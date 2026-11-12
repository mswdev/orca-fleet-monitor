import { assert, describe, test } from 'orca/testing'
import { BEACON_PREFIX, decodeBeacon, encodeBeacon } from '../src/beacon.ts'
import { estimateCloneBytes, PanelBridge, SNAPSHOT_MAX_BYTES, type BridgeSource } from '../src/bridge.ts'
import { DEFAULT_HEALTH } from '../src/health.ts'
import { HistoryRing } from '../src/history.ts'
import { mergeMachine } from '../src/merge.ts'
import type { FleetMode, FleetUpdate, MachineState } from '../src/model.ts'
import type { MachineEntry } from '../src/poller.ts'
import { readSettings } from '../src/settings.ts'
import { statusBarView } from '../src/status-bar.ts'
import { readFileSync } from 'node:fs'
import { FakeTime, localSample, macMemory } from './helpers.ts'

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
            latest: { ...localSample(), run: 'r', seq: 1, intervalMs: 5_000, cpu: over.cpu ?? 10, perCore: null, coreGroups: null, memTotal: 10, memFree: 5, loggedAt: 0 },
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

/** Whether a value survives a structured clone, which is how Orca hands it to a panel. */
function clones(value: unknown): boolean {
  try {
    structuredClone(value)
    return true
  } catch {
    return false
  }
}

