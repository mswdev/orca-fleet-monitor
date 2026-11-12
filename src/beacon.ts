// The beacon: one compact log line per interval that a paired desktop reads back with
// `orca plugin logs <key> --environment <id> --json`.
//
// Compatibility: the version stays 1 for as long as fields are only added. A reader ignores keys
// it does not know, and every key added after the first release (`cg`) is optional, so an older
// Fleet Monitor on either side keeps working.
import { COUNT_LIMITS, lastEntries } from './bounds.ts'
import { groupsFit } from './core-groups.ts'
import type { BeaconRecord, CoreGroup, LocalSample } from './model.ts'

export const BEACON_PREFIX = 'FLEETMON1 '
export const BEACON_VERSION = 1
/** Orca cuts a worker log line at 8192 characters without saying so; stay well under that. */
export const BEACON_MAX_CHARS = 4096
export const BEACON_INTERVAL_MS = 5_000
/** A beacon older than this many intervals is stale. */
export const BEACON_STALE_INTERVALS = 3
const TEXT_LIMIT = 96

type Wire = {
  v: number
  r: string
  q: number
  t: number
  iv: number
  h: string
  p: string
  a: string
  rl: string
  m: string
  n: number
  u: number
  c: number | null
  pc?: number[]
  /** Core groups over `pc`: [kind, start, count], kind `P` (performance) or `E` (efficiency). */
  cg?: [string, number, number][]
  mt: number
  mf: number
  l: [number, number, number]
}

const WIRE_KIND: Record<CoreGroup['kind'], string> = { performance: 'P', efficiency: 'E' }

/** Only the two literal wire kinds. A lookup in a plain object would also find `constructor`,
 *  `toString` and the rest of Object.prototype, and put a function into the model. */
function kindOfWire(value: unknown): CoreGroup['kind'] | null {
  if (value === 'P') return 'performance'
  if (value === 'E') return 'efficiency'
  return null
}

/** Bounds on what a beacon may claim. Every value Fleet Monitor itself writes is inside them. */
const MAX_CORES = 4_096
/** A 4096-character line holds at most about 2,000 per-core values ("0,0,..."). */
const MAX_PER_CORE = 2_048
const MAX_UPTIME_SEC = 100 * 365 * 86_400
const MAX_MEMORY_BYTES = 2 ** 52
const MAX_LOAD = 1_000_000
/** Freshness is judged in intervals, so a beacon cannot claim one long enough to stay fresh for
 *  hours. Fleet Monitor writes every 5 s. */
const MIN_INTERVAL_MS = 1_000
const MAX_INTERVAL_MS = 60_000

function encodeGroups(groups: readonly CoreGroup[] | null | undefined, cores: number): [string, number, number][] | undefined {
  if (!groups || !groupsFit(groups, cores)) return undefined
  return groups.map((g) => [WIRE_KIND[g.kind], g.start, g.count])
}

function decodeGroups(raw: unknown, cores: number): CoreGroup[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 4) return null
  const groups: CoreGroup[] = []
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length !== 3) return null
    const kind = kindOfWire(entry[0])
    const start = entry[1]
    const count = entry[2]
    if (!kind || typeof start !== 'number' || typeof count !== 'number') return null
    groups.push({ kind, start, count })
  }
  return groupsFit(groups, cores) ? groups : null
}

const round1 = (value: number): number => Math.round(value * 10) / 10
const round2 = (value: number): number => Math.round(value * 100) / 100
const clip = (text: string, max: number): string => (text.length > max ? text.slice(0, max) : text)

