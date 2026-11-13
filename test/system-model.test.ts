// 1.2's readings through the model: history columns, merge, process availability, the sampler's
// system reader and the bridge's size limits. Every value here is invented.
import { assert, describe, test } from 'orca/testing'
import { decodeBeacon, encodeBeacon } from '../src/beacon.ts'
import { PanelBridge, estimateCloneBytes } from '../src/bridge.ts'
import { DEFAULT_HEALTH } from '../src/health.ts'
import { coreColumns, downsample, HistoryRing, toColumns } from '../src/history.ts'
import { beaconPoint, historyPointOf, mergeMachine, processAvailability, systemPointOf } from '../src/merge.ts'
import type { MacSystem, MachineState } from '../src/model.ts'
import { LocalSampler, type CpuInfo, type OsSource } from '../src/sampler.ts'
import { localSample } from './helpers.ts'

const SYSTEM: MacSystem = {
  net: { iface: 'en0', rxBytesPerSec: 1_234.6, txBytesPerSec: 99 },
  disk: { totalBytes: 1_000, usedBytes: 400, readBytesPerSec: 50, writeBytesPerSec: 60 },
  gpu: { percent: 33.33 },
  battery: { present: true, percent: 71.26, state: 'discharging', source: 'battery', minutesRemaining: 90 }
}

describe('history', () => {
  test('the 1.2 columns only where some point has them; rates whole, percentages to 0.1', () => {
    const plain = toColumns([{ t: 1, cpu: 1, mem: 2 }])
    assert.deepEqual(plain, { t: [1], cpu: [1], mem: [2] })
    const cols = toColumns([{ t: 1, cpu: 1, mem: 2, ...systemPointOf(SYSTEM) }, { t: 2, cpu: 1, mem: 2 }])
    assert.deepEqual([cols.rx, cols.tx, cols.dr, cols.dw, cols.gpu, cols.bat], [[1_235, null], [99, null], [50, null], [60, null], [33.3, null], [71.3, null]])
    const thin = downsample(toColumns([1, 2, 3].map((t) => ({ t, cpu: t, mem: t, gpu: t }))), 2)
    assert.deepEqual(thin.gpu, [1, 3])
    assert.deepEqual(Object.keys(coreColumns(cols)), ['t', 'cpu', 'mem'])
  })

  test('a battery that is not there adds no battery column', () => {
    assert.equal('bat' in systemPointOf({ ...SYSTEM, battery: { present: false, percent: null, state: null, source: 'ac', minutesRemaining: null } }), false)
    assert.deepEqual(systemPointOf(null), {})
  })
})

const merge = (over: Partial<Parameters<typeof mergeMachine>[0]>) =>
  mergeMachine({ id: 'env-a', name: 'A', kind: 'remote', now: 1_000, status: 'online', lastSeenAt: 1_000, latencyMs: 1, error: null, health: DEFAULT_HEALTH, ...over })

