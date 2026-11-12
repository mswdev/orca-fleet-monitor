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
//
// Everything that leaves goes through `plainJson` (src/bounds.ts) first, machine by machine, so
// only plain data can reach a panel whatever a remote sent. The snapshot then always fits its
// cap: first by thinning history, then by dropping it, then by leaving out each machine's bulky
// detail, and last by leaving out machines (counted in `omitted`).
import { clipText, plainJson } from './bounds.ts'
import { DEFAULT_HEALTH } from './health.ts'
import { downsample, toColumns, HISTORY_WINDOW_MS } from './history.ts'
import type {
  CliInfo,
  FleetMode,
  FleetSnapshot,
  FleetThresholds,
  FleetUpdate,
  HistoryColumns,
  MachineState,
  MachineView
} from './model.ts'
import type { MachineEntry } from './poller.ts'

export const SNAPSHOT_MAX_BYTES = 960 * 1024
export const POST_MAX_BYTES = 240 * 1024
const MAX_OBJECTS = 9_000
const EMPTY_HISTORY: HistoryColumns = { t: [], cpu: [], mem: [] }

/** One machine's state as plain data. Something that is not (a function where a string should
 *  be, say) cannot survive the copy, and a state that lost its identity becomes a stub. */
export function plainMachine(state: MachineState): MachineState {
  const copy = plainJson(state) as unknown as MachineState | undefined
  if (copy && typeof copy === 'object' && typeof copy.id === 'string' && typeof copy.name === 'string') return copy
  return stubMachine(state)
}

/** The least a panel needs to list a machine: who it is, and that its readings did not come. */
function stubMachine(state: Pick<MachineState, 'id' | 'name' | 'kind'>): MachineState {
  const id = typeof state.id === 'string' ? clipText(state.id, 128) : 'unknown'
  return {
    id,
    name: typeof state.name === 'string' ? clipText(state.name, 128) : id,
    kind: state.kind === 'local' ? 'local' : 'remote',
    tier: 'basic',
    status: 'offline',
    online: false,
    lastSeenAt: null,
    latencyMs: null,
    error: 'Its readings could not be sent to this panel',
    host: { hostname: null, platform: null, arch: null, cpuModel: null, cores: null, uptimeSec: null },
    cpu: { percent: null, source: null, perCore: null, groups: null },
    memory: null,
    load: null,
    orca: null,
    workspaces: { byCpu: [], byMemory: [] },
    health: { level: 'unknown', reasons: [], cpu: null, memory: null },
    beacon: { state: 'absent', ageMs: null, seq: null, pluginKey: null, remotePlugin: 'unknown' },
    updatedAt: 0
  }
}

/** A machine without its bulky detail: no workspaces, per-core values or reasons, a short error. */
function leanMachine(state: MachineState): MachineState {
  return {
    ...state,
    error: state.error === null ? null : clipText(state.error, 120),
    cpu: { ...state.cpu, perCore: null, groups: null },
    workspaces: { byCpu: [], byMemory: [] },
    health: { ...state.health, reasons: [] }
  }
}

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
    const machines = entries.map((entry) => ({
      state: plainMachine(entry.state),
      history: plainJson(toColumns(entry.history.all())) as HistoryColumns
    }))
    const header = {
      v: 1 as const,
      seq: this.seq,
      generatedAt: this.deps.now(),
      mode: this.deps.source.mode(),
      intervalMs: this.deps.source.intervalMs(),
      historyWindowMs: HISTORY_WINDOW_MS,
      cli: plainJson(this.deps.cli()) as unknown as CliInfo,
      thresholds: plainJson(this.thresholds()) as unknown as FleetThresholds,
      historyRev: this.deps.source.historyRevision?.() ?? 0,
      run: this.deps.run ?? ''
    }
    const max = this.deps.snapshotMaxBytes ?? SNAPSHOT_MAX_BYTES
    const fits = (snapshot: FleetSnapshot): boolean => estimateCloneBytes(snapshot) <= max
    const build = (views: MachineView[], omitted = 0): FleetSnapshot =>
      omitted > 0 ? { ...header, machines: views, omitted } : { ...header, machines: views }
    // 1. History thinned by halves until it fits.
    for (let step = 1; step <= 1_024; step *= 2) {
      const snapshot = build(machines.map((m) => ({ ...m.state, history: downsample(m.history, step) })))
      if (fits(snapshot)) return snapshot
    }
    // 2. No history, then no bulky detail.
    const bare = build(machines.map((m) => ({ ...m.state, history: EMPTY_HISTORY })))
    if (fits(bare)) return bare
    const lean = machines.map((m) => ({ ...leanMachine(m.state), history: EMPTY_HISTORY }))
    const leanSnapshot = build(lean)
    if (fits(leanSnapshot)) return leanSnapshot
    // 3. As many machines as fit, this computer first; then stubs; never over the cap.
    const kept: MachineView[] = []
    for (const view of lean) {
      if (fits(build([...kept, view], lean.length - kept.length - 1))) kept.push(view)
      else if (fits(build([...kept, { ...stubMachine(view), history: EMPTY_HISTORY }], lean.length - kept.length - 1)))
        kept.push({ ...stubMachine(view), history: EMPTY_HISTORY })
    }
    const last = build(kept, lean.length - kept.length)
    return fits(last) ? last : build([], lean.length)
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
    const states = entries.map((entry) => plainMachine(entry.state))
    const base = {
      v: 1 as const,
      seq: this.seq,
      generatedAt: this.lastPostAt,
      mode: this.deps.source.mode(),
      intervalMs: this.deps.source.intervalMs(),
      cli: plainJson(this.deps.cli()) as unknown as CliInfo,
      thresholds: plainJson(this.thresholds()) as unknown as FleetThresholds,
      historyRev: this.deps.source.historyRevision?.() ?? 0,
      run: this.deps.run ?? '',
      recentMs: this.recentWindowMs()
    }
    const cap = this.deps.postMaxBytes ?? POST_MAX_BYTES
    let update: FleetUpdate = { ...base, machines: states, appended: plainJson(appended) as Record<string, HistoryColumns> }
    if (estimateCloneBytes(update) > cap) {
      // Too much detail for one post: the same states without their bulk, then a resync.
      update = { ...update, machines: states.map(leanMachine) }
      if (estimateCloneBytes(update) > cap) update = { ...base, machines: [], appended: {}, resync: true }
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
