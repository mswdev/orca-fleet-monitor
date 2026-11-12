// The panel's data-binding layer (panel/fleet-binding.mjs) against a stand-in window.orca.
import { assert, describe, test } from 'orca/testing'
import { createFleetBinding, mergeColumns, type FleetOrca, type FleetReadyView, type FleetView } from '../panel/fleet-binding.mjs'
import { flush } from './helpers.ts'

type Handler = (payload: unknown) => void

/** The view once ready; fails the test otherwise. Narrowing by hand keeps every TypeScript happy. */
function readyView(view: FleetView): FleetReadyView {
  if (!view.ready) throw new Error(`the view is not ready (error: ${view.error ?? 'none'})`)
  return view
}

function fakeOrca(options: { snapshots?: unknown[]; heartbeatSeq?: () => number; failSnapshot?: boolean } = {}) {
  const handlers = new Map<string, Handler>()
  const requests: string[] = []
  const inputs: unknown[] = []
  let snapshotIndex = 0
  const orca: FleetOrca = {
    plugin: {
      request: async (name: string, input?: unknown) => {
        requests.push(name)
        inputs.push(input)
        if (name === 'fleet.snapshot') {
          if (options.failSnapshot) throw Object.assign(new Error('worker down'), { code: 'unavailable' })
          const list = options.snapshots ?? []
          return list[Math.min(snapshotIndex++, list.length - 1)]
        }
        if (name === 'fleet.heartbeat') return { ok: true, mode: 'fast', seq: options.heartbeatSeq?.() ?? 0 }
        if (name === 'fleet.retry') return { ok: (input as { id?: string } | undefined)?.id === 'env-a' }
        throw Object.assign(new Error('nope'), { code: 'unknown_method' })
      },
      on: (event: string, handler: Handler) => {
        handlers.set(event, handler)
        return { dispose: () => handlers.delete(event) }
      }
    }
  }
  const snapshotCount = () => requests.filter((r) => r === 'fleet.snapshot').length
  return { orca, requests, inputs, snapshotCount, post: (payload: unknown) => handlers.get('fleet.update')?.(payload), handlers }
}

type Columns = { t: number[]; cpu: (number | null)[]; mem: (number | null)[] }

const machineState = (id: string, cpu: number) => ({ id, name: id, kind: 'remote', online: true, cpu: { percent: cpu } })
const snapshot = (
  seq: number,
  generatedAt: number,
  history: Columns = { t: [1_000, 2_000], cpu: [1, 2], mem: [10, 20] },
  extra: Record<string, unknown> = {}
) => ({
  v: 1,
  seq,
  generatedAt,
  mode: 'fast',
  intervalMs: 5_000,
  historyWindowMs: 60_000,
  cli: { path: null, source: 'bundled', error: null },
  thresholds: { cpu: { busy: 50, strained: 60, critical: 70 }, memory: { busy: 75, strained: 88, critical: 95 } },
  historyRev: 0,
  run: 'run-1',
  machines: [{ ...machineState('env-a', 5), history }],
  ...extra
})
const update = (seq: number, generatedAt: number, appended: Record<string, Columns> = {}, extra: Record<string, unknown> = {}) => ({
  v: 1,
  seq,
  generatedAt,
  mode: 'fast',
  intervalMs: 5_000,
  cli: null,
  recentMs: 30_000,
  historyRev: 0,
  run: 'run-1',
  machines: [machineState('env-a', 50)],
  appended,
  ...extra
})

