// 1.2 in the panel's data-binding layer (panel/fleet-binding.mjs): network, disk, GPU and battery
// on each machine, the process list model, and asking for processes. Every value here is invented.
import { assert, describe, test } from 'orca/testing'
import { createFleetBinding, mergeColumns, toFleet, toProcessList, type FleetOrca } from '../panel/fleet-binding.mjs'
import { flush } from './helpers.ts'

const NOW = 1_800_000_000_000
const MIN = 60_000
const t30 = Array.from({ length: 30 }, (_, i) => NOW - (29 - i) * MIN)

const machine = (over: Record<string, unknown> = {}) => ({
  id: 'env-a',
  name: 'Studio',
  kind: 'remote',
  tier: 'full',
  status: 'online',
  online: true,
  host: { platform: 'darwin', cores: 8 },
  cpu: { percent: 10, source: 'beacon', perCore: null, groups: null },
  memory: { total: 64 * 2 ** 30, used: 32 * 2 ** 30, available: 32 * 2 ** 30, percent: 50, source: 'beacon', reliable: true },
  health: { level: 'ok', reasons: [], cpu: 'ok', memory: 'ok' },
  beacon: { state: 'fresh', remotePlugin: 'running' },
  workspaces: { byCpu: [], byMemory: [] },
  system: {
    net: { iface: 'en0', rxBytesPerSec: 4_200_000, txBytesPerSec: 310_000 },
    disk: { totalBytes: 1_000e9, usedBytes: 400e9, readBytesPerSec: 2_000, writeBytesPerSec: 3_000, ioAgeMs: 10_000 },
    gpu: { percent: 12, ageMs: 500 },
    battery: { present: true, percent: 82, state: 'charging', source: 'ac', minutesRemaining: 38, ageMs: 20_000 }
  },
  processes: { state: 'top', reason: null, takenAt: NOW - 8_000, memAgeMs: 50_000, largest: { pid: 70, name: 'Remote Big', mem: 16 * 2 ** 30 } },
  history: { t: t30, cpu: t30.map(() => 10), mem: t30.map(() => 40), rx: t30.map((_, i) => (i === 29 ? 5_000_000 : 1_000_000)), gpu: t30.map(() => 12) },
  ...over
})
const fleetOf = (...machines: unknown[]) => toFleet({ ready: true, error: null, seq: 1, generatedAt: NOW, mode: 'fast', intervalMs: 5_000, historyWindowMs: 30 * MIN, cli: null, thresholds: { cpu: { busy: 70, strained: 85, critical: 95 }, memory: { busy: 75, strained: 88, critical: 95 } }, machines } as never, NOW)

