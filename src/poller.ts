// The fleet poller: finds paired Orca servers, reads each one through the Orca CLI, and keeps
// one merged state and a history ring per machine.
//
// Rules:
// - At most one CLI call per machine at a time, and every call has a timeout.
// - Calls run in two lanes. This computer's own calls and those to machines that answer share
//   `maxConcurrent` slots. A machine moves to `maxProbes` slots of its own (the probe lane) as
//   soon as a call to it fails or times out, and stays there while it is connecting, offline or
//   failing; a plugin list or log read that keeps failing stays there until it works. So a
//   machine that stops answering holds a shared slot for at most one call, until the timeout.
// - An unreachable machine is retried with growing back-off, and so is a remote whose plugin
//   list or log cannot be read.
// - Reads keep their own beat: a 5 s interval reads every 5 s, however long each call takes.
// - A beacon is judged as each read of its log comes back. Between reads it stays as current as
//   this desktop's own schedule allows (`beaconAllowance`), and no longer once a call fails.
// - `now` is the worker's steady clock (src/worker.ts), which a wall-clock step never moves back.
import {
  assessBeacon,
  BEACON_INTERVAL_MS,
  BEACON_STALE_INTERVALS,
  emptyTracker,
  readBeaconLog,
  type BeaconTracker
} from './beacon.ts'
import { clipText, isPluginKey, TEXT_LIMITS } from './bounds.ts'
import type { CommandResult, CommandRunner } from './cli.ts'
import type { HealthSettings, MemoryRules } from './health.ts'
import { HistoryRing } from './history.ts'
import { beaconPoint, historyPointOf, mergeMachine } from './merge.ts'
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
/** CLI calls at once for this computer and for machines that answer. */
export const DEFAULT_MAX_CONCURRENT = 2
/** CLI calls at once for machines that are connecting, offline or failing. */
export const DEFAULT_MAX_PROBES = 2
export const DEFAULT_CALL_TIMEOUT_MS = 15_000
/** With several copies of Fleet Monitor on a machine, this many reads in a row without a fresh
 *  beacon move on to the next copy. */
export const QUIET_READS_BEFORE_NEXT_COPY = 3
/** Longest wait between tries of a `plugin logs` read that keeps failing. */
const LOG_RETRY_MAX_MS = 60_000
/** A beacon this close to a point already in history is taken for the same reading. */
const BEACON_POINT_SPACING_MS = 2_500
/** Points older than this are outside what each post repeats; adding one needs a re-fetch. */
const POSTED_WINDOW_MS = 20_000
/** This computer's diagnostics older than this, or than about two slow intervals when that is
 *  longer, no longer stand for its memory. They stop when nobody is looking and background
 *  monitoring is off. */
const LOCAL_DIAG_MAX_AGE_MS = 5 * 60_000
/** A beacon read that has waited this long for a free slot no longer keeps the beacon current. */
const MAX_QUEUE_WAIT_MS = 60_000
/** A remote's clock offset that moves by more than a beacon's staleness limit means its clock was
 *  set: its log is read again at once, so its beacon is judged on the new clock. */
const CLOCK_STEP_MS = BEACON_INTERVAL_MS * BEACON_STALE_INTERVALS
/** While no panel is open, a machine whose memory is strained or critical has the read that
 *  carries its memory (its beacon, or its diagnostics) made about this often, so an alert can be
 *  confirmed, or escalate, without waiting for the slow interval. */
export const ALERT_READ_MS = 15_000

export type PollerSettings = { fastIntervalMs: number; slowIntervalMs: number; health: HealthSettings; memoryRules?: MemoryRules }

export type PollerDeps = {
  run: CommandRunner
  now: () => number
  /** The shared local sampler's newest reading. */
  localSample: () => LocalSample | null
  localName: () => string
  /** This computer's platform, known before the sampler's first reading. */
  localPlatform?: string
  pluginId: string
  maxConcurrent?: number
  maxProbes?: number
  timeoutMs?: number
  /** True while slow-mode results would go unused (background monitoring off, or no status bar):
   *  no CLI calls then until a panel heartbeats. */
  idleWhenSlow?: () => boolean
  onChange?: () => void
  /** A machine's memory was read anew (a new sample, beacon or diagnostics that its memory comes
   *  from), with the state it gave. Re-merges that bring no new reading do not call it. */
  onMemoryReading?: (state: MachineState) => void
  log?: (message: string) => void
}

