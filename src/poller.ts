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
//
// Memory readings, for alerts (src/alerts.ts), are handed on one by one as they are taken, never
// once per read of the machine: each sample of this computer, each beacon in a remote's log that
// has not been judged yet (a read returns every beacon since the last), and each diagnostics answer
// that a machine's memory comes from. A machine whose memory is elevated is read about every 15 s
// with no panel open (watch mode); one that stops answering while it is elevated is marked `lost`.
import type { LostEvent, MemoryReading } from './alerts.ts'
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
import { MAC_FIGURES_MAX_AGE_MS, memoryElevated, memoryReasons, memorySummary, type HealthSettings, type MemoryRules } from './health.ts'
import { HistoryRing } from './history.ts'
import { beaconMemoryOf, beaconPoint, historyPointOf, mergeMachine } from './merge.ts'
import { readProcessLog, type ProcessRecord } from './process-line.ts'
import { largestProcess } from './processes.ts'
import type { BeaconRecord, DiagnosticsSample, FleetMode, LocalSample, LostReading, MacMemory, MachineState, TopProcess } from './model.ts'
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
/** While no panel is open, a machine whose memory is elevated (src/health.ts `memoryElevated`) has
 *  the read that carries its memory (its beacon, or its diagnostics) made about this often, and a
 *  failed one retried from this often, so an alert, or "stopped answering", comes without waiting
 *  for the slow interval (watch mode). */
export const ALERT_READ_MS = 15_000
/** On the first read of a machine's log, only beacons this recent are judged for alerts; the rest
 *  are older than anything this desktop could have told. */
export const FIRST_JUDGE_MS = 30_000
/** Beacons older than this when read are not judged (this desktop slept, say). */
export const JUDGE_BACKLOG_MS = 5 * 60_000
/** A process line's time is moved onto the local clock and bounded to this long ago. */
const PROCESS_LINE_MAX_AGE_MS = 24 * 60 * 60_000
/** Runs whose judged sequence is remembered per machine. */
const JUDGED_RUNS = 16
/** A machine that reports its own Mac readings, marked `lost`, stays marked while only Orca's
 *  figure arrives for this long; one without stays marked until Orca's figure arrives again. */
export const LOST_HOLD_MS = 10 * 60_000
/** Ticks further apart than this mean this desktop slept (or its timers stalled). */
const TICK_GAP_MS = 10_000
/** For this long after that, no machine is marked lost: the network may not be back yet, and every
 *  beacon looks old until it is read again. */
export const RESUME_QUIET_MS = 60_000

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
  /** One new reading of a machine's memory: a sample of this computer, a beacon not judged
   *  before, or a diagnostics answer that its memory comes from. Each is handed on once; re-merges
   *  that bring no new reading do not call it. */
  onMemoryReading?: (reading: MemoryReading) => void
  /** The reading that carries a machine's memory stopped arriving while that memory was elevated. */
  onMemoryLost?: (event: LostEvent) => void
  /** This computer's process lists (src/monitor.ts): when the newest was taken (worker clock),
   *  and the process using the most memory, last known, with when its figure was read. */
  localProcesses?: () => { takenAt: number | null; lastLargest: { largest: TopProcess; at: number } | null } | null
  log?: (message: string) => void
}

/** A remote's newest process line, as the poller holds it. */
export type RemoteProcessLine = {
  record: ProcessRecord
  /** When it was taken (the remote's time moved onto the local clock), and when it was read. */
  takenAt: number
  readAt: number
  /** The process using the most memory in it. */
  largest: TopProcess | null
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
  /** Per worker run in its log, the highest beacon sequence already judged for alerts. */
  judged: Map<string, number>
  /** Its log has been read once since this copy was chosen: later reads judge every new beacon. */
  beaconSeen: boolean
  /** It reports its own Mac readings (a beacon of run `ownRun` with `mm`, or this Mac's sampler):
   *  a reading without one, or Orca's calm figure, then says nothing. */
  ownReadings: boolean
  ownRun: string | null
  /** The last beacon with a Mac reading, which stands in (display only) for up to two that lack it. */
  lastMac: { mac: MacMemory; t: number; run: string } | null
  carriedMac: MacMemory | null
  /** Its memory reading stopped arriving while elevated; and since when Orca's figure alone came. */
  lost: LostReading | null
  lostDiagSince: number | null
  /** Its beacon went stale while a call to it was out: the state with its last reading, until
   *  that call ends (settleLost). */
  lostPending: MachineState | null
  /** Its memory is elevated (as of its last reading): watch mode. */
  watch: boolean
  /** The last diagnostics handed on as a memory reading. */
  diagFed: number | null
  /** The newest process line from the worker run its beacons come from (1.2). */
  processes: RemoteProcessLine | null
  /** The process using the most memory, last known from its lines, and when its figure was read
   *  (local clock): kept while it publishes no newer line with memory figures. */
  lastLargest: { largest: TopProcess; at: number } | null
}

