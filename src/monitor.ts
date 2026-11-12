// Wires the pieces together inside a worker. Everything that touches the outside world comes in
// through `MonitorDeps`, so tests run the real wiring with a fake CLI and a fake clock.
import type { OrcaWorkerApi } from 'orca/worker'
import { BEACON_INTERVAL_MS, encodeBeacon } from './beacon.ts'
import { PanelBridge } from './bridge.ts'
import type { CliResolution, CommandRunner } from './cli.ts'
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

export type WorkerOrca = Pick<OrcaWorkerApi, 'settings' | 'panels' | 'host' | 'log' | 'commands'>

export type MonitorDeps = {
  now: () => number
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (handle: unknown) => void
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  sampler: { sample(): LocalSample; latest(): LocalSample | null }
  resolveCli: (override: string | null) => CliResolution
  createRunner: (cliPath: () => string | null) => { run: CommandRunner; stop(): void }
  localName: () => string
  runId: () => string
  /** The worker's own file, from which "Show Fleet Monitor" works out this copy's plugin key. */
  workerFile?: string | null
  /** Worker commands the manifest declares; only those are registered. */
  declaredCommands?: readonly string[]
}

export type FleetMonitor = {
  poller: FleetPoller
  bridge: PanelBridge
  settings: () => FleetSettings
  /** The status bar fields last sent, or null. */
  statusBar: () => StatusBarView | null
  /** True once the status bar has been unavailable for a while: slow polling then stops. */
  headless: () => boolean
  /** Runs the sampler and beacon once, as the 5 s timer does. */
  sampleNow: () => void
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
  const cliInfo = (): CliInfo => ({ path: cli.path, source: cli.source, error: cli.error })
  const runner = deps.createRunner(() => cli.path)

  // Status bar: debounced, skipped when unchanged, and given up on where there is none.
  let statusTimer: unknown = null
  let lastStatus: StatusBarView | null = null
  let unavailableSince: number | null = null
  let nextStatusRetryAt = 0
  const headless = (): boolean => unavailableSince !== null && deps.now() - unavailableSince >= HEADLESS_AFTER_MS
  const pushStatus = async (): Promise<void> => {
    statusTimer = null
    if (headless() && deps.now() < nextStatusRetryAt) return
    const view = statusBarView(poller.entries().map((e) => e.state))
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

  // One id per worker run: the beacon carries it, and so do the panel posts.
  const runId = deps.runId()
  let bridge: PanelBridge | null = null
  const poller = new FleetPoller(
    {
      run: runner.run,
      now: deps.now,
      localSample: () => deps.sampler.latest(),
      localName: deps.localName,
      pluginId: PLUGIN_ID,
      // Nobody sees slow-mode results on a server without a status bar; only the beacon runs.
      idleWhenSlow: headless,
      onChange: () => {
        bridge?.notify()
        scheduleStatus()
      },
      log: (message) => logOnce(message.split(':')[0] ?? message, message)
    },
    settings
  )
  bridge = new PanelBridge({
    source: poller,
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
      poller.heartbeat()
      return activeBridge.snapshot()
    }),
    orca.panels.handle('fleet.heartbeat', () => {
      poller.heartbeat()
      return { ok: true as const, mode: poller.mode(), seq: activeBridge.currentSeq }
    }),
    orca.panels.handle('fleet.retry', (input) => {
      const id = input && typeof input === 'object' && typeof input.id === 'string' ? input.id : null
      if (!id) throw Object.assign(new Error('fleet.retry needs { id }'), { code: 'invalid_params' })
      poller.heartbeat()
      return { ok: poller.retry(id) }
    })
  )

  const reloadSettings = async (): Promise<void> => {
    const next = readSettings(await orca.settings.get().catch(() => ({})))
    if (next.cliPath !== settings.cliPath) {
      cli = deps.resolveCli(next.cliPath)
      if (cli.error) logOnce('cli', cli.error)
    }
    settings = next
    poller.updateSettings(next)
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
  const sampleNow = (): void => {
    const sample = deps.sampler.sample()
    if (settings.beacon) {
      seq += 1
      const line = encodeBeacon(sample, { run: runId, seq, intervalMs: BEACON_INTERVAL_MS })
      if (line) orca.log(line)
    }
    poller.onLocalSample()
  }
  const sampleTimer = deps.setInterval(sampleNow, BEACON_INTERVAL_MS)
  const tickTimer = deps.setInterval(() => poller.tick(), TICK_MS)
  poller.tick()
  scheduleStatus()

  return {
    poller,
    bridge: activeBridge,
    settings: () => settings,
    statusBar: () => lastStatus,
    headless,
    sampleNow,
    stop: async () => {
      deps.clearInterval(sampleTimer)
      deps.clearInterval(tickTimer)
      if (statusTimer !== null) deps.clearTimeout(statusTimer)
      activeBridge.dispose()
      poller.stop()
      runner.stop()
      for (const d of disposables) d.dispose()
    }
  }
}
