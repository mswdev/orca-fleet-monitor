// The process line: a Mac's top processes, one log line about every 30 s, read back by a paired
// desktop from the same `orca plugin logs` answer as the beacons. It has a prefix of its own, so a
// beacon reader (Fleet Monitor 1.0 and 1.1 included) skips it.
//
// Sized to leave the beacons room in Orca's 200-line log: at one process line per six beacons,
// the log still holds about 14 minutes of beacons, so a desktop back-fills at least 10 minutes of
// history. Each line stays under PROCESS_MAX_CHARS (Orca cuts a line at 8192 characters).
//
// Wire (version 1):
//   FLEETPS1 {"v":1,"r":run,"q":seq,"t":epoch ms,"iv":interval ms,"n":processes on the machine,
//             "cw":CPU window ms,"ma":memory age ms,"ew":energy window ms,"u":[user names],
//             "p":[[pid, ppid, user index, name, CPU % ×10, footprint KiB, energy ×10, start s]]}
//   Unknown figures are null; a user index of -1 means none. Readers take any extra entries in a
//   row for later additions and ignore them.
import { clipText, COUNT_LIMITS, lastEntries } from './bounds.ts'
import type { ProcessRow } from './model.ts'
import { oneLineName, selectTop, type ProcessTable } from './processes.ts'

export const PROCESS_PREFIX = 'FLEETPS1 '
export const PROCESS_VERSION = 1
export const PROCESS_MAX_CHARS = 6_000
export const PROCESS_INTERVAL_MS = 30_000
export const PROCESS_TOP = { byMemory: 40, byCpu: 20 } as const
/** Names on the wire; the panel shows about this much anyway. */
const WIRE_NAME_MAX = 48
const SHORT_NAME_MAX = 24
/** What a reader keeps of another machine's line. */
export const MAX_WIRE_ROWS = 100
const MAX_USERS = 16
/** Epoch ms: 2286. */
const MAX_TIME_MS = 1e13
const NAME_MAX = 64
const USER_MAX = 32

type WireRow = [number, number | null, number, string, number | null, number | null, number | null, number | null]
type Wire = { v: number; r: string; q: number; t: number; iv: number; n: number; cw?: number; ma?: number; ew?: number; u: string[]; p: WireRow[] }

export type ProcessRecord = {
  run: string
  seq: number
  /** The remote's clock, epoch ms. */
  t: number
  intervalMs: number
  total: number | null
  cpuWindowMs: number | null
  memAgeMs: number | null
  energyWindowMs: number | null
  rows: ProcessRow[]
  /** When the remote Orca appended the line (remote clock). */
  loggedAt: number
}

const opt = <K extends string>(key: K, value: number | null): { [P in K]?: number } => (value === null ? {} : { [key]: Math.round(value) }) as { [P in K]?: number }

