// This Linux computer's processes, as `top` lists them, from /proc alone, read without privileges:
//
//   /proc                  its numeric directories: one for each process (threads are not listed)
//   /proc/<pid>/stat       the process's parent, cumulative CPU time (user + system, in clock
//                          ticks of 1/100 s), start time (in ticks after boot), resident pages,
//                          and the kernel's short name for it (`comm`)
//   /proc/<pid>/exe        the link to the process's executable (the link is read, never the
//                          file): the process is named by its executable's file name, which is
//                          what `ucomm` is on a Mac
//   /proc/<pid>            the directory's owner (one `stat`) is the process's effective user,
//                          named through /etc/passwd (read once; of each line only the name and
//                          the uid are kept)
//   /proc/self/auxv        the page size (AT_PAGESZ), read once
//   /proc/stat             `btime`, when the computer started, about once a minute: a start
//                          time is that plus the process's ticks after boot
//
// The name. Of the executable's path only the file name is kept: the directory part is dropped
// at once, in the step that reads the link (exeName), and is never stored, returned, logged or
// published. The link can be read for this user's own processes (for every process when the
// worker runs as root). For another user's process, for one that has made itself unreadable (a
// password agent, say) and for a zombie it cannot, and the process then shows the kernel's
// short name: its executable's file name cut to 15 bytes when it started, or whatever short name
// it has given itself since (prctl PR_SET_NAME). That is why the executable comes first: Node 24
// names itself `MainThread`, and a computer full of Node programs would be a column of it.
//
// Nothing else under /proc/<pid> is read: not cmdline, environ, cwd or status. So no argument,
// environment or working directory is read at all, and none can be published, answered or logged.
//
// CPU % is the CPU time used between two readings over the time between them, as a percentage
// of one core (it passes 100 for a process busy on several), which is how `top` counts it.
//
// Memory is the resident set size (RSS), which `top` calls RES: the process's pages that are in
// RAM. A page several processes share (a library, shared memory) is counted in each of them, so
// the column adds up to more than the memory in use. It is read in the same pass as the rest,
// so it is never older than the list.
//
// Kernel threads (kthreadd, pid 2, and its children) are left out: they have no memory of their
// own, and nobody would look for them here.
//
// Cost: one small read, one `stat` and one link read for each process, never more than 64
// processes at once. With 1,000 processes, every link readable, in a Linux virtual machine on an
// Apple M1 Max (kernel 7.0, Node 24), one reading took about 125 ms of CPU (user + system, the
// threads that read the files included) and 75 ms from start to end, and never held the event
// loop for more than about 5 ms. The reads are asynchronous although the same pass with
// synchronous ones took about 30 ms of CPU: a read that stalls in the kernel (a computer out of
// memory) then stalls one reading, which is given up on after 5 s, and not the worker and its
// beacon. Nothing runs between requests: no child process, no stream, no timer but the deadline
// of a reading under way.
import { readlink, stat as statPath } from 'node:fs/promises'
import os from 'node:os'
import { performance } from 'node:perf_hooks'
import { listDir, MAX_FILE_BYTES, readBytesBounded, readTextBounded, type ReadDir, type ReadFile } from './linux-system.ts'
import type { ProcessRow } from './model.ts'
import { LIST_CACHE_MS, MAX_PROCESSES, NAME_MAX, oneLineName, USER_MAX, type ProcessTable, type Timers } from './processes.ts'

export const PROC_PATH = '/proc'
export const PROC_STAT_PATH = '/proc/stat'
export const PROC_UPTIME_PATH = '/proc/uptime'
export const AUXV_PATH = '/proc/self/auxv'
export const PASSWD_PATH = '/etc/passwd'
/** The kernel reports a process's CPU time, and its start after boot, in clock ticks of USER_HZ,
 *  which is 100 a second on every architecture Node runs on, whatever the kernel's own timer
 *  rate (`getconf CLK_TCK`). */
