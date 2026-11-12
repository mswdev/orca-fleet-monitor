// This Mac's processes, as Activity Monitor lists them, from two tools macOS ships:
//
//   ps -axww -o pid=,ppid=,uid=,user=,time=,lstart=,ucomm=   (LC_CTYPE=UTF-8, TZ=UTC)
//       every process's parent, owner, cumulative CPU time, start time and name. The name is the
//       kernel's short name for the process (`ucomm`: the executable's file name, at most 16
//       characters), never `comm`, which on macOS is argv[0] or a title the process set itself
//       and can carry its arguments, tokens included. CPU % is the CPU time used between two
//       readings over the time between them, as Activity Monitor works out its "% CPU" over its
//       update interval. About 28 ms of CPU on a Mac with 1,000 processes.
//   top -l 0 -s <seconds> -stats pid,mem,power
//       a long-running stream: MEM is each process's physical footprint, the figure in Activity
//       Monitor's Memory column (resident size, which `ps` has, is far from it: a few per cent of
//       it for WindowServer), and POWER is top's energy impact. `top` is setuid root, so it reads
//       every user's processes, which `footprint` and `vmmap` cannot without root. Its first
//       sample costs about 2 s of CPU, each later one about 0.3 s (1,000 processes), whatever is
//       asked of it; so it runs as a stream, slowly (every 120 s) for the published list, and fast
//       (every 5 s) only while a panel keeps asking for this computer's list.
//
// Both are joined on pid. A footprint from a `top` sample taken before the process started (a
// pid reused since) is not used. No path, argument or process title is read at all, so none can
// be published, answered or logged.
import { spawn as nodeSpawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { clipText } from './bounds.ts'
import { createRunBounded, type ExecFile } from './mac-memory.ts'
import type { ProcessRow, TopProcess } from './model.ts'

export const PS_PATH = '/bin/ps'
export const TOP_PATH = '/usr/bin/top'
export const PS_ARGS = ['-axww', '-o', 'pid=,ppid=,uid=,user=,time=,lstart=,ucomm='] as const
/** UTF-8 so names outside ASCII come through whole; UTC so start times never move when the
 *  machine's time zone changes (lstart is then UTC). */
export const PS_ENV: Readonly<Record<string, string>> = Object.freeze({ LC_CTYPE: 'UTF-8', TZ: 'UTC' })
/** `ps`'s own bounded runner, apart from the memory reads' (src/mac-memory.ts). */
export const processRunBounded: ExecFile = createRunBounded()
const PS_TIMEOUT_MS = 5_000
/** About 150 bytes a process; 4 MiB is far more than any Mac runs. */
const PS_MAX_BYTES = 4 * 1024 * 1024
/** How long one name and one user name may be. */
export const NAME_MAX = 128
export const USER_MAX = 32
/** Most processes kept from one `ps` reading. */
export const MAX_PROCESSES = 8_000

/** The slow stream, for the published list: memory figures at most two minutes old (their age
 *  travels with them). Each sample costs about 0.3 s of CPU on a Mac with 1,000 processes, so
 *  every 2 minutes keeps an unattended Mac's whole sampling under about 1% of one core. */
export const SLOW_TOP_SECONDS = 120
/** The fast stream, while a panel keeps asking for this computer's list: Activity Monitor's own
 *  default update interval. */
export const FAST_TOP_SECONDS = 5
/** The fast stream stops this long after the last request. */
export const FAST_TOP_LINGER_MS = 20_000
/** The first request waits this long for the fast stream's first sample (about 2 s). */
export const FIRST_SAMPLE_WAIT_MS = 3_500
/** A request this soon after the last `ps` reading is answered from it. */
export const LIST_CACHE_MS = 2_000
/** Two `ps` readings closer than this give no CPU %. */
const MIN_CPU_WINDOW_MS = 500

// --- ps --------------------------------------------------------------------------------------

/** One process from `ps`: its kernel short name, never a path, argument or title. */
export type PsRow = {
  pid: number
  ppid: number
  uid: number
  user: string
  /** Cumulative CPU time, user + system, in hundredths of a second. */
  cpuCs: number
  /** Start time, epoch seconds (`ps` prints it in UTC: PS_ENV). */
  start: number
  /** The kernel's short name (`ucomm`), at most 16 characters as macOS keeps it. */
  name: string
}

const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 }
const PS_LINE =
  /^\s*(\d{1,10})\s+(\d{1,10})\s+(\d{1,10})\s+(\S{1,64})\s+([\d:.-]{4,24})\s+[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s+(.+?)\s*$/

/** `ps`'s `time` column, `[[dd-]hh:]mm:ss.cc` (macOS counts minutes past 59: `2288:59.69`), in
 *  hundredths of a second; null when out of shape. */
export function parseCpuTime(text: string): number | null {
  const match = /^(?:(\d{1,5})-)?(?:(\d{1,7}):)?(\d{1,7}):(\d{2})(?:\.(\d{1,2}))?$/.exec(text)
  if (!match) return null
  const [, days, hours, minutes, seconds, fraction] = match
  if (Number(seconds) > 59) return null
  if (days !== undefined && hours === undefined) return null
  const cs = fraction === undefined ? 0 : Number(fraction.padEnd(2, '0'))
  const total = ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds)
  const value = total * 100 + cs
  return Number.isSafeInteger(value) ? value : null
}

