// A time-windowed ring of { t, cpu, mem } points, oldest first.
import type { ExtraHistoryKey, HistoryColumns, HistoryPoint } from './model.ts'

export const HISTORY_WINDOW_MS = 30 * 60_000
/** Hard cap so a tiny fast interval cannot grow the ring without bound. */
export const HISTORY_MAX_POINTS = 1_200

export class HistoryRing {
  private points: HistoryPoint[] = []
  private readonly windowMs: number
  private readonly maxPoints: number

  constructor(windowMs = HISTORY_WINDOW_MS, maxPoints = HISTORY_MAX_POINTS) {
    this.windowMs = windowMs
    this.maxPoints = maxPoints
  }

  get size(): number {
    return this.points.length
  }

  all(): HistoryPoint[] {
    return this.points.slice()
  }

  last(): HistoryPoint | null {
    return this.points[this.points.length - 1] ?? null
  }

  /**
   * Adds a point. One closer than `minSpacingMs` to the newest replaces it; one older than the
   * newest is inserted in time order (backfill), unless it lands within `minSpacingMs` of a
   * neighbour. Returns whether the ring changed.
   */
  add(point: HistoryPoint, now: number, minSpacingMs = 1_000): boolean {
    if (!Number.isFinite(point.t) || point.t < now - this.windowMs || point.t > now + 60_000) {
      return false
    }
    const newest = this.last()
    if (!newest || point.t > newest.t) {
      if (newest && point.t - newest.t < minSpacingMs) {
        this.points[this.points.length - 1] = point
      } else {
        this.points.push(point)
      }
    } else {
      let index = this.points.findIndex((p) => p.t > point.t)
      if (index === -1) index = this.points.length
      const before = this.points[index - 1]
      const after = this.points[index]
      if (
        (before && point.t - before.t < minSpacingMs) ||
        (after && after.t - point.t < minSpacingMs)
      ) {
        return false
      }
      this.points.splice(index, 0, point)
    }
    this.trim(now)
    return true
  }

  trim(now: number): void {
    const cutoff = now - this.windowMs
    let drop = 0
    while (drop < this.points.length && this.points[drop]!.t < cutoff) drop += 1
    if (this.points.length - drop > this.maxPoints) drop = this.points.length - this.maxPoints
    if (drop > 0) this.points.splice(0, drop)
  }

  /**
   * Adds a point only where the ring has none within `spacingMs` of it, in time order; never
   * replaces or moves one. For filling gaps (a back-fill from older beacons), which must not
   * overwrite readings already taken. Returns whether it was added.
   */
  insertMissing(point: HistoryPoint, now: number, spacingMs: number): boolean {
    if (!Number.isFinite(point.t) || point.t < now - this.windowMs || point.t > now + 60_000) {
      return false
    }
    let index = this.points.findIndex((p) => p.t > point.t)
    if (index === -1) index = this.points.length
    const before = this.points[index - 1]
    const after = this.points[index]
    if ((before && point.t - before.t < spacingMs) || (after && after.t - point.t < spacingMs)) {
      return false
    }
    this.points.splice(index, 0, point)
    this.trim(now)
    return true
  }

  /** Points newer than `t` (exclusive). */
  since(t: number): HistoryPoint[] {
    return this.points.filter((p) => p.t > t)
  }
}

/** The history keys added in 1.2: network (`rx`, `tx`) and disk (`dr`, `dw`) bytes per second,
 *  GPU % and battery %. Each is in a machine's columns only when some point has it. */
export const EXTRA_HISTORY_KEYS: readonly ExtraHistoryKey[] = ['rx', 'tx', 'dr', 'dw', 'gpu', 'bat']
/** Bytes per second are kept whole; percentages to one decimal. */
const WHOLE_KEYS: ReadonlySet<ExtraHistoryKey> = new Set(['rx', 'tx', 'dr', 'dw'])

/** Columns of the points. `ram` (RAM in use, from a Mac's own reading) and the 1.2 columns are
 *  there only when some point has them, so a machine without them sends what it always did. */
export function toColumns(points: readonly HistoryPoint[]): HistoryColumns {
  const round = (value: number | null | undefined): number | null =>
    value === null || value === undefined ? null : Math.round(value * 10) / 10
  const whole = (value: number | null | undefined): number | null => (value === null || value === undefined ? null : Math.round(value))
  const columns: HistoryColumns = {
    t: points.map((p) => p.t),
    cpu: points.map((p) => round(p.cpu)),
    mem: points.map((p) => round(p.mem))
  }
  if (points.some((p) => typeof p.ram === 'number')) columns.ram = points.map((p) => round(p.ram))
  for (const key of EXTRA_HISTORY_KEYS) {
    if (!points.some((p) => typeof p[key] === 'number')) continue
    const fit = WHOLE_KEYS.has(key) ? whole : round
    columns[key] = points.map((p) => fit(p[key]))
  }
  return columns
}

/** Every `step`-th point, newest kept, to shrink a snapshot that would be too large. */
export function downsample(columns: HistoryColumns, step: number): HistoryColumns {
  if (step <= 1) return columns
  const keep = (_: unknown, i: number, arr: readonly unknown[]): boolean => (arr.length - 1 - i) % step === 0
  const out: HistoryColumns = { t: columns.t.filter(keep), cpu: columns.cpu.filter(keep), mem: columns.mem.filter(keep) }
  if (columns.ram) out.ram = columns.ram.filter(keep)
  for (const key of EXTRA_HISTORY_KEYS) {
    const column = columns[key]
    if (column) out[key] = column.filter(keep)
  }
  return out
}

/** The columns without the 1.2 ones: what a snapshot that is too large sheds first. */
export function coreColumns(columns: HistoryColumns): HistoryColumns {
  const out: HistoryColumns = { t: columns.t, cpu: columns.cpu, mem: columns.mem }
  if (columns.ram) out.ram = columns.ram
  return out
}