function bind(fake: ReturnType<typeof fakeOrca>, visible = { value: true }, now?: () => number) {
  const timers: { fn: () => void; ms: number }[] = []
  let visibilityHandler: () => void = () => {}
  const binding = createFleetBinding(fake.orca, {
    now,
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
    const views: FleetView[] = []
    binding.subscribe((v) => views.push(v))
    await binding.ready
    const v = readyView(binding.current())
    assert.equal(v.seq, 3)
    assert.equal(v.cli?.source, 'bundled')
    assert.deepEqual(v.thresholds.cpu, { busy: 50, strained: 60, critical: 70 })
    assert.deepEqual(v.machines.map((m) => m.id), ['env-a'])
    assert.deepEqual(v.machines[0]!.history.t, [1_000, 2_000])
    assert.equal(views[0]!.ready, false, 'the first call is the loading state')
    assert.deepEqual(fake.requests, ['fleet.snapshot'])
  })

  test('a snapshot from an older worker without thresholds gets the defaults', async () => {
    const fake = fakeOrca({ snapshots: [snapshot(3, 10_000, undefined, { thresholds: undefined })] })
    const { binding } = bind(fake)
    await binding.ready
    assert.deepEqual(readyView(binding.current()).thresholds.cpu, { busy: 70, strained: 85, critical: 95 })
  })

  test('updates replace states and merge points by time', async () => {
    const fake = fakeOrca({ snapshots: [snapshot(3, 10_000)] })
    const { binding } = bind(fake)
    await binding.ready
    fake.post(update(4, 15_000, { 'env-a': { t: [2_000, 3_000], cpu: [2.5, 3], mem: [25, 30] } }))
    const m = readyView(binding.current()).machines[0]!
    assert.equal(m.cpu.percent, 50)
    assert.deepEqual(m.history, { t: [1_000, 2_000, 3_000], cpu: [1, 2.5, 3], mem: [10, 25, 30] })
    fake.post(update(4, 15_000, { 'env-a': { t: [9_000], cpu: [9], mem: [9] } }))
    assert.equal(readyView(binding.current()).machines[0]!.history.t.length, 3, 'a repeated seq is ignored')
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
    assert.equal(readyView(binding.current()).seq, 9)
  })

  test('resync and a worker far ahead both re-fetch', async () => {
    let workerSeq = 3
    const fake = fakeOrca({ snapshots: [snapshot(3, 10_000)], heartbeatSeq: () => workerSeq })
    const { binding } = bind(fake)
    await binding.ready
    fake.post(update(4, 11_000, {}, { resync: true, machines: [] }))
    await flush()
    assert.equal(fake.snapshotCount(), 2)
    workerSeq = 20
    binding._heartbeat()
    await flush()
    assert.equal(fake.snapshotCount(), 3)
  })

  test('a restarted worker (new run, seq from 1 again) is followed, not ignored', async () => {
    const fake = fakeOrca({ snapshots: [snapshot(40, 10_000), snapshot(2, 20_000, undefined, { run: 'run-2' })] })
    const { binding } = bind(fake)
    await binding.ready
    fake.post(update(1, 20_000, {}, { run: 'run-2' }))
    await flush()
    assert.equal(fake.snapshotCount(), 2)
    fake.post(update(3, 21_000, {}, { run: 'run-2', machines: [machineState('env-a', 77)] }))
    assert.equal(readyView(binding.current()).machines[0]!.cpu.percent, 77)
    assert.equal(fake.snapshotCount(), 2)
  })

  test('history rewritten further back than a post repeats (a back-fill) re-fetches once', async () => {
    const fake = fakeOrca({
      snapshots: [snapshot(3, 10_000), snapshot(5, 12_000, { t: [500, 1_000, 2_000], cpu: [1, 1, 2], mem: [1, 1, 2] }, { historyRev: 1 })]
    })
    const { binding } = bind(fake)
    await binding.ready
    fake.post(update(4, 11_000, {}, { historyRev: 1 }))
    await flush()
    assert.equal(fake.snapshotCount(), 2)
    assert.deepEqual(readyView(binding.current()).machines[0]!.history.t, [500, 1_000, 2_000])
    fake.post(update(6, 13_000, {}, { historyRev: 1 }))
    await flush()
    assert.equal(fake.snapshotCount(), 2, 'the same revision does not re-fetch again')
  })

  test('retry asks the worker and says whether it took the request', async () => {
    const fake = fakeOrca({ snapshots: [snapshot(3, 10_000)] })
    const { binding } = bind(fake)
    await binding.ready
    assert.equal(await binding.retry('env-a'), true)
    assert.equal(await binding.retry('env-gone'), false)
    assert.deepEqual(fake.inputs.slice(-2), [{ id: 'env-a' }, { id: 'env-gone' }])
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
    assert.equal(fake.snapshotCount(), 2)
  })

  test('a hidden panel never asks for a snapshot (which would keep fast polling on); it catches up when shown', async () => {
    const visible = { value: true }
    const fake = fakeOrca({ snapshots: [snapshot(3, 10_000), snapshot(9, 100_000)] })
    const { binding, changeVisibility, timers } = bind(fake, visible)
    await binding.ready
    visible.value = false
    changeVisibility()
    // Another panel keeps the worker fast, so this one still hears posts.
    fake.post(update(4, 11_000, {}, { resync: true, machines: [] }))
    fake.post(update(5, 12_000, {}, { run: 'run-2' }))
    fake.post(update(8, 90_000))
    fake.post(update(9, 91_000, {}, { historyRev: 4 }))
    timers[0]!.fn()
    await flush()
    assert.equal(fake.snapshotCount(), 1, 'nothing while hidden')
    assert.equal(fake.requests.filter((r) => r === 'fleet.heartbeat').length, 0)
    visible.value = true
    changeVisibility()
    await flush()
    assert.equal(fake.snapshotCount(), 2, 'one re-fetch as it comes back')
  })

  test('a panel created hidden waits until it is shown', async () => {
    const visible = { value: false }
    const fake = fakeOrca({ snapshots: [snapshot(3, 10_000)] })
    const { binding, changeVisibility } = bind(fake, visible)
    await binding.ready
    assert.equal(fake.snapshotCount(), 0)
    visible.value = true
    changeVisibility()
    await flush()
    assert.equal(fake.snapshotCount(), 1)
    assert.equal(readyView(binding.current()).seq, 3)
  })

  test('works out the worker clock from each answer and post', async () => {
    let frame = 50_000
    const fake = fakeOrca({ snapshots: [snapshot(3, 3_650_000)] })
    const { binding } = bind(fake, { value: true }, () => frame)
    await binding.ready
    assert.equal(readyView(binding.current()).clockOffsetMs, 3_600_000, 'the worker runs an hour ahead of this frame')
    frame = 60_000
    fake.post(update(4, 3_660_500))
    assert.equal(readyView(binding.current()).clockOffsetMs, 3_600_500)
  })

  test('reports a worker it cannot reach, and keeps asking on each heartbeat', async () => {
    const fake = fakeOrca({ failSnapshot: true })
    const { binding } = bind(fake)
    await binding.ready
    assert.deepEqual(binding.current(), { ready: false, error: 'unavailable', machines: [] })
    binding._heartbeat()
    await flush()
    assert.equal(fake.snapshotCount(), 2, 'no snapshot yet: a heartbeat asks for one')
    assert.equal(fake.requests.filter((r) => r === 'fleet.heartbeat').length, 0)
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
