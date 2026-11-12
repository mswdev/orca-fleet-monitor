// Wires the pieces together inside a worker. Everything that touches the outside world comes in
// through `MonitorDeps`, so tests run the real wiring with a fake CLI and a fake clock.
import type { OrcaWorkerApi } from 'orca/worker'
import { MemoryAlerts, type AlertNotice } from './alerts.ts'
import { BEACON_INTERVAL_MS, encodeBeacon } from './beacon.ts'
import { PanelBridge } from './bridge.ts'
import { cliLauncherName, type CliResolution, type CommandRunner } from './cli.ts'
import type { CliInfo, LocalSample } from './model.ts'
import { openOwnPanel, SHOW_COMMAND_ID } from './open-panel.ts'
import { FleetPoller } from './poller.ts'
import { readSettings, type FleetSettings } from './settings.ts'
import { STATUS_BAR_ID, statusBarView, type StatusBarView } from './status-bar.ts'
// src/protocol.ts types `fleet.*` requests and posts; tsconfig includes it, nothing imports it.

export const PLUGIN_ID = 'fleet-monitor'
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
    memoryRules: () => settings.memoryRules
  })
  const showAlert = async (notice: AlertNotice): Promise<void> => {
    try {
      // Only `title` and `body`: Orca refuses a field it does not know.
      const result = (await orca.host.call('notifications.show', { title: notice.title, body: notice.body })) as { delivered?: unknown } | null
      if (result?.delivered !== true) logOnce('notify-undelivered', 'a memory alert was not shown as a desktop notification here')
    } catch (error) {
      const code = (error as { code?: unknown }).code
      logOnce('notify', `memory alert failed: ${String(code ?? error)}`)
    }
  }

  // One id per worker run: the beacon carries it, and so do the panel posts.
  const runId = deps.runId()
  let bridge: PanelBridge | null = null
  const activePoller = new FleetPoller(
    {
      run: runner.run,
      now: deps.now,
      localSample: () => deps.sampler.latest(),
      localName: deps.localName,
      localPlatform: platform,
      pluginId: PLUGIN_ID,
      idleWhenSlow,
      onChange: () => {
        bridge?.notify()
        scheduleStatus()
      },
      onMemoryReading: (state) => {
        const notice = alerts.observe(state)
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


  // The beacon has its own timer so a slow or hung CLI call never delays it.
  let seq = 0
  let stopped = false
  let preparing = false
  const takeSample = (): void => {
    if (stopped) return
    const sample = deps.sampler.sample()
    if (settings.beacon) {
      seq += 1
      const line = encodeBeacon(sample, { run: runId, seq, intervalMs: BEACON_INTERVAL_MS })
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
      deps.clearInterval(tickTimer)
      if (statusTimer !== null) deps.clearTimeout(statusTimer)
      activeBridge.dispose()
      activePoller.stop()
      runner.stop()
      for (const d of disposables) d.dispose()
    }
  }
}