export const CLOCK_TICKS_PER_SECOND = 100
/** The page size used when /proc/self/auxv cannot be read: x86's, and most arm64 kernels'. */
export const FALLBACK_PAGE_BYTES = 4096
/** How many processes are read side by side. */
export const READ_BATCH = 64
/** A reading that has not finished after this long is answered as failed. */
export const READ_DEADLINE_MS = 5_000
/** /proc/<pid>/stat is one line of 52 fields: a few hundred bytes. */
const STAT_MAX_BYTES = 4_096
/** The auxiliary vector is about twenty pairs of words. */
const AUXV_MAX_BYTES = 4_096
/** The longest link target taken: a path of PATH_MAX (4,096) bytes and ` (deleted)`. */
const EXE_MAX_CHARS = 4_096 + 16
/** The most directories of /proc tried in one reading: more than MAX_PROCESSES are kept from,
 *  since kernel threads are read before they are left out. */
const MAX_PIDS_READ = 4 * MAX_PROCESSES
/** Most accounts kept from /etc/passwd. */
const MAX_USERS = 4_096
/** /etc/passwd is read again for a uid it did not name at most this often. */
const PASSWD_RETRY_MS = 60_000
/** `btime` moves when the clock is set (at boot, before the network time arrives, say). */
const BOOT_TIME_MAX_AGE_MS = 60_000
/** Two readings closer than this give no CPU %. */
const MIN_CPU_WINDOW_MS = 500

// --- parsers ---------------------------------------------------------------------------------

/** What is taken from one /proc/<pid>/stat. */
export type ProcStat = {
  pid: number
  /** The kernel's short name, as it stands in the file (not yet made fit for one line): the
   *  executable's file name cut to 15 bytes, or what the process has named itself since. It names
   *  the process only where its executable's name cannot be read (exeName). */
  comm: string
  /** One letter: R running, S sleeping, Z zombie and so on. */
  state: string
  ppid: number
  /** Cumulative CPU time, user + system, of every thread, in clock ticks. */
  cpuTicks: number
  /** When it started, in clock ticks after boot. With the pid, this says which process it is. */
  startTicks: number
  /** The size of its address space in bytes: 0 for a kernel thread, which has none. */
  vsize: number
  /** Resident set size in pages. */
  rssPages: number
}

const NUMBER = /^\d{1,20}$/

/**
 * One /proc/<pid>/stat: `pid (comm) state ppid …`, 52 fields on one line. `comm` may hold spaces
 * and parentheses (`(sd-pam)`, `Web Content`), so it is what stands between the first `(` and
 * the last `)`: nothing after it but numbers and the state letter. Counting the pid as field 1,
 * utime is field 14, stime 15, starttime 22, vsize 23 and rss 24. Null for anything out of shape.
 */
export function parseProcStat(text: unknown): ProcStat | null {
  if (typeof text !== 'string' || text.length > STAT_MAX_BYTES) return null
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open < 1 || close < open) return null
  const pidText = text.slice(0, open).trim()
  // What follows `comm` starts at field 3: field n is f[n − 3].
  const f = text.slice(close + 1).trim().split(/\s+/)
  if (!/^\d{1,10}$/.test(pidText) || f.length < 22 || !/^[A-Za-z]$/.test(f[0]!)) return null
  const [ppid, utime, stime, starttime, vsize, rss] = [f[1]!, f[11]!, f[12]!, f[19]!, f[20]!, f[21]!]
  if (![ppid, utime, stime, starttime, vsize, rss].every((n) => NUMBER.test(n))) return null
  const stat: ProcStat = {
    pid: Number(pidText),
    comm: text.slice(open + 1, close),
    state: f[0]!,
    ppid: Number(ppid),
    cpuTicks: Number(utime) + Number(stime),
    startTicks: Number(starttime),
    vsize: Number(vsize),
    rssPages: Number(rss)
  }
  if (stat.pid < 1 || stat.pid > 2 ** 31 || stat.ppid > 2 ** 31) return null
  return [stat.cpuTicks, stat.startTicks, stat.vsize, stat.rssPages].every((n) => Number.isSafeInteger(n)) ? stat : null
}

