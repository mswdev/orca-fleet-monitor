// toFleet() and its helpers (panel/fleet-binding.mjs), the chart paths (panel/charts.mjs) and the
// text formats (panel/format.mjs): everything between the worker's model and the drawing.
import { assert, describe, test } from 'orca/testing'
import { seriesPaths } from '../panel/charts.mjs'
import {
  bucketHistory,
  installCommand,
  INSTALL_SOURCE,
  levelFor,
  toFleet,
  windowStats,
  type FleetReadyView,
  type MachineModel
} from '../panel/fleet-binding.mjs'
import { ago, duration, gb, loads, pct, share, size } from '../panel/format.mjs'
import { DEFAULT_HEALTH } from '../src/health.ts'
import type { MachineView } from '../src/model.ts'

const NOW = 1_800_000_000_000
const MIN = 60_000
const GIB = 2 ** 30

function machine(over: Partial<MachineView> = {}): MachineView {
  return {
    id: 'env-a',
    name: 'Build Box',
    kind: 'remote',
    tier: 'full',
    status: 'online',
    online: true,
    lastSeenAt: NOW - 3_000,
    latencyMs: 300,
    error: null,
    host: { hostname: 'build-box', platform: 'darwin', arch: 'arm64', cpuModel: 'Example Chip', cores: 4, uptimeSec: 90_000 },
    cpu: { percent: 88, source: 'beacon', perCore: [90, 80, 20, 10], groups: null },
    memory: { total: 64 * GIB, used: 32 * GIB, available: 32 * GIB, percent: 50, source: 'orca', reliable: true },
    load: { one: 3.5, five: 3, fifteen: 2.25 },
    orca: { cpu: 40, memory: 2 * GIB, totalCpu: 100, totalMemory: 4 * GIB },
    workspaces: { byCpu: [], byMemory: [] },
    health: { level: 'strained', reasons: ['CPU 88% ≥ 85%'], cpu: 'strained', memory: 'ok' },
    beacon: { state: 'fresh', ageMs: 1_000, seq: 9, pluginKey: 'local.fleet-monitor', remotePlugin: 'running' },
    updatedAt: NOW,
    history: { t: [], cpu: [], mem: [] },
    ...over
  }
}

function view(machines: MachineView[]): FleetReadyView {
  return {
    ready: true,
    error: null,
    seq: 1,
    generatedAt: NOW,
    mode: 'fast',
    intervalMs: 5_000,
    historyWindowMs: 30 * MIN,
    cli: { path: '/x/orca', source: 'bundled', error: null },
    thresholds: DEFAULT_HEALTH,
    machines
  }
}

const only = (m: MachineView): MachineModel => toFleet(view([m]), NOW).machines[0]!

describe('history as 30 one-minute points', () => {
  test('averages each minute, leaves minutes without readings empty, and ends on the newest reading', () => {
    const t = [NOW - 125_000, NOW - 115_000, NOW - 61_000, NOW - 30_000, NOW - 1_000]
    const cpu = [10, 30, 40, 50, 70]
    const points = bucketHistory({ t, cpu, mem: t.map(() => null) }, 'cpu', NOW)
    assert.equal(points.length, 30)
    assert.deepEqual(points.slice(0, 26), new Array(26).fill(null), 'nothing older than 3 minutes')
    // (-180 s, -120 s]: 10 · (-120 s, -60 s]: 30 and 40 · the last minute: the newest reading, 70.
    assert.deepEqual(points.slice(26), [null, 10, 35, 70])
  })

  test('ignores readings outside the 30 minutes and empty values', () => {
    const t = [NOW - 31 * MIN, NOW - 10_000]
    assert.deepEqual(bucketHistory({ t, cpu: [99, null], mem: [] }, 'cpu', NOW), new Array(30).fill(null))
  })

  test('average and peak come from the raw readings in the window', () => {
    const t = [NOW - 40 * MIN, NOW - 20 * MIN, NOW - 10 * MIN, NOW - 1_000]
    assert.deepEqual(windowStats({ t, cpu: [100, 20, 60, 40], mem: [] }, 'cpu', NOW), { avg: 40, peak: 60 })
    assert.equal(windowStats({ t: [], cpu: [], mem: [] }, 'cpu', NOW), null)
  })
})

