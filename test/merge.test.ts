import { assert, describe, test } from 'orca/testing'
import { decodeBeacon, encodeBeacon } from '../src/beacon.ts'
import { DEFAULT_HEALTH } from '../src/health.ts'
import { backfillPoints, historyPointOf, loadEstimate, mergeMachine, type MergeInput } from '../src/merge.ts'
import { parseDiagnostics, parseEnvelope } from '../src/parse.ts'
import { fixtureText, localSample, macMemory } from './helpers.ts'

const diag = parseDiagnostics(parseEnvelope(fixtureText('diagnostics-remote.json')))!
const base = (over: Partial<MergeInput>): MergeInput => ({
  id: 'env-0001',
  name: 'Build Box',
  kind: 'remote',
  now: 1_000,
  status: 'online',
  lastSeenAt: 900,
  latencyMs: 350,
  error: null,
  health: DEFAULT_HEALTH,
  ...over
})
const beaconOf = (over: Parameters<typeof localSample>[0] = {}) =>
  decodeBeacon(encodeBeacon(localSample(over), { run: 'r1', seq: 3, intervalMs: 5_000 }))!

describe('local machine', () => {
  test('CPU from the sampler, memory from Orca diagnostics when present', () => {
    const m = mergeMachine(base({ id: 'local', kind: 'local', local: localSample({ platform: 'darwin' }), diag }))
    assert.equal(m.tier, 'full')
    assert.equal(m.online, true)
    assert.deepEqual(m.cpu, { percent: 42.5, source: 'sampler', perCore: [40, 45, 41.2, 43.8], groups: null })
    assert.equal(m.memory?.source, 'orca')
    assert.equal(m.memory?.percent, 50)
    assert.equal(m.memory?.reliable, true)
    assert.deepEqual(m.load, { one: 1.5, five: 1.25, fifteen: 1 })
    assert.equal(m.host.cpuModel, 'Example CPU 8-Core')
    assert.equal(m.workspaces.byCpu[0]?.name, 'feature-alpha')
    assert.equal(m.orca?.memory, 780_000_000)
  })

  test('without diagnostics, macOS os.freemem() memory is shown but not trusted', () => {
    const mac = mergeMachine(base({ id: 'local', kind: 'local', local: localSample({ platform: 'darwin' }) }))
    assert.equal(mac.memory?.source, 'os')
    assert.equal(mac.memory?.reliable, false)
    assert.equal(mac.memory?.percent, 75)
    const linux = mergeMachine(base({ id: 'local', kind: 'local', local: localSample({ platform: 'linux' }) }))
    assert.equal(linux.memory?.reliable, true)
  })
})

