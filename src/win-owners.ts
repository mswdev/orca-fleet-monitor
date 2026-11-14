// Who each Windows process belongs to, as Task Manager's "User name" column has it, without
// elevation: `qprocess *` (query process), which asks the Remote Desktop Services API and lists
// every process with its user, session, session id, pid and image name. Only the user and the pid
// are kept; nothing else of the line is used. It reads no command line or window title.
//
//   USERNAME              SESSIONNAME         ID    PID  IMAGE
//  >(unknown)             services             0      4  system
//  >system                services             0    472  registry
//   local service         services             0   2196  svchost.exe
//   matt                  rdp-tcp#0            2  22548  wavebox.exe
//
// The user is the first 22 characters after the marker column; the session name has no spaces and
// may be blank, so the pid is the second number after it. qprocess writes user names in lower case,
// so the system's accounts and this user are given back the capitals Task Manager shows. It is run
// at most every OWNER_REFRESH_MS, and sooner only when a process started after the last run (a new
// process, or a pid that changed hands), never more often than OWNER_MIN_GAP_MS. Where qprocess is
// missing (it ships with the Remote Desktop tools, not every edition) or cannot be started, there
// are no owners, and it is tried again after OWNER_RETRY_MS. A run that fails or takes too long
// keeps the owners already known, and the next is at the usual cadence; what a run cut short
// printed is not used.
//
// Cost: about 40 ms for 430 processes on a desktop.
import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { systemRoot } from './win-host.ts'

export const OWNER_REFRESH_MS = 10_000
export const OWNER_MIN_GAP_MS = 2_000
export const OWNER_RETRY_MS = 60 * 60_000
/** How long one run may take before it is given up on (and the list goes on without owners). */
export const OWNER_TIMEOUT_MS = 3_000
/** Longest output read: about 100 characters a process. */
const OUTPUT_MAX = 2 * 1024 * 1024
const USER_COLUMNS = 22
/** qprocess cuts a user name to 20 characters and pads it with spaces to its 22: two characters
 *  that are not spaces there mean a line laid out otherwise, which is skipped. */
const USER_SPACE = 2
const USER_MAX = 32

/** The accounts Windows names in capitals (Task Manager shows them so). */
const WELL_KNOWN: Record<string, string> = { system: 'SYSTEM', 'local service': 'LOCAL SERVICE', 'network service': 'NETWORK SERVICE' }

/** A user name as qprocess prints it (lower case), as Task Manager shows it; null for none. */
export function ownerName(raw: string, me: string | null): string | null {
  const name = raw.trim()
  // "(unknown)", or what a Windows in another language says instead.
  if (name === '' || /^\(.*\)$/.test(name) || /[^\x20-\x7e]/.test(name) || name.length > USER_MAX) return null
  const lower = name.toLowerCase()
  if (Object.hasOwn(WELL_KNOWN, lower)) return WELL_KNOWN[lower]!
  // Window Manager and font driver accounts, one a session: dwm-2, umfd-0.
  if (/^(dwm|umfd)-\d+$/.test(lower)) return lower.toUpperCase()
  if (me !== null && lower === me.toLowerCase()) return me
  return name
}

/** Every pid's user in qprocess's output; a line out of shape is skipped. */
export function parseQprocess(text: string, me: string | null): Map<number, string> {
  const owners = new Map<number, string>()
  const lines = text.split(/\r?\n/)
  for (const line of lines.slice(1)) {
    if (line.length <= USER_COLUMNS + 1 || line.slice(1 + USER_COLUMNS - USER_SPACE, 1 + USER_COLUMNS).trim() !== '') continue
    const user = ownerName(line.slice(1, 1 + USER_COLUMNS), me)
    const rest = line.slice(1 + USER_COLUMNS).trim().split(/\s+/)
    // Session name, session id, pid; or, with no session name, session id and pid.
    const pidText = /^\d+$/.test(rest[0] ?? '') && /^\d+$/.test(rest[1] ?? '') ? rest[1] : rest[2]
    if (pidText === undefined || !/^\d{1,10}$/.test(pidText)) continue
    const pid = Number(pidText)
    if (user !== null && pid > 0) owners.set(pid, user)
  }
  return owners
}

