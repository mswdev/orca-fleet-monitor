// Wires the pieces together inside a worker. Everything that touches the outside world comes in
// through `MonitorDeps`, so tests run the real wiring with a fake CLI and a fake clock.
import type { OrcaWorkerApi } from 'orca/worker'
import { MemoryAlerts, oneLine, type AlertNotice } from './alerts.ts'
import { BEACON_INTERVAL_MS, encodeBeacon } from './beacon.ts'
import { PanelBridge } from './bridge.ts'
import { localAnswer, remoteAnswer, unavailableAnswer } from './process-answer.ts'
import { encodeProcessLine, PROCESS_INTERVAL_MS } from './process-line.ts'
import { largestProcess, type ProcessTable } from './processes.ts'
import type { TopProcess } from './model.ts'
import { cliLauncherName, type CliResolution, type CommandRunner } from './cli.ts'
import type { CliInfo, LocalSample } from './model.ts'
import { openOwnPanel, SHOW_COMMAND_ID } from './open-panel.ts'
import { FleetPoller, LOCAL_ID } from './poller.ts'
import { readSettings, type FleetSettings } from './settings.ts'
import { STATUS_BAR_ID, statusBarView, type StatusBarView } from './status-bar.ts'
// src/protocol.ts types `fleet.*` requests and posts; tsconfig includes it, nothing imports it.

export const PLUGIN_ID = 'fleet-monitor'
/** "Fleet Monitor: Send a test alert": a labelled test notification, through the alerts' own path. */
export const TEST_ALERT_COMMAND_ID = 'fleet.testAlert'
const TICK_MS = 1_000
const STATUS_BAR_DEBOUNCE_MS = 1_000
/** `statusBar.update` failing with `unavailable` for this long, without a success in between,
 *  means this Orca has no status bar. Orca's own desktop and `orca serve` both construct the
 *  status bar service at start-up (src/main/startup/main-process-plugins.ts), so this is a guard
 *  for hosts without one rather than an expected path. */
const HEADLESS_AFTER_MS = 2 * 60_000
/** While judged headless, the status bar is still tried this often. */
const HEADLESS_RETRY_MS = 60_000
const LOG_REPEAT_MS = 10 * 60_000
/** Longest wait for the sampler's own reads (a Mac's memory) before a sample is taken anyway. */
const PREPARE_WAIT_MS = 3_000
/** After memory pressure was last critical, process reads wait this long (one slow `top` beat). */
export const CRITICAL_HOLD_MS = 120_000

export type WorkerOrca = Pick<OrcaWorkerApi, 'settings' | 'panels' | 'host' | 'log' | 'commands'>

export type MonitorDeps = {
  now: () => number
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (handle: unknown) => void
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  /** `prepare`, when there is one, reads what a sample needs that takes a child process (a Mac's
   *  memory) and is awaited before each `sample()`. */
  sampler: { sample(): LocalSample; latest(): LocalSample | null; prepare?(): Promise<void> }
  resolveCli: (override: string | null) => CliResolution
  createRunner: (cliPath: () => string | null) => { run: CommandRunner; stop(): void }
  localName: () => string
  runId: () => string
  /** The worker's own file, from which "Show Fleet Monitor" works out this copy's plugin key. */
  workerFile?: string | null
  /** Worker commands the manifest declares; only those are registered. */
  declaredCommands?: readonly string[]
  /** This computer's platform; process.platform when not given. */
  platform?: string
  /** This computer's processes (src/processes.ts on a Mac, src/linux-processes.ts,
   *  src/win-processes.ts); absent where there are none to list. */
  processes?: ProcessSource | null
  /** Ends whatever the readers keep running that nothing else stops (Windows' PowerShell process). */
  dispose?: () => void
  /** Wall clock, epoch ms (process tables carry wall times); Date.now when not given. */
  wall?: () => number
}

/** What the monitor needs of src/processes.ts's ProcessSampler. */
export type ProcessSource = {
  readonly supported: boolean
  setPublishing(on: boolean): void
  localTable(): Promise<ProcessTable | null>
  publishTable(): Promise<ProcessTable | null>
  stop(): void
  /** True while the list cannot be read on this computer at all (Windows, when PowerShell cannot
   *  run the reader); nothing is published then, and the panel says why. */
  unavailable?(): boolean
}

export type FleetMonitor = {
  poller: FleetPoller
  bridge: PanelBridge
  settings: () => FleetSettings
  /** The status bar fields last sent, or null. */
  statusBar: () => StatusBarView | null
  /** True once the status bar has been unavailable for a while: slow polling then stops. */
  headless: () => boolean
  /** True while slow-mode polling is off: background monitoring turned off, or no status bar. */
  idleWhenSlow: () => boolean
  /** Runs the sampler and beacon once, as the 5 s timer does; with a sampler that prepares, the
   *  promise settles once the beacon is written. */
  sampleNow: () => void | Promise<void>
  alerts: MemoryAlerts
  stop: () => Promise<void>
}