describe('remote machine', () => {
  test('full tier: a fresh beacon gives CPU, per-core and 1/5/15 load', () => {
    const m = mergeMachine(
      base({ diag, beacon: { latest: beaconOf(), fresh: true, ageMs: 1_200, pluginKey: 'local.fleet-monitor', remotePlugin: 'running' } })
    )
    assert.equal(m.tier, 'full')
    assert.equal(m.cpu.source, 'beacon')
    assert.equal(m.cpu.percent, 42.5)
    assert.deepEqual(m.cpu.perCore, [40, 45, 41, 44])
    assert.deepEqual(m.load, { one: 1.5, five: 1.25, fifteen: 1 })
    assert.equal(m.memory?.source, 'orca')
    assert.equal(m.beacon.state, 'fresh')
    assert.equal(m.beacon.seq, 3)
    assert.equal(m.host.hostname, 'test-host')
    assert.equal(m.host.uptimeSec, 3_600)
  })

  test('core groups come from the local sampler or a fresh beacon, never from a stale one', () => {
    const groups = [
      { kind: 'performance' as const, start: 1, count: 3 },
      { kind: 'efficiency' as const, start: 0, count: 1 }
    ]
    const local = mergeMachine(base({ id: 'local', kind: 'local', local: localSample({ coreGroups: groups }), diag }))
    assert.deepEqual(local.cpu.groups, groups)
    const fresh = mergeMachine(
      base({ diag, beacon: { latest: beaconOf({ coreGroups: groups }), fresh: true, ageMs: 0, pluginKey: 'k', remotePlugin: 'running' } })
    )
    assert.deepEqual(fresh.cpu.groups, groups)
    const old = mergeMachine(
      base({ diag, beacon: { latest: beaconOf(), fresh: true, ageMs: 0, pluginKey: 'k', remotePlugin: 'running' } })
    )
    assert.equal(old.cpu.groups, null, 'a beacon from the first release has none: one group')
    const stale = mergeMachine(
      base({ diag, beacon: { latest: beaconOf({ coreGroups: groups }), fresh: false, ageMs: 60_000, pluginKey: 'k', remotePlugin: 'running' } })
    )
    assert.equal(stale.cpu.groups, null)
  })

  test('basic tier: CPU is estimated from load and labelled so, and health is judged on memory alone', () => {
    const m = mergeMachine(base({ diag }))
    assert.equal(m.tier, 'basic')
    assert.deepEqual(m.cpu, { percent: 75, source: 'load', perCore: null, groups: null })
    assert.deepEqual(m.load, { one: 6, five: null, fifteen: null })
    assert.equal(m.health.level, 'ok', 'a 75% estimate is not "busy": memory is 50%')
    assert.equal(m.health.cpu, null)
    assert.equal(m.health.memory, 'ok')
    assert.deepEqual(m.health.reasons, [])
    assert.equal(m.beacon.state, 'absent')
    assert.equal(m.host.cores, 8)
  })

  test('basic tier: a 100% estimate on a machine with low memory is still ok; high memory is not', () => {
    const busy = { ...diag, host: { ...diag.host, load1: 40 } }
    assert.equal(mergeMachine(base({ diag: busy })).health.level, 'ok')
    const full = { ...diag, host: { ...diag.host, load1: 0.5, memoryPercent: 96 } }
    const m = mergeMachine(base({ diag: full }))
    assert.equal(m.health.level, 'critical')
    // The fixture is a Mac (availableMemorySource memory-pressure): Orca's figure is memory
    // pressure there, and 1.1 says so.
    assert.deepEqual(m.health.reasons, ['memory pressure 96% ≥ 95%'])
  })

  test('a machine that reports no load average (Windows) has no estimate rather than 0%', () => {
    const windows = { ...diag, host: { ...diag.host, load1: 0, availableMemorySource: 'free-memory' } }
    const m = mergeMachine(base({ diag: windows }))
    assert.deepEqual(m.cpu, { percent: null, source: 'load', perCore: null, groups: null })
    assert.equal(m.load, null)
    const idleMac = { ...diag, host: { ...diag.host, load1: 0, availableMemorySource: 'memory-pressure' } }
    assert.equal(mergeMachine(base({ diag: idleMac })).cpu.percent, 0, 'an idle Mac or Linux box does report 0')
    const staleWindowsBeacon = mergeMachine(
      base({ diag: { ...diag, host: { ...diag.host, load1: 0 } }, beacon: { latest: beaconOf({ platform: 'win32' }), fresh: false, ageMs: 60_000, pluginKey: 'k', remotePlugin: 'running' } })
    )
    assert.equal(staleWindowsBeacon.cpu.percent, null, 'its last beacon said win32')
  })

  test('a stale beacon keeps the basic tier but still names the machine', () => {
    const m = mergeMachine(
      base({ diag, beacon: { latest: beaconOf(), fresh: false, ageMs: 60_000, pluginKey: 'local.fleet-monitor', remotePlugin: 'running' } })
    )
    assert.equal(m.tier, 'basic')
    assert.equal(m.cpu.source, 'load')
    assert.equal(m.beacon.state, 'stale')
    assert.equal(m.host.hostname, 'test-host')
    assert.equal(m.host.uptimeSec, null)
  })

  test('offline: unknown health, last data kept', () => {
    const m = mergeMachine(base({ status: 'offline', diag, error: 'timed out' }))
    assert.equal(m.online, false)
    assert.equal(m.health.level, 'unknown')
    assert.equal(m.error, 'timed out')
    assert.equal(historyPointOf(m, 1_000), null)
  })

  test('connecting with nothing yet', () => {
    const m = mergeMachine(base({ status: 'connecting', lastSeenAt: null }))
    assert.equal(m.cpu.percent, null)
    assert.equal(m.memory, null)
    assert.equal(m.tier, 'basic')
  })
})

test('loadEstimate is load per core as a percent, capped at 100', () => {
  assert.equal(loadEstimate(2, 8), 25)
  assert.equal(loadEstimate(20, 8), 100)
  assert.equal(loadEstimate(1, 0), 100)
})

test('history points carry memory only when it is trusted', () => {
  const mac = mergeMachine(base({ id: 'local', kind: 'local', local: localSample({ platform: 'darwin' }) }))
  assert.deepEqual(historyPointOf(mac, 5), { t: 5, cpu: 42.5, mem: null })
  const full = mergeMachine(base({ diag }))
  assert.deepEqual(historyPointOf(full, 6), { t: 6, cpu: 75, mem: 50 })
})

test('backfill moves beacon times onto the local clock and drops macOS os memory', () => {
  const linux = beaconOf({ t: 10_000, platform: 'linux' })
  const mac = beaconOf({ t: 15_000, platform: 'darwin' })
  const first = beaconOf({ t: 20_000, cpu: null })
  assert.deepEqual(backfillPoints([linux, mac, first], 2_000), [
    { t: 8_000, cpu: 42.5, mem: 75 },
    { t: 13_000, cpu: 42.5, mem: null }
  ])
})