describe('a machine\'s network, disk, GPU and battery', () => {
  test('figures, ages and history series', () => {
    const m = fleetOf(machine()).machines[0]!
    assert.deepEqual([m.net?.iface, m.net?.rxBytesPerSec, m.net?.txBytesPerSec, m.net?.ageSec], ['en0', 4_200_000, 310_000, null])
    assert.equal(m.net?.rx.history[29], 5_000_000)
    assert.equal(m.net?.rx.stats?.peak, 5_000_000)
    assert.deepEqual(m.net?.tx.history.filter((v) => v !== null), [], 'no tx column: an empty series')
    assert.deepEqual([m.disk?.usedPct, m.disk?.freeBytes, m.disk?.ioAgeSec, m.disk?.spaceAgeSec], [40, 600e9, 10, null])
    assert.deepEqual([m.gpu?.pct, m.gpu?.ageSec, m.gpu?.history[0]], [12, null, 12])
    assert.deepEqual([m.battery?.present, m.battery?.pct, m.battery?.state, m.battery?.source, m.battery?.minutesRemaining, m.battery?.ageSec], [true, 82, 'charging', 'ac', 38, 20])
  })

  test('none for a machine without them, or offline', () => {
    const none = fleetOf(machine({ system: undefined }), machine({ id: 'env-b', online: false, status: 'offline' })).machines
    for (const m of none) assert.deepEqual([m.net, m.disk, m.gpu, m.battery], [null, null, null, null])
  })

  test('hostile figures are bounded, and text is plain', () => {
    const m = fleetOf(machine({ system: { net: { iface: 'en0‮evil', rxBytesPerSec: -5, txBytesPerSec: 'fast' }, disk: { totalBytes: 100, usedBytes: 500, readBytesPerSec: NaN }, gpu: { percent: 900 }, battery: { present: true, percent: -3, state: 'toString', source: 'constructor', minutesRemaining: -1 } } })).machines[0]!
    assert.deepEqual([m.net?.iface, m.net?.rxBytesPerSec, m.net?.txBytesPerSec], ['en0�evil', null, null])
    assert.deepEqual([m.disk?.usedBytes, m.disk?.usedPct, m.disk?.readBytesPerSec], [100, 100, null])
    assert.equal(m.gpu?.pct, 100)
    assert.deepEqual([m.battery?.pct, m.battery?.state, m.battery?.source, m.battery?.minutesRemaining], [0, null, null, null])
    const bare = fleetOf(machine({ system: { net: { iface: 5 }, disk: null, gpu: { percent: 'x' }, battery: { present: 'yes' } } })).machines[0]!
    assert.deepEqual([bare.net, bare.disk, bare.gpu, bare.battery], [null, null, null, null])
  })

  test('the process summary: top list, age, and the largest process with its share of RAM', () => {
    const m = fleetOf(machine()).machines[0]!
    assert.deepEqual(m.processes, { state: 'top', reason: null, topList: true, takenAt: NOW - 8_000, ageSec: 8, memAgeSec: 58, largest: { pid: 70, name: 'Remote Big', memBytes: 16 * 2 ** 30, memPct: 25 } })
    const outdated = fleetOf(machine({ processes: { state: 'unavailable', reason: 'outdated', takenAt: null } })).machines[0]!
    assert.deepEqual([outdated.processes.state, outdated.processes.reason, outdated.processes.largest], ['unavailable', 'outdated', null])
    const hostile = fleetOf(machine({ processes: { state: 'evil', reason: 'toString', largest: { pid: 1.5, name: 'x', mem: 5 } } })).machines[0]!
    assert.deepEqual([hostile.processes.state, hostile.processes.reason, hostile.processes.largest], ['unavailable', null, null])
    const carried = fleetOf(machine({ processes: { state: 'top', reason: null, takenAt: NOW - 8_000, largestAt: NOW - 180_000, memAgeMs: 170_000, largest: { pid: 70, name: 'Remote Big', mem: 2 ** 30 } } })).machines[0]!
    assert.equal(carried.processes.memAgeSec, 180, 'its real age, from when its figure was read')
    const expired = fleetOf(machine({ processes: { state: 'top', reason: null, takenAt: NOW, largestAt: null, memAgeMs: null, largest: null } })).machines[0]!
    assert.deepEqual([expired.processes.largest, expired.processes.memAgeSec], [null, null])
    const missing = fleetOf(machine({ processes: undefined })).machines[0]!
    assert.equal(missing.processes.state, 'unavailable')
  })

  test('history columns merge with the 1.2 ones kept where either side has them', () => {
    const merged = mergeColumns({ t: [1, 2], cpu: [1, 2], mem: [1, 2], gpu: [5, 6] }, { t: [3], cpu: [3], mem: [3], rx: [100] }, 60_000)
    assert.deepEqual(merged, { t: [1, 2, 3], cpu: [1, 2, 3], mem: [1, 2, 3], rx: [null, null, 100], gpu: [5, 6, null] })
  })
})

const answer = (over: Record<string, unknown> = {}) => ({
  machineId: 'local',
  state: 'ok',
  reason: null,
  scope: 'full',
  takenAt: NOW - 2_000,
  ageMs: 0,
  cpuWindowMs: 5_000,
  memAgeMs: 1_000,
  energyWindowMs: 5_000,
  total: 4,
  columns: {
    pid: [10, 11, 12, 13],
    ppid: [1, 1, 10, 1],
    name: ['Example Editor', 'example-helper', 'Zeta', 'alpha'],
    user: ['example', 'root', 'example', null],
    cpu: [5, 50, null, 0.5],
    mem: [400, 900, 100, null],
    energy: [1, 9, null, 0],
    start: [100, 101, 102, 103]
  },
  ...over
})

