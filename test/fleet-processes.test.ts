// `fleet.processes` and the process line through the real wiring (src/monitor.ts) under Orca's
// mountWorker: a fake CLI, a fake clock and a fake process source. Every value here is invented.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { JsonValue } from 'orca/worker'
import { BEACON_PREFIX, decodeBeacon, encodeBeacon } from '../src/beacon.ts'
import type { LocalSample, MacMemory, ProcessList, ProcessRow } from '../src/model.ts'
import { startFleetMonitor, type FleetMonitor, type MonitorDeps, type ProcessSource } from '../src/monitor.ts'
import { encodeProcessLine, PROCESS_INTERVAL_MS, PROCESS_PREFIX } from '../src/process-line.ts'
import type { ProcessTable } from '../src/processes.ts'
import { diagnosticsFor, envelope, FakeCli, FakeTime, flush, localSample, macMemory, okResult } from './helpers.ts'

const row = (pid: number, mem: number, name = `tool-${pid}`): ProcessRow => ({ pid, ppid: 1, name, user: 'example', cpu: 1, mem, energy: 0, start: 1_800_000_000 })

function fakeProcesses(time: FakeTime) {
  const calls = { publishing: [] as boolean[], local: 0, publish: 0, stopped: 0 }
  /** `footprints` false: as while `top` has no sample (just restarted, or paused). */
  const sim = { footprints: true, big: { pid: 11, name: 'Big Example' } }
  const table = (): ProcessTable => {
    const mem = (n: number) => (sim.footprints ? n : null)
    const rows = [row(10, 5_000), row(sim.big.pid, 9_000, sim.big.name), row(12, 1_000)].map((r) => ({ ...r, mem: mem(r.mem!) }))
    return { takenAt: time.now() - 1_000, rows, cpuWindowMs: 3_000, memAgeMs: sim.footprints ? 2_000 : null, energyWindowMs: 3_000, total: 3 }
  }
  const source: ProcessSource = {
    supported: true,
    setPublishing: (on) => void calls.publishing.push(on),
    localTable: async () => {
      calls.local += 1
      return table()
    },
    publishTable: async () => {
      calls.publish += 1
      return table()
    },
    stop: () => void (calls.stopped += 1)
  }
  return { source, calls, sim }
}

/** A remote Mac with Fleet Monitor 1.2: beacons every 5 s and a process line. */
function remoteLogs(time: FakeTime, options: { run?: string; processes?: boolean; lineRun?: string; skewMs?: number; lineAgoMs?: number } = {}): string {
  const run = options.run ?? 'run-r'
  const remoteNow = time.now() + (options.skewMs ?? 0)
  const lines: { ts: number; level: string; line: string }[] = []
  for (let i = 5; i >= 0; i -= 1) {
    const t = remoteNow - i * 5_000
    lines.push({ ts: t, level: 'info', line: encodeBeacon(localSample({ t, platform: 'darwin' }), { run, seq: 100 - i, intervalMs: 5_000, processes: options.processes ?? true })! })
  }
  const procTable: ProcessTable = { takenAt: remoteNow - (options.lineAgoMs ?? 10_000), rows: [row(70, 2 ** 30, 'Remote Big'), row(71, 2 ** 20)], cpuWindowMs: 30_000, memAgeMs: 50_000, energyWindowMs: 120_000, total: 640 }
  lines.push({ ts: remoteNow, level: 'info', line: encodeProcessLine(procTable, { run: options.lineRun ?? run, seq: 4, intervalMs: PROCESS_INTERVAL_MS })! })
  return envelope({ pluginKey: 'example.fleet-monitor', lines })
}

