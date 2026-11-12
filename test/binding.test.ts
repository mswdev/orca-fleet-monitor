// The panel's data-binding layer (panel/fleet-binding.mjs) against a stand-in window.orca.
import { assert, describe, test } from 'orca/testing'
import { createFleetBinding, mergeColumns } from '../panel/fleet-binding.mjs'
import { flush } from './helpers.ts'

type Handler = (payload: unknown) => void

function fakeOrca(options: { snapshots?: unknown[]; heartbeatSeq?: () => number; failSnapshot?: boolean } = {}) {
  const handlers = new Map<string, Handler>()
  const requests: string[] = []
  let snapshotIndex = 0
  const orca = {
    plugin: {
      request: async (name: string) => {
        requests.push(name)
        if (name === 'fleet.snapshot') {
          if (options.failSnapshot) throw Object.assign(new Error('worker down'), { code: 'unavailable' })
          const list = options.snapshots ?? []
          return list[Math.min(snapshotIndex++, list.length - 1)]
        }
        if (name === 'fleet.heartbeat') return { ok: true, mode: 'fast', seq: options.heartbeatSeq?.() ?? 0 }
        throw Object.assign(new Error('nope'), { code: 'unknown_method' })
      },
      on: (event: string, handler: Handler) => {
        handlers.set(event, handler)
        return { dispose: () => handlers.delete(event) }
      }
    }
  }
  return { orca, requests, post: (payload: unknown) => handlers.get('fleet.update')?.(payload), handlers }
}

const machineState = (id: string, cpu: number) => ({ id, name: id, kind: 'remote', online: true, cpu: { percent: cpu } })
const snapshot = (seq: number, generatedAt: number, history = { t: [1_000, 2_000], cpu: [1, 2], mem: [10, 20] }) => ({
  v: 1,
  seq,
  generatedAt,
  mode: 'fast',
  intervalMs: 5_000,
  historyWindowMs: 60_000,
  cli: { path: null, source: 'bundled', error: null },
  machines: [{ ...machineState('env-a', 5), history }]
})
const update = (seq: number, generatedAt: number, appended: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  v: 1,
  seq,
  generatedAt,
  mode: 'fast',
  intervalMs: 5_000,
  cli: null,
  recentMs: 30_000,
  machines: [machineState('env-a', 50)],
  appended,
  ...extra
})

function bind(fake: ReturnType<typeof fakeOrca>, visible = { value: true }) {
  const timers: { fn: () => void; ms: number }[] = []
  let visibilityHandler: () => void = () => {}
  const binding = createFleetBinding(fake.orca, {
    setInterval: (fn: () => void, ms: number) => {
      timers.push({ fn, ms })
      return timers.length
    },
    clearInterval: () => {},
    isVisible: () => visible.value,
    onVisibilityChange: (handler: () => void) => {
      visibilityHandler = handler
      return () => {}
    }
  })
  return { binding, timers, changeVisibility: () => visibilityHandler() }
}

