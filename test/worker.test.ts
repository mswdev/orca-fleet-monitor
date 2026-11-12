// The real wiring (src/monitor.ts) under Orca's mountWorker, with a fake CLI and a fake clock, so
// no real `orca` command runs. The worker's default export is exercised for its shape only.
import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import { BEACON_PREFIX, decodeBeacon } from '../src/beacon.ts'
import type { FleetSnapshot } from '../src/model.ts'
import { startFleetMonitor, type FleetMonitor, type MonitorDeps } from '../src/monitor.ts'
import * as worker from '../src/worker.ts'
import type { JsonValue, OrcaWorkerApi } from 'orca/worker'
import { diagnosticsFor, envelope, FakeCli, FakeTime, flush, localSample, okResult } from './helpers.ts'

function fakeDeps(time: FakeTime, cli: FakeCli, override: { cliPath?: string | null } = {}): MonitorDeps {
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
    runId: () => 'cafe01'
  }
}

function fakeCli(time: FakeTime): FakeCli {
  return new FakeCli(time, (args) => {
    if (args[0] === 'environment') {
      return okResult(envelope({ environments: [{ id: 'env-a', name: 'Build Box', runtimeId: 'rt-a' }] }, { runtimeId: 'local' }))
    }
    if (args[0] === 'diagnostics') return okResult(diagnosticsFor({ collectedAt: time.now(), load1: 4, cores: 8 }))
    if (args[0] === 'plugin' && args[1] === 'list') return okResult(envelope({ plugins: [] }))
    return okResult(envelope(null))
  })
}

async function mount(settings: Record<string, JsonValue> = {}, statusBar?: () => unknown) {
  const time = new FakeTime()
  const cli = fakeCli(time)
  let monitor: FleetMonitor | null = null
  let workerOrca: OrcaWorkerApi | null = null
  const host = mockHost(statusBar ? { settings, results: { 'statusBar.update': statusBar } } : { settings })
  const mounted = await mountWorker(
    {
      default: async (orca) => {
        workerOrca = orca
        monitor = await startFleetMonitor(orca, fakeDeps(time, cli))
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
  await t.settle()
  const beat = (await t.mounted.request('fleet.heartbeat')) as { ok: boolean; mode: string }
  assert.deepEqual([beat.ok, beat.mode], [true, 'fast'])
  const machines = t.monitor().poller.entries().map((e) => e.state.id)
  assert.deepEqual(machines, ['local', 'env-a'])
  assert.deepEqual(t.mounted.refusals, [])
  await t.mounted.deactivate()
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