async function mount(settings: Record<string, JsonValue> = {}, options: { supported?: boolean; pressure?: MacMemory['pressure'] | (() => MacMemory['pressure']); logs?: (time: FakeTime) => string; skewMs?: number } = {}) {
  const time = new FakeTime()
  const procs = fakeProcesses(time)
  const cli = new FakeCli(time, (args) => {
    if (args[0] === 'environment') return okResult(envelope({ environments: [{ id: 'env-r', name: 'Remote Mac', runtimeId: 'rt-r' }] }, { runtimeId: 'local' }))
    if (args[0] === 'diagnostics') return okResult(diagnosticsFor({ collectedAt: time.now() + (args.includes('--environment') ? (options.skewMs ?? 0) : 0), memorySource: 'memory-pressure' }))
    if (args[0] === 'plugin' && args[1] === 'list') return okResult(envelope({ plugins: args.includes('--environment') ? [{ pluginKey: 'example.fleet-monitor', status: 'running' }] : [] }))
    if (args[0] === 'plugin' && args[1] === 'logs') return okResult((options.logs ?? remoteLogs)(time))
    return okResult(envelope(null))
  })
  let last: LocalSample | null = null
  const deps: MonitorDeps = {
    now: time.now,
    wall: time.now,
    setInterval: time.setInterval,
    clearInterval: time.clearInterval,
    setTimeout: time.setTimeout,
    clearTimeout: time.clearTimeout,
    sampler: {
      sample: () => (last = localSample({ t: time.now(), platform: 'darwin', macMemory: macMemory({ pressure: typeof options.pressure === 'function' ? options.pressure() : (options.pressure ?? 'normal') }) })),
      latest: () => last
    },
    resolveCli: () => ({ path: '/fake/orca', source: 'bundled', tried: [], error: null }),
    createRunner: () => ({ run: cli.run, stop: () => {} }),
    localName: () => 'this-desktop',
    runId: () => 'cafe02',
    declaredCommands: [],
    platform: 'darwin',
    processes: options.supported === false ? { ...procs.source, supported: false } : procs.source
  }
  let monitor: FleetMonitor | null = null
  const mounted = await mountWorker(
    {
      default: async (orca) => {
        monitor = await startFleetMonitor(orca, deps)
      },
      deactivate: async () => monitor?.stop()
    },
    { host: mockHost({ settings }) }
  )
  const settle = async () => {
    for (let i = 0; i < 10; i += 1) {
      await flush()
      time.advance(0)
    }
  }
  const run = async (ms: number) => {
    for (let at = 0; at < ms; at += 1_000) {
      time.advance(1_000)
      await settle()
    }
  }
  const processLines = () => mounted.logs.filter((l) => l.startsWith(PROCESS_PREFIX))
  const beacons = () => mounted.logs.filter((l) => l.startsWith(BEACON_PREFIX)).map((l) => decodeBeacon(l)!)
  return { time, cli, procs, mounted, monitor: () => monitor!, settle, run, processLines, beacons }
}

test('this computer: the whole list on request, which counts as a heartbeat', async () => {
  const t = await mount({ backgroundMonitoring: false })
  assert.equal(t.monitor().poller.mode(), 'slow')
  const answer = (await t.mounted.request('fleet.processes', { id: 'local' })) as ProcessList
  assert.deepEqual([answer.state, answer.scope, answer.total, answer.ageMs, answer.cpuWindowMs], ['ok', 'full', 3, 1_000, 3_000])
  assert.deepEqual(answer.columns.pid, [10, 11, 12])
  assert.equal(answer.takenAt, t.time.now() - 1_000)
  assert.equal(t.monitor().poller.mode(), 'fast')
  assert.equal(t.procs.calls.local, 1)
  // The machine's own state names its largest process, for the overview.
  assert.deepEqual(t.monitor().poller.stateOf('local')?.processes?.largest, { pid: 11, name: 'Big Example', mem: 9_000 })
  await assert.rejects(t.mounted.request('fleet.processes', {} as never), /needs \{ id \}/)
  await t.mounted.deactivate()
})

test('the process line: every 30 s while publishing, flagged in the beacon; none with publishing off', async () => {
  const t = await mount({ backgroundMonitoring: false })
  await t.run(PROCESS_INTERVAL_MS * 2)
  assert.equal(t.processLines().length, 2)
  assert.ok(t.beacons().every((b) => b.publishesProcesses === true))
  assert.equal(t.procs.calls.publishing.at(-1), true, 'the slow top stream runs')
  assert.ok(t.monitor().poller.stateOf('local')?.processes?.largest, 'and the overview has the largest process')
  await t.mounted.deactivate()

  const off = await mount({ beacon: false, backgroundMonitoring: false })
  await off.run(PROCESS_INTERVAL_MS * 2)
  assert.equal(off.processLines().length, 0)
  assert.equal(off.procs.calls.publish, 0, 'nobody looking and nothing published: nothing read')
  assert.equal(off.procs.calls.publishing.at(-1), false)
  await off.mounted.deactivate()
})

