// The fleet poller: finds paired Orca servers, reads each one through the Orca CLI, and keeps
// one merged state and a history ring per machine.
//
// Rules: at most one CLI call per machine at a time, at most `maxConcurrent` CLI calls overall,
// every call has a timeout, and an unreachable machine is retried with growing back-off.
import { assessBeacon, emptyTracker, readBeacons, type BeaconTracker } from './beacon.ts'
import type { CommandResult, CommandRunner } from './cli.ts'
import type { HealthSettings } from './health.ts'
import { HistoryRing } from './history.ts'
import { backfillPoints, historyPointOf, mergeMachine } from './merge.ts'
import type { BeaconRecord, DiagnosticsSample, FleetMode, LocalSample, MachineState } from './model.ts'
import {
  findPluginKeys,
  parseDiagnostics,
  parseEnvelope,
  parseEnvironments,
  parseLocalHostName,
  parseLogs,
  type Envelope,
  type RemotePluginInfo
} from './parse.ts'

export const LOCAL_ID = 'local'
/** Fast polling continues this long after the last panel heartbeat. */
export const FAST_LINGER_MS = 15_000
export const MAX_BACKOFF_MS = 5 * 60_000
export const PLUGIN_LIST_INTERVAL_MS = 5 * 60_000
/** While a panel is open, a machine without a live beacon has its plugin list re-read this often,
 *  so installing Fleet Monitor there shows up within about half a minute. */
export const BASIC_PLUGIN_RECHECK_MS = 30_000
/** How often the name Orca shows for this computer (`orca host list`) is re-read. */
export const LOCAL_NAME_INTERVAL_MS = 30 * 60_000
const LOCAL_NAME_RETRY_MS = 5 * 60_000
/** With a fresh beacon, diagnostics (memory, workspaces) are read at most this often while fast. */
export const FULL_TIER_DIAG_MIN_MS = 15_000

export type PollerSettings = { fastIntervalMs: number; slowIntervalMs: number; health: HealthSettings }

export type PollerDeps = {
  run: CommandRunner
  now: () => number
  /** The shared local sampler's newest reading. */
  localSample: () => LocalSample | null
  localName: () => string
  pluginId: string
  maxConcurrent?: number
  timeoutMs?: number
  /** True while nobody can see the results (no status bar, no panel): skip CLI calls when slow. */
  idleWhenSlow?: () => boolean
  onChange?: () => void
  log?: (message: string) => void
}

type Feed = 'diag' | 'keys' | 'beacon'

type Slot = {
  id: string
  name: string
  kind: 'local' | 'remote'
  runtimeId: string | null
  busy: boolean
  due: Record<Feed, number>
  failures: number
  status: MachineState['status']
  lastSeenAt: number | null
  latencyMs: number | null
  error: string | null
  diag: DiagnosticsSample | null
  /** Remote clock minus local clock, from diagnostics `collectedAt`. */
  offsetMs: number | null
  plugin: RemotePluginInfo | null
  /** Local clock, when the plugin list was last read; null before the first read. */
  keysReadAt: number | null
  keyIndex: number
  emptyReads: number
  latest: BeaconRecord | null
  tracker: BeaconTracker
  beaconFresh: boolean
  beaconAge: number | null
  history: HistoryRing
  state: MachineState
  lastLocalT: number | null
}

export type MachineEntry = { state: MachineState; history: HistoryRing }

export class FleetPoller {
  private readonly deps: PollerDeps
  private settings: PollerSettings
  private readonly slots = new Map<string, Slot>()
  private running = 0
  private envBusy = false
  private envDue = 0
  private nameBusy = false
  private nameDue = 0
  private historyRev = 0
  private heartbeatAt = Number.NEGATIVE_INFINITY
  private localRuntimeId: string | null = null
  private stopped = false
  private idleWaiters: (() => void)[] = []

  constructor(deps: PollerDeps, settings: PollerSettings) {
    this.deps = deps
    this.settings = settings
    const local = this.newSlot(LOCAL_ID, deps.localName(), 'local', null)
    this.slots.set(LOCAL_ID, local)
  }

  // --- public surface -------------------------------------------------------------------------

  mode(now = this.deps.now()): FleetMode {
    return now - this.heartbeatAt <= FAST_LINGER_MS ? 'fast' : 'slow'
  }

  intervalMs(now = this.deps.now()): number {
    return this.mode(now) === 'fast' ? this.settings.fastIntervalMs : this.settings.slowIntervalMs
  }