export async function startFleetMonitor(orca: WorkerOrca, deps: MonitorDeps): Promise<FleetMonitor> {
  const lastLogged = new Map<string, number>()
  const logOnce = (key: string, message: string): void => {
    const now = deps.now()
    if ((lastLogged.get(key) ?? Number.NEGATIVE_INFINITY) + LOG_REPEAT_MS > now) return
    lastLogged.set(key, now)
    orca.log(`fleet-monitor: ${message}`)
  }

  let settings = readSettings(await orca.settings.get().catch(() => ({})))
  let cli = deps.resolveCli(settings.cliPath)
  if (cli.error) logOnce('cli', cli.error)
  const platform = deps.platform ?? process.platform
  const launcher = cliLauncherName(platform)
  let poller: FleetPoller | null = null
  const cliInfo = (): CliInfo => ({
    path: cli.path,
    source: cli.source,
    error: cli.error,
    runError: poller?.environmentError() ?? null,
    launcher
  })
  const runner = deps.createRunner(() => cli.path)

  // Status bar: debounced, skipped when unchanged, and given up on where there is none.
  let statusTimer: unknown = null
  let lastStatus: StatusBarView | null = null
  let unavailableSince: number | null = null
  let nextStatusRetryAt = 0
  const headless = (): boolean => unavailableSince !== null && deps.now() - unavailableSince >= HEADLESS_AFTER_MS
  // Slow-mode reads only feed the status bar. With background monitoring off (a server that is
  // there to publish its beacon, say) or no status bar, they would go unused.
  const idleWhenSlow = (): boolean => !settings.backgroundMonitoring || headless()
  const pushStatus = async (): Promise<void> => {
    statusTimer = null
    if (!poller || (headless() && deps.now() < nextStatusRetryAt)) return
    const remotesPaused = !settings.backgroundMonitoring && poller.mode() === 'slow'
    const view = statusBarView(poller.entries().map((e) => e.state), { remotesPaused })
    if (lastStatus && JSON.stringify(lastStatus) === JSON.stringify(view)) return
    try {
      await orca.host.call('statusBar.update', { id: STATUS_BAR_ID, ...view })
      lastStatus = view
      unavailableSince = null
    } catch (error) {
      const code = (error as { code?: unknown }).code
      if (code === 'unavailable') {
        unavailableSince ??= deps.now()
        nextStatusRetryAt = deps.now() + HEADLESS_RETRY_MS
      } else {
        logOnce('status', `status bar update failed: ${String(code ?? error)}`)
      }
    }
  }
  const scheduleStatus = (): void => {
    if (statusTimer === null) statusTimer = deps.setTimeout(() => void pushStatus(), STATUS_BAR_DEBOUNCE_MS)
  }

  // Memory alerts, on every new memory reading of a machine.
  const alerts = new MemoryAlerts({
    now: deps.now,
    enabled: () => settings.memoryAlerts,
    health: () => settings.health,
    memoryRules: () => settings.memoryRules,
    log: (line) => orca.log(`fleet-monitor: ${oneLine(line)}`)
  })
  /** Shows one alert, and writes one line for it to the plugin log with what Orca answered, so
   *  delivery can be checked (`delivered: true` means Orca handed it to the system; Focus or
   *  macOS's notification settings can still hide it). The line never starts like a beacon: the
   *  machine's name in it is on one line, after "fleet-monitor:". */
  const showAlert = async (notice: AlertNotice): Promise<void> => {
    const what = oneLine(`${notice.kind} alert "${notice.title}"`).slice(0, 200)
    try {
      // Only `title` and `body`: Orca refuses a field it does not know.
      const result = (await orca.host.call('notifications.show', { title: notice.title, body: notice.body })) as { delivered?: unknown } | null
      const delivered = result && typeof result === 'object' ? result.delivered : undefined
      orca.log(`fleet-monitor: ${what} sent; Orca answered delivered: ${delivered === true ? 'true' : delivered === false ? 'false' : 'unknown'}`)
    } catch (error) {
      const code = (error as { code?: unknown }).code
      orca.log(`fleet-monitor: ${what} not sent; Orca answered ${oneLine(String(code ?? (error instanceof Error ? error.message : error))).slice(0, 120)}`)
    }
  }

  // One id per worker run: the beacon carries it, and so do the panel posts.
  const runId = deps.runId()
  const wall = deps.wall ?? Date.now
  const processes = deps.processes?.supported ? deps.processes : null
  /** A table's wall time on the worker's clock. */
  const onWorkerClock = (wallAt: number): number => deps.now() - Math.max(0, wall() - wallAt)
  /** When this computer's newest process list was read (worker clock), and its largest process,
   *  last known: replaced only by a newer reading that has memory figures, so it survives a pause
   *  of the sampling (src/merge.ts shows it with its age, and drops it after 15 minutes). The
   *  table itself is not kept for anything. */
  let localListAt: number | null = null
  let localLargest: { largest: TopProcess; at: number } | null = null
  const noteTable = (table: ProcessTable | null): void => {
    if (!table) return
    const takenAt = onWorkerClock(table.takenAt)
    localListAt = takenAt
    const largest = largestProcess(table.rows)
    if (!largest || table.memAgeMs === null) return
    const at = takenAt - table.memAgeMs
    if (!localLargest || at >= localLargest.at) localLargest = { largest, at }
  }
  /** This computer publishes its top processes along with its readings (the beacon setting),
   *  where it can read them. */
  const publishingProcesses = (): boolean => processes !== null && settings.beacon && !processes.unavailable?.()
  /** The background process beat waits while macOS memory pressure is critical, and for
   *  CRITICAL_HOLD_MS after it was last seen critical: a Mac flipping between warning and critical
   *  would otherwise restart `top` (about 2 s of CPU each time) every few seconds, just when it
   *  can least afford it. A reading that says nothing about pressure (none came, or no level in
   *  it) keeps a hold going rather than ending it. A person asking for this computer's list is
   *  still answered (src/processes.ts localTable), critical or not: someone is looking. */
  let criticalUntil = Number.NEGATIVE_INFINITY
  const memoryCritical = (): boolean => {
    const now = deps.now()
    const pressure = deps.sampler.latest()?.macMemory?.pressure ?? null
    if (pressure === 'critical' || (pressure === null && now < criticalUntil)) criticalUntil = now + CRITICAL_HOLD_MS
    return now < criticalUntil
  }
  /** The process beat (one `ps` every PROCESS_INTERVAL_MS, with the slow `top` stream) runs while
   *  the list is published, and while a panel is open here (for this computer's largest process,
   *  which the overview names); not while memory is critical (memoryCritical). An open process
   *  list keeps the fast stream going regardless, until 20 s after its last request. */
  const processBeat = (): boolean => processes !== null && (publishingProcesses() || poller?.mode() === 'fast') && !memoryCritical()
  const syncPublishing = (): void => {
    processes?.setPublishing(processBeat())
  }
  let processSeq = 0
  let processStopped = false
  /** One process beat: this Mac's processes read, and its top list logged for paired desktops
   *  while publishing. */
  const publishProcesses = async (): Promise<void> => {
    syncPublishing()
    if (processStopped || !processes || !processBeat()) return
    const table = await processes.publishTable()
    if (processStopped || !table) return
    noteTable(table)
    if (publishingProcesses()) {
      processSeq += 1
      const line = encodeProcessLine(table, { run: runId, seq: processSeq, intervalMs: PROCESS_INTERVAL_MS })
      if (line) orca.log(line)
    }
    poller?.onLocalProcesses()
  }
  let bridge: PanelBridge | null = null
  const activePoller = new FleetPoller(
    {
      run: runner.run,
      now: deps.now,
      localSample: () => deps.sampler.latest(),
      localName: deps.localName,
      localPlatform: platform,
      pluginId: PLUGIN_ID,
      localProcesses: () => (localListAt === null && !localLargest ? null : { takenAt: localListAt, lastLargest: localLargest }),
      idleWhenSlow,
      onChange: () => {
        bridge?.notify()
        scheduleStatus()
      },
      onMemoryReading: (reading) => {
        const notice = alerts.observe(reading)
        if (notice) void showAlert(notice)
      },
      onMemoryLost: (event) => {
        const notice = alerts.stopped(event)
        if (notice) void showAlert(notice)
      },
      log: (message) => logOnce(message.split(':')[0] ?? message, message)
    },
    settings
  )
  poller = activePoller
  bridge = new PanelBridge({
    source: activePoller,
    post: (payload) => orca.panels.post('fleet.update', payload),
    now: deps.now,
    cli: cliInfo,
    thresholds: () => settings.health,
    run: runId,
    setTimeout: deps.setTimeout,
    clearTimeout: deps.clearTimeout
  })
  const activeBridge = bridge

  const disposables: { dispose(): void }[] = []
  disposables.push(
    orca.panels.handle('fleet.snapshot', () => {
      activePoller.heartbeat()
      return activeBridge.snapshot()
    }),
    orca.panels.handle('fleet.heartbeat', () => {
      activePoller.heartbeat()
      return { ok: true as const, mode: activePoller.mode(), seq: activeBridge.currentSeq }
    }),
    // This computer's whole process list (read only while asked), or a paired Mac's newest top
    // list with its age. Counts as a heartbeat: a panel is open.
    orca.panels.handle('fleet.processes', async (input) => {
      const id = input && typeof input === 'object' && typeof input.id === 'string' ? input.id : null
      if (!id) throw Object.assign(new Error('fleet.processes needs { id }'), { code: 'invalid_params' })
      activePoller.heartbeat()
      if (id !== LOCAL_ID) return remoteAnswer(id, activePoller.stateOf(id), activePoller.processLineOf(id), deps.now())
      if (!processes) return unavailableAnswer(id, 'not-mac', 'full')
      if (processes.unavailable?.()) return unavailableAnswer(id, 'no-reader', 'full')
      const table = await processes.localTable()
      noteTable(table)
      activePoller.onLocalProcesses()
      return localAnswer(id, table, deps.now(), wall())
    }),
    orca.panels.handle('fleet.retry', (input) => {
      const id = input && typeof input === 'object' && typeof input.id === 'string' ? input.id : null
      if (!id) throw Object.assign(new Error('fleet.retry needs { id }'), { code: 'invalid_params' })
      activePoller.heartbeat()
      return { ok: activePoller.retry(id) }
    })
  )

  const reloadSettings = async (): Promise<void> => {
    const next = readSettings(await orca.settings.get().catch(() => ({})))
    if (next.cliPath !== settings.cliPath) {
      cli = deps.resolveCli(next.cliPath)
      if (cli.error) logOnce('cli', cli.error)
    }
    settings = next
    activePoller.updateSettings(next)
    syncPublishing()
  }
  disposables.push(orca.settings.onDidChange(() => void reloadSettings()))
  // "Show Fleet Monitor", run by the status bar item. Orca stops a worker that registers a command
  // its manifest does not declare, so it is registered only when declared.
  if (deps.declaredCommands?.includes(SHOW_COMMAND_ID)) {
    disposables.push(
      orca.commands.register(SHOW_COMMAND_ID, async () => {
        await openOwnPanel(runner.run, PLUGIN_ID, deps.workerFile ?? null)
      })
    )
  }
  // "Fleet Monitor: Send a test alert": so a person can check that this computer shows them.
  if (deps.declaredCommands?.includes(TEST_ALERT_COMMAND_ID)) {
    disposables.push(
      orca.commands.register(TEST_ALERT_COMMAND_ID, async () => {
        await showAlert(alerts.testNotice())
      })
    )
  }


  // The beacon has its own timer so a slow or hung CLI call never delays it.
  let seq = 0
  let stopped = false
  let preparing = false
  const takeSample = (): void => {
    if (stopped) return
    const sample = deps.sampler.sample()
    syncPublishing()
    if (settings.beacon) {
      seq += 1
      const line = encodeBeacon(sample, { run: runId, seq, intervalMs: BEACON_INTERVAL_MS, processes: processes?.unavailable?.() ? 'unavailable' : publishingProcesses() })
      if (line) orca.log(line)
    }
    activePoller.onLocalSample()
  }
  const sampleNow = (): void | Promise<void> => {
    const prepare = deps.sampler.prepare
    if (!prepare) {
      takeSample()
      return
    }
    // One sample per read. A read still running (each command has a 2 s timeout) takes this
    // tick's sample when it ends; one that somehow never ends is not waited for past
    // PREPARE_WAIT_MS, so the beacon never stops.
    if (preparing) return
    preparing = true
    return new Promise<void>((resolve) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        preparing = false
        deps.clearTimeout(timer)
        takeSample()
        resolve()
      }
      const timer = deps.setTimeout(finish, PREPARE_WAIT_MS)
      prepare.call(deps.sampler).then(finish, finish)
    })
  }
  const sampleTimer = deps.setInterval(() => void sampleNow(), BEACON_INTERVAL_MS)
  const processTimer = deps.setInterval(() => void publishProcesses(), PROCESS_INTERVAL_MS)
  syncPublishing()
  const tickTimer = deps.setInterval(() => activePoller.tick(), TICK_MS)
  activePoller.tick()
  scheduleStatus()

  return {
    poller: activePoller,
    bridge: activeBridge,
    settings: () => settings,
    statusBar: () => lastStatus,
    headless,
    idleWhenSlow,
    sampleNow,
    alerts,
    stop: async () => {
      stopped = true
      deps.clearInterval(sampleTimer)
      deps.clearInterval(processTimer)
      deps.clearInterval(tickTimer)
      processStopped = true
      processes?.stop()
      deps.dispose?.()
      if (statusTimer !== null) deps.clearTimeout(statusTimer)
      activeBridge.dispose()
      activePoller.stop()
      runner.stop()
      for (const d of disposables) d.dispose()
    }
  }
}