test('with publishing off, an open panel still gets this computer\'s largest process, without a log line', async () => {
  const t = await mount({ beacon: false, backgroundMonitoring: false })
  // An open panel heartbeats every 5 s.
  for (let i = 0; i < PROCESS_INTERVAL_MS / 5_000; i += 1) {
    await t.mounted.request('fleet.heartbeat')
    await t.run(5_000)
  }
  assert.equal(t.procs.calls.publish, 1)
  assert.equal(t.processLines().length, 0)
  assert.equal(t.monitor().poller.stateOf('local')?.processes?.largest?.pid, 11)
  assert.equal(t.procs.calls.local, 0, 'the fast sampling was never started')
  await t.mounted.deactivate()
})

test('no process reads while macOS memory pressure is critical', async () => {
  const t = await mount({ backgroundMonitoring: false }, { pressure: 'critical' })
  await t.run(PROCESS_INTERVAL_MS * 2)
  assert.equal(t.procs.calls.publish, 0)
  assert.equal(t.procs.calls.publishing.at(-1), false)
  await t.mounted.deactivate()
})

test('stopping the worker stops the process sampler and its streams', async () => {
  const t = await mount()
  await t.run(5_000)
  await t.mounted.deactivate()
  assert.equal(t.procs.calls.stopped, 1)
  const before = t.processLines().length
  await t.run(PROCESS_INTERVAL_MS * 2)
  assert.equal(t.processLines().length, before, 'nothing after stop')
})

test('anything but a Mac: no list, and no flag in the beacon', async () => {
  const t = await mount({ backgroundMonitoring: false }, { supported: false })
  const answer = (await t.mounted.request('fleet.processes', { id: 'local' })) as ProcessList
  assert.deepEqual([answer.state, answer.reason], ['unavailable', 'not-mac'])
  await t.run(PROCESS_INTERVAL_MS)
  assert.equal(t.processLines().length, 0)
  assert.ok(t.beacons().every((b) => b.publishesProcesses === undefined))
  await t.mounted.deactivate()
})

test('a paired Mac: its newest top list, with its age, and its largest process on its state', async () => {
  const t = await mount()
  await t.mounted.request('fleet.snapshot')
  await t.run(12_000)
  const answer = (await t.mounted.request('fleet.processes', { id: 'env-r' })) as ProcessList
  assert.deepEqual([answer.state, answer.scope, answer.total, answer.memAgeMs], ['ok', 'top', 640, 50_000])
  assert.deepEqual(answer.columns.name, ['Remote Big', 'tool-71'])
  assert.ok(answer.ageMs !== null && answer.ageMs >= 10_000, `${answer.ageMs} ms old`)
  assert.deepEqual(t.monitor().poller.stateOf('env-r')?.processes?.largest, { pid: 70, name: 'Remote Big', mem: 2 ** 30 })
  const unknown = (await t.mounted.request('fleet.processes', { id: 'env-gone' })) as ProcessList
  assert.deepEqual([unknown.state, unknown.reason], ['unavailable', 'unknown-machine'])
  await t.mounted.deactivate()
})

test('a paired Mac on 1.1 says outdated; a process line from an older run of its plugin is dropped', async () => {
  const old = await mount({}, { logs: (time) => remoteLogs(time, { processes: false }) })
  await old.mounted.request('fleet.snapshot')
  await old.run(12_000)
  const answer = (await old.mounted.request('fleet.processes', { id: 'env-r' })) as ProcessList
  assert.deepEqual([answer.state, answer.reason], ['unavailable', 'outdated'])
  await old.mounted.deactivate()

  const stale = await mount({}, { logs: (time) => remoteLogs(time, { lineRun: 'run-old' }) })
  await stale.mounted.request('fleet.snapshot')
  await stale.run(12_000)
  assert.equal(stale.monitor().poller.processLineOf('env-r'), null)
  const waiting = (await stale.mounted.request('fleet.processes', { id: 'env-r' })) as ProcessList
  assert.equal(waiting.state, 'waiting')
  await stale.mounted.deactivate()
})

