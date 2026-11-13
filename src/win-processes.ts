// This Windows computer's processes, from one read of the "Process" performance counters by the
// resident PowerShell (src/win-host.ts, `proc`). A signed-in user may read them without
// elevation; a standard user's service, scheduled task or SSH session may not (that needs the
// Performance Monitor Users group), and then there is no list, which the panel says:
//
//   ID Process, Creating Process ID   pid and parent pid (the parent may be long gone)
//   % Processor Time                  its raw value: cumulative CPU time, user + kernel, in units
//                                     of 100 ns. CPU % is the CPU time used between two readings
//                                     over the time between them, by the readings' own time
//                                     stamps: percent of one core, as on a Mac (Task Manager
//                                     shows percent of the whole computer instead)
//   Working Set - Private             bytes: what Task Manager's Memory column is meant to show
//                                     (not checked on a Windows machine)
//   Elapsed Time                      its raw value: when the process started, taken to be a
//                                     Windows file time (100 ns units since 1601, UTC). It tells
//                                     a process from a later one with the same pid, which needs
//                                     only that it stays the same, whatever its epoch.
//   the instance name                 the image's file name without `.exe`, with `#1`, `#2` added
//                                     by .NET to tell several of one name apart
//
// The owner of a process is not read (another user's needs elevation), nor is any energy figure.
// No path, command line or window title is read at all, so none can be published, answered or
// logged.
//
// Cost, on a 4-core CI machine with about 150 processes: a read is answered in about 10 ms. Not
// measured on a desktop with several hundred.
import { performance } from 'node:perf_hooks'
import type { ProcessRow } from './model.ts'
import { LIST_CACHE_MS, MAX_PROCESSES, NAME_MAX, oneLineName, type ProcessTable } from './processes.ts'
import { PowerShellHost } from './win-host.ts'

/** Readings in a row without a list before the list is taken to be unreadable here, and how
 *  long before it is tried again. */
export const EMPTY_LIMIT = 5
export const RETRY_BLOCKED_MS = 60 * 60_000
/** How long PowerShell has to answer; a panel waits on this, and gets no list after it. */
const PROC_TIMEOUT_MS = 10_000
/** The counters count in units of 100 ns. */
const TICKS_PER_MS = 10_000
const TICKS_PER_SECOND = 10_000_000
/** Two readings closer than this give no CPU %. */
const MIN_CPU_WINDOW_MS = 500
/** A Windows pid is 32 bits. */
const MAX_PID = 2 ** 32 - 1
/** Seconds from 1601, where Windows file times start, to 1970. */
const FILE_TIME_EPOCH_SECONDS = 11_644_473_600
/** A start time this far past its own reading is no start time (the clock may have been set
 *  back a little in between; not by a day). */
const START_SLACK_TICKS = 24 * 3_600 * TICKS_PER_SECOND

/** One process from `proc`: its image's name, never a path, argument or title. */
export type WindowsProcess = {
  pid: number
  ppid: number | null
  name: string
  /** Cumulative CPU time, user + kernel, in units of 100 ns. */
  cpuTicks: number | null
  /** Private working set, bytes. */
  mem: number | null
  /** When it started, as the counter gives it (a file time). Past 2^53, so JSON rounds it (by
   *  under 2 µs), always to the same number: what matters is that it does not change. */
  started: number | null
}

/** One `proc` answer: its own time stamp, a file time in units of 100 ns, and the processes. */
export type ProcAnswer = { t: number; rows: WindowsProcess[] }
export type WindowsProcessReading = ProcAnswer & { at: number; wallAt: number }

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * A process's name from its counter instance name: `chrome#12` is the thirteenth `chrome`, and
 * Windows can be set to name instances `chrome_4242` (ProcessNameFormat 2) or, in its newer
 * counter set, `chrome:4242`. A number is taken off only when it is the process's own pid.
 */