describe('toFleet', () => {
  test('is loading before the first snapshot, and an error when it failed', () => {
    assert.equal(toFleet({ ready: false, error: null, machines: [] }, NOW).state, 'loading')
    const failed = toFleet({ ready: false, error: 'unavailable', machines: [] }, NOW)
    assert.deepEqual([failed.state, failed.error], ['error', 'unavailable'])
  })

  test('counts machines online, and remotes, for the header', () => {
    const fleet = toFleet(
      view([
        machine({ id: 'local', kind: 'local', name: 'This one' }),
        machine({ id: 'env-b', online: false, status: 'offline' }),
        machine({ id: 'env-c', online: false, status: 'connecting' })
      ]),
      NOW
    )
    assert.deepEqual([fleet.online, fleet.total, fleet.remotes], [1, 3, 2])
    assert.deepEqual(fleet.machines.map((m) => m.status), ['online', 'offline', 'connecting'])
  })

  test('a full machine: health and per-metric tones from the worker, one group of cores without a split', () => {
    const m = only(machine())
    assert.deepEqual([m.health, m.healthLabel, m.cpu.tone, m.mem.tone, m.tier, m.tag], ['strained', 'Strained', 'strained', 'ok', 'full', ''])
    assert.equal(m.cpu.estimated, false)
    assert.deepEqual(m.cpu.groups?.map((g) => [g.label, g.short, g.values.length]), [['Cores', null, 4]])
    assert.deepEqual(m.cpu.groups?.[0]?.tones, ['ok', 'ok', 'ok', 'ok'].map((_, i) => levelFor([90, 80, 20, 10][i]!, DEFAULT_HEALTH.cpu)))
    assert.equal(m.uptimeSec, 90_000)
    assert.equal(m.chip, 'Example Chip')
    assert.equal(m.install, null)
  })

  test('P-cores come before E-cores, whatever order os.cpus() lists them in', () => {
    const m = only(
      machine({
        cpu: {
          percent: 50,
          source: 'sampler',
          perCore: [11, 12, 90, 91, 92, 93],
          groups: [
            { kind: 'performance', start: 2, count: 4 },
            { kind: 'efficiency', start: 0, count: 2 }
          ]
        }
      })
    )
    assert.deepEqual(
      m.cpu.groups?.map((g) => [g.label, g.short, g.values]),
      [
        ['P-cores', 'P', [90, 91, 92, 93]],
        ['E-cores', 'E', [11, 12]]
      ]
    )
  })

  test('a split that does not fit the cores is drawn as one group', () => {
    const m = only(machine({ cpu: { percent: 5, source: 'beacon', perCore: [1, 2, 3], groups: [{ kind: 'performance', start: 0, count: 2 }] } }))
    assert.deepEqual(m.cpu.groups?.map((g) => g.label), ['Cores'])
  })

  test('a basic machine: estimated CPU, no per-core view, the Basic tag and an install hint', () => {
    const m = only(
      machine({
        tier: 'basic',
        cpu: { percent: 40, source: 'load', perCore: null, groups: null },
        load: { one: 1.6, five: null, fifteen: null },
        host: { hostname: null, platform: null, arch: null, cpuModel: null, cores: 4, uptimeSec: null },
        beacon: { state: 'absent', ageMs: null, seq: null, pluginKey: null, remotePlugin: 'absent' }
      })
    )
    assert.deepEqual([m.tier, m.tag, m.cpu.estimated, m.cpu.groups, m.chip, m.uptimeSec], ['basic', 'Basic', true, null, null, null])
    assert.deepEqual(m.install, { reason: 'absent', command: `orca plugin install ${INSTALL_SOURCE} --environment "Build Box"` })
  })

  test('the basic row says why when Fleet Monitor is there but silent or off', () => {
    const basic = (remotePlugin: 'installed' | 'running') =>
      only(machine({ tier: 'basic', beacon: { state: 'stale', ageMs: null, seq: 1, pluginKey: null, remotePlugin } })).install
    assert.deepEqual(basic('installed'), { reason: 'installed', command: null })
    assert.deepEqual(basic('running'), { reason: 'quiet', command: null })
  })

  test('the local machine is never basic and is tagged by its platform', () => {
    const mac = only(machine({ id: 'local', kind: 'local', tier: 'full' }))
    assert.deepEqual([mac.local, mac.tag, mac.install], [true, 'This Mac', null])
    const linux = only(machine({ id: 'local', kind: 'local', host: { ...machine().host, platform: 'linux' } }))
    assert.equal(linux.tag, 'This machine')
  })

  test('workspaces: one list from both tops, CPU as a share of the whole machine, busiest first', () => {
    const w = (id: string, cpu: number, memory: number) => ({ id, name: `ws-${id}`, repo: 'demo', cpu, memory, sessions: 1 })
    const m = only(
      machine({ workspaces: { byCpu: [w('a', 200, 1), w('b', 40, 2)], byMemory: [w('c', 0, 9 * GIB), w('a', 200, 1)] } })
    )
    assert.deepEqual(
      m.workspaces.map((x) => [x.name, x.cpuPct, x.memBytes]),
      [
        ['ws-a', 50, 1],
        ['ws-b', 10, 2],
        ['ws-c', 0, 9 * GIB]
      ]
    )
  })

  test('offline: no live sections, last known values from history, last seen on the local clock', () => {
    const m = only(
      machine({
        online: false,
        status: 'offline',
        lastSeenAt: NOW - 3 * MIN,
        error: 'orca diagnostics memory timed out',
        health: { level: 'unknown', reasons: ['offline'], cpu: null, memory: null },
        history: { t: [NOW - 4 * MIN, NOW - 3 * MIN], cpu: [30, 35], mem: [60, 61] }
      })
    )
    assert.deepEqual([m.online, m.status, m.health, m.workspaces.length, m.cpu.groups, m.uptimeSec], [false, 'offline', 'unknown', 0, null, null])
    assert.deepEqual(m.lastKnown, { cpuPct: 35, memPct: 61 })
    assert.equal(m.updatedAt, NOW - 3 * MIN)
    assert.equal(m.error, 'orca diagnostics memory timed out')
  })

  test('memory that cannot be trusted has no tone and is not "last known"', () => {
    const m = only(machine({ memory: { total: 8 * GIB, used: 7 * GIB, available: GIB, percent: 90, source: 'os', reliable: false }, health: { level: 'ok', reasons: [], cpu: 'ok', memory: null } }))
    assert.deepEqual([m.mem.reliable, m.mem.tone, m.lastKnown.memPct], [false, 'ok', null])
  })
})