/** The process line for a table: its top list, or null when even a trimmed one will not fit. */
export function encodeProcessLine(table: ProcessTable, meta: { run: string; seq: number; intervalMs: number }, maxChars = PROCESS_MAX_CHARS): string | null {
  const rows = selectTop(table.rows, PROCESS_TOP.byMemory, PROCESS_TOP.byCpu)
  const users: string[] = []
  const userIndex = (user: string | null): number => {
    if (user === null) return -1
    let i = users.indexOf(user)
    if (i === -1 && users.length < MAX_USERS) i = users.push(user) - 1
    return i
  }
  const wireRows = (nameMax: number): WireRow[] =>
    rows.map((r) => [
      r.pid,
      r.ppid,
      userIndex(r.user === null ? null : clipText(r.user, USER_MAX)),
      clipText(r.name, nameMax),
      r.cpu === null ? null : Math.round(r.cpu * 10),
      r.mem === null ? null : Math.round(r.mem / 1024),
      r.energy === null ? null : Math.round(r.energy * 10),
      r.start
    ])
  const head = {
    v: PROCESS_VERSION,
    r: meta.run.slice(0, 16),
    q: meta.seq,
    t: table.takenAt,
    iv: meta.intervalMs,
    n: table.total,
    ...opt('cw', table.cpuWindowMs),
    ...opt('ma', table.memAgeMs),
    ...opt('ew', table.energyWindowMs)
  }
  const line = (p: WireRow[]): string => PROCESS_PREFIX + JSON.stringify({ ...head, u: users, p } satisfies Wire)
  for (const nameMax of [WIRE_NAME_MAX, SHORT_NAME_MAX]) {
    users.length = 0
    const p = wireRows(nameMax)
    let text = line(p)
    if (text.length <= maxChars) return text
    if (nameMax === SHORT_NAME_MAX) {
      // Still too long (names in a script JSON escapes, say): the least used go first.
      for (let keep = p.length - 1; keep >= 1; keep -= 1) {
        text = line(p.slice(0, keep))
        if (text.length <= maxChars) return text
      }
    }
  }
  return null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function intIn(value: unknown, min: number, max: number): number | null {
  const n = num(value)
  return n !== null && Number.isInteger(n) && n >= min && n <= max ? n : null
}

/** A process line from another machine, every value bounded, or null for anything that is not a
 *  whole, valid one. A row out of shape is skipped, and so is a second row for a pid. */
export function decodeProcessLine(line: unknown, loggedAt: number | null = null): ProcessRecord | null {
  if (typeof line !== 'string' || !line.startsWith(PROCESS_PREFIX) || line.length > 8192) return null
  let raw: unknown
  try {
    raw = JSON.parse(line.slice(PROCESS_PREFIX.length))
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const w = raw as Record<string, unknown>
  const seq = intIn(w.q, 0, Number.MAX_SAFE_INTEGER)
  const t = num(w.t)
  const iv = num(w.iv)
  // A time outside 1970 to 2286 is no reading: the line is refused, as for any other field.
  if (w.v !== PROCESS_VERSION || typeof w.r !== 'string' || seq === null || t === null || t < 0 || t > MAX_TIME_MS || iv === null || iv <= 0 || !Array.isArray(w.p)) return null
  const users = (Array.isArray(w.u) ? w.u.slice(0, MAX_USERS) : []).map((u) => (typeof u === 'string' ? oneLineName(u, USER_MAX) : null))
  const rows: ProcessRow[] = []
  const seen = new Set<number>()
  for (const entry of w.p.slice(0, MAX_WIRE_ROWS)) {
    if (!Array.isArray(entry) || entry.length < 8) continue
    const pid = intIn(entry[0], 0, 2 ** 31)
    if (pid === null || seen.has(pid) || typeof entry[3] !== 'string') continue
    seen.add(pid)
    const userAt = intIn(entry[2], 0, MAX_USERS - 1)
    const cpu = num(entry[4])
    const memKiB = num(entry[5])
    const energy = num(entry[6])
    const name = oneLineName(entry[3], NAME_MAX) || String(pid)
    rows.push({
      pid,
      ppid: intIn(entry[1], 0, 2 ** 31),
      name,
      user: userAt === null ? null : (users[userAt] ?? null),
      cpu: cpu === null || cpu < 0 ? null : Math.min(1_000_000, cpu) / 10,
      mem: memKiB === null || memKiB < 0 ? null : Math.min(2 ** 42, Math.round(memKiB)) * 1024,
      energy: energy === null || energy < 0 ? null : Math.min(10_000_000, energy) / 10,
      start: intIn(entry[7], 0, 1e11)
    })
  }
  const window = (value: unknown, max: number): number | null => {
    const n = num(value)
    return n === null || n < 0 ? null : Math.min(max, Math.round(n))
  }
  return {
    run: clipText(w.r, 16),
    seq,
    t,
    intervalMs: Math.min(600_000, Math.max(1_000, iv)),
    total: intIn(w.n, 0, 10_000_000),
    cpuWindowMs: window(w.cw, 3_600_000),
    memAgeMs: window(w.ma, 3_600_000),
    energyWindowMs: window(w.ew, 3_600_000),
    rows,
    loggedAt: loggedAt ?? t
  }
}

/** The newest process line in a `plugin logs` answer: the last in log order, and within its run
 *  the highest sequence (as for beacons, so a remote clock set back cannot make an old one look
 *  new). */
export function readProcessLog(lines: readonly unknown[]): ProcessRecord | null {
  let latest: ProcessRecord | null = null
  const all: ProcessRecord[] = []
  for (const entry of lastEntries(lines, COUNT_LIMITS.logLines)) {
    if (!entry || typeof entry !== 'object') continue
    const { line, ts } = entry as { line?: unknown; ts?: unknown }
    if (typeof line !== 'string' || !line.startsWith(PROCESS_PREFIX)) continue
    const record = decodeProcessLine(line, num(ts))
    if (record) {
      all.push(record)
      latest = record
    }
  }
  for (const record of all) {
    if (latest && record.run === latest.run && record.seq > latest.seq) latest = record
  }
  return latest
}