export type MachineEntry = { state: MachineState; history: HistoryRing }

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
  /** When the poller's 1 s tick last ran, and when it last came after a long gap (sleep). */
  private lastTickAt: number | null = null
  private resumedAt: number | null = null
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

  /** One machine's merged state, or null for an id the poller does not know. */
  stateOf(id: string): MachineState | null {
    return this.slots.get(id)?.state ?? null
  }

  /** A remote's newest process line, with the remote's clock offset (remote minus local) when
   *  known; null when none has been read from its current worker run. */
  processLineOf(id: string): RemoteProcessLine | null {
    const slot = this.slots.get(id)
    return slot && slot.kind === 'remote' ? slot.processes : null
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
    if (this.lastTickAt !== null && now - this.lastTickAt > TICK_GAP_MS) this.resumedAt = now
    this.lastTickAt = now
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

  /** The read that carries a machine's memory, while that memory is elevated (watch mode): its
   *  beacon (a Mac with Fleet Monitor 1.1) or its diagnostics. None for this computer's own
   *  sampler, which reads every 5 s anyway, or while memory is fine. */
  private alertFeed(slot: Slot): 'diag' | 'beacon' | null {
    const memory = slot.state?.memory
    if (!memory || !slot.watch || slot.kind !== 'remote') return null
    if (memory.source === 'beacon') return 'beacon'
    if (memory.source === 'orca') return 'diag'
    return null
  }

  /** The wait before retrying a failing read: the interval, doubling with each failure. In watch
   *  mode with no panel open it starts from ALERT_READ_MS, so a machine that stopped answering
   *  while short of memory is tried again soon. */
  private backoff(failures: number, now: number, slot?: Slot): number {
    const interval = this.intervalMs(now)
    const base = slot?.watch && slot.kind === 'remote' && this.mode(now) === 'slow' ? Math.min(interval, ALERT_READ_MS) : interval
    return Math.min(MAX_BACKOFF_MS, base * 2 ** Math.max(0, failures - 1))
  }

  /** Whether a machine's memory, as merged, is elevated. */
  private elevated(state: MachineState): boolean {
    return state.online && memoryElevated(state.memory, this.settings.health, this.settings.memoryRules)
  }

  /** The memory level one reading gives, or null when it cannot be judged. */
  private levelOf(memory: MachineState['memory']): MemoryReading['level'] {
    return memoryReasons(memory, this.settings.health, this.settings.memoryRules).level
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
      this.settleLost(slot, feed)
      this.finishJob(lane)
    }
  }

  /**
   * A machine's beacon went stale (or a call to it failed just after this desktop woke): whether
   * it stopped answering, or only its readings stopped, or nothing stopped and this desktop merely
   * had not asked, is decided by the next call to it that ends. A failed call: it stopped
   * answering. A log read that still finds the beacon stale: its readings stopped. A fresh beacon:
   * nothing stopped. Any other call that worked leaves it to the next log read. Until this desktop
   * has been awake for RESUME_QUIET_MS, nothing is decided.
   */
  private settleLost(slot: Slot, feed: Feed): void {
    const before = slot.lostPending
    if (!before) return
    if (slot.lost || slot.beaconFresh || !this.slots.has(slot.id) || this.stopped) {
      slot.lostPending = null
      return
    }
    const now = this.deps.now()
    if (this.resuming(now)) return
    let how: LostReading['how'] | null = null
    if (slot.callFailed || slot.status !== 'online') how = 'unanswered'
    else if (feed === 'beacon') how = 'stale'
    if (!how) return
    slot.lostPending = null
    this.noteLost(slot, how, before, now)
    this.remerge(slot, false)
    this.changed()
  }

  /** This desktop has just woken (or its timers stalled): calls may fail and every beacon looks
   *  old for a while, through no fault of the machines. */
  private resuming(now: number): boolean {
    return this.resumedAt !== null && now - this.resumedAt < RESUME_QUIET_MS
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
      const before = slot.state
      slot.failures += 1
      slot.callFailed = true
      slot.error = envelope.ok ? 'Unexpected diagnostics answer' : envelope.message
      if (slot.kind === 'remote') {
        // One missed read keeps the last data; a second, or never having connected, is offline.
        if (slot.failures >= 2 || slot.status !== 'online') {
          slot.status = 'offline'
          slot.beaconFresh = false
        }
        // Its memory came from these diagnostics, or it is now offline: that reading stopped.
        if (before.memory?.source === 'orca' || slot.status === 'offline') {
          if (this.resuming(now)) slot.lostPending ??= before
          else this.noteLost(slot, 'unanswered', before, now)
        }
        const retry = now + this.backoff(slot.failures, now, slot)
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
    // A machine marked lost whose memory comes from Orca is back; one that reports its own Mac
    // readings stays marked until those come again, or Orca's figure has stood for LOST_HOLD_MS.
    if (slot.lost) {
      if (!slot.ownReadings) slot.lost = null
      else {
        slot.lostDiagSince ??= now
        if (now - slot.lostDiagSince >= LOST_HOLD_MS) slot.lost = null
      }
      if (!slot.lost) slot.lostDiagSince = null
    }
    // Without a fresh beacon, diagnostics are the only reading, so they make the history point.
    this.remerge(slot, slot.kind === 'remote' && !slot.beaconFresh)
    if (slot.kind === 'remote') this.diagReading(slot)
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
      slot.beaconSeen = false
      slot.due.beacon = Math.min(slot.due.beacon, now)
    }
    if (info.keys.length === 0) {
      slot.latest = null
      slot.beaconFresh = false
      slot.beaconAge = null
      slot.processes = null
      slot.lastLargest = null
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
      slot.due.beacon = now + Math.min(LOG_RETRY_MAX_MS, this.backoff(slot.logFailures, now, slot))
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
        slot.beaconSeen = false
      }
    }
    // A beacon without a Mac reading (a 1.1 build that drops it on a failed read) shows the one
    // from up to two beacons before, marked with its age. Display only: alerts judge each beacon.
    slot.carriedMac = null
    if (latest?.macMemory) {
      slot.lastMac = { mac: latest.macMemory, t: latest.t, run: latest.run }
    } else if (latest && slot.lastMac && slot.lastMac.run === latest.run) {
      const age = latest.t - slot.lastMac.t
      if (age >= 0 && age <= MAC_FIGURES_MAX_AGE_MS) {
        const mac = slot.lastMac.mac
        slot.carriedMac = { ...mac, ageMs: (mac.ageMs ?? 0) + age, pressureAgeMs: (mac.pressureAgeMs ?? 0) + age }
      }
    }
    if (assessed.fresh && !wasFresh) {
      // Promoted: the beacon now carries CPU, so memory and workspaces can be read less often.
      slot.due.diag = Math.max(slot.due.diag, (slot.lastSeenAt ?? now) + this.diagInterval(slot, now))
    } else if (!assessed.fresh && wasFresh) {
      this.demote(slot, now)
    }
    // Its own readings are arriving again.
    if (assessed.fresh && assessed.advanced && slot.lost && slot.ownReadings) {
      slot.lost = null
      slot.lostDiagSince = null
    }
    if (latest && assessed.fresh && slot.offsetMs !== null) this.recordBeacons(slot, records, latest, now)
    this.takeProcessLine(slot, logs.lines, latest, now)
    this.remerge(slot, assessed.fresh && assessed.advanced)
    if (latest) this.judgeBeacons(slot, records, latest, now)
    this.changed()
  }

  /**
   * The newest process line in this read, when it comes from the worker run that wrote the newest
   * beacon (one from an earlier run describes processes of a plugin that has since restarted, and
   * is dropped). Only a line newer than the one held replaces it.
   */
  private takeProcessLine(slot: Slot, lines: readonly unknown[], latest: BeaconRecord | null, now: number): void {
    const record = latest ? readProcessLog(lines) : null
    if (!record || !latest || record.run !== latest.run) {
      if (slot.processes && (!latest || slot.processes.record.run !== latest.run)) slot.processes = null
      return
    }
    const held = slot.processes?.record
    if (held && held.run === record.run && held.seq >= record.seq) return
    // On the local clock, and never older than a day (whatever the remote's clock says).
    const takenAt = slot.offsetMs === null ? now : Math.max(now - PROCESS_LINE_MAX_AGE_MS, Math.min(now, record.t - slot.offsetMs))
    const largest = largestProcess(record.rows)
    slot.processes = { record, takenAt, readAt: now, largest }
    // A line without memory figures (its `top` stream had just restarted) keeps the last known.
    if (largest && record.memAgeMs !== null) {
      const at = takenAt - record.memAgeMs
      if (!slot.lastLargest || at >= slot.lastLargest.at) slot.lastLargest = { largest, at }
    }
  }

  /**
   * Hands on, for alerts, every beacon in this read that has not been judged yet, in log order,
   * whether or not the newest is fresh: a Mac short of memory answers slowly, and the beacons it
   * wrote meanwhile are what tells. Each run's highest judged sequence is kept, so a beacon is
   * judged once, and a run that started since (the plugin restarted) is judged from its start. On
   * the first read of a log only the last FIRST_JUDGE_MS are judged, and never anything older than
   * JUDGE_BACKLOG_MS.
   */
  private judgeBeacons(slot: Slot, records: readonly BeaconRecord[], latest: BeaconRecord, now: number): void {
    const offset = slot.offsetMs
    const remoteNow = offset === null ? null : now + offset
    const first = !slot.beaconSeen
    slot.beaconSeen = true
    const own = records.some((r) => r.run === latest.run && r.macMemory)
    if (slot.ownRun !== latest.run) {
      slot.ownRun = latest.run
      slot.ownReadings = own
    } else if (own) {
      slot.ownReadings = true
    }
    for (const r of records) {
      const judged = slot.judged.get(r.run)
      if (judged !== undefined && r.seq <= judged) continue
      slot.judged.delete(r.run)
      slot.judged.set(r.run, r.seq)
      if (slot.judged.size > JUDGED_RUNS) slot.judged.delete(slot.judged.keys().next().value!)
      if (first && remoteNow === null) continue // how old this log is cannot be told
      const age = remoteNow === null ? latest.t - r.t : remoteNow - r.t
      if (age > (first ? FIRST_JUDGE_MS : JUDGE_BACKLOG_MS)) continue
      const reading = this.beaconReading(slot, r, offset, now)
      if (reading) this.deps.onMemoryReading?.(reading)
    }
  }

  /** One beacon as a memory reading. Without a Mac reading it says nothing on a Mac that reports
   *  its own, and is no reading at all elsewhere (its memory comes from diagnostics). A kernel
   *  level carried over a failed read was judged when it was read, so it says nothing either. */
  private beaconReading(slot: Slot, r: BeaconRecord, offset: number | null, now: number): MemoryReading | null {
    const at = offset === null ? now : Math.min(now, r.t - offset)
    const base = { id: slot.id, name: slot.name, at }
    const memory = beaconMemoryOf(r, slot.diag)
    if (!memory) return slot.ownReadings && r.run === slot.ownRun ? { ...base, level: null, memory: null } : null
    const carried = memory.mac?.pressureAgeMs !== undefined
    return { ...base, level: carried ? null : this.levelOf(memory), memory }
  }

  /** The newest diagnostics as a memory reading, once, when the machine's memory comes from them.
   *  On a machine that reports its own Mac readings, a calm figure from Orca says nothing (it is
   *  not the kernel's level); a strained or critical one counts. */
  private diagReading(slot: Slot): void {
    const state = slot.state
    if (!state.online || state.memory?.source !== 'orca' || slot.diagAt === null || slot.diagFed === slot.diagAt) return
    slot.diagFed = slot.diagAt
    let level = this.levelOf(state.memory)
    if (slot.ownReadings && level !== 'strained' && level !== 'critical') level = null
    this.deps.onMemoryReading?.({ id: slot.id, name: slot.name, level, at: slot.diagAt, memory: state.memory })
  }

  /** This computer's newest sample as a memory reading: its own Mac reading, or what stands in. */
  private localReading(slot: Slot, now: number): void {
    const memory = slot.state.memory
    if (memory?.source === 'sampler') {
      slot.ownReadings = true
      const carried = memory.mac?.pressureAgeMs !== undefined
      this.deps.onMemoryReading?.({ id: slot.id, name: slot.name, level: carried ? null : this.levelOf(memory), at: now, memory })
    } else if (memory?.source === 'orca') {
      this.diagReading(slot)
    } else if (memory) {
      this.deps.onMemoryReading?.({ id: slot.id, name: slot.name, level: slot.ownReadings ? null : this.levelOf(memory), at: now, memory })
    }
  }

  /**
   * The reading that carries a machine's memory stopped arriving (its beacon went stale, a call to
   * it failed, it went offline). If that memory was elevated as last read (`before`), the machine
   * is marked lost and `onMemoryLost` tells, once until it clears; a later, worse way of stopping
   * (offline after stale) only updates the mark.
   */
  private noteLost(slot: Slot, how: LostReading['how'], before: MachineState, now: number): void {
    if (slot.kind !== 'remote') return
    if (slot.lost) {
      if (how === 'unanswered' && slot.lost.how === 'stale') slot.lost = { ...slot.lost, how }
      return
    }
    if (!before.online || !before.memory) return
    // A Mac's own reading: the newest beacon's, which a late read may have brought after the
    // merged one.
    let memory: NonNullable<MachineState['memory']> = before.memory
    let level = before.health.memory
    const fromBeacon = memory.source === 'beacon' && slot.latest !== null
    if (fromBeacon && slot.latest!.macMemory) {
      const newest = beaconMemoryOf(slot.latest!, slot.diag)
      if (newest) {
        memory = newest
        level = this.levelOf(newest)
      }
    }
    if (!memoryElevated(memory, this.settings.health, this.settings.memoryRules)) return
    const lastReadingAt = fromBeacon && slot.offsetMs !== null ? Math.min(now, slot.latest!.t - slot.offsetMs) : (slot.diagAt ?? before.lastSeenAt)
    slot.lost = { how, since: now, lastReadingAt, level: level ?? 'ok', summary: memorySummary(memory) }
    slot.lostDiagSince = null
    this.deps.onMemoryLost?.({ id: slot.id, name: slot.name, ...slot.lost })
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
    // `slot.state` is still merged from the fresh beacon: it holds the last own reading. Whether
    // the machine stopped answering, only its readings stopped, or this desktop merely has not
    // asked (it slept, or reads nothing with no panel open and background monitoring off) is
    // known once the next call to it ends: decided then (settleLost).
    if (slot.state.memory?.source === 'beacon' && !slot.lost) slot.lostPending ??= slot.state
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
      judged: new Map(),
      beaconSeen: false,
      ownReadings: false,
      ownRun: null,
      lastMac: null,
      carriedMac: null,
      lost: null,
      lostDiagSince: null,
      lostPending: null,
      watch: false,
      diagFed: null,
      processes: null,
      lastLargest: null
    }
    this.remerge(slot, false)
    return slot
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
    const wasWatched = slot.watch
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
              remotePlugin: slot.plugin?.state ?? 'unknown',
              logRead: slot.logReadAt !== null,
              carriedMac: slot.carriedMac
            }
          : null,
      lost: slot.lost,
      health: this.settings.health,
      memoryRules: this.settings.memoryRules,
      platform: slot.kind === 'local' ? (this.deps.localPlatform ?? null) : null,
      processLine: slot.kind === 'local' ? this.localProcessList() : slot.processes ? { takenAt: slot.processes.takenAt } : null,
      lastLargest: slot.kind === 'local' ? (this.localProcessesNow()?.lastLargest ?? null) : slot.lastLargest
    })
    // Watch mode follows the last reading; offline, it keeps what it was.
    if (slot.state.online) slot.watch = this.elevated(slot.state)
    if (pointAt !== null) {
      const point = historyPointOf(slot.state, pointAt)
      if (point) slot.history.add(point, now, Math.min(1_000, this.settings.fastIntervalMs / 2))
      // This computer's memory reading arrives with each sample (a remote's, with each beacon and
      // diagnostics read: judgeBeacons, diagReading).
      if (slot.kind === 'local') this.localReading(slot, now)
    }
    if (!wasWatched && slot.watch) this.hurryAlertFeed(slot, now)
    slot.history.trim(now)
  }

  /** Memory just became elevated: with no panel open, the read that carries it comes about every
   *  ALERT_READ_MS from its last one, starting now rather than at the slow interval. */
  private hurryAlertFeed(slot: Slot, now: number): void {
    if (this.mode(now) !== 'slow' || slot.failures > 0) return
    const feed = this.alertFeed(slot)
    if (feed === 'diag') slot.due.diag = Math.min(slot.due.diag, (slot.diagAt ?? now) + ALERT_READ_MS)
    else if (feed === 'beacon' && slot.logFailures === 0) slot.due.beacon = Math.min(slot.due.beacon, (slot.logReadAt ?? now) + ALERT_READ_MS)
  }

  private localProcessesNow(): ReturnType<NonNullable<PollerDeps['localProcesses']>> {
    try {
      return this.deps.localProcesses?.() ?? null
    } catch {
      return null
    }
  }

  private localProcessList(): { takenAt: number | null } | null {
    const local = this.localProcessesNow()
    return local && local.takenAt !== null ? { takenAt: local.takenAt } : null
  }

  /** This computer read its process list: its largest process may have changed. */
  onLocalProcesses(): void {
    const slot = this.slots.get(LOCAL_ID)
    if (!slot) return
    this.remerge(slot, false)
    this.changed()
  }

  private changed(): void {
    this.deps.onChange?.()
  }
}
