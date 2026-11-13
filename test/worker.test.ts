// The real wiring (src/monitor.ts) under Orca's mountWorker, with a fake CLI and a fake clock, so
// no real `orca` command runs. The worker's default export is exercised for its shape only.
import { readFileSync } from 'node:fs'
import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import { toFleet } from '../panel/fleet-binding.mjs'
import { BEACON_PREFIX, decodeBeacon } from '../src/beacon.ts'
import type { FleetSnapshot } from '../src/model.ts'
import { startFleetMonitor, type FleetMonitor, type MonitorDeps } from '../src/monitor.ts'
import * as worker from '../src/worker.ts'
import type { JsonValue, OrcaWorkerApi } from 'orca/worker'
import { diagnosticsFor, envelope, FakeCli, FakeTime, flush, localSample, okResult } from './helpers.ts'

function fakeDeps(time: FakeTime, cli: FakeCli, override: { cliPath?: string | null; platform?: string; more?: Partial<MonitorDeps> } = {}): MonitorDeps {
  let reading = 0
  let last: ReturnType<typeof localSample> | null = null
  return {
    now: time.now,
    setInterval: time.setInterval,
    clearInterval: time.clearInterval,
    setTimeout: time.setTimeout,
    clearTimeout: time.clearTimeout,
    sampler: {
      sample: () => {
        reading += 1
        last = localSample({ t: time.now(), cpu: { total: 20 + reading, perCore: [20, 22, 24, 26] } })
        return last
      },
      latest: () => last
    },
    resolveCli: (cliPath) =>
      cliPath === '/bad/orca'
        ? { path: null, source: 'setting', tried: [cliPath], error: 'The CLI path in settings cannot be run: /bad/orca' }
        : { path: override.cliPath ?? '/fake/orca', source: 'bundled', tried: [], error: null },
    createRunner: () => ({ run: cli.run, stop: () => {} }),
    localName: () => 'this-desktop',
    runId: () => 'cafe01',
    workerFile: '/home/u/code/orca-fleet-monitor/src/worker.ts',
    declaredCommands: ['fleet.show'],
    platform: override.platform ?? 'darwin',
    ...override.more
  }
}

function fakeCli(time: FakeTime, options: { failList?: () => boolean } = {}): FakeCli {
  return new FakeCli(time, (args) => {
    if (args[0] === 'environment' && options.failList?.()) return { ...okResult(''), spawnError: 'spawn EACCES' }
    if (args[0] === 'environment') {
      return okResult(envelope({ environments: [{ id: 'env-a', name: 'Build Box', runtimeId: 'rt-a' }] }, { runtimeId: 'local' }))
    }
    if (args[0] === 'diagnostics') return okResult(diagnosticsFor({ collectedAt: time.now(), load1: 4, cores: 8 }))
    if (args[0] === 'plugin' && args[1] === 'list' && !args.includes('--environment')) {
      return okResult(envelope({ plugins: [{ pluginKey: 'local.fleet-monitor', status: 'running', isDev: true, panels: [{ id: 'fleet' }] }] }))
    }
    if (args[0] === 'plugin' && args[1] === 'list') return okResult(envelope({ plugins: [] }))
    if (args[0] === 'plugin' && args[1] === 'open') return okResult(envelope({ pluginKey: args[2], panelId: 'fleet' }))
    return okResult(envelope(null))
  })
}

async function mount(
  settings: Record<string, JsonValue> = {},
  statusBar?: () => unknown,
  options: { platform?: string; failList?: () => boolean } = {}
) {
  const time = new FakeTime()
  const cli = fakeCli(time, { failList: options.failList })
  let monitor: FleetMonitor | null = null
  let workerOrca: OrcaWorkerApi | null = null
  const host = mockHost(statusBar ? { settings, results: { 'statusBar.update': statusBar } } : { settings })
  const mounted = await mountWorker(
    {
      default: async (orca) => {
        workerOrca = orca
        monitor = await startFleetMonitor(orca, fakeDeps(time, cli, { platform: options.platform }))
      },
      deactivate: async () => monitor?.stop()
    },
    { host }
  )
  const settle = async () => {
    for (let i = 0; i < 10; i += 1) {
      await flush()
      time.advance(0)
    }
  }
  return { time, cli, mounted, host, monitor: () => monitor!, orca: () => workerOrca!, settle }
}

test('the worker module has the shape Orca calls', () => {
  assert.equal(typeof worker.default, 'function')
  assert.equal(typeof worker.deactivate, 'function')
  assert.equal(worker.localMachineName('build-box.local'), 'build-box')
  assert.equal(worker.localMachineName('Example.localdomain'), 'Example')
  assert.equal(worker.localMachineName('192.0.2.7'), '192.0.2.7')
  assert.equal(worker.localMachineName(''), 'This machine')
})