/** A process's name as `ps` prints its `ucomm`: plain text on one line, bounded. Kept whole
 *  otherwise (a `/` in it is part of the name, not a path to cut). */
export function processName(ucomm: string): string {
  return oneLineName(ucomm, NAME_MAX)
}

/** Text from a process table made fit for one line: controls become spaces, bidirectional
 *  controls U+FFFD (clipText), cut to `max`. */
export function oneLineName(text: string, max: number): string {
  return clipText(text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').trim(), max)
}

/** Every process in `ps -axww -o pid=,ppid=,uid=,user=,time=,lstart=,ucomm=` (PS_ENV). A line
 *  out of shape is skipped; so is a second line for a pid. */
export function parsePs(text: unknown): PsRow[] | null {
  if (typeof text !== 'string' || text.length > PS_MAX_BYTES) return null
  const out: PsRow[] = []
  const seen = new Set<number>()
  for (const line of text.split('\n')) {
    if (out.length >= MAX_PROCESSES) break
    const m = PS_LINE.exec(line)
    if (!m) continue
    const pid = Number(m[1])
    const month = Object.hasOwn(MONTHS, m[6]!) ? MONTHS[m[6]!]! : -1
    const cpuCs = parseCpuTime(m[5]!)
    if (seen.has(pid) || month < 0 || cpuCs === null || pid > 2 ** 31) continue
    const start = Date.UTC(Number(m[11]), month, Number(m[7]), Number(m[8]), Number(m[9]), Number(m[10])) / 1000
    if (!Number.isFinite(start)) continue
    seen.add(pid)
    out.push({ pid, ppid: Number(m[2]), uid: Number(m[3]), user: oneLineName(m[4]!, USER_MAX), cpuCs, start: Math.round(start), name: processName(m[12]!) })
  }
  return out
}

// --- top -------------------------------------------------------------------------------------

export type TopRow = { mem: number | null; power: number | null }
export type TopSample = {
  /** Monotonic ms and wall ms when it was read. */
  at: number
  wallAt: number
  /** 0 for the stream's first sample, whose POWER is not yet a measurement. */
  index: number
  /** The stream's interval: what POWER is averaged over. */
  intervalMs: number
  rows: Map<number, TopRow>
}

const UNITS: Record<string, number> = { '': 1, B: 1, K: 2 ** 10, M: 2 ** 20, G: 2 ** 30, T: 2 ** 40 }

/** `top`'s MEM column (`2768K`, `473M`, `5204M+`) in bytes; null when out of shape. */
export function parseTopMem(text: string): number | null {
  const m = /^(\d{1,9}(?:\.\d{1,3})?)([BKMGT]?)[+\-<>]?$/.exec(text)
  if (!m) return null
  const value = Math.round(Number(m[1]) * UNITS[m[2]!]!)
  return Number.isSafeInteger(value) ? value : null
}

/** The rows of one sample of `top -l … -stats pid,mem,power`: from its `PID` header line to the
 *  end. Lines out of shape are skipped. */
export function parseTopSample(text: string): Map<number, TopRow> | null {
  const lines = text.split('\n')
  const header = lines.findIndex((line) => /^PID\s+MEM\s+POWER\s*$/.test(line.trim()))
  if (header === -1) return null
  const rows = new Map<number, TopRow>()
  for (const line of lines.slice(header + 1)) {
    if (rows.size >= MAX_PROCESSES) break
    const f = line.trim().split(/\s+/)
    if (f.length !== 3 || !/^\d{1,10}$/.test(f[0]!)) continue
    const power = /^\d{1,7}(?:\.\d{1,2})?$/.test(f[2]!) ? Number(f[2]) : null
    rows.set(Number(f[0]), { mem: parseTopMem(f[1]!), power })
  }
  return rows
}

/** What TopStream needs of a child process (a test seam). */
export type TopChild = {
  pid?: number | undefined
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}
export type SpawnTop = (file: string, args: readonly string[]) => TopChild

const realSpawnTop: SpawnTop = (file, args) =>
  nodeSpawn(file, [...args], { stdio: ['ignore', 'pipe', 'ignore'], env: { LC_ALL: 'C' }, windowsHide: true }) as unknown as TopChild

/** Text a stream may hold before a sample is complete; `top` writes about 25 KB per sample. */
const TOP_BUFFER_MAX = 4 * 1024 * 1024
/** A sample counts as complete once `top` has been quiet this long after writing it. */
const TOP_QUIET_MS = 150
const TOP_RESTART_MIN_MS = 5_000
const TOP_RESTART_MAX_MS = 5 * 60_000

export type Timers = { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (handle: unknown) => void }
const realTimers: Timers = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    handle.unref?.()
    return handle
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

/**
 * One long-running `top -l 0 -s <seconds> -stats pid,mem,power`, and its newest whole sample. It
 * is killed (SIGKILL; `top` is setuid root but runs for this user, so that works) on `stop()`, on
 * output out of shape or too large, and when it stalls; it starts again after a growing pause if it
 * ends by itself. Should the worker die, `top` ends at its next write, on the broken pipe.
 */
export class TopStream {
  readonly intervalMs: number
  private readonly spawnTop: SpawnTop
  private readonly timers: Timers
  private readonly mono: () => number
  private readonly wall: () => number
  private child: TopChild | null = null
  private buffer = ''
  private quiet: unknown = null
  private stall: unknown = null
  private restart: unknown = null
  private restartDelay = TOP_RESTART_MIN_MS
  private index = 0
  private latestSample: TopSample | null = null
  private waiters: (() => void)[] = []
  private running = false

  constructor(seconds: number, deps: { spawnTop?: SpawnTop; timers?: Timers; mono?: () => number; wall?: () => number } = {}) {
    this.intervalMs = Math.max(1, Math.round(seconds)) * 1000
    this.spawnTop = deps.spawnTop ?? realSpawnTop
    this.timers = deps.timers ?? realTimers
    this.mono = deps.mono ?? (() => performance.now())
    this.wall = deps.wall ?? Date.now
  }

  get active(): boolean {
    return this.running
  }

  latest(): TopSample | null {
    return this.latestSample
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.spawn()
  }

  /** Stops the stream and forgets its sample: footprints from before a pause are not shown as
   *  current once it starts again (until the new stream's first sample, there are none). */
  stop(): void {
    this.running = false
    this.timers.clearTimeout(this.restart)
    this.restart = null
    this.kill()
    this.latestSample = null
    this.release()
  }

  /** Resolves with the next whole sample, or null after `timeoutMs` (or once stopped). */
  nextSample(timeoutMs: number): Promise<TopSample | null> {
    if (!this.running) return Promise.resolve(null)
    return new Promise((resolve) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        this.timers.clearTimeout(timer)
        resolve(this.latestSample)
      }
      const timer = this.timers.setTimeout(() => {
        if (done) return
        done = true
        this.waiters = this.waiters.filter((w) => w !== finish)
        resolve(null)
      }, timeoutMs)
      this.waiters.push(finish)
    })
  }

  private spawn(): void {
    const seconds = String(this.intervalMs / 1000)
    let child: TopChild
    try {
      child = this.spawnTop(TOP_PATH, ['-l', '0', '-s', seconds, '-stats', 'pid,mem,power'])
    } catch {
      this.scheduleRestart()
      return
    }
    this.child = child
    this.buffer = ''
    this.index = 0
    child.stdout?.on('data', (chunk) => {
      if (this.child !== child) return
      this.buffer += String(chunk)
      if (this.buffer.length > TOP_BUFFER_MAX) {
        this.kill()
        this.scheduleRestart()
        return
      }
      this.timers.clearTimeout(this.quiet)
      this.quiet = this.timers.setTimeout(() => this.takeSample(child), TOP_QUIET_MS)
    })
    const ended = (): void => {
      if (this.child !== child) return
      this.child = null
      this.clearTimers()
      if (this.running) this.scheduleRestart()
    }
    child.on('exit', ended)
    child.on('error', ended)
    this.armStall()
  }

  /** Everything since the newest `Processes:` header is the newest sample. */
  private takeSample(child: TopChild): void {
    if (this.child !== child) return
    const at = this.buffer.lastIndexOf('Processes:')
    if (at === -1) return
    const rows = parseTopSample(this.buffer.slice(at))
    this.buffer = ''
    if (!rows) {
      // Not top's logging format: something is wrong with this stream.
      this.kill()
      this.scheduleRestart()
      return
    }
    this.latestSample = { at: this.mono(), wallAt: this.wall(), index: this.index, intervalMs: this.intervalMs, rows }
    this.index += 1
    this.restartDelay = TOP_RESTART_MIN_MS
    this.armStall()
    this.release()
  }

  private release(): void {
    const waiters = this.waiters
    this.waiters = []
    for (const resolve of waiters) resolve()
  }

  /** No sample for three intervals and a bit: the stream is stuck; start again. */
  private armStall(): void {
    this.timers.clearTimeout(this.stall)
    this.stall = this.timers.setTimeout(() => {
      if (!this.running) return
      this.kill()
      this.scheduleRestart()
    }, 3 * this.intervalMs + 10_000)
  }

  private scheduleRestart(): void {
    if (!this.running || this.restart !== null) return
    const delay = this.restartDelay
    this.restartDelay = Math.min(TOP_RESTART_MAX_MS, delay * 2)
    this.restart = this.timers.setTimeout(() => {
      this.restart = null
      if (this.running && !this.child) this.spawn()
    }, delay)
  }

  private clearTimers(): void {
    this.timers.clearTimeout(this.quiet)
    this.timers.clearTimeout(this.stall)
    this.quiet = null
    this.stall = null
  }

  private kill(): void {
    const child = this.child
    this.child = null
    this.clearTimers()
    if (!child) return
    try {
      child.kill('SIGKILL')
    } catch {
      // Already gone.
    }
  }
}

