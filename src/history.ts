// A time-windowed ring of { t, cpu, mem } points, oldest first.
import type { HistoryColumns, HistoryPoint } from './model.ts'

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

  /** Removes every point at or after `t`. */
  dropFrom(t: number): void {
    const index = this.points.findIndex((p) => p.t >= t)
    if (index !== -1) this.points.splice(index)
  }

  /** Points newer than `t` (exclusive). */
  since(t: number): HistoryPoint[] {
    return this.points.filter((p) => p.t > t)
  }
}

export function toColumns(points: readonly HistoryPoint[]): HistoryColumns {
  const round = (value: number | null): number | null => (value === null ? null : Math.round(value * 10) / 10)
  return {
    t: points.map((p) => p.t),
    cpu: points.map((p) => round(p.cpu)),
    mem: points.map((p) => round(p.mem))
  }
}

/** Every `step`-th point, newest kept, to shrink a snapshot that would be too large. */
export function downsample(columns: HistoryColumns, step: number): HistoryColumns {
  if (step <= 1) return columns
  const keep = (_: unknown, i: number, arr: readonly unknown[]): boolean => (arr.length - 1 - i) % step === 0
  return { t: columns.t.filter(keep), cpu: columns.cpu.filter(keep), mem: columns.mem.filter(keep) }
}