test('pressure flipping between warning and critical does not restart top over and over', async () => {
  let n = 0
  const t = await mount({ backgroundMonitoring: false }, { pressure: () => (n++ % 2 === 0 ? 'critical' : 'warning') })
  await t.run(60_000)
  const switchedOn = t.procs.calls.publishing.filter((on, i, all) => on && all[i - 1] === false).length
  assert.equal(switchedOn, 0, 'held off for two minutes after the last critical reading')
  assert.equal(t.procs.calls.publish, 0)
  await t.mounted.deactivate()
})

test('two minutes after the last critical reading, the process beat comes back', async () => {
  let critical = true
  const t = await mount({ backgroundMonitoring: false }, { pressure: () => (critical ? 'critical' : 'normal') })
  await t.run(10_000)
  critical = false
  await t.run(100_000)
  assert.equal(t.procs.calls.publishing.at(-1), false, 'still held')
  await t.run(60_000)
  assert.equal(t.procs.calls.publishing.at(-1), true)
  assert.ok(t.processLines().length >= 1)
  await t.mounted.deactivate()
})

test('this computer\'s state carries its footprints\' own age beside its largest process', async () => {
  const t = await mount({ backgroundMonitoring: false })
  await t.run(PROCESS_INTERVAL_MS)
  const p = t.monitor().poller.stateOf('local')?.processes
  // The fake table was read 1 s before it was handed over, its footprints 2 s before that.
  assert.equal(p?.largest?.pid, 11)
  assert.equal(p?.largestAt, p!.takenAt! - 2_000)
  assert.ok(p!.memAgeMs! >= 3_000, `${p?.memAgeMs} ms old`)
  await t.mounted.deactivate()
})

test('a memory reading that says nothing about pressure keeps a critical hold going', async () => {
  let n = 0
  const t = await mount({ backgroundMonitoring: false }, { pressure: () => (n++ === 0 ? 'critical' : null) })
  await t.run(3 * 60_000)
  assert.equal(t.procs.calls.publish, 0, 'still held three minutes on')
  assert.equal(t.procs.calls.publishing.at(-1), false)
  await t.mounted.deactivate()
})

test('a remote\'s process line is moved onto this computer\'s clock, and bounded to a day ago', async () => {
  const skewed = await mount({}, { skewMs: 3_600_000, logs: (time) => remoteLogs(time, { skewMs: 3_600_000 }) })
  await skewed.mounted.request('fleet.snapshot')
  await skewed.run(12_000)
  const held = skewed.monitor().poller.processLineOf('env-r')!
  assert.ok(Math.abs(held.takenAt - (held.readAt - 10_000)) <= 2_000, `taken ${held.readAt - held.takenAt} ms before it was read`)
  await skewed.mounted.deactivate()

  const ancient = await mount({}, { logs: (time) => remoteLogs(time, { lineAgoMs: 1_700_000_000_000 }) })
  await ancient.mounted.request('fleet.snapshot')
  await ancient.run(12_000)
  const old = ancient.monitor().poller.processLineOf('env-r')!
  assert.equal(old.readAt - old.takenAt <= 24 * 60 * 60_000, true)
  await ancient.mounted.deactivate()
})