test('answers fleet.snapshot and fleet.heartbeat, and a heartbeat turns on fast polling', async () => {
  const t = await mount()
  const snap = (await t.mounted.request('fleet.snapshot')) as FleetSnapshot
  assert.equal(snap.v, 1)
  assert.equal(snap.mode, 'fast')
  assert.equal(snap.machines[0]?.id, 'local')
  assert.equal(snap.machines[0]?.name, 'this-desktop')
  assert.equal(snap.cli.source, 'bundled')
  assert.deepEqual(snap.thresholds.cpu, { busy: 70, strained: 85, critical: 95 }, 'thresholds travel with the snapshot')
  await t.settle()
  const beat = (await t.mounted.request('fleet.heartbeat')) as { ok: boolean; mode: string }
  assert.deepEqual([beat.ok, beat.mode], [true, 'fast'])
  const machines = t.monitor().poller.entries().map((e) => e.state.id)
  assert.deepEqual(machines, ['local', 'env-a'])
  assert.deepEqual(t.mounted.refusals, [])
  await t.mounted.deactivate()
})

test('this computer is tagged by its platform from the first answer, before the sampler has read it', async () => {
  for (const [platform, tag] of [['darwin', 'This Mac'], ['win32', 'This PC'], ['linux', 'This machine']] as const) {
    const t = await mount({}, undefined, { platform })
    const snap = (await t.mounted.request('fleet.snapshot')) as FleetSnapshot
    assert.equal(t.monitor().poller.entries()[0]?.state.host.hostname, null, 'no sample yet')
    assert.equal(snap.machines[0]?.host.platform, platform)
    const local = toFleet({ ready: true, error: null, ...snap }, t.time.now()).machines[0]!
    assert.equal(local.tag, tag)
    await t.mounted.deactivate()
  }
})

test('writes a beacon line every 5 s that decodes back', async () => {
  const t = await mount()
  t.time.advance(5_000)
  t.time.advance(5_000)
  const beacons = t.mounted.logs.filter((line) => line.startsWith(BEACON_PREFIX))
  assert.equal(beacons.length, 2)
  const decoded = beacons.map((line) => decodeBeacon(line))
  assert.deepEqual(decoded.map((b) => [b?.run, b?.seq]), [['cafe01', 1], ['cafe01', 2]])
  assert.ok(beacons.every((line) => line.length < 4_096))
  await t.mounted.deactivate()
})

test('the beacon can be turned off in settings', async () => {
  const t = await mount({ beacon: false })
  t.time.advance(10_000)
  assert.equal(t.mounted.logs.filter((line) => line.startsWith(BEACON_PREFIX)).length, 0)
  await t.mounted.deactivate()
})

test('posts fleet.update to open panels and keeps the status bar item current', async () => {
  const t = await mount()
  await t.mounted.request('fleet.heartbeat')
  await t.settle()
  t.time.advance(1_000)
  await t.settle()
  const posts = t.mounted.posts.filter((p) => p.event === 'fleet.update')
  assert.ok(posts.length >= 1)
  const last = posts[posts.length - 1]!.payload as { machines: { id: string }[]; seq: number }
  assert.deepEqual(last.machines.map((m) => m.id), ['local', 'env-a'])
  const statusCalls = t.host.callsOf('statusBar.update') as { id: string; text: string; tone: string }[]
  assert.ok(statusCalls.length >= 1)
  assert.equal(statusCalls[statusCalls.length - 1]!.id, 'fleet')
  assert.match(statusCalls[statusCalls.length - 1]!.text, /Build Box busy|machines ok/)
  assert.deepEqual(t.mounted.refusals, [])
  await t.mounted.deactivate()
})

test('reads settings, and follows a change', async () => {
  const t = await mount({ fastIntervalSeconds: 3, cpuBusyPercent: 40 })
  assert.equal(t.monitor().settings().fastIntervalMs, 3_000)
  assert.equal(t.monitor().settings().health.cpu.busy, 40)
  await t.mounted.request('fleet.heartbeat')
  assert.equal(t.monitor().poller.intervalMs(), 3_000)
  await t.orca().settings.set('fastIntervalSeconds', 7)
  await t.settle()
  assert.equal(t.monitor().settings().fastIntervalMs, 7_000)
  assert.equal(t.monitor().poller.intervalMs(), 7_000)
  await t.orca().settings.set('cliPath', '/bad/orca')
  await t.settle()
  const snap = (await t.mounted.request('fleet.snapshot')) as FleetSnapshot
  assert.match(snap.cli.error ?? '', /cannot be run/)
  assert.deepEqual(t.mounted.refusals, [])
  await t.mounted.deactivate()
})