/** One beacon line for `orca.log`, or null when even the trimmed form will not fit. */
export function encodeBeacon(
  sample: LocalSample,
  meta: { run: string; seq: number; intervalMs: number },
  maxChars = BEACON_MAX_CHARS
): string | null {
  const wire: Wire = {
    v: BEACON_VERSION,
    r: clip(meta.run, 16),
    q: meta.seq,
    t: sample.t,
    iv: meta.intervalMs,
    h: clip(sample.hostname, 255),
    p: clip(sample.platform, 32),
    a: clip(sample.arch, 32),
    rl: clip(sample.release, 64),
    m: clip(sample.cpuModel, 128),
    n: sample.cores,
    u: sample.uptimeSec,
    c: sample.cpu ? round1(sample.cpu.total) : null,
    ...(sample.cpu ? { pc: sample.cpu.perCore.map((value) => Math.round(value)) } : {}),
    ...(sample.cpu ? { cg: encodeGroups(sample.coreGroups, sample.cpu.perCore.length) } : {}),
    mt: sample.memory.total,
    mf: sample.memory.free,
    l: [round2(sample.load[0]), round2(sample.load[1]), round2(sample.load[2])]
  }
  // Degrade in steps: per-core values (and the groups over them) first, then long free-text fields.
  const attempts: Wire[] = [
    wire,
    { ...wire, pc: undefined, cg: undefined },
    { ...wire, pc: undefined, cg: undefined, h: clip(wire.h, TEXT_LIMIT), m: clip(wire.m, TEXT_LIMIT), rl: clip(wire.rl, 32) }
  ]
  for (const attempt of attempts) {
    const line = BEACON_PREFIX + JSON.stringify(attempt)
    if (line.length <= maxChars) {
      return line
    }
  }
  return null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function str(value: unknown, max = 255): string | null {
  return typeof value === 'string' ? clip(value, max) : null
}

/** A beacon from one log line, or null for anything that is not a whole, valid beacon. */
export function decodeBeacon(line: unknown, loggedAt: number | null = null): BeaconRecord | null {
  if (typeof line !== 'string' || !line.startsWith(BEACON_PREFIX) || line.length > 8192) {
    return null
  }
  let raw: unknown
  try {
    raw = JSON.parse(line.slice(BEACON_PREFIX.length))
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }
  const w = raw as Record<string, unknown>
  if (w.v !== BEACON_VERSION) {
    return null
  }
  const seq = num(w.q)
  const t = num(w.t)
  const iv = num(w.iv)
  const cores = num(w.n)
  const memTotal = num(w.mt)
  const memFree = num(w.mf)
  const run = str(w.r, 16)
  if (
    seq === null ||
    !Number.isSafeInteger(seq) ||
    seq < 0 ||
    t === null ||
    iv === null ||
    iv <= 0 ||
    cores === null ||
    cores < 1 ||
    memTotal === null ||
    memFree === null ||
    run === null
  ) {
    return null
  }
  const clamp = (value: number, max: number): number => Math.min(max, Math.max(0, value))
  const load = Array.isArray(w.l) ? w.l.slice(0, 3).map((value) => clamp(num(value) ?? 0, MAX_LOAD)) : []
  const cpu = w.c === null ? null : num(w.c)
  const perCore =
    Array.isArray(w.pc) && w.pc.length <= MAX_PER_CORE && w.pc.every((value) => num(value) !== null)
      ? (w.pc as number[]).map((value) => Math.min(100, Math.max(0, value)))
      : null
  const total = clamp(memTotal, MAX_MEMORY_BYTES)
  return {
    run,
    seq,
    t,
    intervalMs: Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, iv)),
    hostname: str(w.h) ?? '',
    platform: str(w.p, 32) ?? '',
    arch: str(w.a, 32) ?? '',
    release: str(w.rl, 64) ?? '',
    cpuModel: str(w.m, 128) ?? '',
    cores: Math.min(MAX_CORES, Math.round(cores)),
    uptimeSec: Math.round(clamp(num(w.u) ?? 0, MAX_UPTIME_SEC)),
    cpu: cpu === null ? null : Math.min(100, Math.max(0, cpu)),
    perCore,
    memTotal: total,
    memFree: Math.min(total, Math.max(0, memFree)),
    load: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0],
    coreGroups: perCore ? decodeGroups(w.cg, perCore.length) : null,
    loggedAt: loggedAt ?? t
  }
}

/** Every beacon in a `plugin logs` answer, oldest first. Lines from older worker runs are kept;
 *  ordering is by the remote's log time, then by sequence. */
export function readBeacons(lines: readonly unknown[]): BeaconRecord[] {
  const records: BeaconRecord[] = []
  for (const entry of lastEntries(lines, COUNT_LIMITS.logLines)) {
    if (!entry || typeof entry !== 'object') {
      continue
    }
    const { line, ts } = entry as { line?: unknown; ts?: unknown }
    const record = decodeBeacon(line, num(ts))
    if (record) {
      records.push(record)
    }
  }
  return records.sort((a, b) => a.loggedAt - b.loggedAt || a.t - b.t || a.seq - b.seq)
}

export type BeaconTracker = {
  run: string | null
  seq: number | null
  /** Local clock, when the newest beacon last moved forward. */
  advancedAt: number | null
}

export type BeaconAssessment = {
  fresh: boolean
  ageMs: number | null
  restarted: boolean
  advanced: boolean
  tracker: BeaconTracker
}

/**
 * Is the newest beacon current? Judged on the remote's own clock when `remoteNow` is known (from
 * the remote's diagnostics `collectedAt`), and otherwise by whether its sequence keeps moving on
 * the local clock. Either test failing makes it stale.
 */
export function assessBeacon(
  latest: BeaconRecord | null,
  tracker: BeaconTracker,
  context: { localNow: number; remoteNow: number | null; staleIntervals?: number }
): BeaconAssessment {
  if (!latest) {
    return { fresh: false, ageMs: null, restarted: false, advanced: false, tracker }
  }
  const limit = Math.max(latest.intervalMs, 1_000) * (context.staleIntervals ?? BEACON_STALE_INTERVALS)
  const restarted = tracker.run !== null && tracker.run !== latest.run
  const advanced = restarted || tracker.seq === null || latest.seq > tracker.seq
  const next: BeaconTracker = advanced
    ? { run: latest.run, seq: latest.seq, advancedAt: context.localNow }
    : tracker
  const ageMs = context.remoteNow === null ? null : Math.max(0, context.remoteNow - latest.t)
  const stalledFor = next.advancedAt === null ? 0 : context.localNow - next.advancedAt
  const freshByClock = ageMs === null ? true : ageMs <= limit
  // The first sighting cannot show movement; let the remote clock decide it.
  const freshByMovement = stalledFor <= limit
  const firstSighting = tracker.seq === null
  const fresh = ageMs === null && firstSighting ? false : freshByClock && freshByMovement
  return { fresh, ageMs, restarted, advanced, tracker: next }
}

export function emptyTracker(): BeaconTracker {
  return { run: null, seq: null, advancedAt: null }
}