export function windowsProcessName(instance: string, pid: number): string {
  let name = instance.replace(/#\d{1,9}$/, '')
  for (const mark of [':', '_']) {
    const suffix = `${mark}${pid}`
    if (name.length > suffix.length && name.endsWith(suffix)) name = name.slice(0, -suffix.length)
  }
  return oneLineName(name, NAME_MAX)
}

/**
 * `proc`'s answer, `{ t, p: [[pid, ppid, name, cpu, mem, started], …] }`, or null when out of
 * shape. A row out of shape is skipped, and so are a second row for a pid and pid 0 (the idle
 * "process"); a figure out of shape is left out of its row.
 */
export function parseProcAnswer(answer: unknown): ProcAnswer | null {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return null
  const { t, p } = answer as { t?: unknown; p?: unknown }
  if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0 || !Array.isArray(p)) return null
  // PowerShell's own JSON writer hands back a list of one as the one: a lone row is the list.
  const list: unknown[] = p.length === 6 && !p.some(Array.isArray) ? [p] : p
  const rows: WindowsProcess[] = []
  const seen = new Set<number>()
  for (const item of list) {
    if (rows.length >= MAX_PROCESSES) break
    if (!Array.isArray(item) || item.length < 6) continue
    const [pid, ppid, instance, cpu, mem, started] = item as unknown[]
    if (!isCount(pid) || pid < 1 || pid > MAX_PID || seen.has(pid) || typeof instance !== 'string') continue
    const name = windowsProcessName(instance, pid)
    if (name === '') continue
    seen.add(pid)
    rows.push({
      pid,
      ppid: isCount(ppid) && ppid <= MAX_PID ? ppid : null,
      name,
      cpuTicks: isCount(cpu) ? cpu : null,
      mem: isCount(mem) ? mem : null,
      started: typeof started === 'number' && Number.isFinite(started) && started > 0 ? started : null
    })
  }
  return { t, rows }
}

/** A start time in epoch seconds from a file time, or null when it is not a time a process read
 *  at `readAt` (a file time too) could have started: before 1970, or after the reading. */
export function startSeconds(started: number | null, readAt: number): number | null {
  if (started === null || started > readAt + START_SLACK_TICKS) return null
  const seconds = Math.round(started / TICKS_PER_SECOND) - FILE_TIME_EPOCH_SECONDS
  return seconds > 0 ? seconds : null
}

/**
 * A table from a reading and the one before it, for CPU %: only for a process in both readings
 * with the same start time, or one that is new or has taken over a pid, whose whole CPU time is
 * then spread over the window (as src/processes.ts does on a Mac). The window is the time between
 * the two answers' own stamps, so it does not depend on how long either took to arrive.
 */
export function buildWindowsTable(current: WindowsProcessReading, previous: WindowsProcessReading | null, cores = 0): ProcessTable {
  const window = previous ? current.t - previous.t : null
  const usableWindow = window !== null && window >= MIN_CPU_WINDOW_MS * TICKS_PER_MS ? window : null
  const before = previous && usableWindow !== null ? new Map(previous.rows.map((r) => [r.pid, r])) : null
  const maxCpu = Math.max(100, cores * 100)
  const rows: ProcessRow[] = current.rows.map((r) => {
    let cpu: number | null = null
    if (before && usableWindow !== null && r.cpuTicks !== null) {
      const old = before.get(r.pid)
      if (!old || (old.started !== null && r.started !== null && old.started !== r.started)) {
        // Started since the last reading: all its CPU time was used in this window, and is
        // shared over the whole window, not over its shorter life.
        cpu = (r.cpuTicks * 100) / usableWindow
      } else if (old.started !== null && old.started === r.started) {
        if (old.cpuTicks !== null && r.cpuTicks >= old.cpuTicks) cpu = ((r.cpuTicks - old.cpuTicks) * 100) / usableWindow
      }
      // Otherwise a start time is missing, and with it any way to tell whether the pid has
      // changed hands: no figure.
      if (cpu !== null) cpu = Math.round(Math.min(maxCpu, Math.max(0, cpu)) * 10) / 10
    }
    return { pid: r.pid, ppid: r.ppid, name: r.name, user: null, cpu, mem: r.mem, energy: null, start: startSeconds(r.started, current.t) }
  })
  return {
    takenAt: current.wallAt,
    rows,
    cpuWindowMs: usableWindow === null ? null : Math.round(usableWindow / TICKS_PER_MS),
    // Memory is read with everything else, in the one answer.
    memAgeMs: 0,
    energyWindowMs: null,
    total: rows.length
  }
}

export type WindowsProcessSamplerDeps = {
  host?: Pick<PowerShellHost, 'request'> & { readonly unavailable?: boolean; ask?: PowerShellHost['ask'] }
  mono?: () => number
  wall?: () => number
  platform?: string
  cores?: () => number
}