  /** A panel is open. Switching from slow to fast pulls every due read forward. */
  heartbeat(): void {
    const now = this.deps.now()
    const wasFast = this.mode(now) === 'fast'
    this.heartbeatAt = now
    if (!wasFast) {
      this.envDue = Math.min(this.envDue, now)
      for (const slot of this.slots.values()) {
        if (slot.failures > 0) continue // keep the back-off
        slot.due.diag = Math.min(slot.due.diag, now)
        slot.due.beacon = Math.min(slot.due.beacon, now)
        // A panel just opened: has Fleet Monitor been installed on a basic machine meanwhile?
        if (slot.kind === 'remote' && !slot.beaconFresh) slot.due.keys = Math.min(slot.due.keys, now)
      }
    }
    this.tick()
  }

  /** "Retry connection": reads the machine now instead of waiting out its back-off. A failure
   *  still counts toward the back-off. False for an unknown or local id. */
  retry(id: string): boolean {
    const slot = this.slots.get(id)
    if (!slot || slot.kind !== 'remote') return false
    const now = this.deps.now()
    slot.due.diag = Math.min(slot.due.diag, now)
    slot.due.keys = Math.min(slot.due.keys, now)
    slot.due.beacon = Math.min(slot.due.beacon, now)
    this.tick()
    return true
  }

  updateSettings(settings: PollerSettings): void {
    this.settings = settings
    const now = this.deps.now()
    const ceiling = now + this.intervalMs(now)
    for (const slot of this.slots.values()) {
      if (slot.failures === 0) {
        slot.due.diag = Math.min(slot.due.diag, ceiling)
        slot.due.beacon = Math.min(slot.due.beacon, ceiling)
      }
      this.remerge(slot, false)
    }
    this.changed()
  }

  /** The shared sampler took a new reading. */
  onLocalSample(): void {
    const slot = this.slots.get(LOCAL_ID)
    if (slot) {
      this.remerge(slot, true)
      this.changed()
    }
  }