/** What one run of qprocess came to: its whole output; `missing` when it could not be started
 *  (not on this Windows, or not this user's to run); `failed` when it ended badly or too late. */
export type QprocessRun = { output: string } | 'missing' | 'failed'
export type RunQprocess = () => Promise<QprocessRun>

function realRun(env: NodeJS.ProcessEnv): RunQprocess {
  const file = path.win32.join(systemRoot(env), 'System32', 'qprocess.exe')
  return () =>
    new Promise((resolve) => {
      execFile(file, ['*'], { windowsHide: true, timeout: OWNER_TIMEOUT_MS, maxBuffer: OUTPUT_MAX, encoding: 'latin1', env }, (error, stdout) => {
        const code = (error as NodeJS.ErrnoException | null)?.code
        if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') resolve('missing')
        else if (error) resolve('failed')
        else resolve({ output: typeof stdout === 'string' ? stdout : '' })
      })
    })
}

/**
 * The owners of this computer's processes, for the process list (src/win-processes.ts). `lookup`
 * never throws and never waits longer than OWNER_TIMEOUT_MS; whatever is known stays known.
 */
export class WindowsOwners {
  private readonly run: RunQprocess
  private readonly mono: () => number
  private readonly wall: () => number
  private readonly me: string | null
  private owners: Map<number, string> = new Map()
  /** When qprocess was last run (steady clock, for the cadence), and when the owners now known
   *  were read (wall clock, against processes' start times). */
  private triedAt = Number.NEGATIVE_INFINITY
  private readWall = Number.NEGATIVE_INFINITY
  /** When qprocess could not be started: not tried again for OWNER_RETRY_MS. */
  private missingAt = Number.NEGATIVE_INFINITY
  private running: Promise<void> | null = null

  constructor(deps: { run?: RunQprocess; mono?: () => number; wall?: () => number; me?: string | null; env?: NodeJS.ProcessEnv } = {}) {
    this.run = deps.run ?? realRun(deps.env ?? process.env)
    this.mono = deps.mono ?? (() => performance.now())
    this.wall = deps.wall ?? Date.now
    let me = deps.me
    if (me === undefined) {
      try {
        me = os.userInfo().username
      } catch {
        me = null
      }
    }
    this.me = me
  }

  /** Each process's owner, reading them again when they are due, and when they were read (epoch
   *  ms, when the run began): a process that started later may not be in them. `newestStart` is
   *  when the newest process in the list started (epoch seconds), so one newer than the last read
   *  is found. */
  async lookup(newestStart: number | null): Promise<{ owners: ReadonlyMap<number, string>; readAt: number }> {
    const now = this.mono()
    if (!(now - this.missingAt < OWNER_RETRY_MS && now >= this.missingAt)) {
      const stale = now - this.triedAt >= OWNER_REFRESH_MS || now < this.triedAt
      const newer = newestStart !== null && newestStart * 1000 > this.readWall - 1_000 && now - this.triedAt >= OWNER_MIN_GAP_MS
      if (stale || newer) await this.read()
    }
    return { owners: this.owners, readAt: this.readWall }
  }

  private read(): Promise<void> {
    this.running ??= (async () => {
      const wall = this.wall()
      this.triedAt = this.mono()
      let run: QprocessRun = 'failed'
      try {
        run = await this.run()
      } catch {
        run = 'failed'
      }
      if (run === 'missing') {
        this.missingAt = this.mono()
        this.owners = new Map()
        return
      }
      // A run that failed keeps what is known; the next comes at the usual cadence.
      const owners = run === 'failed' ? null : parseQprocess(run.output, this.me)
      if (!owners || owners.size === 0) return
      this.owners = owners
      this.readWall = wall
    })().finally(() => {
      this.running = null
    })
    return this.running
  }
}