test('fleet.retry reads a machine now, and refuses a request without an id', async () => {
  const t = await mount()
  await t.mounted.request('fleet.heartbeat')
  await t.settle()
  const before = t.cli.count((a) => a[0] === 'diagnostics' && a.includes('env-a'))
  const answer = (await t.mounted.request('fleet.retry', { id: 'env-a' })) as { ok: boolean }
  assert.equal(answer.ok, true)
  await t.settle()
  assert.ok(t.cli.count((a) => a[0] === 'diagnostics' && a.includes('env-a')) > before)
  assert.deepEqual(await t.mounted.request('fleet.retry', { id: 'no-such-machine' }), { ok: false })
  let code: unknown = null
  try {
    await t.mounted.request('fleet.retry', {} as { id: string }) // deliberately without the id
  } catch (error) {
    code = (error as { code?: unknown }).code
  }
  assert.equal(code, 'invalid_params')
  await t.mounted.deactivate()
})

test('the status bar command shows the panel through the CLI, on this machine only', async () => {
  const t = await mount()
  await t.mounted.command('fleet.show')
  const opens = t.cli.calls.filter((c) => c.args[0] === 'plugin' && c.args[1] === 'open').map((c) => c.args)
  assert.deepEqual(opens, [['plugin', 'open', 'local.fleet-monitor', '--panel', 'fleet', '--json']])
  assert.deepEqual(t.mounted.refusals, [])
  await t.mounted.deactivate()
})

test('declaredCommands follows the manifest and fails closed', () => {
  const manifest = (commands: unknown) => () => JSON.stringify({ contributes: { commands } })
  assert.deepEqual(worker.declaredCommands(manifest([{ id: 'fleet.show', title: 'Show' }, { id: 'x', title: 'X', action: 'view.tasks' }])), ['fleet.show'])
  assert.deepEqual(worker.declaredCommands(manifest(undefined)), [])
  assert.deepEqual(worker.declaredCommands(() => 'not json'), [])
  assert.deepEqual(worker.declaredCommands(() => {
    throw new Error('no file')
  }), [])
  assert.ok(worker.declaredCommands().includes('fleet.show'), 'this repository declares it')
})

// Windows: the PowerShell process the readers share is stopped by nothing else.
test('stopping the monitor stops the process list and whatever the readers keep running', async () => {
  const time = new FakeTime()
  const cli = fakeCli(time)
  const stopped: string[] = []
  const processes = { supported: true, setPublishing: () => {}, localTable: async () => null, publishTable: async () => null, stop: () => void stopped.push('processes') }
  const mounted = await mountWorker(
    {
      default: async (orca) => {
        const monitor = await startFleetMonitor(orca, fakeDeps(time, cli, { platform: 'win32', more: { processes, dispose: () => void stopped.push('dispose') } }))
        await monitor.stop()
      },
      deactivate: async () => {}
    },
    { host: mockHost({ settings: {} }) }
  )
  assert.deepEqual(stopped, ['processes', 'dispose'])
  await mounted.deactivate()
})

// Windows, where PowerShell cannot run the reader: said in the answer and in the beacon.
test('a process list that cannot be read here is answered and published as that, not as waiting', async () => {
  const time = new FakeTime()
  const cli = fakeCli(time)
  let asked = 0
  const processes = {
    supported: true,
    setPublishing: () => {},
    localTable: async () => {
      asked += 1
      return null
    },
    publishTable: async () => null,
    stop: () => {},
    unavailable: () => true
  }
  let monitor: FleetMonitor | null = null
  const mounted = await mountWorker(
    {
      default: async (orca) => {
        monitor = await startFleetMonitor(orca, fakeDeps(time, cli, { platform: 'win32', more: { processes } }))
      },
      deactivate: async () => monitor?.stop()
    },
    { host: mockHost({ settings: {} }) }
  )
  const answer = (await mounted.request('fleet.processes', { id: 'local' })) as { state: string; reason: string }
  assert.deepEqual([answer.state, answer.reason], ['unavailable', 'no-reader'])
  assert.equal(asked, 0, 'nothing is read')
  time.advance(5_000)
  await flush()
  const beacons = mounted.logs.filter((line) => line.startsWith(BEACON_PREFIX))
  assert.ok(beacons.length > 0)
  assert.ok(beacons.every((line) => line.includes('"pl":2')), 'the beacon says it cannot list them')
  await mounted.deactivate()
})