describe('only plain data, never over the cap', () => {
  const bridgeOf = (entries: MachineEntry[], extra: Partial<ConstructorParameters<typeof PanelBridge>[0]> = {}) => {
    const time = new FakeTime()
    const posts: FleetUpdate[] = []
    const bridge = new PanelBridge({
      source: source(time, entries, { value: 'fast' }),
      post: (p) => posts.push(p),
      now: time.now,
      cli: () => ({ path: null, source: null, error: null }),
      setTimeout: time.setTimeout,
      clearTimeout: time.clearTimeout,
      ...extra
    })
    return { bridge, posts, time }
  }

  test('a beacon whose core kind is "constructor" cannot put a function in front of the panel', () => {
    const line = (kind: string) =>
      `${BEACON_PREFIX}${JSON.stringify({ v: 1, r: 'run', q: 1, t: 1, iv: 5000, h: 'h', p: 'linux', a: 'x64', rl: '1', m: 'cpu', n: 4, u: 1, c: 10, pc: [1, 2, 3, 4], cg: [[kind, 0, 4]], mt: 1000, mf: 500, l: [1, 2, 3] })}`
    for (const kind of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      const latest = decodeBeacon(line(kind))
      assert.ok(latest)
      assert.equal(latest.coreGroups, null, kind)
      const state = mergeMachine({
        id: 'env-x', name: 'x', kind: 'remote', now: 0, status: 'online', lastSeenAt: 0, latencyMs: 1, error: null,
        beacon: { latest, fresh: true, ageMs: 0, pluginKey: 'local.fleet-monitor', remotePlugin: 'running' }, health: DEFAULT_HEALTH
      })
      const { bridge } = bridgeOf([{ state: machine('local'), history: new HistoryRing() }, { state, history: new HistoryRing() }])
      const snap = bridge.snapshot()
      assert.ok(clones(snap), kind)
      assert.deepEqual(snap.machines.map((m) => m.id), ['local', 'env-x'])
    }
  })

  test('whatever slips into a state, the snapshot and the posts carry plain data only', () => {
    const bad = machine('env-bad') as unknown as Record<string, unknown>
    bad.cpu = { ...(bad.cpu as object), groups: [{ kind: Object, start: 0, count: 1 }], percent: Number.NaN }
    bad.extra = () => 1
    bad.when = new Date(0)
    const { bridge, posts } = bridgeOf([{ state: machine('local'), history: new HistoryRing() }, { state: bad as unknown as MachineState, history: new HistoryRing() }])
    const snap = bridge.snapshot()
    assert.ok(clones(snap))
    const sent = snap.machines.find((m) => m.id === 'env-bad') as unknown as Record<string, unknown>
    assert.equal('extra' in sent, false)
    assert.equal('when' in sent, false)
    assert.deepEqual((sent.cpu as { groups: unknown }).groups, [{ start: 0, count: 1 }])
    bridge.flush()
    assert.ok(clones(posts[0]))
    assert.equal(posts[0]?.resync, undefined)
  })

  test('the cap holds without history: thin, then drop detail, then leave machines out (counted)', () => {
    const huge = (id: string): MachineState => {
      const m = machine(id)
      const w = { id: 'w'.repeat(128), name: 'n'.repeat(128), repo: 'r'.repeat(128), cpu: 1, memory: 1, sessions: 1 }
      return { ...m, error: 'e'.repeat(500), cpu: { ...m.cpu, perCore: Array.from({ length: 2_048 }, () => 50) }, workspaces: { byCpu: [w, w, w, w, w], byMemory: [w, w, w, w, w] } }
    }
    const entries = Array.from({ length: 64 }, (_, i) => ({ state: huge(i === 0 ? 'local' : `env-${i}`), history: new HistoryRing() }))
    const { bridge } = bridgeOf(entries)
    const snap = bridge.snapshot()
    assert.ok(estimateCloneBytes(snap) <= SNAPSHOT_MAX_BYTES, `${estimateCloneBytes(snap)} bytes`)
    assert.equal(snap.machines.length, 64, 'every machine is still listed, without its bulk')
    assert.equal(snap.machines[5]?.cpu.perCore, null)
    const tight = bridgeOf(entries, { snapshotMaxBytes: 12_000 }).bridge.snapshot()
    assert.ok(estimateCloneBytes(tight) <= 12_000)
    assert.ok(tight.machines.length > 0 && tight.machines.length < 64)
    assert.equal(tight.machines[0]?.id, 'local', 'this computer first')
    assert.equal(tight.omitted, 64 - tight.machines.length)
  })

  test('a post too large with detail is sent lean before it falls back to a resync', () => {
    const big = (id: string): MachineState => ({ ...machine(id), cpu: { ...machine(id).cpu, perCore: Array.from({ length: 1_000 }, () => 1) } })
    const entries = Array.from({ length: 30 }, (_, i) => ({ state: big(`env-${i}`), history: new HistoryRing() }))
    const { bridge, posts } = bridgeOf(entries)
    bridge.flush()
    assert.equal(posts[0]?.resync, undefined)
    assert.equal(posts[0]?.machines.length, 30)
    assert.equal(posts[0]?.machines[0]?.cpu.perCore, null)
    assert.equal(posts[0]?.lean, true, 'marked, so a panel keeps the detail it has')
  })

  test('detail is left out of the bulkiest machines first: a small machine keeps its per-core values', () => {
    const small = { ...machine('env-small'), cpu: { ...machine('env-small').cpu, perCore: [10, 20, 30, 40] } }
    const bulky = (id: string): MachineState => ({ ...machine(id), cpu: { ...machine(id).cpu, perCore: Array.from({ length: 2_048 }, () => 99) } })
    const entries = [small, ...Array.from({ length: 12 }, (_, i) => bulky(`env-big-${i}`))].map((state) => ({ state, history: new HistoryRing() }))
    const { bridge, posts } = bridgeOf(entries)
    bridge.flush()
    const post = posts[0]!
    assert.ok(estimateCloneBytes(post) <= 240 * 1024)
    assert.equal(post.lean, true)
    const sent = post.machines.find((m) => m.id === 'env-small')!
    assert.deepEqual(sent.cpu.perCore, [10, 20, 30, 40], 'the small machine keeps live per-core values')
    assert.equal(sent.lean, undefined)
    const leaned = post.machines.filter((m) => m.lean === true)
    assert.ok(leaned.length > 0 && leaned.every((m) => m.id.startsWith('env-big-') && m.cpu.perCore === null))
    const snap = bridgeOf(entries, { snapshotMaxBytes: 200_000 }).bridge.snapshot()
    assert.deepEqual(snap.machines.find((m) => m.id === 'env-small')?.cpu.perCore, [10, 20, 30, 40], 'and so does the snapshot')
  })

  test('only a post or snapshot that left detail out is marked lean', () => {
    const { bridge, posts } = bridgeOf([{ state: machine('local'), history: new HistoryRing() }, { state: machine('env-a'), history: new HistoryRing() }])
    bridge.flush()
    assert.equal(posts[0]?.lean, undefined)
    assert.equal(bridge.snapshot().lean, undefined)
    const big = (id: string): MachineState => ({ ...machine(id), cpu: { ...machine(id).cpu, perCore: Array.from({ length: 2_000 }, () => 1) } })
    const crowded = bridgeOf(Array.from({ length: 40 }, (_, i) => ({ state: big(`env-${i}`), history: new HistoryRing() })), { snapshotMaxBytes: 200_000 })
    const snap = crowded.bridge.snapshot()
    assert.equal(snap.machines[0]?.cpu.perCore, null)
    assert.equal(snap.lean, true)
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

  test('an estimate never names a machine or sets the tone, and is labelled in the tooltip', () => {
    const basicState = mergeMachine({
      id: 'env-b', name: 'Basic Box', kind: 'remote', now: 0, status: 'online', lastSeenAt: 0, latencyMs: 1, error: null,
      diag: {
        collectedAt: 1, runtimeId: null,
        host: { totalMemory: 100, availableMemory: 80, usedMemory: 20, memoryPercent: 20, availableMemorySource: 'proc-meminfo', cores: 4, load1: 8 },
        app: { cpu: 0, memory: 0 }, totalCpu: 0, totalMemory: 0, workspaces: []
      },
      health: DEFAULT_HEALTH
    })
    const v = statusBarView([machine('local'), basicState])
    assert.equal(v.text, '2 machines ok', 'a 100% estimate is not "critical"')
    assert.equal(v.tone, 'neutral')
    assert.match(v.tooltip, /Basic Box: ok · CPU ~100% \(estimate\) · mem 20%/)
  })

  test('with background monitoring off and no panel, only this computer is summed up', () => {
    const v = statusBarView([machine('local'), machine('env-a', { cpu: 99, name: 'Hot Box' })], { remotesPaused: true })
    assert.equal(v.text, '1 machine ok')
    assert.ok(!/Hot Box/.test(v.tooltip))
    assert.match(v.tooltip, /background monitoring is off/)
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

describe('statusBarView and memory (1.1)', () => {
  const GIB = 2 ** 30
  /** A remote Mac with Fleet Monitor 1.1 (CPU 12%), merged from a fresh beacon carrying `reading`. */
  const withMac = (reading: Parameters<typeof macMemory>[0]) =>
    mergeMachine({
      id: 'env-mini',
      name: 'Mac mini',
      kind: 'remote',
      now: 0,
      status: 'online',
      lastSeenAt: 0,
      latencyMs: 1,
      error: null,
      beacon: {
        latest: decodeBeacon(encodeBeacon(localSample({ platform: 'darwin', cpu: { total: 12, perCore: [12] }, macMemory: macMemory(reading) }), { run: 'r', seq: 1, intervalMs: 5_000 }))!,
        fresh: true,
        ageMs: 0,
        pluginKey: 'k',
        remotePlugin: 'running'
      },
      health: DEFAULT_HEALTH
    })

  test('a Mac near its limit: the status bar says memory, the tooltip says why, with RAM, swap and pressure', () => {
    const state = withMac({ used: 15.1 * GIB, app: 9.6 * GIB, pressure: 'warning', availablePercent: 12, swapUsed: 6.2 * GIB, swapTotal: 7 * GIB })
    const v = statusBarView([machine('local'), state])
    assert.equal(v.text, 'Mac mini memory strained')
    assert.equal(v.tone, 'warning')
    assert.match(
      v.tooltip,
      /\nMac mini: strained \(macOS memory pressure warning, 12% available; memory pressure 88% ≥ 88%\) · CPU 12% · RAM 94% used \(15\.1\/16 GB\) · swap 6\.2 GB · memory pressure warning$/
    )
  })

  test('a Mac read only through Orca is memory pressure, never used', () => {
    const state = mergeMachine({
      id: 'env-b', name: 'Build Box', kind: 'remote', now: 0, status: 'online', lastSeenAt: 0, latencyMs: 1, error: null,
      diag: {
        collectedAt: 1, runtimeId: null,
        host: { totalMemory: 16 * GIB, availableMemory: 0.1 * 16 * GIB, usedMemory: 0.9 * 16 * GIB, memoryPercent: 90, availableMemorySource: 'memory-pressure', cores: 4, load1: 1 },
        app: { cpu: 0, memory: 0 }, totalCpu: 0, totalMemory: 0, workspaces: []
      },
      health: DEFAULT_HEALTH
    })
    const v = statusBarView([machine('local'), state])
    assert.equal(v.text, 'Build Box memory strained')
    assert.match(v.tooltip, /Build Box: strained \(memory pressure 90% ≥ 88%\) · CPU ~25% \(estimate\) · memory pressure 90%$/)
    assert.ok(!/used/.test(v.tooltip.split('\n').find((l) => l.startsWith('Build Box'))!))
  })

  test('CPU and memory at the same level: the name and the level, as before', () => {
    const both = withMac({ pressure: 'warning', availablePercent: 12 })
    const hot = { ...both, cpu: { ...both.cpu, percent: 90 }, health: { ...both.health, cpu: 'strained' as const } }
    assert.equal(statusBarView([hot]).text, 'Mac mini strained')
  })
})

describe('readSettings (1.1)', () => {
  test('RAM used busy at 90% unless set, clamped; alerts on unless turned off', () => {
    const s = readSettings({})
    assert.deepEqual([s.memoryRules.ramUsedBusyPercent, s.memoryAlerts], [90, true])
    assert.deepEqual(s.health, DEFAULT_HEALTH, 'the memory thresholds stay where they were')
    const set = readSettings({ ramUsedBusyPercent: 150, memoryAlerts: false })
    assert.deepEqual([set.memoryRules.ramUsedBusyPercent, set.memoryAlerts], [100, false])
    assert.equal(readSettings({ ramUsedBusyPercent: 'x' }).memoryRules.ramUsedBusyPercent, 90)
  })

  test('the manifest declares both settings, and the notifications capability', () => {
    const manifest = JSON.parse(readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8')) as {
      version: string
      contributes: { settings: { key: string; type: string; default: unknown; minimum?: number; maximum?: number }[] }
      capabilities: { kind: string }[]
    }
    const setting = (key: string) => manifest.contributes.settings.find((s) => s.key === key)
    assert.deepEqual(setting('ramUsedBusyPercent') && [setting('ramUsedBusyPercent')!.type, setting('ramUsedBusyPercent')!.default, setting('ramUsedBusyPercent')!.minimum, setting('ramUsedBusyPercent')!.maximum], ['integer', 90, 1, 100])
    assert.deepEqual(setting('memoryAlerts') && [setting('memoryAlerts')!.type, setting('memoryAlerts')!.default], ['boolean', true])
    assert.deepEqual(manifest.capabilities.map((c) => c.kind), ['settings:own', 'notifications:show'])
    assert.equal(manifest.version, '1.1.0')
  })
})