describe('the process list model', () => {
  test('sorted by memory by default, the largest marked, ages in seconds', () => {
    const list = toProcessList(answer(), {}, NOW)
    assert.deepEqual(list.rows.map((r) => r.pid), [11, 10, 12, 13], 'no figure last')
    assert.deepEqual([list.sort, list.state, list.scope, list.topList, list.ageSec, list.cpuWindowSec, list.count, list.shown, list.total], [{ key: 'mem', dir: 'desc' }, 'ok', 'full', false, 2, 5, 4, 4, 4])
    assert.deepEqual(list.largest, { pid: 11, name: 'example-helper', memBytes: 900 })
    assert.deepEqual(list.rows.filter((r) => r.largest).map((r) => r.pid), [11])
  })

  test('every sort key, either way, with rows without a figure last whichever way', () => {
    const order = (sort: string, dir?: 'asc' | 'desc') => toProcessList(answer(), { sort: sort as never, dir }, NOW).rows.map((r) => r.pid)
    assert.deepEqual(order('name'), [13, 10, 11, 12], 'names ignore case')
    assert.deepEqual(order('name', 'desc'), [12, 11, 10, 13])
    assert.deepEqual(order('cpu'), [11, 10, 13, 12])
    assert.deepEqual(order('cpu', 'asc'), [13, 10, 11, 12])
    assert.deepEqual(order('user'), [10, 12, 11, 13])
    assert.deepEqual(order('pid', 'desc'), [13, 12, 11, 10])
    assert.deepEqual(order('energy'), [11, 10, 13, 12])
    assert.deepEqual(order('nonsense'), [11, 10, 12, 13], 'an unknown key sorts by memory')
  })

  test('a text filter on name, user or pid; the largest stays marked whatever is shown', () => {
    assert.deepEqual(toProcessList(answer(), { query: '  EXAMPLE ' }, NOW).rows.map((r) => r.pid), [11, 10, 12])
    assert.deepEqual(toProcessList(answer(), { query: 'root' }, NOW).rows.map((r) => r.pid), [11])
    assert.deepEqual(toProcessList(answer(), { query: '1' }, NOW).rows.map((r) => r.pid), [11, 10, 12, 13])
    const filtered = toProcessList(answer(), { query: 'zeta' }, NOW)
    assert.deepEqual([filtered.shown, filtered.count, filtered.largest?.pid], [1, 4, 11])
  })

  test('a paired Mac\'s top list says so, with how many processes it has in all', () => {
    const list = toProcessList(answer({ scope: 'top', total: 640, memAgeMs: 50_000 }), {}, NOW)
    assert.deepEqual([list.topList, list.total, list.count, list.memAgeSec], [true, 640, 4, 50])
  })

  test('hostile columns: bad pids and duplicates dropped, text plain, figures bounded', () => {
    const list = toProcessList(answer({ columns: { pid: [1, 1, -2, 2.5, '3', 4], name: ['a‮b\u0007', 'dup', 'neg', 'frac', 'str', 7], user: [{}, 'x', 'x', 'x', 'x', 'u'.repeat(99)], cpu: [-1, 0, 0, 0, 0, 'x'], mem: [Infinity, 0, 0, 0, 0, 5], energy: [], start: [] } }), {}, NOW)
    assert.deepEqual(list.rows.map((r) => r.pid), [4, 1])
    const first = list.rows.find((r) => r.pid === 1)!
    assert.deepEqual([first.name, first.user, first.cpuPct, first.memBytes], ['a�b', null, null, null])
    const four = list.rows.find((r) => r.pid === 4)!
    assert.deepEqual([four.name, four.user?.length, four.memBytes], ['4', 32, 5])
  })

  test('states: loading, waiting, unavailable with its reason, and errors', () => {
    assert.equal(toProcessList(null).state, 'loading')
    assert.deepEqual([toProcessList(answer({ state: 'waiting', columns: undefined })).state, toProcessList(answer({ state: 'waiting' })).rows.length], ['waiting', 0])
    const off = toProcessList(answer({ state: 'unavailable', reason: 'publishing-off' }))
    assert.deepEqual([off.state, off.reason, off.rows.length], ['unavailable', 'publishing-off', 0])
    assert.equal(toProcessList(answer({ state: 'unavailable', reason: '__proto__' })).reason, null)
    const failed = toProcessList({ state: 'error', error: 'timeout‮', machineId: 'local' })
    assert.deepEqual([failed.state, failed.error], ['error', 'timeout�'])
    assert.equal(toProcessList({ state: 'bogus' }).state, 'error')
  })
})