// --- a table from ps and top -----------------------------------------------------------------

export type PsReading = { at: number; wallAt: number; rows: PsRow[] }

export type ProcessTable = {
  /** Wall ms when the processes were read. */
  takenAt: number
  rows: ProcessRow[]
  cpuWindowMs: number | null
  memAgeMs: number | null
  energyWindowMs: number | null
  total: number
}

/**
 * Joins a `ps` reading (and the one before it, for CPU %) with the freshest `top` sample. A
 * footprint is used only when the sample was taken after the process started; CPU % only for a
 * process in both readings with the same start time, or started between them.
 */
export function buildTable(current: PsReading, previous: PsReading | null, top: TopSample | null, cores = 0): ProcessTable {
  const windowMs = previous ? current.wallAt - previous.wallAt : null
  const usableWindow = windowMs !== null && windowMs >= MIN_CPU_WINDOW_MS ? windowMs : null
  const before = previous && usableWindow !== null ? new Map(previous.rows.map((r) => [r.pid, r])) : null
  const maxCpu = Math.max(100, cores * 100)
  const topRows = top?.rows ?? null
  const rows: ProcessRow[] = current.rows.map((r) => {
    let cpu: number | null = null
    if (before && usableWindow !== null) {
      const old = before.get(r.pid)
      if (old && old.start === r.start) {
        if (r.cpuCs >= old.cpuCs) cpu = ((r.cpuCs - old.cpuCs) * 10 * 100) / usableWindow
      } else {
        // Started since the last reading: all its CPU time was used in this window, and is
        // shared over the whole window, as Activity Monitor counts it (not over its shorter life,
        // which would make every young process look busy).
        cpu = (r.cpuCs * 10 * 100) / usableWindow
      }
      if (cpu !== null) cpu = Math.round(Math.min(maxCpu, Math.max(0, cpu)) * 10) / 10
    }
    const t = topRows?.get(r.pid)
    const fromThis = t !== undefined && top!.wallAt >= r.start * 1000
    return {
      pid: r.pid,
      ppid: r.ppid,
      name: r.name,
      user: r.user,
      cpu,
      mem: fromThis ? t.mem : null,
      // POWER means nothing on a stream's first sample.
      energy: fromThis && top!.index > 0 ? t.power : null,
      start: r.start
    }
  })
  // `ps` does not list the kernel (pid 0); Activity Monitor does, as kernel_task, and so does top.
  const kernel = topRows?.get(0)
  if (kernel && !rows.some((r) => r.pid === 0)) {
    rows.push({ pid: 0, ppid: null, name: 'kernel_task', user: 'root', cpu: null, mem: kernel.mem, energy: top!.index > 0 ? kernel.power : null, start: null })
  }
  return {
    takenAt: current.wallAt,
    rows,
    cpuWindowMs: usableWindow,
    memAgeMs: top ? Math.max(0, Math.round(current.wallAt - top.wallAt)) : null,
    energyWindowMs: top && top.index > 0 ? top.intervalMs : null,
    total: rows.length
  }
}