  entries(): MachineEntry[] {
    const list = [...this.slots.values()]
    list.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'local' ? -1 : 1))
    return list.map((slot) => ({ state: slot.state, history: slot.history }))
  }

  inFlight(): number {
    return this.running
  }

  /** Rises each time older history is rewritten (a back-fill), which posts alone cannot carry. */
  historyRevision(): number {
    return this.historyRev
  }

  stop(): void {
    this.stopped = true
    this.resolveIdle()
  }

  /** Resolves once no CLI call is running and none is due. */
  whenIdle(): Promise<void> {
    if (this.running === 0) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  /** Reads every machine once as if a panel were open, then resolves. */
  async runOnce(): Promise<MachineEntry[]> {
    this.heartbeat()
    // Each finished call starts the next due one; wait until the chain runs dry.
    for (let i = 0; i < 20; i += 1) {
      await this.whenIdle()
      this.tick()
      if (this.running === 0) break
    }
    return this.entries()
  }

  /** Starts every read that is due, up to the concurrency limit. Called by a timer and after
   *  each read finishes. */
  tick(): void {
    if (this.stopped) return
    const now = this.deps.now()
    const fast = this.mode(now) === 'fast'
    if (!fast && this.deps.idleWhenSlow?.()) return
    const max = this.deps.maxConcurrent ?? 2
    if (!this.envBusy && now >= this.envDue && this.running < max) {
      void this.refreshEnvironments()
    }
    const due: { slot: Slot; feed: Feed; at: number }[] = []
    for (const slot of this.slots.values()) {
      if (slot.busy) continue
      const feed = this.nextFeed(slot, now)
      if (feed) due.push({ slot, feed, at: this.dueOf(slot, feed, now) })
    }
    due.sort((a, b) => a.at - b.at)
    for (const { slot, feed } of due) {
      if (this.running >= max) break
      void this.startFeed(slot, feed)
    }
    // Readings first; the display name can wait for a free slot.
    if (!this.nameBusy && now >= this.nameDue && this.running < max) {
      void this.refreshLocalName()
    }
  }

  // --- scheduling -----------------------------------------------------------------------------

  private nextFeed(slot: Slot, now: number): Feed | null {
    const candidates: Feed[] = ['diag']
    if (slot.kind === 'remote' && slot.status === 'online') {
      candidates.push('keys')
      if (slot.plugin && slot.plugin.keys.length > 0) candidates.push('beacon')
    }
    let best: Feed | null = null
    for (const feed of candidates) {
      const at = this.dueOf(slot, feed, now)
      if (at <= now && (best === null || at < this.dueOf(slot, best, now))) best = feed
    }
    return best
  }

  /** When a feed is next due. The plugin list of a machine without a live beacon is re-read
   *  every `BASIC_PLUGIN_RECHECK_MS` while a panel is open, whatever its slow schedule says. */
  private dueOf(slot: Slot, feed: Feed, now: number): number {
    const at = slot.due[feed]
    if (feed !== 'keys' || slot.beaconFresh || slot.failures > 0 || slot.keysReadAt === null) return at
    if (this.mode(now) !== 'fast') return at
    return Math.min(at, slot.keysReadAt + BASIC_PLUGIN_RECHECK_MS)
  }

  private diagInterval(slot: Slot, now: number): number {
    const interval = this.intervalMs(now)
    if (this.mode(now) === 'slow') return interval
    const full = slot.kind === 'local' || slot.beaconFresh
    return full ? Math.max(3 * interval, FULL_TIER_DIAG_MIN_MS) : interval
  }

  private backoff(slot: Slot, now: number): number {
    return Math.min(MAX_BACKOFF_MS, this.intervalMs(now) * 2 ** Math.max(0, slot.failures - 1))
  }

  private async callCli(args: string[]): Promise<{ result: CommandResult; envelope: Envelope }> {
    const result = await this.deps.run(args, { timeoutMs: this.deps.timeoutMs ?? 15_000 })
    let envelope: Envelope
    if (result.spawnError) {
      envelope = { ok: false, code: 'spawn_failed', message: result.spawnError }
    } else if (result.timedOut) {
      envelope = { ok: false, code: 'timeout', message: `orca ${args[0]} ${args[1] ?? ''} timed out` }
    } else if (result.truncated) {
      envelope = { ok: false, code: 'too_large', message: 'The Orca CLI printed more than the output cap' }
    } else {
      envelope = parseEnvelope(result.stdout, result.stderr)
    }
    return { result, envelope }
  }

  private async refreshEnvironments(): Promise<void> {
    this.envBusy = true
    this.running += 1
    try {
      const { envelope } = await this.callCli(['environment', 'list', '--json'])
      if (this.stopped) return
      const done = this.deps.now()
      if (!envelope.ok) {
        this.deps.log?.(`environment list failed: ${envelope.code}: ${envelope.message}`)
        this.envDue = done + this.intervalMs(done)
        return
      }
      const list = parseEnvironments(envelope, this.localRuntimeId)
      const keep = new Set([LOCAL_ID, ...list.map((e) => e.id)])
      for (const id of [...this.slots.keys()]) {
        if (!keep.has(id)) this.slots.delete(id)
      }
      for (const entry of list) {
        const slot = this.slots.get(entry.id)
        if (slot) {
          slot.name = entry.name
          slot.runtimeId = entry.runtimeId
        } else {
          this.slots.set(entry.id, this.newSlot(entry.id, entry.name, 'remote', entry.runtimeId))
        }
      }
      this.envDue = done + (this.mode(done) === 'fast' ? 30_000 : Math.max(60_000, this.settings.slowIntervalMs))
      this.changed()
    } finally {
      this.envBusy = false
      this.finishJob()
    }
  }

  /** The name Orca itself shows for this computer; the hostname stays until one arrives. */
  private async refreshLocalName(): Promise<void> {
    this.nameBusy = true
    this.running += 1
    try {
      const { envelope } = await this.callCli(['host', 'list', '--json'])
      if (this.stopped) return
      const done = this.deps.now()
      const name = parseLocalHostName(envelope)
      const local = this.slots.get(LOCAL_ID)
      if (name && local && local.name !== name) {
        local.name = name
        this.remerge(local, false)
        this.changed()
      }
      this.nameDue = done + (name ? LOCAL_NAME_INTERVAL_MS : LOCAL_NAME_RETRY_MS)
    } finally {
      this.nameBusy = false
      this.finishJob()
    }
  }

  private async startFeed(slot: Slot, feed: Feed): Promise<void> {
    slot.busy = true
    this.running += 1
    try {
      if (feed === 'diag') await this.readDiagnostics(slot)
      else if (feed === 'keys') await this.readPluginKeys(slot)
      else await this.readBeacon(slot)
    } catch (error) {
      this.deps.log?.(`poll ${feed} failed: ${error instanceof Error ? error.message : String(error)}`)
      slot.due[feed] = this.deps.now() + this.intervalMs()
    } finally {
      slot.busy = false
      this.finishJob()
    }
  }

  private finishJob(): void {
    this.running -= 1
    if (this.stopped) {
      this.resolveIdle()
      return
    }
    this.tick()
    if (this.running === 0) this.resolveIdle()
  }

  private resolveIdle(): void {
    const waiters = this.idleWaiters
    this.idleWaiters = []
    for (const resolve of waiters) resolve()
  }

  // --- reads ----------------------------------------------------------------------------------

  private async readDiagnostics(slot: Slot): Promise<void> {
    const args = ['diagnostics', 'memory', '--json']
    if (slot.kind === 'remote') args.push('--environment', slot.id)
    const { result, envelope } = await this.callCli(args)
    if (this.stopped || !this.slots.has(slot.id)) return
    const now = this.deps.now()
    const sample = parseDiagnostics(envelope)
    if (slot.kind === 'remote') slot.latencyMs = result.durationMs
    if (!sample) {
      slot.failures += 1
      slot.error = envelope.ok ? 'Unexpected diagnostics answer' : envelope.message
      if (slot.kind === 'remote') {
        // One missed read keeps the last data; a second, or never having connected, is offline.
        if (slot.failures >= 2 || slot.status !== 'online') {
          slot.status = 'offline'
          slot.beaconFresh = false
        }
        const retry = now + this.backoff(slot, now)
        slot.due.diag = retry
        slot.due.keys = Math.max(slot.due.keys, retry)
        slot.due.beacon = Math.max(slot.due.beacon, retry)
      } else {
        slot.due.diag = now + this.backoff(slot, now)
      }
      this.remerge(slot, false)
      this.changed()
      return
    }
    const wasOffline = slot.status !== 'online'
    slot.failures = 0
    slot.error = null
    slot.status = 'online'
    slot.lastSeenAt = now
    slot.diag = sample
    if (sample.collectedAt > 0) {
      const midpoint = now - result.durationMs / 2
      slot.offsetMs = sample.collectedAt - midpoint
    }
    if (slot.kind === 'local' && sample.runtimeId && sample.runtimeId !== this.localRuntimeId) {
      this.localRuntimeId = sample.runtimeId
      for (const [id, other] of this.slots) {
        if (other.kind === 'remote' && other.runtimeId === sample.runtimeId) this.slots.delete(id)
      }
    }
    if (wasOffline && slot.kind === 'remote') {
      slot.due.keys = Math.min(slot.due.keys, now)
      slot.due.beacon = Math.min(slot.due.beacon, now)
    }
    slot.due.diag = now + this.diagInterval(slot, now)
    // Without a fresh beacon, diagnostics are the only reading, so they make the history point.
    this.remerge(slot, slot.kind === 'remote' && !slot.beaconFresh)
    this.changed()
  }

  private async readPluginKeys(slot: Slot): Promise<void> {
    const { envelope } = await this.callCli(['plugin', 'list', '--environment', slot.id, '--json'])
    if (this.stopped || !this.slots.has(slot.id)) return
    const now = this.deps.now()
    slot.keysReadAt = now
    const info = findPluginKeys(envelope, this.deps.pluginId)
    if (!info) {
      slot.due.keys = now + this.intervalMs(now)
      return
    }
    const changed = JSON.stringify(info.keys) !== JSON.stringify(slot.plugin?.keys ?? [])
    slot.plugin = info
    if (changed) {
      slot.keyIndex = 0
      slot.emptyReads = 0
      slot.due.beacon = Math.min(slot.due.beacon, now)
    }
    if (info.keys.length === 0) {
      slot.latest = null
      slot.beaconFresh = false
      slot.beaconAge = null
    }
    slot.due.keys = now + PLUGIN_LIST_INTERVAL_MS
    this.remerge(slot, false)
    this.changed()
  }

  private async readBeacon(slot: Slot): Promise<void> {
    const keys = slot.plugin?.keys ?? []
    const key = keys[slot.keyIndex % Math.max(1, keys.length)]
    if (!key) return
    const { result, envelope } = await this.callCli(['plugin', 'logs', key, '--environment', slot.id, '--json'])
    if (this.stopped || !this.slots.has(slot.id)) return
    const now = this.deps.now()
    slot.due.beacon = now + this.intervalMs(now)
    const logs = parseLogs(envelope)
    if (!logs) return
    slot.latencyMs = result.durationMs
    const records = readBeacons(logs.lines)
    const latest = records[records.length - 1] ?? null
    if (!latest) {
      slot.emptyReads += 1
      if (slot.emptyReads >= 3) {
        slot.emptyReads = 0
        slot.keyIndex += 1 // try the next copy; the list may also be out of date
        slot.due.keys = Math.min(slot.due.keys, now)
      }
    } else {
      slot.emptyReads = 0
    }
    const remoteNow = slot.offsetMs === null ? null : now + slot.offsetMs
    const assessed = assessBeacon(latest, slot.tracker, { localNow: now, remoteNow })
    const wasFresh = slot.beaconFresh
    slot.tracker = assessed.tracker
    slot.latest = latest
    slot.beaconFresh = assessed.fresh
    slot.beaconAge = assessed.ageMs
    if (assessed.fresh && !wasFresh) {
      // Promoted: the beacon now carries CPU, so memory and workspaces can be read less often.
      slot.due.diag = Math.max(slot.due.diag, (slot.lastSeenAt ?? now) + this.diagInterval(slot, now))
    }
    if (latest && assessed.fresh && !wasFresh && slot.offsetMs !== null) {
      // Newly on the full tier: the older beacons of this worker run (contiguous, unlike earlier
      // runs) replace the load-based points they overlap. The 200-line log ring holds about 16
      // minutes of 5 s beacons, less when the remote logs other lines.
      const sameRun = records.filter((r) => r.run === latest.run).slice(0, -1)
      const points = backfillPoints(sameRun, slot.offsetMs)
      if (points.length > 0) {
        slot.history.dropFrom(points[0]!.t)
        for (const point of points) slot.history.add(point, now)
        this.historyRev += 1
      }
    }
    this.remerge(slot, assessed.fresh && assessed.advanced)
    this.changed()
  }

  // --- state ----------------------------------------------------------------------------------

  private newSlot(id: string, name: string, kind: 'local' | 'remote', runtimeId: string | null): Slot {
    const now = this.deps.now()
    const slot: Slot = {
      id,
      name,
      kind,
      runtimeId,
      busy: false,
      due: { diag: now, keys: now, beacon: now },
      failures: 0,
      status: kind === 'local' ? 'online' : 'connecting',
      lastSeenAt: null,
      latencyMs: null,
      error: null,
      diag: null,
      offsetMs: null,
      plugin: null,
      keysReadAt: null,
      keyIndex: 0,
      emptyReads: 0,
      latest: null,
      tracker: emptyTracker(),
      beaconFresh: false,
      beaconAge: null,
      history: new HistoryRing(),
      state: null as unknown as MachineState,
      lastLocalT: null
    }
    this.remerge(slot, false)
    return slot
  }

  private remerge(slot: Slot, addPoint: boolean): void {
    const now = this.deps.now()
    const local = slot.kind === 'local' ? this.deps.localSample() : null
    slot.state = mergeMachine({
      id: slot.id,
      name: slot.name,
      kind: slot.kind,
      now,
      status: slot.status,
      lastSeenAt: slot.lastSeenAt,
      latencyMs: slot.latencyMs,
      error: slot.error,
      local,
      diag: slot.diag,
      beacon:
        slot.kind === 'remote'
          ? {
              latest: slot.latest,
              fresh: slot.beaconFresh,
              ageMs: slot.beaconAge,
              pluginKey: slot.plugin?.keys[slot.keyIndex % Math.max(1, slot.plugin.keys.length)] ?? null,
              remotePlugin: slot.plugin?.state ?? 'unknown'
            }
          : null,
      health: this.settings.health
    })
    let pointAt: number | null = null
    if (slot.kind === 'local') {
      if (local && local.t !== slot.lastLocalT) {
        slot.lastLocalT = local.t
        pointAt = local.t
      }
    } else if (addPoint) {
      pointAt = slot.beaconFresh && slot.latest && slot.offsetMs !== null ? slot.latest.t - slot.offsetMs : now
    }
    if (pointAt !== null) {
      const point = historyPointOf(slot.state, pointAt)
      if (point) slot.history.add(point, now, Math.min(1_000, this.settings.fastIntervalMs / 2))
    }
    slot.history.trim(now)
  }

  private changed(): void {
    this.deps.onChange?.()
  }
}