test('this computer: the largest process survives a critical spell as last known, ageing, until 15 minutes', async () => {
  let critical = false
  const t = await mount({ backgroundMonitoring: false }, { pressure: () => (critical ? 'critical' : 'normal') })
  const largest = () => t.monitor().poller.stateOf('local')?.processes
  await t.run(PROCESS_INTERVAL_MS)
  assert.equal(largest()?.largest?.pid, 11)
  const at = largest()!.largestAt!
  critical = true
  t.procs.sim.footprints = false
  await t.run(3 * 60_000)
  assert.equal(t.procs.calls.publish, 1, 'the beat paused')
  assert.equal(largest()?.largest?.name, 'Big Example', 'still named')
  assert.equal(largest()?.largestAt, at, 'with the time its figure was read')
  assert.ok(largest()!.memAgeMs! >= 3 * 60_000, `and its real age: ${largest()?.memAgeMs} ms`)
  // A list asked for meanwhile is read fresh: its rows carry no old footprints, and it does not
  // erase the last known largest.
  const answer = (await t.mounted.request('fleet.processes', { id: 'local' })) as ProcessList
  assert.deepEqual(answer.columns.mem, [null, null, null])
  assert.equal(answer.memAgeMs, null)
  assert.equal(largest()?.largest?.pid, 11)
  // Fifteen minutes after its figure was read, it is gone.
  await t.run(15 * 60_000 - (t.time.now() - at) - 5_000)
  assert.equal(largest()?.largest?.pid, 11, 'just under 15 minutes')
  await t.run(10_000)
  assert.deepEqual([largest()?.largest, largest()?.memAgeMs], [null, null], 'expired')
  // The spell ends; two minutes on, the first sample with figures replaces it.
  critical = false
  t.procs.sim.footprints = true
  t.procs.sim.big = { pid: 12, name: 'New Big' }
  await t.run(3 * 60_000)
  assert.equal(largest()?.largest?.name, 'New Big')
  assert.ok(largest()!.memAgeMs! < PROCESS_INTERVAL_MS + 5_000, 'fresh again')
  await t.mounted.deactivate()
})

test('a paired Mac: its largest process stays, ageing, while it publishes nothing new, until 15 minutes', async () => {
  // The remote's own log: beacons always fresh, and one process line under our control.
  const line = { seq: 4, takenAt: 0, withMem: true, big: 'Remote Big' }
  const logs = (time: FakeTime): string => {
    const entries: { ts: number; level: string; line: string }[] = []
    for (let i = 5; i >= 0; i -= 1) {
      const t = time.now() - i * 5_000
      entries.push({ ts: t, level: 'info', line: encodeBeacon(localSample({ t, platform: 'darwin' }), { run: 'run-r', seq: Math.floor(time.now() / 5_000) - i, intervalMs: 5_000, processes: true })! })
    }
    const rows = [row(70, line.withMem ? 2 ** 30 : (null as unknown as number), line.big), row(71, line.withMem ? 2 ** 20 : (null as unknown as number))]
    const table: ProcessTable = { takenAt: line.takenAt, rows, cpuWindowMs: 30_000, memAgeMs: line.withMem ? 20_000 : null, energyWindowMs: null, total: 500 }
    entries.push({ ts: line.takenAt, level: 'info', line: encodeProcessLine(table, { run: 'run-r', seq: line.seq, intervalMs: PROCESS_INTERVAL_MS })! })
    return envelope({ pluginKey: 'example.fleet-monitor', lines: entries })
  }
  const t = await mount({}, { logs })
  line.takenAt = t.time.now()
  const state = () => t.monitor().poller.stateOf('env-r')?.processes
  const beat = async (ms: number) => {
    for (let at = 0; at < ms; at += 5_000) {
      await t.mounted.request('fleet.heartbeat')
      await t.run(5_000)
    }
  }
  await beat(15_000)
  assert.equal(state()?.largest?.name, 'Remote Big')
  const at = state()!.largestAt!
  assert.ok(Math.abs(at - (line.takenAt - 20_000)) <= 1_000, 'its figure\'s time on this computer\'s clock')
  // Memory critical there: it publishes no new process line for five minutes.
  await beat(5 * 60_000)
  assert.equal(state()?.largest?.name, 'Remote Big')
  assert.ok(state()!.memAgeMs! >= 5 * 60_000, `${state()?.memAgeMs} ms old`)
  // Its first line after the spell has no memory figures yet: the last known stays.
  line.seq = 5
  line.withMem = false
  line.takenAt = t.time.now()
  await beat(10_000)
  assert.equal(state()?.largest?.name, 'Remote Big')
  assert.equal(state()?.largestAt, at)
  // Fifteen minutes after its figure was read, it is gone.
  await beat(15 * 60_000 - (t.time.now() - at) + 10_000)
  assert.equal(state()?.largest, null)
  // A line with figures replaces it at once.
  line.seq = 6
  line.withMem = true
  line.big = 'Other Big'
  line.takenAt = t.time.now()
  await beat(10_000)
  assert.equal(state()?.largest?.name, 'Other Big')
  await t.mounted.deactivate()
})