test('deactivate stops every timer', async () => {
  const t = await mount()
  assert.ok(t.time.pending > 0)
  await t.mounted.deactivate()
  await t.settle()
  assert.equal(t.time.pending, 0)
  const before = t.cli.calls.length
  t.time.advance(120_000)
  assert.equal(t.cli.calls.length, before)
})

/** Moves the fake clock in 1 s steps, letting host calls answer in between. */
async function runFor(t: Awaited<ReturnType<typeof mount>>, ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += 1_000) {
    t.time.advance(1_000)
    await flush()
  }
}

test('a status bar that is briefly unavailable is not taken for a headless host', async () => {
  let calls = 0
  const t = await mount({}, () => {
    calls += 1
    if (calls <= 2) throw hostError('unavailable', 'not ready')
    return { ok: true }
  })
  await runFor(t, 180_000)
  assert.equal(t.monitor().headless(), false)
  assert.ok(t.monitor().statusBar(), 'the item was set once it became available')
  const before = t.cli.calls.length
  await runFor(t, 120_000)
  assert.ok(t.cli.calls.length > before, 'slow polling carries on')
  await t.mounted.deactivate()
})

test('a status bar unavailable for two minutes stops slow polling, but not the beacon or a panel', async () => {
  let attempts = 0
  const t = await mount({}, () => {
    attempts += 1
    throw hostError('unavailable', 'this Orca has no status bar')
  })
  await runFor(t, 130_000)
  assert.equal(t.monitor().headless(), true)
  const attemptsAtHeadless = attempts
  const callsAtHeadless = t.cli.calls.length
  await runFor(t, 300_000)
  assert.equal(t.cli.calls.length, callsAtHeadless, 'no CLI calls in slow mode')
  assert.ok(attempts - attemptsAtHeadless <= 6, 'the status bar is retried about once a minute')
  assert.ok(t.mounted.logs.filter((line) => line.startsWith(BEACON_PREFIX)).length > 80, 'the beacon keeps going')
  await t.mounted.request('fleet.heartbeat')
  await t.settle()
  assert.ok(t.cli.calls.length > callsAtHeadless, 'an open panel still polls')
  await t.mounted.deactivate()
})

test('with background monitoring off, a machine only publishes its beacon until a panel opens', async () => {
  const t = await mount({ backgroundMonitoring: false })
  assert.equal(t.monitor().settings().backgroundMonitoring, false)
  await runFor(t, 300_000)
  assert.equal(t.cli.calls.length, 0, 'no CLI calls with no panel open')
  assert.ok(t.mounted.logs.filter((line) => line.startsWith(BEACON_PREFIX)).length >= 59, 'the beacon keeps going')
  await t.mounted.request('fleet.heartbeat')
  await t.settle()
  assert.ok(t.cli.count((a) => a[0] === 'diagnostics' && a.includes('env-a')) >= 1, 'an open panel reads every machine')
  await runFor(t, 30_000) // the panel closes: fast mode lingers 15 s, then nothing
  const afterPanel = t.cli.calls.length
  await runFor(t, 300_000)
  assert.equal(t.cli.calls.length, afterPanel)
  const status = t.host.callsOf('statusBar.update') as { text: string; tooltip: string }[]
  const last = status[status.length - 1]!
  // (The fake sampler's CPU climbs with every reading, so this computer's own level varies.)
  assert.ok(!/Build Box/.test(last.text) && !/Build Box/.test(last.tooltip), 'paired machines are not summed up from stale readings')
  assert.match(last.tooltip, /background monitoring is off/)
  await t.mounted.deactivate()
})

test('the manifest declares the background monitoring setting, on by default', () => {
  const manifest = JSON.parse(readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8')) as {
    contributes: { settings: { key: string; type: string; default: unknown }[] }
  }
  const setting = manifest.contributes.settings.find((s) => s.key === 'backgroundMonitoring')
  assert.deepEqual(setting && [setting.type, setting.default], ['boolean', true])
})

test('the snapshot says why paired machines cannot be listed, and what the CLI is called here', async () => {
  let failing = true
  const t = await mount({}, undefined, { platform: 'linux', failList: () => failing })
  const snap = (await t.mounted.request('fleet.snapshot')) as FleetSnapshot
  await t.settle()
  const again = (await t.mounted.request('fleet.snapshot')) as FleetSnapshot
  assert.equal(again.cli.runError, 'spawn EACCES')
  assert.equal(snap.cli.launcher, 'orca-ide')
  failing = false
  await runFor(t, 31_000)
  const later = (await t.mounted.request('fleet.snapshot')) as FleetSnapshot
  assert.equal(later.cli.runError, null)
  await t.mounted.deactivate()
})