describe('merge', () => {
  test('this Mac: its sampler\'s readings, and its whole process list', () => {
    const state = mergeMachine({ id: 'local', name: 'This', kind: 'local', now: 1, status: 'online', lastSeenAt: 1, latencyMs: null, error: null, health: DEFAULT_HEALTH, local: localSample({ platform: 'darwin', system: SYSTEM }), processLine: { takenAt: 5 }, lastLargest: { largest: { pid: 9, name: 'big', mem: 7 }, at: 0 } })
    assert.deepEqual(state.system, SYSTEM)
    assert.deepEqual(state.processes, { state: 'full', reason: null, takenAt: 5, largest: { pid: 9, name: 'big', mem: 7 }, largestAt: 0, memAgeMs: 1 })
    assert.deepEqual(historyPointOf(state, 3), { t: 3, cpu: 42.5, mem: null, rx: 1_234.6, tx: 99, dr: 50, dw: 60, gpu: 33.33, bat: 71.26 })
    const linux = mergeMachine({ id: 'local', name: 'This', kind: 'local', now: 1, status: 'online', lastSeenAt: 1, latencyMs: null, error: null, health: DEFAULT_HEALTH, local: localSample() })
    assert.deepEqual(linux.processes, { state: 'full', reason: null, takenAt: null, largest: null, largestAt: null, memAgeMs: null }, 'Linux lists its processes from 1.3')
    assert.equal(linux.system, undefined)
    const windows = mergeMachine({ id: 'local', name: 'This', kind: 'local', now: 1, status: 'online', lastSeenAt: 1, latencyMs: null, error: null, health: DEFAULT_HEALTH, local: localSample({ platform: 'win32', system: SYSTEM }) })
    assert.equal(windows.processes?.state, 'full')
    assert.deepEqual(windows.system, SYSTEM, 'and its network, disk, GPU and battery are shown like a Mac\'s')
    const other = mergeMachine({ id: 'local', name: 'This', kind: 'local', now: 1, status: 'online', lastSeenAt: 1, latencyMs: null, error: null, health: DEFAULT_HEALTH, local: localSample({ platform: 'freebsd' }) })
    assert.deepEqual(other.processes, { state: 'unavailable', reason: 'not-mac', takenAt: null, largest: null, largestAt: null, memAgeMs: null })
  })

  test('a remote: a fresh 1.2 beacon\'s readings, and what its process list is', () => {
    const fresh = decodeBeacon(encodeBeacon(localSample({ platform: 'darwin', system: SYSTEM }), { run: 'r', seq: 1, intervalMs: 5_000, processes: true }))!
    const beacon = (latest: typeof fresh | null, isFresh = true) => ({ latest, fresh: isFresh, ageMs: 0, pluginKey: 'x.fleet-monitor', remotePlugin: 'running' as const })
    const top = merge({ beacon: beacon(fresh), processLine: { takenAt: 900 } })
    assert.equal(top.system?.net?.iface, 'en0')
    assert.equal(top.processes?.state, 'top')
    assert.equal(merge({ beacon: beacon(fresh) }).processes?.state, 'waiting')
    assert.equal(merge({ beacon: beacon(fresh, false) }).processes?.reason, 'not-read-yet', 'stale, and its log never read')
    assert.equal(merge({ beacon: beacon(fresh, false) }).system, undefined, 'a stale beacon\'s readings are not shown')
    assert.equal(merge({ status: 'offline', beacon: beacon(fresh) }).processes?.reason, 'offline')
    const old = decodeBeacon(encodeBeacon(localSample({ platform: 'darwin' }), { run: 'r', seq: 1, intervalMs: 5_000 }))!
    assert.equal(merge({ beacon: beacon(old) }).processes?.reason, 'outdated', 'a Mac on 1.1 or older')
    assert.equal(merge({ beacon: { ...beacon(null, false), logRead: true } }).processes?.reason, 'publishing-off')
    assert.equal(merge({ beacon: { ...beacon(null, false), logRead: false } }).processes?.reason, 'not-read-yet')
    assert.equal(merge({ beacon: { ...beacon(null, false), remotePlugin: 'unknown' } }).processes?.reason, 'not-read-yet')
    assert.equal(merge({ beacon: { ...beacon(null, false), remotePlugin: 'absent' } }).processes?.reason, 'basic')
    assert.equal(merge({ status: 'connecting' }).processes?.reason, 'not-read-yet')
    // Linux and Windows list processes from 1.3; a 1.2 copy there says nothing of publishing them.
    for (const platform of ['linux', 'win32']) {
      const publishing = decodeBeacon(encodeBeacon(localSample({ platform, system: SYSTEM }), { run: 'r', seq: 1, intervalMs: 5_000, processes: true }))!
      assert.equal(merge({ beacon: beacon(publishing), processLine: { takenAt: 900 } }).processes?.state, 'top', platform)
      assert.equal(merge({ beacon: beacon(publishing) }).system?.net?.iface, 'en0', platform)
      const onOneTwo = decodeBeacon(encodeBeacon(localSample({ platform }), { run: 'r', seq: 1, intervalMs: 5_000 }))!
      assert.equal(merge({ beacon: beacon(onOneTwo) }).processes?.reason, 'outdated', platform)
    }
    const other = decodeBeacon(encodeBeacon(localSample({ platform: 'freebsd' }), { run: 'r', seq: 1, intervalMs: 5_000, processes: true }))!
    assert.equal(merge({ beacon: beacon(other) }).processes?.reason, 'not-mac')
    assert.deepEqual(processAvailability({ kind: 'local', status: 'online', platform: 'darwin' }, null), { state: 'full', reason: null, takenAt: null, largest: null, largestAt: null, memAgeMs: null })
  })

  test('back-filled points carry the 1.2 fields', () => {
    const r = decodeBeacon(encodeBeacon(localSample({ t: 10_000, platform: 'darwin', system: SYSTEM }), { run: 'r', seq: 1, intervalMs: 5_000 }))!
    const point = beaconPoint(r, 1_000)
    assert.deepEqual([point.t, point.rx, point.gpu, point.bat], [9_000, 1_235, 33, 71])
  })
})