/** A remote's top list: the `byMemory` using the most memory, then the `byCpu` busiest not
 *  already in, most memory first. */
export function selectTop<T extends { pid: number; mem: number | null; cpu: number | null }>(rows: readonly T[], byMemory = 40, byCpu = 20): T[] {
  const memOf = (r: T): number => r.mem ?? -1
  const cpuOf = (r: T): number => r.cpu ?? -1
  const chosen = new Map<number, T>()
  for (const r of rows.filter((r) => r.mem !== null).sort((a, b) => memOf(b) - memOf(a) || a.pid - b.pid).slice(0, byMemory)) chosen.set(r.pid, r)
  let added = 0
  for (const r of rows.filter((r) => r.cpu !== null && r.cpu > 0).sort((a, b) => cpuOf(b) - cpuOf(a) || a.pid - b.pid)) {
    if (added >= byCpu) break
    if (chosen.has(r.pid)) continue
    chosen.set(r.pid, r)
    added += 1
  }
  return [...chosen.values()].sort((a, b) => memOf(b) - memOf(a) || cpuOf(b) - cpuOf(a) || a.pid - b.pid)
}

/** The process using the most memory, or null when no row has a memory figure. */
export function largestProcess(rows: readonly { pid: number; name: string; mem: number | null }[]): TopProcess | null {
  let best: TopProcess | null = null
  for (const r of rows) {
    if (r.mem === null || !Number.isFinite(r.mem) || r.mem <= 0) continue
    if (!best || r.mem > best.mem || (r.mem === best.mem && r.pid < best.pid)) best = { pid: r.pid, name: r.name, mem: r.mem }
  }
  return best
}