type Feed = 'diag' | 'keys' | 'beacon'
type Lane = 'main' | 'probe'

type Slot = {
  id: string
  name: string
  kind: 'local' | 'remote'
  runtimeId: string | null
  busy: boolean
  /** When the call it is busy with started. */
  callStartedAt: number | null
  /** The last call to this machine failed or timed out. Until one works it is read in the probe
   *  lane, and the beacon it holds gets no allowance. */
  callFailed: boolean
  due: Record<Feed, number>
  failures: number
  status: MachineState['status']
  lastSeenAt: number | null
  latencyMs: number | null
  error: string | null
  diag: DiagnosticsSample | null
  /** When the last good diagnostics arrived. */
  diagAt: number | null
  /** Remote clock minus local clock, from diagnostics `collectedAt`. */
  offsetMs: number | null
  plugin: RemotePluginInfo | null
  /** When the plugin list was last read; null before the first read. */
  keysReadAt: number | null
  /** Plugin list reads in a row that failed, for their back-off. */
  keyFailures: number
  keyIndex: number
  /** Beacon reads in a row without a fresh beacon. */
  quietReads: number
  /** `plugin logs` reads in a row that failed or timed out, for their back-off. */
  logFailures: number
  /** When the last good `plugin logs` read finished, and when the next one was then due. */
  logReadAt: number | null
  logPlannedAt: number | null
  latest: BeaconRecord | null
  tracker: BeaconTracker
  beaconFresh: boolean
  beaconAge: number | null
  /** The newest beacon already in history, so the next read records only newer ones. */
  pointRun: string | null
  pointSeq: number
  history: HistoryRing
  state: MachineState
  lastLocalT: number | null
  /** Which reading the memory last handed to `onMemoryReading` came from. */
  memoryKey: string | null
}

export type MachineEntry = { state: MachineState; history: HistoryRing }

/** Memory at strained or critical: alerts watch it, and its reads come faster with no panel open. */
function strainedMemory(state: MachineState | null | undefined): boolean {
  const level = state?.online ? state.health.memory : null
  return level === 'strained' || level === 'critical'
}

/** The next read on the schedule's own beat (`dueAt` plus the interval), so neither the call's
 *  length nor the tick it started on adds up; but never sooner than half an interval after this
 *  read finished, so a call slower than its interval does not run back to back. */
function nextDue(dueAt: number, interval: number, done: number): number {
  return Math.max(dueAt + interval, done + interval / 2)
}