/**
 * This Windows computer's processes: one `proc` request when a list is asked for, unless one was
 * just read. There is nothing to keep running between requests, so publishing or not makes no
 * difference here; the PowerShell host is shared with the system readings (src/win-system.ts), so
 * it is handed in and never stopped here. Nothing is asked on any other platform.
 */
export class WindowsProcessSampler {
  private readonly host: Pick<PowerShellHost, 'request'> & { readonly unavailable?: boolean; ask?: PowerShellHost['ask'] }
  private readonly mono: () => number
  private readonly wall: () => number
  private readonly platform: string
  private readonly cores: () => number
  private current: WindowsProcessReading | null = null
  private previous: WindowsProcessReading | null = null
  private reading: Promise<WindowsProcessReading | null> | null = null
  private table: { table: ProcessTable; of: WindowsProcessReading } | null = null
  /** How many readings in a row gave no list, and until when that is taken as "cannot". */
  private empty = 0
  private blockedUntil = Number.NEGATIVE_INFINITY

  constructor(deps: WindowsProcessSamplerDeps = {}) {
    this.platform = deps.platform ?? process.platform
    this.host = deps.host ?? new PowerShellHost({ platform: this.platform })
    this.mono = deps.mono ?? (() => performance.now())
    this.wall = deps.wall ?? Date.now
    this.cores = deps.cores ?? (() => 0)
  }

  get supported(): boolean {
    return this.platform === 'win32'
  }

  /** Nothing to start or stop: kept for the monitor, which tells every process source. */
  setPublishing(_on: boolean): void {}

  /** Every process on this computer, for a panel: read at most every LIST_CACHE_MS. Null when
   *  PowerShell gives no list. */
  async localTable(): Promise<ProcessTable | null> {
    if (!this.supported) return null
    return this.tableNow()
  }

  /** The table for the published list: a fresh reading (unless one was just made). */
  async publishTable(): Promise<ProcessTable | null> {
    if (!this.supported) return null
    return this.tableNow()
  }

  /** The newest table read, without reading anything. */
  latestTable(): ProcessTable | null {
    return this.table?.table ?? null
  }

  /** Nothing of this sampler's own runs; whoever made the PowerShell host stops it. */
  stop(): void {}

  /** True while the list cannot be read here at all: PowerShell cannot run the reader
   *  (src/win-host.ts `unavailable`), or it runs and has given no list EMPTY_LIMIT times in a row
   *  (the performance counters are off, broken or not this user's to read). Tried again after
   *  RETRY_BLOCKED_MS. */
  unavailable(): boolean {
    return this.host.unavailable === true || this.mono() < this.blockedUntil
  }

  private async tableNow(): Promise<ProcessTable | null> {
    const cached = this.table
    const now = this.mono()
    // Taken to be unreadable here: nothing is asked until its hour is up.
    if (now < this.blockedUntil) return null
    if (cached && now - cached.of.at < LIST_CACHE_MS && now >= cached.of.at) return cached.table
    const reading = await this.read()
    if (!reading) return null
    // Callers that shared the reading share its table too.
    if (this.table?.of === reading) return this.table.table
    const table = buildWindowsTable(reading, this.previous, safeCores(this.cores))
    this.table = { table, of: reading }
    return table
  }

  /** One `proc` request, shared by every caller while it runs. */
  private read(): Promise<WindowsProcessReading | null> {
    this.reading ??= (async () => {
      let answer: ProcAnswer | null = null
      let answered = false
      try {
        // `ask` where the host has it: only a reading PowerShell answered counts below.
        const result = this.host.ask ? await this.host.ask('proc', PROC_TIMEOUT_MS) : { answered: true, value: await this.host.request('proc', PROC_TIMEOUT_MS) }
        answered = result.answered
        answer = parseProcAnswer(result.value)
      } catch {
        answer = null
      }
      if (!answer || answer.rows.length === 0) {
        // PowerShell answered, and had no list: that is the counters. A request that was never
        // asked (PowerShell pausing before a restart) or went with a killed process says nothing.
        if (answered) {
          this.empty += 1
          if (this.empty >= EMPTY_LIMIT) this.blockedUntil = this.mono() + RETRY_BLOCKED_MS
        }
        return null
      }
      this.empty = 0
      this.blockedUntil = Number.NEGATIVE_INFINITY
      const reading: WindowsProcessReading = { ...answer, at: this.mono(), wallAt: this.wall() }
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
