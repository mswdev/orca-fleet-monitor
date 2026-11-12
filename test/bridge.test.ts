import { assert, describe, test } from 'orca/testing'
import { estimateCloneBytes, PanelBridge, type BridgeSource } from '../src/bridge.ts'
import { DEFAULT_HEALTH } from '../src/health.ts'
import { HistoryRing } from '../src/history.ts'
import { mergeMachine } from '../src/merge.ts'
import type { FleetMode, FleetUpdate, MachineState } from '../src/model.ts'
import type { MachineEntry } from '../src/poller.ts'
import { readSettings } from '../src/settings.ts'
import { statusBarView } from '../src/status-bar.ts'
import { FakeTime, localSample } from './helpers.ts'

function machine(id: string, over: { status?: MachineState['status']; cpu?: number; name?: string } = {}): MachineState {
  return mergeMachine({
    id,
    name: over.name ?? id,
    kind: id === 'local' ? 'local' : 'remote',
    now: 0,
    status: over.status ?? 'online',
    lastSeenAt: 0,
    latencyMs: 300,
    error: null,
    local: id === 'local' ? localSample({ cpu: { total: over.cpu ?? 10, perCore: [10] }, memory: { total: 16 * 2 ** 30, free: 12 * 2 ** 30 } }) : null,
    beacon:
      id === 'local'
        ? null
        : {
            latest: { ...localSample(), run: 'r', seq: 1, intervalMs: 5_000, cpu: over.cpu ?? 10, perCore: null, memTotal: 10, memFree: 5, loggedAt: 0 },
            fresh: true,
            ageMs: 0,
            pluginKey: 'local.fleet-monitor',
            remotePlugin: 'running'
          },
    health: DEFAULT_HEALTH
  })
}

function source(time: FakeTime, entries: MachineEntry[], mode: { value: FleetMode }): BridgeSource {
  return { entries: () => entries, mode: () => mode.value, intervalMs: () => (mode.value === 'fast' ? 5_000 : 60_000) }
}

function ringWith(time: FakeTime, points: number, everyMs: number): HistoryRing {
  const ring = new HistoryRing()
  for (let i = points - 1; i >= 0; i -= 1) ring.add({ t: time.now() - i * everyMs, cpu: 10, mem: 20 }, time.now())
  return ring
}

describe('PanelBridge', () => {
  test('snapshot carries every machine with its history', () => {
    const time = new FakeTime()
    const entries = [{ state: machine('local'), history: ringWith(time, 5, 5_000) }]
    const bridge = new PanelBridge({
      source: source(time, entries, { value: 'fast' }),
      post: () => {},
      now: time.now,
      cli: () => ({ path: '/x/orca', source: 'bundled', error: null }),
      setTimeout: time.setTimeout,
      clearTimeout: time.clearTimeout
    })
    const snap = bridge.snapshot()
    assert.equal(snap.v, 1)
    assert.equal(snap.seq, 0)
    assert.equal(snap.mode, 'fast')
    assert.equal(snap.machines[0]?.history.t.length, 5)
    assert.equal(snap.cli.source, 'bundled')
  })

  test('a snapshot over the size cap thins history instead of failing', () => {
    const time = new FakeTime()
    const entries = [{ state: machine('local'), history: ringWith(time, 1_000, 1_000) }]
    const bridge = new PanelBridge({
      source: source(time, entries, { value: 'fast' }),
      post: () => {},
      now: time.now,
      cli: () => ({ path: null, source: null, error: null }),
      setTimeout: time.setTimeout,
      clearTimeout: time.clearTimeout,
      snapshotMaxBytes: 8_000
    })
    const snap = bridge.snapshot()
    assert.ok(estimateCloneBytes(snap) <= 8_000)
    const t = snap.machines[0]!.history.t
    assert.ok(t.length < 1_000 && t.length > 0)
    assert.equal(t[t.length - 1], time.now(), 'the newest point survives')
  })

  test('posts are coalesced to one per second, only while fast, with recent points and a rising seq', () => {
    const time = new FakeTime()
    const mode = { value: 'fast' as FleetMode }
    const entries = [{ state: machine('local'), history: ringWith(time, 20, 5_000) }]
    const posts: FleetUpdate[] = []
    const bridge = new PanelBridge({
      source: source(time, entries, mode),
      post: (p) => posts.push(p),
      now: time.now,
      cli: () => ({ path: null, source: null, error: null }),
      setTimeout: time.setTimeout,
      clearTimeout: time.clearTimeout
    })
    bridge.notify()
    bridge.notify()
    bridge.notify()
    time.advance(0)
    assert.equal(posts.length, 1)
    bridge.notify()
    time.advance(500)
    assert.equal(posts.length, 1, 'not within a second of the last post')
    time.advance(500)
    assert.equal(posts.length, 2)
    assert.deepEqual(posts.map((p) => p.seq), [1, 2])
    const recent = posts[0]!.appended.local!.t
    assert.equal(posts[0]!.recentMs, 30_000)
    assert.ok(recent.length >= 6 && recent.length <= 7, 'about 30 s of 5 s points')
    assert.equal(bridge.snapshot().seq, 2)
    mode.value = 'slow'
    bridge.notify()
    time.advance(5_000)
    assert.equal(posts.length, 2, 'nothing posts while no panel heartbeats')
  })

  test('an update over the post cap becomes a resync request', () => {
    const time = new FakeTime()
    const entries = Array.from({ length: 40 }, (_, i) => ({ state: machine(`env-${i}`), history: ringWith(time, 10, 1_000) }))
    const posts: FleetUpdate[] = []
    const bridge = new PanelBridge({
      source: source(time, entries, { value: 'fast' }),
      post: (p) => posts.push(p),
      now: time.now,
      cli: () => ({ path: null, source: null, error: null }),
      setTimeout: time.setTimeout,
      clearTimeout: time.clearTimeout,
      postMaxBytes: 4_000
    })
    bridge.flush()
    assert.equal(posts[0]?.resync, true)
    assert.deepEqual(posts[0]?.machines, [])
  })
})