describe('createFleetBinding', () => {
  test('starts from a snapshot and hands the view each machine with its history', async () => {
    const fake = fakeOrca({ snapshots: [snapshot(3, 10_000)] })
    const { binding } = bind(fake)
    const views: any[] = []
    binding.subscribe((v: unknown) => views.push(v))
    await binding.ready
    const v = binding.current()
    assert.equal(v.ready, true)
    assert.equal(v.seq, 3)
    assert.equal(v.cli?.source, 'bundled')
    assert.deepEqual(v.machines.map((m: any) => m.id), ['env-a'])
    assert.deepEqual(v.machines[0].history.t, [1_000, 2_000])
    assert.equal(views[0].ready, false, 'the first call is the loading state')
    assert.deepEqual(fake.requests, ['fleet.snapshot'])
  })

  test('updates replace states and merge points by time', async () => {
    const fake = fakeOrca({ snapshots: [snapshot(3, 10_000)] })
    const { binding } = bind(fake)
    await binding.ready
    fake.post(update(4, 15_000, { 'env-a': { t: [2_000, 3_000], cpu: [2.5, 3], mem: [25, 30] } }))
    const m = binding.current().machines[0]
    assert.equal(m.cpu.percent, 50)
    assert.deepEqual(m.history, { t: [1_000, 2_000, 3_000], cpu: [1, 2.5, 3], mem: [10, 25, 30] })
    fake.post(update(4, 15_000, { 'env-a': { t: [9_000], cpu: [9], mem: [9] } }))
    assert.equal(binding.current().machines[0].history.t.length, 3, 'a repeated seq is ignored')
    assert.deepEqual(fake.requests, ['fleet.snapshot'])
  })

  test('a short gap is absorbed; a gap longer than the repeated window re-fetches', async () => {
    const fake = fakeOrca({ snapshots: [snapshot(3, 10_000), snapshot(9, 100_000)] })
    const { binding } = bind(fake)
    await binding.ready
    fake.post(update(5, 20_000))
    assert.deepEqual(fake.requests, ['fleet.snapshot'])
    fake.post(update(8, 90_000))
    assert.deepEqual(fake.requests, ['fleet.snapshot', 'fleet.snapshot'])
    await binding.refresh()
    const after = binding.current()
    assert.ok(after.ready)
    assert.equal(after.seq, 9)
  })

  test('resync and a worker far ahead both re-fetch', async () => {
    let workerSeq = 3
    const fake = fakeOrca({ snapshots: [snapshot(3, 10_000)], heartbeatSeq: () => workerSeq })
    const { binding } = bind(fake)
    await binding.ready
    fake.post(update(4, 11_000, {}, { resync: true, machines: [] }))
    await flush()
    assert.equal(fake.requests.filter((r) => r === 'fleet.snapshot').length, 2)
    workerSeq = 20
    binding._heartbeat()
    await flush()
    assert.equal(fake.requests.filter((r) => r === 'fleet.snapshot').length, 3)
  })

  test('heartbeats every 5 s only while visible; coming back re-fetches', async () => {
    const visible = { value: true }
    const fake = fakeOrca({ snapshots: [snapshot(3, 10_000)] })
    const { binding, timers, changeVisibility } = bind(fake, visible)
    await binding.ready
    assert.deepEqual(timers.map((t) => t.ms), [5_000])
    timers[0]!.fn()
    await flush()
    assert.equal(fake.requests.filter((r) => r === 'fleet.heartbeat').length, 1)
    visible.value = false
    changeVisibility()
    timers[0]!.fn()
    await flush()
    assert.equal(fake.requests.filter((r) => r === 'fleet.heartbeat').length, 1)
    visible.value = true
    changeVisibility()
    await flush()
    assert.equal(fake.requests.filter((r) => r === 'fleet.snapshot').length, 2)
  })

  test('reports a worker it cannot reach', async () => {
    const fake = fakeOrca({ failSnapshot: true })
    const { binding } = bind(fake)
    await binding.ready
    assert.deepEqual(binding.current(), { ready: false, error: 'unavailable', machines: [] })
  })

  test('dispose stops listening', async () => {
    const fake = fakeOrca({ snapshots: [snapshot(3, 10_000)] })
    const { binding } = bind(fake)
    await binding.ready
    binding.dispose()
    assert.equal(fake.handlers.size, 0)
  })
})

test('mergeColumns keeps one point per time, in order, inside the window', () => {
  const merged = mergeColumns({ t: [1, 5, 9], cpu: [1, 5, 9], mem: [null, null, null] }, { t: [5, 12], cpu: [55, 12], mem: [1, 2] }, 8)
  assert.deepEqual(merged, { t: [5, 9, 12], cpu: [55, 9, 12], mem: [1, null, 2] })
  assert.deepEqual(mergeColumns(undefined, undefined, 10), { t: [], cpu: [], mem: [] })
})