export class FleetPoller {
  private readonly deps: PollerDeps
  private settings: PollerSettings
  private readonly slots = new Map<string, Slot>()
  private readonly running: Record<Lane, number> = { main: 0, probe: 0 }
  private envBusy = false
  private envDue = 0
  private envError: string | null = null
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
        if (slot.kind === 'remote' && !slot.beaconFresh && slot.keyFailures === 0) slot.due.keys = Math.min(slot.due.keys, now)
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
    return this.running.main + this.running.probe
  }

  /** Why the last `orca environment list` failed, or null when it worked (or has not run). With
   *  it failing, no paired machine can be found, so the panel says so instead of "nothing paired". */
  environmentError(): string | null {
    return this.envError
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
    if (this.inFlight() === 0) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  /** Reads every machine once as if a panel were open, then resolves. */
  async runOnce(): Promise<MachineEntry[]> {
    this.heartbeat()
    // Each finished call starts the next due one; wait until the chain runs dry.
    for (let i = 0; i < 20; i += 1) {
      await this.whenIdle()
      this.tick()
      if (this.inFlight() === 0) break
    }
    return this.entries()
  }

  /** Starts every read that is due, up to each lane's limit. Called by a timer and after each read
   *  finishes. A beacon that has stopped arriving is judged stale here too, on this clock, even
   *  while its log cannot be read. */
  tick(): void {
    if (this.stopped) return
    const now = this.deps.now()
    for (const slot of [...this.slots.values()]) this.reassessBeacon(slot, now)
    const fast = this.mode(now) === 'fast'
    if (!fast && this.deps.idleWhenSlow?.()) return
    if (!this.envBusy && now >= this.envDue && this.hasRoom('main')) {
      void this.refreshEnvironments()
    }
    const due: { slot: Slot; feed: Feed; at: number }[] = []
    for (const slot of this.slots.values()) {
      if (slot.busy) continue
      const feed = this.nextFeed(slot, now)
      if (feed) due.push({ slot, feed, at: this.dueOf(slot, feed, now) })
    }
    due.sort((a, b) => a.at - b.at)
    for (const { slot, feed, at } of due) {
      const lane = this.laneOf(slot, feed)
      if (this.hasRoom(lane)) void this.startFeed(slot, feed, at, lane)
    }
    // Readings first; the display name can wait for a free slot.
    if (!this.nameBusy && now >= this.nameDue && this.hasRoom('main')) {
      void this.refreshLocalName()
    }
  }

  // --- scheduling -----------------------------------------------------------------------------

  /** Machines not known to answer get their own lane, so their timeouts cost the others nothing:
   *  one connecting or offline, one whose last call failed or timed out, and a plugin list or log
   *  read that keeps failing (a machine whose log hangs is read in the shared lane otherwise). */
  private laneOf(slot: Slot, feed: Feed): Lane {
    if (slot.kind !== 'remote') return 'main'
    if (slot.status !== 'online' || slot.failures > 0 || slot.callFailed) return 'probe'
    if (feed === 'keys' && slot.keyFailures > 0) return 'probe'
    if (feed === 'beacon' && slot.logFailures > 0) return 'probe'
    return 'main'
  }

  private hasRoom(lane: Lane): boolean {
    const limit =
      lane === 'main'
        ? (this.deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT)
        : (this.deps.maxProbes ?? DEFAULT_MAX_PROBES)
    return this.running[lane] < Math.max(1, limit)
  }

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
   *  every `BASIC_PLUGIN_RECHECK_MS` while a panel is open, whatever its slow schedule says,
   *  unless reading it keeps failing. */
  private dueOf(slot: Slot, feed: Feed, now: number): number {
    const at = slot.due[feed]
    if (feed !== 'keys' || slot.beaconFresh || slot.failures > 0 || slot.keyFailures > 0 || slot.keysReadAt === null) return at
    if (this.mode(now) !== 'fast') return at
    return Math.min(at, slot.keysReadAt + BASIC_PLUGIN_RECHECK_MS)
  }

  private diagInterval(slot: Slot, now: number): number {
    const interval = this.intervalMs(now)
    if (this.mode(now) === 'slow') return this.alertFeed(slot) === 'diag' ? Math.min(interval, ALERT_READ_MS) : interval
    const full = slot.kind === 'local' || slot.beaconFresh
    return full ? Math.max(3 * interval, FULL_TIER_DIAG_MIN_MS) : interval
  }

  private beaconInterval(slot: Slot, now: number): number {
    const interval = this.intervalMs(now)
    return this.mode(now) === 'slow' && this.alertFeed(slot) === 'beacon' ? Math.min(interval, ALERT_READ_MS) : interval
  }

  /** The read that carries a machine's memory, while that memory is strained or critical: its
   *  beacon (a Mac with Fleet Monitor 1.1) or its diagnostics. None for this computer's own
   *  sampler, which reads every 5 s anyway, or while memory is fine. */
  private alertFeed(slot: Slot): 'diag' | 'beacon' | null {
    const memory = slot.state?.memory
    if (!memory || !strainedMemory(slot.state)) return null
    if (memory.source === 'beacon') return 'beacon'
    if (memory.source === 'orca') return 'diag'
    return null
  }

  private backoff(failures: number, now: number): number {
    return Math.min(MAX_BACKOFF_MS, this.intervalMs(now) * 2 ** Math.max(0, failures - 1))
  }

  private async callCli(args: string[]): Promise<{ result: CommandResult; envelope: Envelope }> {
    const result = await this.deps.run(args, { timeoutMs: this.deps.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS })
    let envelope: Envelope
    if (result.spawnError) {
      envelope = { ok: false, code: 'spawn_failed', message: clipText(result.spawnError, TEXT_LIMITS.message) }
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
    this.running.main += 1
    try {
      const { envelope } = await this.callCli(['environment', 'list', '--json'])
      if (this.stopped) return
      const done = this.deps.now()
      if (!envelope.ok) {
        this.deps.log?.(`environment list failed: ${envelope.code}: ${envelope.message}`)
        const changed = this.envError !== envelope.message
        this.envError = envelope.message
        this.envDue = done + this.intervalMs(done)
        if (changed) this.changed()
        return
      }
      this.envError = null
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
      this.finishJob('main')
    }
  }

  /** The name Orca itself shows for this computer; the hostname stays until one arrives. */
  private async refreshLocalName(): Promise<void> {
    this.nameBusy = true
    this.running.main += 1
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
      this.finishJob('main')
    }
  }

  private async startFeed(slot: Slot, feed: Feed, dueAt: number, lane: Lane): Promise<void> {
    slot.busy = true
    slot.callStartedAt = this.deps.now()
    this.running[lane] += 1
    try {
      if (feed === 'diag') await this.readDiagnostics(slot, dueAt)
      else if (feed === 'keys') await this.readPluginKeys(slot)
      else await this.readBeacon(slot, dueAt)
    } catch (error) {
      this.deps.log?.(`poll ${feed} failed: ${error instanceof Error ? error.message : String(error)}`)
      slot.due[feed] = this.deps.now() + this.intervalMs()
    } finally {
      slot.busy = false
      slot.callStartedAt = null
      this.finishJob(lane)
    }
  }

  private finishJob(lane: Lane): void {
    this.running[lane] -= 1
    if (this.stopped) {
      this.resolveIdle()
      return
    }
    this.tick()
    if (this.inFlight() === 0) this.resolveIdle()
  }

  private resolveIdle(): void {
    const waiters = this.idleWaiters
    this.idleWaiters = []
    for (const resolve of waiters) resolve()
  }

  // --- reads ----------------------------------------------------------------------------------

  private async readDiagnostics(slot: Slot, dueAt: number): Promise<void> {
    const args = ['diagnostics', 'memory', '--json']
    if (slot.kind === 'remote') args.push('--environment', slot.id)
    const { result, envelope } = await this.callCli(args)
    if (this.stopped || !this.slots.has(slot.id)) return
    const now = this.deps.now()
    const sample = parseDiagnostics(envelope)
    if (slot.kind === 'remote') slot.latencyMs = result.durationMs
    if (!sample) {
      slot.failures += 1
      slot.callFailed = true
      slot.error = envelope.ok ? 'Unexpected diagnostics answer' : envelope.message
      if (slot.kind === 'remote') {
        // One missed read keeps the last data; a second, or never having connected, is offline.
        if (slot.failures >= 2 || slot.status !== 'online') {
          slot.status = 'offline'
          slot.beaconFresh = false
        }
        const retry = now + this.backoff(slot.failures, now)
        slot.due.diag = retry
        slot.due.keys = Math.max(slot.due.keys, retry)
        slot.due.beacon = Math.max(slot.due.beacon, retry)
      } else {
        slot.due.diag = now + this.backoff(slot.failures, now)
      }
      this.remerge(slot, false)
      this.changed()
      return
    }
    const wasOffline = slot.status !== 'online'
    slot.failures = 0
    slot.callFailed = false
    slot.error = null
    slot.status = 'online'
    slot.lastSeenAt = now
    slot.diag = sample
    slot.diagAt = now
    if (sample.collectedAt > 0) {
      const midpoint = now - result.durationMs / 2
      const offset = sample.collectedAt - midpoint
      const stepped = slot.offsetMs !== null && Math.abs(offset - slot.offsetMs) > CLOCK_STEP_MS
      slot.offsetMs = offset
      // Its clock was set: read its log again now, to judge the beacon on the new clock.
      if (stepped && slot.kind === 'remote' && (slot.plugin?.keys.length ?? 0) > 0) {
        slot.due.beacon = Math.min(slot.due.beacon, now)
      }
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
    slot.due.diag = nextDue(dueAt, this.diagInterval(slot, now), now)
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
      // An older Orca, plugins turned off there, or a failing call: ask less and less often.
      slot.keyFailures += 1
      slot.callFailed = true
      slot.due.keys = now + Math.min(PLUGIN_LIST_INTERVAL_MS, this.backoff(slot.keyFailures, now))
      return
    }
    slot.keyFailures = 0
    slot.callFailed = false
    const changed = JSON.stringify(info.keys) !== JSON.stringify(slot.plugin?.keys ?? [])
    slot.plugin = info
    if (changed) {
      slot.keyIndex = 0
      slot.quietReads = 0
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

  private async readBeacon(slot: Slot, dueAt: number): Promise<void> {
    const keys = slot.plugin?.keys ?? []
    if (keys.length === 0) return
    const index = slot.keyIndex % keys.length
    const key = keys[index]
    if (!isPluginKey(key, this.deps.pluginId)) {
      slot.due.beacon = this.deps.now() + PLUGIN_LIST_INTERVAL_MS
      return
    }
    const { result, envelope } = await this.callCli(['plugin', 'logs', key, '--environment', slot.id, '--json'])
    if (this.stopped || !this.slots.has(slot.id)) return
    const now = this.deps.now()
    slot.due.beacon = nextDue(dueAt, this.beaconInterval(slot, now), now)
    const logs = parseLogs(envelope)
    if (!logs) {
      // The log cannot be read just now: the last beacon must be within three intervals again
      // (no allowance), and the next try waits longer each time, in the probe lane, so a log read
      // that hangs leaves room for diagnostics and for the other machines.
      slot.logFailures += 1
      slot.callFailed = true
      slot.due.beacon = now + Math.min(LOG_RETRY_MAX_MS, this.backoff(slot.logFailures, now))
      this.reassessBeacon(slot, now)
      return
    }
    slot.logFailures = 0
    slot.callFailed = false
    slot.logReadAt = now
    slot.logPlannedAt = slot.due.beacon
    slot.latencyMs = result.durationMs
    const { records, latest } = readBeaconLog(logs.lines)
    const remoteNow = slot.offsetMs === null ? null : now + slot.offsetMs
    // Judged strictly, as read: within three intervals on the remote clock, and still moving.
    const moved = latest !== null && slot.tracker.run === latest.run && slot.tracker.seq !== null && latest.seq > slot.tracker.seq
    const assessed = assessBeacon(latest, slot.tracker, { localNow: now, remoteNow })
    if (moved && assessed.clockStale) {
      // Its sequence moved on since the last read, yet its clock calls the beacon old: that clock
      // was set back. Measure the remote clock again now rather than at the next diagnostics.
      slot.due.diag = Math.min(slot.due.diag, now)
    }
    const wasFresh = slot.beaconFresh
    slot.tracker = assessed.tracker
    slot.latest = latest
    slot.beaconFresh = assessed.fresh
    slot.beaconAge = assessed.ageMs
    if (assessed.fresh) {
      slot.quietReads = 0
    } else {
      slot.quietReads += 1
      if (slot.quietReads >= QUIET_READS_BEFORE_NEXT_COPY && keys.length > 1) {
        // Several copies (a development folder and an install, say), and this one has nothing
        // current to say: its beacon may be off or its worker stopped. Try the next one.
        slot.quietReads = 0
        slot.keyIndex = (index + 1) % keys.length
        slot.tracker = emptyTracker()
      }
    }
    if (assessed.fresh && !wasFresh) {
      // Promoted: the beacon now carries CPU, so memory and workspaces can be read less often.
      slot.due.diag = Math.max(slot.due.diag, (slot.lastSeenAt ?? now) + this.diagInterval(slot, now))
    } else if (!assessed.fresh && wasFresh) {
      this.demote(slot, now)
    }
    if (latest && assessed.fresh && slot.offsetMs !== null) this.recordBeacons(slot, records, latest, now)
    this.remerge(slot, assessed.fresh && assessed.advanced)
    this.changed()
  }

  /**
   * History points for this run's beacons not recorded yet. On the first fresh read that is the
   * older ones still in the log (about the last 16 minutes): a back-fill. After that it is any
   * written between two reads, so none is lost to timing. The newest is left to `remerge`. Points
   * go in only where history has none: a back-fill never replaces a reading already taken.
   */
  private recordBeacons(slot: Slot, records: readonly BeaconRecord[], latest: BeaconRecord, now: number): void {
    const offset = slot.offsetMs ?? 0
    const after = slot.pointRun === latest.run ? slot.pointSeq : Number.NEGATIVE_INFINITY
    const memory = slot.state.memory?.reliable ? slot.state.memory : null
    // The pressure figure history's `mem` holds (for a Mac's own reading, not its RAM in use).
    const diagMemory = memory ? (memory.kind === 'used' ? (memory.pressurePercent ?? null) : memory.percent) : null
    let rewritten = false
    for (const r of records) {
      if (r.run !== latest.run || r.seq <= after || r.seq >= latest.seq || r.cpu === null) continue
      const t = r.t - offset
      // Written before the remote's clock was set back: it would land in the future here.
      if (t > now) continue
      // Memory: the beacon's own where it can be trusted (a Mac's own reading from 1.1, or
      // os.freemem() on other systems); for a beacon just missed between two reads, the
      // diagnostics reading, which is at most that old; else none. RAM in use only from a Mac's.
      const point = beaconPoint(r, offset, now - t <= FULL_TIER_DIAG_MIN_MS ? diagMemory : null)
      if (slot.history.insertMissing(point, now, BEACON_POINT_SPACING_MS) && t < now - POSTED_WINDOW_MS) {
        rewritten = true
      }
    }
    slot.pointRun = latest.run
    slot.pointSeq = latest.seq
    if (rewritten) this.historyRev += 1
  }

  /** Back to the basic tier: diagnostics are the reading again, at their own cadence, and they
   *  make the history points. */
  private demote(slot: Slot, now: number): void {
    slot.beaconFresh = false
    slot.due.diag = Math.min(slot.due.diag, (slot.lastSeenAt ?? now) + this.diagInterval(slot, now))
  }

  /** Is the beacon the machine is shown with still current? Asked on every tick, so it goes stale
   *  on time even while its log cannot be read or the read hangs. */
  private reassessBeacon(slot: Slot, now: number): void {
    if (slot.kind !== 'remote' || !slot.beaconFresh || !slot.latest) return
    const remoteNow = slot.offsetMs === null ? null : now + slot.offsetMs
    const assessed = assessBeacon(slot.latest, slot.tracker, {
      localNow: now,
      remoteNow,
      allowanceMs: this.beaconAllowance(slot, now)
    })
    slot.beaconAge = assessed.ageMs
    if (assessed.fresh) return
    this.demote(slot, now)
    this.remerge(slot, false)
    this.changed()
  }

  /**
   * How much older than three beacon intervals the beacon a machine is shown with may grow before
   * it is stale. Each read of the log judges the beacon strictly; between reads it is as current
   * as this desktop's own schedule allows, so the allowance is the time since the last good read
   * during which this desktop did not ask for a newer one:
   * - until the next read is due (the fast or slow interval, however long that is);
   * - while that read waits for a free slot, because a round of reads takes longer than the
   *   interval (up to `MAX_QUEUE_WAIT_MS`);
   * - but not while a call to that machine runs: from when it started, its time counts.
   * None after a failed or timed-out call to that machine, so readings that stopped arriving are
   * never shown as live: in fast mode at 5 s, a machine whose log fails or hangs, or whose beacon
   * stops moving, is back on the basic tier within about 20 s of its last good read.
   */
  private beaconAllowance(slot: Slot, now: number): number {
    if (slot.callFailed || slot.logFailures > 0 || slot.logReadAt === null || slot.logPlannedAt === null) return 0
    const due = Math.min(slot.due.beacon, slot.logPlannedAt)
    let askedAt: number
    if (now < due) askedAt = due
    else if (slot.busy && slot.callStartedAt !== null) askedAt = Math.min(Math.max(due, slot.callStartedAt), due + MAX_QUEUE_WAIT_MS)
    else if (this.mode(now) === 'slow' && this.deps.idleWhenSlow?.()) askedAt = due // nothing is being read
    else askedAt = Math.min(now, due + MAX_QUEUE_WAIT_MS)
    return Math.max(0, askedAt - slot.logReadAt)
  }

  /** How long this computer's diagnostics stand for its memory: about two of the longest
   *  intervals they are read at (five minutes at least), or five minutes while nothing is read. */
  private localDiagMaxAge(now: number): number {
    if (this.mode(now) === 'slow' && this.deps.idleWhenSlow?.()) return LOCAL_DIAG_MAX_AGE_MS
    const longest = Math.max(this.settings.slowIntervalMs, 3 * this.settings.fastIntervalMs, FULL_TIER_DIAG_MIN_MS)
    return Math.max(LOCAL_DIAG_MAX_AGE_MS, 2 * longest + (this.deps.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS))
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
      callStartedAt: null,
      callFailed: false,
      due: { diag: now, keys: now, beacon: now },
      failures: 0,
      status: kind === 'local' ? 'online' : 'connecting',
      lastSeenAt: null,
      latencyMs: null,
      error: null,
      diag: null,
      diagAt: null,
      offsetMs: null,
      plugin: null,
      keysReadAt: null,
      keyFailures: 0,
      keyIndex: 0,
      quietReads: 0,
      logFailures: 0,
      logReadAt: null,
      logPlannedAt: null,
      latest: null,
      tracker: emptyTracker(),
      beaconFresh: false,
      beaconAge: null,
      pointRun: null,
      pointSeq: 0,
      history: new HistoryRing(),
      state: null as unknown as MachineState,
      lastLocalT: null,
      memoryKey: null
    }
    this.remerge(slot, false)
    return slot
  }

  /** Which reading a state's memory came from, so the same one is never counted twice. */
  private memoryKeyOf(slot: Slot, state: MachineState, local: LocalSample | null): string | null {
    const memory = state.memory
    if (!memory || !state.online) return null
    if (memory.source === 'sampler' || (memory.source === 'os' && slot.kind === 'local')) return local ? `local:${local.t}` : null
    if (memory.source === 'beacon' || memory.source === 'os') return slot.latest ? `beacon:${slot.latest.run}:${slot.latest.seq}` : null
    return slot.diagAt === null ? null : `diag:${slot.diagAt}`
  }

  private remerge(slot: Slot, addPoint: boolean): void {
    const now = this.deps.now()
    const local = slot.kind === 'local' ? this.deps.localSample() : null
    let pointAt: number | null = null
    if (slot.kind === 'local') {
      // A new sample: it was taken now, on this clock (its own `t` is wall time, for the beacon).
      if (local && local.t !== slot.lastLocalT) {
        slot.lastLocalT = local.t
        slot.lastSeenAt = now
        pointAt = now
      }
    } else if (addPoint) {
      pointAt = slot.beaconFresh && slot.latest && slot.offsetMs !== null ? Math.min(now, slot.latest.t - slot.offsetMs) : now
    }
    const staleLocalDiag = slot.kind === 'local' && slot.diagAt !== null && now - slot.diagAt > this.localDiagMaxAge(now)
    const wasStrained = slot.state ? strainedMemory(slot.state) : false
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
      diag: staleLocalDiag ? null : slot.diag,
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
      health: this.settings.health,
      memoryRules: this.settings.memoryRules,
      platform: slot.kind === 'local' ? (this.deps.localPlatform ?? null) : null
    })
    if (pointAt !== null) {
      const point = historyPointOf(slot.state, pointAt)
      if (point) slot.history.add(point, now, Math.min(1_000, this.settings.fastIntervalMs / 2))
      // Only when a reading arrives (as with history points), and only a new one.
      const key = this.memoryKeyOf(slot, slot.state, local)
      if (key !== null && key !== slot.memoryKey) {
        slot.memoryKey = key
        this.deps.onMemoryReading?.(slot.state)
      }
    }
    if (!wasStrained && strainedMemory(slot.state)) this.hurryAlertFeed(slot, now)
    slot.history.trim(now)
  }

  /** Memory just became strained or critical: with no panel open, the read that carries it comes
   *  about every ALERT_READ_MS from its last one, starting now rather than at the slow interval. */
  private hurryAlertFeed(slot: Slot, now: number): void {
    if (this.mode(now) !== 'slow' || slot.failures > 0) return
    const feed = this.alertFeed(slot)
    if (feed === 'diag') slot.due.diag = Math.min(slot.due.diag, (slot.diagAt ?? now) + ALERT_READ_MS)
    else if (feed === 'beacon' && slot.logFailures === 0) slot.due.beacon = Math.min(slot.due.beacon, (slot.logReadAt ?? now) + ALERT_READ_MS)
  }

  private changed(): void {
    this.deps.onChange?.()
  }
}