/** A kernel thread: kthreadd (pid 2) or a child of it, with no address space. The last part
 *  matters in a container, where pid 2 is an ordinary process with children of its own. */
export function isKernelThread(stat: ProcStat): boolean {
  return (stat.pid === 2 || stat.ppid === 2) && stat.vsize === 0
}

/**
 * The file name of a process's executable, from the target of its /proc/<pid>/exe link: what
 * follows the last `/`, without the ` (deleted)` the kernel adds once the file has been replaced
 * (by an update, say), made fit for one line. The directory part is dropped here and goes no
 * further. Null when the target is not an absolute path or names no file (`/`): the caller then
 * keeps `comm`.
 */
export function exeName(target: unknown): string | null {
  if (typeof target !== 'string' || target.length > EXE_MAX_CHARS || !target.startsWith('/')) return null
  const path = target.replace(/ \(deleted\)$/, '')
  const name = oneLineName(path.slice(path.lastIndexOf('/') + 1), NAME_MAX)
  return name === '' ? null : name
}

/** The process ids in a listing of /proc: its all-digit names, in order, each once. */
export function pidsOf(names: unknown): number[] {
  if (!Array.isArray(names)) return []
  const pids = new Set<number>()
  for (const name of names) {
    if (typeof name !== 'string' || !/^[1-9]\d{0,9}$/.test(name)) continue
    const pid = Number(name)
    if (pid <= 2 ** 31) pids.add(pid)
  }
  return [...pids].sort((a, b) => a - b)
}

/**
 * The account names in /etc/passwd by uid: `name:password:uid:gid:comment:home:shell`. Only the
 * name and the uid are kept (the comment is often a person's full name). The first line for a
 * uid wins, as it does for `ls` and `ps`; comments and NIS lines (`+`, `-`) are skipped.
 */