// --- the sampler -----------------------------------------------------------------------------

export type ProcessSamplerDeps = {
  exec?: ExecFile
  spawnTop?: SpawnTop
  timers?: Timers
  mono?: () => number
  wall?: () => number
  platform?: string
  cores?: () => number
}

/**
 * This Mac's processes: `ps` when asked, joined with the freshest of two `top` streams. The slow
 * stream runs while this copy publishes its list (`setPublishing(true)`); the fast one starts on a
 * request for the local list and stops FAST_TOP_LINGER_MS after the last. Nothing runs on any
 * other platform, or with neither publishing nor requests.
 */
export class ProcessSampler {
  private readonly exec: ExecFile
  private readonly timers: Timers
  private readonly mono: () => number
  private readonly wall: () => number
  private readonly platform: string
  private readonly cores: () => number
  readonly slow: TopStream
  readonly fast: TopStream
  private fastTimer: unknown = null
  private current: PsReading | null = null
  private previous: PsReading | null = null
  private reading: Promise<PsReading | null> | null = null
  private table: { table: ProcessTable; at: number } | null = null

  constructor(deps: ProcessSamplerDeps = {}) {
    this.exec = deps.exec ?? processRunBounded
    this.timers = deps.timers ?? realTimers
    this.mono = deps.mono ?? (() => performance.now())
    this.wall = deps.wall ?? Date.now
    this.platform = deps.platform ?? process.platform
    this.cores = deps.cores ?? (() => 0)
    const streamDeps = { spawnTop: deps.spawnTop, timers: this.timers, mono: this.mono, wall: this.wall }
    this.slow = new TopStream(SLOW_TOP_SECONDS, streamDeps)
    this.fast = new TopStream(FAST_TOP_SECONDS, streamDeps)
  }