describe('the sampler', () => {
  const cpus: CpuInfo[] = [{ model: 'Example', times: { user: 1, nice: 0, sys: 1, idle: 8, irq: 0 } }]
  const os: OsSource = { cpus: () => cpus, totalmem: () => 2 ** 34, freemem: () => 2 ** 33, loadavg: () => [1, 1, 1], uptime: () => 9, hostname: () => 'h', platform: () => 'darwin', arch: () => 'arm64', release: () => '25', now: () => 1 }

  test('a system reader is refreshed by prepare, and its snapshot rides on the sample', async () => {
    let refreshed = 0
    const sampler = new LocalSampler(os, null, () => 0, {}, { refresh: async () => void (refreshed += 1), snapshot: () => SYSTEM })
    await sampler.prepare()
    assert.equal(refreshed, 1)
    assert.deepEqual(sampler.sample().system, SYSTEM)
  })

  test('one that fails, or throws, costs the sample nothing', async () => {
    const sampler = new LocalSampler(os, null, () => 0, {}, { refresh: async () => { throw new Error('boom') }, snapshot: () => { throw new Error('boom') } })
    await sampler.prepare()
    const sample = sampler.sample()
    assert.equal(sample.system, undefined)
    assert.equal(sample.cores, 1)
  })
})

describe('the bridge', () => {
  test('a snapshot too large sheds the 1.2 history columns before thinning the rest', () => {
    const ring = new HistoryRing()
    for (let i = 0; i < 360; i += 1) ring.add({ t: 1_000_000 + i * 5_000, cpu: 50, mem: 40, rx: 1e6, tx: 1e6, dr: 1e6, dw: 1e6, gpu: 5, bat: 80 }, 1_000_000 + 360 * 5_000)
    const state = merge({ id: 'local', kind: 'local', local: localSample({ platform: 'darwin' }) }) as MachineState
    const bridge = (max: number) =>
      new PanelBridge({ source: { entries: () => [{ state, history: ring }], mode: () => 'fast', intervalMs: () => 5_000 }, post: () => {}, now: () => 0, cli: () => ({ path: null, source: null, error: null }), setTimeout: () => null, clearTimeout: () => {}, snapshotMaxBytes: max })
    const whole = bridge(10_000_000).snapshot()
    assert.equal(whole.machines[0]!.history.gpu?.length, 360)
    const size = estimateCloneBytes(whole)
    const shed = bridge(size - 1).snapshot()
    assert.equal(shed.machines[0]!.history.gpu, undefined, 'the 1.2 columns went first')
    assert.equal(shed.machines[0]!.history.cpu.length, 360, 'the CPU history is whole')
  })
})

test('fleet.update posts carry the 1.2 history columns for their recent window', () => {
  const ring = new HistoryRing()
  ring.add({ t: 99_000, cpu: 5, mem: 6, rx: 700, gpu: 9 }, 100_000)
  const state = merge({ id: 'local', kind: 'local', local: localSample({ platform: 'darwin' }) }) as MachineState
  const posted: unknown[] = []
  const bridge = new PanelBridge({ source: { entries: () => [{ state, history: ring }], mode: () => 'fast', intervalMs: () => 5_000 }, post: (p) => posted.push(p), now: () => 100_000, cli: () => ({ path: null, source: null, error: null }), setTimeout: () => null, clearTimeout: () => {} })
  const update = bridge.flush()!
  assert.deepEqual([update.appended.local?.rx, update.appended.local?.gpu], [[700], [9]])
})