test('estimateCloneBytes counts as Orca does, not as JSON', () => {
  assert.equal(estimateCloneBytes(null), 1)
  assert.equal(estimateCloneBytes(1), 8)
  assert.equal(estimateCloneBytes('é'), 2)
  assert.equal(estimateCloneBytes([1, 2]), 8 + 2 * (4 + 8))
  assert.equal(estimateCloneBytes({ ab: true }), 4 + 2 + 1)
  // Short numbers cost far more than their JSON: 1,000 of them are ~2 KB of JSON, 12 KB here.
  const numbers = Array.from({ length: 1_000 }, () => 1)
  assert.ok(estimateCloneBytes(numbers) > 5 * JSON.stringify(numbers).length)
  // Too many objects is refused whatever their size.
  assert.equal(estimateCloneBytes(Array.from({ length: 10_000 }, () => ({}))), Number.POSITIVE_INFINITY)
})

describe('statusBarView', () => {
  test('all fine', () => {
    const v = statusBarView([machine('local'), machine('env-a')])
    assert.equal(v.text, '2 machines ok')
    assert.equal(v.tone, 'neutral')
    assert.equal(v.icon, 'gauge')
    assert.equal(v.tooltip, 'Fleet Monitor\nlocal: ok · CPU 10% · mem 25%\nenv-a: ok · CPU 10% · mem 50%')
  })

  test('names the worst machine and colours by level', () => {
    assert.deepEqual(
      [statusBarView([machine('local'), machine('env-a', { cpu: 75, name: 'Build Box' })]).text, statusBarView([machine('env-a', { cpu: 75 })]).tone],
      ['Build Box busy', 'accent']
    )
    assert.equal(statusBarView([machine('env-a', { cpu: 90 })]).tone, 'warning')
    const critical = statusBarView([machine('env-a', { cpu: 99, name: 'A very long machine name that keeps going' })])
    assert.equal(critical.tone, 'danger')
    assert.equal(critical.text, 'A very long machine nam… critical')
  })

  test('counts offline machines and warns', () => {
    const v = statusBarView([machine('local'), machine('env-a', { status: 'offline' })])
    assert.equal(v.text, '1 machine ok · 1 offline')
    assert.equal(v.tone, 'warning')
    assert.match(v.tooltip, /env-a: offline/)
  })
})

describe('readSettings', () => {
  test('defaults', () => {
    const s = readSettings({})
    assert.equal(s.fastIntervalMs, 5_000)
    assert.equal(s.slowIntervalMs, 60_000)
    assert.deepEqual(s.health, DEFAULT_HEALTH)
    assert.equal(s.cliPath, null)
    assert.equal(s.beacon, true)
  })

  test('clamps, orders and trims', () => {
    const s = readSettings({
      fastIntervalSeconds: 0.5,
      slowIntervalSeconds: 99_999,
      cpuBusyPercent: 90,
      cpuStrainedPercent: 50,
      cpuCriticalPercent: 400,
      memoryBusyPercent: 'x',
      cliPath: '  /opt/orca/bin/orca  ',
      beacon: false
    })
    assert.equal(s.fastIntervalMs, 2_000)
    assert.equal(s.slowIntervalMs, 3_600_000)
    assert.deepEqual(s.health.cpu, { busy: 50, strained: 90, critical: 100 })
    assert.equal(s.health.memory.busy, DEFAULT_HEALTH.memory.busy)
    assert.equal(s.cliPath, '/opt/orca/bin/orca')
    assert.equal(s.beacon, false)
    assert.equal(readSettings({ fastIntervalSeconds: 40, slowIntervalSeconds: 20 }).slowIntervalMs, 40_000)
    assert.equal(readSettings(null).fastIntervalMs, 5_000)
  })
})