export function parsePasswd(text: unknown, maxBytes = MAX_FILE_BYTES): Map<number, string> | null {
  if (typeof text !== 'string' || text.length > maxBytes) return null
  const users = new Map<number, string>()
  for (const line of text.split('\n')) {
    if (users.size >= MAX_USERS) break
    const f = line.split(':')
    if (f.length < 4 || /^[#+-]/.test(f[0]!) || !/^\d{1,10}$/.test(f[2]!)) continue
    const uid = Number(f[2])
    const name = oneLineName(f[0]!, USER_MAX)
    if (name && uid <= 0xffff_ffff && !users.has(uid)) users.set(uid, name)
  }
  return users
}

const AT_NULL = 0
const AT_PAGESZ = 6
/** A word of this process's auxiliary vector is an `unsigned long`: 4 bytes where Node is a
 *  32-bit program, 8 everywhere else, in the processor's own byte order. */
const WORD_BYTES: 4 | 8 = ['arm', 'ia32', 'mips', 'mipsel', 'ppc', 's390'].includes(process.arch) ? 4 : 8

function littleEndian(): boolean {
  try {
    return os.endianness() === 'LE'
  } catch {
    return true
  }
}

/**
 * The page size from /proc/self/auxv: pairs of words, a key then its value, ending at AT_NULL;
 * AT_PAGESZ is key 6. Null unless the value is a power of two from 4 KiB to 1 MiB (4096 on x86
 * and most arm64, 16384 on Apple silicon, 65536 on some arm64 and POWER kernels).
 */
export function parseAuxvPageSize(bytes: unknown, wordBytes: 4 | 8 = WORD_BYTES, little = littleEndian()): number | null {
  if (!(bytes instanceof Uint8Array) || bytes.length > AUXV_MAX_BYTES) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const word = (at: number): number => (wordBytes === 8 ? Number(view.getBigUint64(at, little)) : view.getUint32(at, little))
  for (let at = 0; at + 2 * wordBytes <= bytes.length; at += 2 * wordBytes) {
    const key = word(at)
    if (key === AT_NULL) break
    if (key !== AT_PAGESZ) continue
    const size = word(at + wordBytes)
    return Number.isSafeInteger(size) && size >= 4096 && size <= 1024 * 1024 && (size & (size - 1)) === 0 ? size : null
  }
  return null
}

/** `btime` in /proc/stat: when the computer started, epoch seconds. */
export function parseBootTime(text: unknown, maxBytes = MAX_FILE_BYTES): number | null {
  if (typeof text !== 'string' || text.length > maxBytes) return null
  const match = /^btime\s+(\d{1,12})\s*$/m.exec(text)
  const seconds = match ? Number(match[1]) : 0
  return seconds > 0 ? seconds : null
}

/** `/proc/uptime`'s first figure, seconds since boot, in clock ticks: the clock a process's
 *  start time is on. Null when out of shape. */
export function parseUptimeTicks(text: unknown): number | null {
  if (typeof text !== 'string' || text.length > 256) return null
  const match = /^\s*(\d{1,12})(?:\.(\d{1,3}))?\s/.exec(text)
  if (!match) return null
  const ticks = Math.floor(Number(`${match[1]}.${match[2] ?? '0'}`) * CLOCK_TICKS_PER_SECOND)
  return Number.isSafeInteger(ticks) ? ticks : null
}

/** The kernel's short name with any directory dropped. An executable's own never has one; a
 *  process that named itself with a path keeps only what follows its last `/`. */
export function commName(comm: string): string {
  const slash = comm.lastIndexOf('/')
  return oneLineName(slash === -1 ? comm : comm.slice(slash + 1), NAME_MAX)
}

// --- a table from two readings ---------------------------------------------------------------

/** One process of a reading. */
export type ProcRow = {
  pid: number
  ppid: number
  /** Its executable's file name, or the kernel's short name where that cannot be read: never a
   *  directory or an argument. */
  name: string
  user: string | null
  /** Cumulative CPU time, user + system, in clock ticks. */
  cpuTicks: number
  /** When it started, in clock ticks after boot. */
  startTicks: number
  /** Start time, epoch seconds; null when the computer's boot time could not be read. */
  start: number | null
  /** Resident set size in bytes. */
  mem: number | null
}

/** `at` is monotonic ms and `wallAt` wall ms, both when the last process had been read.
 *  `sinceBootTicks` is how long the computer had been up when this reading began, in clock ticks
 *  (null when /proc/uptime could not be read): a process that started later than that was not
 *  there for this reading to see. */
export type ProcReading = { at: number; wallAt: number; rows: ProcRow[]; sinceBootTicks?: number | null }

/**
 * A table from a reading and the one before it, with src/processes.ts's rules for CPU %: two
 * readings at least 500 ms apart; a pid is the same process only when its start matches; a
 * process started since the last reading has all its CPU time shared over the whole window; never
 * more than every core; one decimal. Two things differ from a Mac's table. The window is measured
 * on the monotonic clock, so setting the wall clock between two readings cannot bend it. And
 * "started since the last reading" is decided by the start time, which is exact here: only a
 * process that started when the last reading began or later (the same clock tick counts: both
 * times are whole ticks). One that was already running then, but is
 * missing from that reading (its read failed), gets no CPU % rather than its whole life's CPU
 * time in one window; so does every unmatched process when the uptime could not be read.
 */
export function buildProcessTable(current: ProcReading, previous: ProcReading | null, cores = 0): ProcessTable {
  const windowMs = previous ? current.at - previous.at : null
  const usableWindow = windowMs !== null && windowMs >= MIN_CPU_WINDOW_MS ? windowMs : null
  const before = previous && usableWindow !== null ? new Map(previous.rows.map((r) => [r.pid, r])) : null
  const lastBegan = previous?.sinceBootTicks ?? null
  const maxCpu = Math.max(100, cores * 100)
  const msPerTick = 1000 / CLOCK_TICKS_PER_SECOND
  const rows: ProcessRow[] = current.rows.map((r) => {
    let cpu: number | null = null
    if (before && usableWindow !== null) {
      const old = before.get(r.pid)
      let ticks: number | null = null
      if (old && old.startTicks === r.startTicks) {
        if (r.cpuTicks >= old.cpuTicks) ticks = r.cpuTicks - old.cpuTicks
      } else if (lastBegan !== null && r.startTicks >= lastBegan) {
        // Started since the last reading: all its CPU time was used in this window, and is
        // shared over the whole window (not over its shorter life, which would make every young
        // process look busy).
        ticks = r.cpuTicks
      }
      if (ticks !== null) cpu = Math.round(Math.min(maxCpu, Math.max(0, (ticks * msPerTick * 100) / usableWindow)) * 10) / 10
    }
    return { pid: r.pid, ppid: r.ppid, name: r.name, user: r.user, cpu, mem: r.mem, energy: null, start: r.start }
  })
  return {
    takenAt: current.wallAt,
    rows,
    cpuWindowMs: usableWindow === null ? null : Math.round(usableWindow),
    // Memory comes from the same file as the CPU time, in the same pass.
    memAgeMs: 0,
    energyWindowMs: null,
    total: rows.length
  }
}

// --- the sampler -----------------------------------------------------------------------------

export type LinuxProcessSamplerDeps = {
  readFile?: ReadFile
  /** For /proc/self/auxv, which is not text. */
  readBytes?: (path: string) => Promise<Uint8Array | null>
  readDir?: ReadDir
  /** The uid that owns `path`, or null when it cannot be read (the process has gone). */
  statUid?: (path: string) => Promise<number | null>
  /** Where the link at `path` points, or null when it cannot be read. For /proc/<pid>/exe. */
  readLink?: (path: string) => Promise<string | null>
  timers?: Timers
  mono?: () => number
  wall?: () => number
  platform?: string
  cores?: () => number
}

const realStatUid = async (path: string): Promise<number | null> => {
  try {
    const { uid } = await statPath(path)
    return Number.isSafeInteger(uid) && uid >= 0 ? uid : null
  } catch {
    return null
  }
}

const realReadLink = async (path: string): Promise<string | null> => {
  try {
    return await readlink(path)
  } catch {
    return null
  }
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    handle.unref?.()
    return handle
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

/** What one process's step of a reading gives: `exe` is its executable's file name alone. */
type FoundProcess = { stat: ProcStat; uid: number | null; exe: string | null }

/**
 * This Linux computer's processes, read from /proc when asked and at most every LIST_CACHE_MS.
 * There is nothing to keep running between requests (a Mac's sampler keeps `top` streams), so
 * `setPublishing` and `stop` have nothing to start or end. Never throws; nothing is read on any
 * other platform.
 */
export class LinuxProcessSampler {
  private readonly readFile: ReadFile
  private readonly readBytes: (path: string) => Promise<Uint8Array | null>
  private readonly readDir: ReadDir
  private readonly statUid: (path: string) => Promise<number | null>
  private readonly readLink: (path: string) => Promise<string | null>
  private readonly timers: Timers
  private readonly mono: () => number
  private readonly wall: () => number
  private readonly platform: string
  private readonly cores: () => number
  private current: ProcReading | null = null
  private reading: Promise<ProcessTable | null> | null = null
  private table: { table: ProcessTable; at: number } | null = null
  private pageBytes: number | null = null
  private users: { byUid: Map<number, string>; at: number } | null = null
  private boot: { seconds: number | null; at: number } | null = null

  constructor(deps: LinuxProcessSamplerDeps = {}) {
    this.readFile = deps.readFile ?? ((path) => readTextBounded(path))
    this.readBytes = deps.readBytes ?? ((path) => readBytesBounded(path, AUXV_MAX_BYTES))
    this.readDir = deps.readDir ?? listDir
    this.statUid = deps.statUid ?? realStatUid
    this.readLink = deps.readLink ?? realReadLink
    this.timers = deps.timers ?? realTimers
    this.mono = deps.mono ?? (() => performance.now())
    this.wall = deps.wall ?? Date.now
    this.platform = deps.platform ?? process.platform
    this.cores = deps.cores ?? (() => 0)
  }

  get supported(): boolean {
    return this.platform === 'linux'
  }

  /** Nothing runs in the background here; the published list is read when it is asked for. */
  setPublishing(_on: boolean): void {}

  /** Every process on this computer, for a panel: /proc read at most every LIST_CACHE_MS. Null
   *  when /proc cannot be read. */
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

  /** Nothing to end: no child process and no stream. A reading under way finishes by itself. */
  stop(): void {}

  private tableNow(): Promise<ProcessTable | null> {
    const cached = this.table
    const now = this.mono()
    if (cached && now - cached.at < LIST_CACHE_MS && now >= cached.at) return Promise.resolve(cached.table)
    // One reading, shared by every caller while it runs.
    this.reading ??= this.readTable()
      .catch(() => null)
      .finally(() => {
        this.reading = null
      })
    return this.withDeadline(this.reading)
  }

  /** The reading's answer, or null once READ_DEADLINE_MS has passed. A reading that overruns is
   *  left to finish (later callers join it, each for no longer than the deadline) rather than
   *  have a second one start beside it. */
  private withDeadline(reading: Promise<ProcessTable | null>): Promise<ProcessTable | null> {
    return new Promise((resolve) => {
      const timer = this.timers.setTimeout(() => resolve(null), READ_DEADLINE_MS)
      void reading.then((table) => {
        this.timers.clearTimeout(timer)
        resolve(table)
      })
    })
  }

  private async readTable(): Promise<ProcessTable | null> {
    // Before the listing: whatever starts from here on is new to the next reading.
    const began = this.mono()
    const sinceBootTicks = parseUptimeTicks(await this.file(PROC_UPTIME_PATH))
    const pids = pidsOf(await this.dir(PROC_PATH)).slice(0, MAX_PIDS_READ)
    if (pids.length === 0) return null
    const [pageBytes, bootSeconds] = await Promise.all([this.pageBytesNow(), this.bootSecondsNow()])
    const found: FoundProcess[] = []
    for (let i = 0; i < pids.length && found.length < MAX_PROCESSES; i += READ_BATCH) {
      const batch = await Promise.all(pids.slice(i, i + READ_BATCH).map((pid) => this.readProcess(pid)))
      for (const one of batch) if (one && found.length < MAX_PROCESSES) found.push(one)
    }
    if (found.length === 0) return null
    const at = this.mono()
    const wallAt = this.wall()
    const users = await this.usersFor(found)
    const rows: ProcRow[] = found.map(({ stat, uid, exe }) => {
      const mem = stat.rssPages * pageBytes
      return {
        pid: stat.pid,
        ppid: stat.ppid,
        // The executable's file name; where it could not be read, the kernel's short name. A
        // process may give itself an empty one: its pid then stands in, as on a line from afar.
        name: exe ?? (commName(stat.comm) || String(stat.pid)),
        // An account /etc/passwd does not name (one from a directory service) shows as its uid.
        user: uid === null ? null : (users.get(uid) ?? String(uid)),
        cpuTicks: stat.cpuTicks,
        startTicks: stat.startTicks,
        start: bootSeconds === null ? null : bootSeconds + Math.floor(stat.startTicks / CLOCK_TICKS_PER_SECOND),
        mem: Number.isSafeInteger(mem) ? mem : null
      }
    })
    // The uptime only helps if it is on the clock the start times are on. Under LXCFS it is the
    // container's age while a process's start stays counted from the host's boot, and then every
    // process seems to have started in the future: the uptime is not used.
    const passTicks = Math.ceil((at - began) / (1000 / CLOCK_TICKS_PER_SECOND)) + CLOCK_TICKS_PER_SECOND
    const sameClock = sinceBootTicks !== null && rows.every((r) => r.startTicks <= sinceBootTicks + passTicks)
    const reading: ProcReading = { at, wallAt, rows, sinceBootTicks: sameClock ? sinceBootTicks : null }
    const table = buildProcessTable(reading, this.current, safeCores(this.cores))
    this.current = reading
    this.table = { table, at }
    return table
  }

  /** One process, or null: a kernel thread, or one that ended between the listing of /proc and
   *  this read (its file is gone, or cut short), which is simply not in the list. Its owner and
   *  its executable's name are asked for side by side, in this same step, so a process takes one
   *  place in its batch from start to end. */
  private async readProcess(pid: number): Promise<FoundProcess | null> {
    const stat = parseProcStat(await this.file(`${PROC_PATH}/${pid}/stat`))
    if (!stat || stat.pid !== pid || isKernelThread(stat)) return null
    const [uid, exe] = await Promise.all([this.ownerOf(pid), this.exeNameOf(pid)])
    return { stat, uid, exe }
  }

  private async ownerOf(pid: number): Promise<number | null> {
    try {
      const uid = await this.statUid(`${PROC_PATH}/${pid}`)
      return typeof uid === 'number' && Number.isSafeInteger(uid) && uid >= 0 ? uid : null
    } catch {
      return null
    }
  }

  /** The file name of the process's executable, or null where its link cannot be read. The
   *  link's target goes straight into exeName and nowhere else: only the file name comes out of
   *  this method, so no directory can reach a row, a log line or the list that is published. */
  private async exeNameOf(pid: number): Promise<string | null> {
    try {
      return exeName(await this.readLink(`${PROC_PATH}/${pid}/exe`))
    } catch {
      return null
    }
  }

  private async file(path: string): Promise<string | null> {
    try {
      const text = await this.readFile(path)
      return typeof text === 'string' ? text : null
    } catch {
      return null
    }
  }

  private async dir(path: string): Promise<string[] | null> {
    try {
      const names = await this.readDir(path)
      return Array.isArray(names) ? names : null
    } catch {
      return null
    }
  }

  /** The page size, kept once read. Until it can be, the usual 4 KiB stands in. */
  private async pageBytesNow(): Promise<number> {
    if (this.pageBytes === null) {
      try {
        this.pageBytes = parseAuxvPageSize(await this.readBytes(AUXV_PATH))
      } catch {
        this.pageBytes = null
      }
    }
    return this.pageBytes ?? FALLBACK_PAGE_BYTES
  }

  /** When the computer started, epoch seconds, read again once it is a minute old. A read that
   *  fails keeps the last one known. */
  private async bootSecondsNow(): Promise<number | null> {
    const now = this.mono()
    const known = this.boot
    if (known && known.seconds !== null && now - known.at < BOOT_TIME_MAX_AGE_MS && now >= known.at) return known.seconds
    const seconds = parseBootTime(await this.file(PROC_STAT_PATH)) ?? known?.seconds ?? null
    this.boot = { seconds, at: now }
    return seconds
  }

  /** Account names by uid: /etc/passwd read once and kept, and read again, at most once a
   *  minute, when a process belongs to a uid it did not name (an account added since). A read
   *  that fails keeps the names already known. */
  private async usersFor(found: readonly { uid: number | null }[]): Promise<Map<number, string>> {
    const now = this.mono()
    const known = this.users
    const stale = known !== null && (now - known.at >= PASSWD_RETRY_MS || now < known.at)
    if (!known || (stale && found.some(({ uid }) => uid !== null && !known.byUid.has(uid)))) {
      const read = parsePasswd(await this.file(PASSWD_PATH))
      this.users = { byUid: read ?? known?.byUid ?? new Map<number, string>(), at: now }
    }
    return this.users!.byUid
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