describe('installCommand', () => {
  test('quotes a plain name, apostrophes included', () => {
    assert.equal(installCommand({ id: 'env-1', name: "Example's Mac mini" }), `orca plugin install ${INSTALL_SOURCE} --environment "Example's Mac mini"`)
  })

  test('falls back to the environment id for a name a shell would read as code', () => {
    for (const name of ['$(rm -rf ~)', 'a"b', 'back`tick`', 'semi\\colon', 'bang!', 'line\nbreak', '']) {
      assert.equal(installCommand({ id: 'env-0000-1111', name }), `orca plugin install ${INSTALL_SOURCE} --environment env-0000-1111`, name)
    }
  })

  test('never lets an odd id through either', () => {
    assert.equal(installCommand({ id: 'x;$(y)', name: '$bad' }), `orca plugin install ${INSTALL_SOURCE} --environment "xy"`)
  })
})

describe('chart paths', () => {
  test('spread points evenly and keep gaps open', () => {
    const p = seriesPaths([null, 0, 100, null, 50], 100, 10, 0)
    assert.equal(p.line, 'M25 10 L50 0 M100 5 L100 5')
    assert.equal(p.area, 'M25 10 L50 0 L50 10 L25 10 Z')
    assert.equal(p.points, 3)
  })

  test('nothing to draw is empty', () => {
    assert.deepEqual(seriesPaths(new Array(30).fill(null), 300, 72), { line: '', area: '', points: 0 })
  })
})

describe('text', () => {
  test('numbers and sizes as the design writes them', () => {
    assert.deepEqual([pct(17.6), pct(null), gb(34.6 * GIB), gb(64 * GIB), size(6.4 * GIB), size(512 * 2 ** 20)], ['18', '–', '34.6', '64', '6.4 GB', '512 MB'])
    assert.deepEqual([share(38.2), share(0.2), share(0)], ['38%', '<1%', '0%'])
    assert.equal(loads({ one: 2.31, five: 2.64, fifteen: 2.9 }), '2.31 · 2.64 · 2.90')
    assert.equal(loads({ one: 1.5, five: null, fifteen: null }), '1.50')
  })

  test('durations and times ago', () => {
    assert.deepEqual([duration(23 * 86_400 + 7 * 3_600), duration(5 * 3_600 + 12 * 60), duration(720)], ['23d 7h', '5h 12m', '12m'])
    assert.deepEqual(
      [ago(NOW - 500, NOW), ago(NOW - 2_000, NOW), ago(NOW - 4 * MIN, NOW), ago(NOW - 134 * MIN, NOW), ago(NOW - 77 * 3_600_000, NOW)],
      ['just now', '2s ago', '4m ago', '2h 14m ago', '3d 5h ago']
    )
  })
})

describe('health colour contrast', () => {
  test('the design colours stand on a white card; a tinted light card needs the stronger set', async () => {
    const { contrastRatio, needsStrongerHealth } = await import('../panel/contrast.mjs')
    const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
    const design = ['#15803d', '#a16207', '#c2410c', '#b91c1c'].map(hex)
    const stronger = ['#166534', '#854d0e', '#9a3412', '#991b1b'].map(hex)
    assert.ok(Math.abs(contrastRatio(hex('#000000'), hex('#ffffff')) - 21) < 0.01)
    assert.equal(needsStrongerHealth(design, [hex('#ffffff'), hex('#f6f6f7')]), false)
    assert.equal(needsStrongerHealth(design, [hex('#d5d6db')]), true)
    assert.equal(needsStrongerHealth(stronger, [hex('#d5d6db')]), false)
    assert.equal(needsStrongerHealth([null, ...design], [null]), false, 'unknown colours are not guessed')
  })
})