  get supported(): boolean {
    return this.platform === 'darwin'
  }

  /** The slow stream runs while this copy publishes its list. */
  setPublishing(on: boolean): void {
    if (!this.supported) return
    if (on) this.slow.start()
    else this.slow.stop()
  }

  /** Every process on this computer, for a panel: `ps` at most every LIST_CACHE_MS, with the fast
   *  stream's footprints. On the first request the fast stream's first sample (about 2 s) is
   *  waited for unless the slow stream already has one. Null when `ps` cannot be read. */
  async localTable(): Promise<ProcessTable | null> {
    if (!this.supported) return null
    this.keepFastRunning()
    if (!this.fast.latest() && !this.slow.latest()) await this.fast.nextSample(FIRST_SAMPLE_WAIT_MS)
    return this.tableNow()
  }

  /** The table for the published list: a fresh `ps` (unless one was just read). */
  async publishTable(): Promise<ProcessTable | null> {
    if (!this.supported) return null
    return this.tableNow()
  }

  /** The newest table read, without reading anything. */
  latestTable(): ProcessTable | null {
    return this.table?.table ?? null
  }

  stop(): void {
    this.timers.clearTimeout(this.fastTimer)
    this.fastTimer = null
    this.slow.stop()
    this.fast.stop()
  }

  private keepFastRunning(): void {
    this.fast.start()
    this.timers.clearTimeout(this.fastTimer)
    this.fastTimer = this.timers.setTimeout(() => {
      this.fastTimer = null
      this.fast.stop()
    }, FAST_TOP_LINGER_MS)
  }

  /** The freshest `top` sample of the two streams. */
  private freshestTop(): TopSample | null {
    const a = this.fast.latest()
    const b = this.slow.latest()
    if (!a) return b
    if (!b) return a
    return a.wallAt >= b.wallAt ? a : b
  }

  private async tableNow(): Promise<ProcessTable | null> {
    const cached = this.table
    const now = this.mono()
    if (cached && now - cached.at < LIST_CACHE_MS && now >= cached.at) return cached.table
    const reading = await this.readPs()
    if (!reading) return null
    const table = buildTable(reading, this.previous, this.freshestTop(), safeCores(this.cores))
    this.table = { table, at: reading.at }
    return table
  }

  /** One `ps` reading, shared by every caller while it runs. */
  private readPs(): Promise<PsReading | null> {
    this.reading ??= (async () => {
      let rows: PsRow[] | null = null
      try {
        const out = await this.exec(PS_PATH, PS_ARGS, { timeout: PS_TIMEOUT_MS, maxBuffer: PS_MAX_BYTES, env: { ...PS_ENV } })
        rows = out.error ? null : parsePs(out.stdout)
      } catch {
        rows = null
      }
      if (!rows || rows.length === 0) return null
      const reading: PsReading = { at: this.mono(), wallAt: this.wall(), rows }
      this.previous = this.current
      this.current = reading
      return reading
    })().finally(() => {
      this.reading = null
    })
    return this.reading
  }
}

function safeCores(cores: () => number): number {
  try {
    const n = cores()
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}