describe('memory from a Mac’s own reading (1.1)', () => {
  const GIB = 2 ** 30
  const reading = macMemory({ used: 15.1 * GIB, app: 9.6 * GIB, availablePercent: 12, pressure: 'warning', swapUsed: 6.2 * GIB, swapTotal: 7 * GIB })
  const macBeacon = (over: Parameters<typeof localSample>[0] = {}) => beaconOf({ platform: 'darwin', macMemory: reading, ...over })

  test("this Mac: the sampler's reading wins over Orca's diagnostics, as RAM in use", () => {
    const m = mergeMachine(base({ id: 'local', kind: 'local', local: localSample({ platform: 'darwin', macMemory: reading }), diag }))
    assert.equal(m.memory?.source, 'sampler')
    assert.equal(m.memory?.kind, 'used')
    assert.equal(m.memory?.used, 15.1 * GIB)
    assert.equal(m.memory?.total, 16 * GIB)
    assert.equal(Math.round((m.memory?.percent ?? 0) * 10) / 10, 94.4)
    assert.equal(m.memory?.pressurePercent, 88)
    assert.deepEqual(m.memory?.mac, reading)
    assert.equal(m.health.memory, 'strained')
    assert.deepEqual(m.health.reasons, ['macOS memory pressure warning, 12% available', 'memory pressure 88% ≥ 88%'])
  })

  test('a remote Mac: a fresh beacon’s reading wins over diagnostics; a stale one never does', () => {
    const fresh = mergeMachine(base({ diag, beacon: { latest: macBeacon(), fresh: true, ageMs: 1_000, pluginKey: 'k', remotePlugin: 'running' } }))
    assert.deepEqual([fresh.memory?.source, fresh.memory?.kind, fresh.memory?.used], ['beacon', 'used', 15.1 * GIB])
    const stale = mergeMachine(base({ diag, beacon: { latest: macBeacon(), fresh: false, ageMs: 60_000, pluginKey: 'k', remotePlugin: 'running' } }))
    assert.deepEqual([stale.memory?.source, stale.memory?.kind, stale.memory?.percent], ['orca', 'pressure', 50])
    assert.equal(stale.memory?.mac, undefined)
  })

  test('a remote still on 1.0.0, and the basic tier, show Orca’s figure: memory pressure on a Mac, as before elsewhere', () => {
    const old = mergeMachine(base({ diag, beacon: { latest: beaconOf({ platform: 'darwin' }), fresh: true, ageMs: 1_000, pluginKey: 'k', remotePlugin: 'running' } }))
    assert.deepEqual([old.tier, old.memory?.source, old.memory?.kind, old.memory?.pressurePercent], ['full', 'orca', 'pressure', 50])
    const basicMac = mergeMachine(base({ diag }))
    assert.deepEqual([basicMac.tier, basicMac.memory?.kind], ['basic', 'pressure'])
    const linux = mergeMachine(base({ diag: { ...diag, host: { ...diag.host, availableMemorySource: 'proc-meminfo' } } }))
    assert.equal(linux.memory?.kind, undefined, 'Linux keeps its figure and its wording')
    assert.equal('pressurePercent' in (linux.memory ?? {}), false)
  })

  test("pressure falls back on Orca's figure when the kernel's percentage could not be read", () => {
    const noLevel = macMemory({ availablePercent: null })
    const m = mergeMachine(base({ id: 'local', kind: 'local', local: localSample({ platform: 'darwin', macMemory: noLevel }), diag }))
    assert.equal(m.memory?.pressurePercent, 50)
    const alone = mergeMachine(base({ id: 'local', kind: 'local', local: localSample({ platform: 'darwin', macMemory: noLevel }) }))
    assert.equal(alone.memory?.pressurePercent, null)
    assert.equal(alone.memory?.reliable, true, 'RAM in use is still known')
  })

  test('the RAM used threshold comes from the settings', () => {
    const busy = macMemory({ used: 14.6 * GIB, app: 9.1 * GIB })
    const at = (ramUsedBusyPercent: number) =>
      mergeMachine(base({ id: 'local', kind: 'local', local: localSample({ platform: 'darwin', macMemory: busy }), memoryRules: { ramUsedBusyPercent } })).health.memory
    assert.deepEqual([at(90), at(95)], ['busy', 'ok'])
  })

  test('history: RAM in use in its own column, pressure in mem, so the two never mix', () => {
    const mac = mergeMachine(base({ id: 'local', kind: 'local', local: localSample({ platform: 'darwin', macMemory: reading }) }))
    const point = historyPointOf(mac, 7)!
    assert.deepEqual([point.t, point.cpu, point.mem, Math.round(point.ram! * 10) / 10], [7, 42.5, 88, 94.4])
    const orca = mergeMachine(base({ diag }))
    assert.deepEqual(historyPointOf(orca, 8), { t: 8, cpu: 75, mem: 50 }, 'no ram key without a Mac reading')
  })

  test('back-fill from a Mac’s beacons carries RAM in use and pressure', () => {
    const points = backfillPoints([macBeacon({ t: 10_000 }), beaconOf({ t: 15_000, platform: 'darwin' })], 2_000)
    assert.deepEqual(points.map((p) => [p.t, p.mem, typeof p.ram === 'number' ? Math.round(p.ram * 10) / 10 : 'none']), [
      [8_000, 88, 94.4],
      [13_000, null, 'none']
    ])
  })
})
