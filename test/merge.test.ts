import { assert, describe, test } from 'orca/testing'
import { decodeBeacon, encodeBeacon } from '../src/beacon.ts'
import { DEFAULT_HEALTH } from '../src/health.ts'
import { backfillPoints, historyPointOf, loadEstimate, mergeMachine, type MergeInput } from '../src/merge.ts'
import { parseDiagnostics, parseEnvelope } from '../src/parse.ts'
import { fixtureText, localSample } from './helpers.ts'

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

  test('basic tier: CPU is estimated from load and labelled so', () => {
    const m = mergeMachine(base({ diag }))
    assert.equal(m.tier, 'basic')
    assert.deepEqual(m.cpu, { percent: 75, source: 'load', perCore: null, groups: null })
    assert.deepEqual(m.load, { one: 6, five: null, fifteen: null })
    assert.equal(m.health.level, 'busy')
    assert.deepEqual(m.health.reasons, ['CPU load 75% ≥ 70%'])
    assert.equal(m.beacon.state, 'absent')
    assert.equal(m.host.cores, 8)
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
