// Worker side of the panel bridge: answers `fleet.snapshot` and posts `fleet.update`.
//
// Orca's limits (docs/reference/plugin-authoring.md, "Panels, workers and data"): a request
// answer up to 1 MiB, a post up to 256 KiB and 200 posts per 10 s per plugin. Orca sizes them as
// a structured clone, not as JSON (`estimateCloneBytes` below follows the same counting), and
// refuses one with more than 10,000 objects in it. History travels as columns of numbers, not as
// one object per point, to stay far below that. Posts are
// coalesced to at most one per `minPostGapMs` and only sent while a panel is heartbeating.
// Each post repeats the last `recentWindowMs` of history, so a panel merges points by time and a
// missed post costs nothing; a gap in `seq` longer than that window means it should re-fetch.
import { DEFAULT_HEALTH } from './health.ts'
import { downsample, toColumns, HISTORY_WINDOW_MS } from './history.ts'
import type { CliInfo, FleetMode, FleetSnapshot, FleetThresholds, FleetUpdate, HistoryColumns } from './model.ts'
import type { MachineEntry } from './poller.ts'

export const SNAPSHOT_MAX_BYTES = 960 * 1024
export const POST_MAX_BYTES = 240 * 1024
const MAX_OBJECTS = 9_000

const encoder = new TextEncoder()

/**
 * Size of a JSON-like value as Orca counts a structured clone: strings by UTF-8 bytes, numbers 8,
 * booleans and null 1, arrays 8 plus 4 per element, objects 4 plus the key's bytes per property.
 * Returns Infinity past `MAX_OBJECTS` objects or 100 levels deep, which Orca also refuses.
 */
export function estimateCloneBytes(value: unknown): number {
  let objects = 0
  const walk = (v: unknown, depth: number): number => {
    if (v === null || v === undefined || typeof v === 'boolean') return 1
    if (typeof v === 'number') return 8
    if (typeof v === 'string') return encoder.encode(v).length
    if (typeof v !== 'object') return Number.POSITIVE_INFINITY
    objects += 1
    if (objects > MAX_OBJECTS || depth > 100) return Number.POSITIVE_INFINITY
    if (Array.isArray(v)) {
      let total = 8
      for (const item of v) total += 4 + walk(item, depth + 1)
      return total
    }
    let total = 0
    for (const [key, item] of Object.entries(v as Record<string, unknown>)) {
      total += 4 + encoder.encode(key).length + walk(item, depth + 1)
    }
    return total
  }
  return walk(value, 0)
}

export type BridgeSource = {
  entries(): MachineEntry[]
  mode(): FleetMode
  intervalMs(): number
  /** See FleetPoller.historyRevision; 0 when the source never rewrites older history. */
  historyRevision?(): number
}

export type BridgeDeps = {
  source: BridgeSource
  post: (payload: FleetUpdate) => void
  now: () => number
  cli: () => CliInfo
  /** The person's CPU and memory thresholds; the defaults when not given. */
  thresholds?: () => FleetThresholds
  /** This worker run's id, so a panel can tell a restart (seq starting over) from old posts. */
  run?: string
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  minPostGapMs?: number
  snapshotMaxBytes?: number
  postMaxBytes?: number
  recentWindowMs?: number
}

export class PanelBridge {
  private readonly deps: BridgeDeps
  private seq = 0
  private lastPostAt = Number.NEGATIVE_INFINITY
  private timer: unknown = null

  constructor(deps: BridgeDeps) {
    this.deps = deps
  }

  get currentSeq(): number {
    return this.seq
  }

  snapshot(): FleetSnapshot {
    const entries = this.deps.source.entries()
    const histories = new Map<string, HistoryColumns>()
    for (const entry of entries) histories.set(entry.state.id, toColumns(entry.history.all()))
    const build = (step: number): FleetSnapshot => ({
      v: 1,
      seq: this.seq,
      generatedAt: this.deps.now(),
      mode: this.deps.source.mode(),
      intervalMs: this.deps.source.intervalMs(),
      historyWindowMs: HISTORY_WINDOW_MS,
      cli: this.deps.cli(),
      thresholds: this.thresholds(),
      historyRev: this.deps.source.historyRevision?.() ?? 0,
      run: this.deps.run ?? '',
      machines: entries.map((entry) => ({
        ...entry.state,
        history: downsample(histories.get(entry.state.id)!, step)
      }))
    })
    const max = this.deps.snapshotMaxBytes ?? SNAPSHOT_MAX_BYTES
    let step = 1
    let snapshot = build(step)
    while (estimateCloneBytes(snapshot) > max && step < 1_024) {
      step *= 2
      snapshot = build(step)
    }
    return snapshot
  }

  /** Something changed: post soon, at most once per `minPostGapMs`, while a panel is open. */
  notify(): void {
    if (this.deps.source.mode() !== 'fast' || this.timer !== null) return
    const gap = this.deps.minPostGapMs ?? 1_000
    const wait = Math.max(0, this.lastPostAt + gap - this.deps.now())
    this.timer = this.deps.setTimeout(() => {
      this.timer = null
      this.flush()
    }, wait)
  }

  flush(): FleetUpdate | null {
    if (this.timer !== null) {
      this.deps.clearTimeout(this.timer)
      this.timer = null
    }
    if (this.deps.source.mode() !== 'fast') return null
    const now = this.deps.now()
    const entries = this.deps.source.entries()
    const since = now - this.recentWindowMs()
    const appended: Record<string, HistoryColumns> = {}
    for (const entry of entries) {
      const points = entry.history.since(since)
      if (points.length > 0) appended[entry.state.id] = toColumns(points)
    }
    this.seq += 1
    this.lastPostAt = now
    let update: FleetUpdate = {
      v: 1,
      seq: this.seq,
      generatedAt: this.lastPostAt,
      mode: this.deps.source.mode(),
      intervalMs: this.deps.source.intervalMs(),
      cli: this.deps.cli(),
      thresholds: this.thresholds(),
      historyRev: this.deps.source.historyRevision?.() ?? 0,
      run: this.deps.run ?? '',
      machines: entries.map((entry) => entry.state),
      recentMs: this.recentWindowMs(),
      appended
    }
    if (estimateCloneBytes(update) > (this.deps.postMaxBytes ?? POST_MAX_BYTES)) {
      update = { ...update, machines: [], appended: {}, resync: true }
    }
    this.deps.post(update)
    return update
  }

  private thresholds(): FleetThresholds {
    return this.deps.thresholds?.() ?? DEFAULT_HEALTH
  }

  /** How much recent history each post repeats. */
  recentWindowMs(): number {
    return Math.max(this.deps.recentWindowMs ?? 30_000, 6 * this.deps.source.intervalMs())
  }

  dispose(): void {
    if (this.timer !== null) this.deps.clearTimeout(this.timer)
    this.timer = null
  }
}