describe('asking for processes', () => {
  function setup() {
    const timers: { fn: () => void; ms: number; live: boolean }[] = []
    let visible = true
    let onVisible: (() => void) | null = null
    const requests: { name: string; input: unknown }[] = []
    let hold: ((value: unknown) => void) | null = null
    let fail = false
    const orca: FleetOrca = {
      plugin: {
        request: (name: string, input?: unknown) => {
          requests.push({ name, input })
          if (name === 'fleet.processes') {
            if (fail) return Promise.reject(Object.assign(new Error('no'), { code: 'timeout' }))
            return new Promise((resolve) => (hold = resolve))
          }
          return new Promise(() => {})
        },
        on: () => ({ dispose: () => {} })
      }
    }
    const binding = createFleetBinding(orca, {
      setInterval: (fn: () => void, ms: number) => {
        const timer = { fn, ms, live: true }
        timers.push(timer)
        return timer
      },
      clearInterval: (handle: unknown) => void ((handle as { live: boolean }).live = false),
      isVisible: () => visible,
      onVisibilityChange: (handler: () => void) => {
        onVisible = handler
        return () => (onVisible = null)
      }
    })
    const asks = () => requests.filter((r) => r.name === 'fleet.processes').length
    const answerWith = async (value: unknown) => {
      hold?.(value)
      hold = null
      await flush()
    }
    return { binding, timers, asks, answerWith, hide: () => (visible = false), show: () => { visible = true; onVisible?.() }, requests, failNext: () => (fail = true) }
  }

  test('now, then every 5 s for this computer and 10 s for a paired Mac, never two at once', async () => {
    const t = setup()
    const got: unknown[] = []
    const stop = t.binding.watchProcesses('local', (a) => got.push(a))
    assert.equal(t.asks(), 1)
    const timer = t.timers.find((x) => x.ms === 5_000 && x.live && x.fn.name !== 'heartbeat')!
    timer.fn()
    assert.equal(t.asks(), 1, 'one still out')
    await t.answerWith({ state: 'ok', machineId: 'local' })
    assert.equal(got.length, 1)
    timer.fn()
    assert.equal(t.asks(), 2)
    stop()
    assert.equal(timer.live, false)
    await t.answerWith({ state: 'ok' })
    assert.equal(got.length, 1, 'nothing after stop')
    t.binding.watchProcesses('env-a', () => {})
    assert.ok(t.timers.some((x) => x.ms === 10_000 && x.live))
    assert.deepEqual(t.requests.at(-1), { name: 'fleet.processes', input: { id: 'env-a' } })
  })

  test('not while hidden; at once when shown again', async () => {
    const t = setup()
    t.hide()
    t.binding.watchProcesses('local', () => {})
    assert.equal(t.asks(), 0)
    t.show()
    assert.equal(t.asks(), 1)
  })

  test('a failed request reaches the listener as an error, not a throw', async () => {
    const t = setup()
    t.failNext()
    const answers = await t.binding.processes('local')
    assert.deepEqual(answers, { state: 'error', error: 'timeout', machineId: 'local' })
    t.binding.dispose()
    assert.equal((await t.binding.processes('local')).state, 'error')
  })
})
