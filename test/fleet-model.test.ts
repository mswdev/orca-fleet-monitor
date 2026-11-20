// toFleet() and its helpers (panel/fleet-binding.mjs), the chart paths (panel/charts.mjs) and the
// text formats (panel/format.mjs): everything between the worker's model and the drawing.
import { assert, describe, test } from 'orca/testing'
import { GAP_MS, frameOf, levelOf, levelStops, linePath, monotone, placeFrame, rangePath, tweenFrame, type Frame } from '../panel/charts.mjs'
import {
  chartRule,
  installCommand,
  measuredCpu,
  INSTALL_SOURCE,
  levelFor,
  toFleet,
  trendOf,
  windowStats,
  type FleetReadyView,
  type MachineModel
} from '../panel/fleet-binding.mjs'
import { ago, duration, gb, loads, pct, share, size } from '../panel/format.mjs'
import { DEFAULT_HEALTH } from '../src/health.ts'
import type { MachineView } from '../src/model.ts'
import { SAMPLE_THRESHOLDS, sampleSnapshot } from '../tools/preview/sample-fleet.mjs'
import { readFileSync } from 'node:fs'

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

describe('history as per-minute trends', () => {
  // NOW falls on a minute's start, so every reading before it is in a minute already over.
  const t = [NOW - 125_000, NOW - 115_000, NOW - 61_000, NOW - 30_000, NOW - 1_000]
  const cpu = [10, 30, 40, 50, 70]

  test("one point per minute with readings: its readings' mean, lowest and highest, at their mean time", () => {
    const trend = trendOf({ t, cpu, mem: t.map(() => null) }, 'cpu', NOW)
    assert.deepEqual(trend.points, [
      { key: NOW / MIN - 3, t: NOW - 125_000, v: 10, lo: 10, hi: 10 },
      { key: NOW / MIN - 2, t: NOW - 88_000, v: 35, lo: 30, hi: 40 },
      { key: NOW / MIN - 1, t: NOW - 15_500, v: 60, lo: 50, hi: 70 }
    ])
    assert.deepEqual(trend.live, { t: NOW - 1_000, v: 70 }, 'the line ends on the newest reading')
    assert.equal(trend.count, 5)
  })

  test('the minute under way is not a point: the newest reading stands for it', () => {
    const later = trendOf({ t: [...t, NOW + 10_000], cpu: [...cpu, 90], mem: [] }, 'cpu', NOW + 20_000)
    assert.equal(later.points.length, 3)
    assert.deepEqual(later.live, { t: NOW + 10_000, v: 90 })
  })

  test('a minute already drawn keeps its figures as time passes', () => {
    const columns = { t, cpu, mem: [] }
    assert.deepEqual(trendOf(columns, 'cpu', NOW + 5_000).points, trendOf(columns, 'cpu', NOW + 55_000).points)
  })

  test('a minute of one reading that is also the newest is one point, not two', () => {
    const trend = trendOf({ t: [NOW - 30_000], cpu: [42], mem: [] }, 'cpu', NOW)
    assert.equal(trend.points.length, 1)
    assert.equal(trend.live, null)
    assert.equal(trend.count, 1)
  })

  test('ignores readings outside the window (but one minute before it, to enter from the edge) and empty values', () => {
    const trend = trendOf({ t: [NOW - 40 * MIN, NOW - 30.5 * MIN, NOW - 10_000], cpu: [99, 20, null], mem: [] }, 'cpu', NOW)
    assert.deepEqual(trend.points.map((p) => p.v), [20])
    assert.equal(trend.count, 0, 'the reading just before the window is not counted in it')
  })

  test('a reading after the window\'s end (the clock stepped back) is left for later', () => {
    const columns = { t: [NOW - 5_000, NOW + 5_000], cpu: [1, 100], mem: [] }
    const trend = trendOf(columns, 'cpu', NOW)
    assert.deepEqual([trend.count, trend.live], [1, null])
    assert.deepEqual(windowStats(columns, 'cpu', NOW), { avg: 1, peak: 1, peakAt: NOW - 5_000 })
  })

  test('a machine measured now leaves its earlier load estimates out of the CPU chart', () => {
    const columns = { t: [NOW - 90_000, NOW - 30_000, NOW - 1_000], cpu: [98, 10, 12], mem: [40, 40, 40], ce: [1, null, null] as (1 | null)[] }
    assert.deepEqual(measuredCpu(columns), { t: [NOW - 30_000, NOW - 1_000], cpu: [10, 12], mem: [] })
    const m = toFleet(view([machine({ history: columns, cpu: { percent: 12, source: 'beacon', perCore: [12], groups: null } })]), NOW).machines[0]!
    assert.equal(m.cpu.stats?.peak, 12, 'the 98 % estimate is not its peak')
    assert.deepEqual(m.cpu.trend.points.map((pt) => pt.v), [11], 'nor drawn: one minute of 10 and 12')
    const basic = toFleet(view([machine({ tier: 'basic', history: columns, cpu: { percent: 97, source: 'load', perCore: null, groups: null } })]), NOW).machines[0]!
    assert.equal(basic.cpu.stats?.peak, 98, 'a machine still estimated draws its estimates')
  })

  test('average and peak come from the raw readings in the window, with when the peak was', () => {
    const times = [NOW - 40 * MIN, NOW - 20 * MIN, NOW - 10 * MIN, NOW - 1_000]
    assert.deepEqual(windowStats({ t: times, cpu: [100, 20, 60, 40], mem: [] }, 'cpu', NOW), { avg: 40, peak: 60, peakAt: NOW - 10 * MIN })
    assert.equal(windowStats({ t: [], cpu: [], mem: [] }, 'cpu', NOW), null)
  })
})

describe('chart rules: what each chart is coloured and banded by', () => {
  const thresholds = { cpu: { busy: 60, strained: 80, critical: 90 }, memory: { busy: 70, strained: 85, critical: 92 }, ramUsedBusy: 93 }
  test("measured CPU on the person's CPU thresholds; an estimate on none", () => {
    assert.deepEqual(chartRule('cpu', { estimated: false }, thresholds), [
      { level: 'busy', at: 60 },
      { level: 'strained', at: 80 },
      { level: 'critical', at: 90 }
    ])
    assert.equal(chartRule('cpu', { estimated: true }, thresholds), null)
  })
  test('RAM in use on its one rule; pressure and Orca\'s figure on the memory thresholds; nothing unjudged', () => {
    assert.deepEqual(chartRule('memory', { kind: 'used', reliable: true }, thresholds), [{ level: 'busy', at: 93 }])
    assert.deepEqual(chartRule('memory', { kind: 'pressure', reliable: true }, thresholds)?.map((r) => r.at), [70, 85, 92])
    assert.deepEqual(chartRule('memory', { kind: 'orca', reliable: true }, thresholds)?.map((r) => r.at), [70, 85, 92])
    assert.equal(chartRule('memory', { kind: 'unavailable', reliable: false }, thresholds), null)
    assert.equal(chartRule('memory', { kind: 'used', reliable: true, stale: true }, thresholds), null, 'carried too long to be judged: one colour')
    assert.equal(chartRule('memory', { kind: 'orca', reliable: false }, thresholds), null)
  })
  test("a snapshot's thresholds reach the model, RAM in use's own included", () => {
    const m = toFleet({ ...view([machine()]), thresholds: thresholds as never }, NOW).machines[0]!
    assert.deepEqual(m.cpu.rule?.map((r) => r.at), [60, 80, 90])
    const older = chartRule('memory', { kind: 'used', reliable: true }, { cpu: thresholds.cpu, memory: thresholds.memory } as never)
    assert.deepEqual(older, [{ level: 'busy', at: 90 }], "a worker that does not send RAM in use's rule: the default")
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
    assert.deepEqual(m.install, { reason: 'absent', command: `orca plugin install ${INSTALL_SOURCE} --environment "Build Box"`, launcher: 'orca' })
  })

  test('only a machine known to be a Mac gets the Mac install pitch', () => {
    const absent = { state: 'absent' as const, ageMs: null, seq: null, pluginKey: null, remotePlugin: 'absent' as const }
    const basic = (memory: Record<string, unknown>) => only(machine({ tier: 'basic', beacon: absent, host: { hostname: null, platform: null, arch: null, cpuModel: null, cores: 4, uptimeSec: null }, memory: { total: 16 * GIB, used: 8 * GIB, available: 8 * GIB, percent: 50, source: 'orca', reliable: true, ...memory } as never }))
    assert.equal(basic({ kind: 'pressure', pressurePercent: 50 }).install?.mac, true, "Orca's pressure reading is a Mac's")
    assert.equal(basic({}).install?.mac, undefined)
    // "Only free memory" is what Orca says of a Mac after a slow reading, and of Linux without /proc/meminfo.
    assert.equal(basic({ kind: 'unavailable', reliable: false }).install?.mac, undefined)
  })

  test('an estimate is never coloured by the CPU thresholds, even if a worker sent a CPU level', () => {
    const m = only(
      machine({
        tier: 'basic',
        cpu: { percent: 99, source: 'load', perCore: null, groups: null },
        health: { level: 'critical', reasons: [], cpu: 'critical', memory: 'ok' },
        beacon: { state: 'absent', ageMs: null, seq: null, pluginKey: null, remotePlugin: 'absent' }
      })
    )
    assert.equal(m.cpu.tone, 'ok')
  })

  test('the install command uses the launcher this computer has, and the id for a name two machines share', () => {
    const basicMachine = (id: string, name: string) =>
      machine({ id, name, tier: 'basic', cpu: { percent: 1, source: 'load', perCore: null, groups: null }, beacon: { state: 'absent', ageMs: null, seq: null, pluginKey: null, remotePlugin: 'absent' } })
    const linux = toFleet(
      {
        ...view([machine({ id: 'local', kind: 'local', host: { ...machine().host, platform: 'linux' } }), basicMachine('env-1', 'Twin'), basicMachine('env-2', 'Twin')]),
        cli: { path: '/x', source: 'bundled', error: null }
      },
      NOW
    )
    assert.equal(linux.launcher, 'orca-ide', 'from the local platform when the worker does not say')
    assert.deepEqual(
      linux.machines.slice(1).map((m) => m.install?.command),
      [`orca-ide plugin install ${INSTALL_SOURCE} --environment=env-1`, `orca-ide plugin install ${INSTALL_SOURCE} --environment=env-2`]
    )
    const said = toFleet({ ...view([basicMachine('env-1', 'Build Box')]), cli: { path: '/x', source: 'bundled', error: null, launcher: 'orca-ide' } }, NOW)
    assert.equal(said.machines[0]!.install?.command, `orca-ide plugin install ${INSTALL_SOURCE} --environment "Build Box"`)
    const odd = toFleet({ ...view([basicMachine('env-1', 'Build Box')]), cli: { path: '/x', source: 'bundled', error: null, launcher: 'rm -rf' as 'orca' } }, NOW)
    assert.match(odd.machines[0]!.install?.command ?? '', /^orca plugin install/, 'only a known launcher name')
  })

  test('a name the CLI reads as this computer, or that another server answers to under Orca\'s comparison, gets the id', () => {
    const basicMachine = (id: string, name: string) =>
      machine({ id, name, tier: 'basic', cpu: { percent: 1, source: 'load', perCore: null, groups: null }, beacon: { state: 'absent', ageMs: null, seq: null, pluginKey: null, remotePlugin: 'absent' } })
    const commands = (...remotes: MachineView[]) =>
      toFleet(view([machine({ id: 'local', kind: 'local', name: 'Desk' }), ...remotes]), NOW).machines.slice(1).map((m) => m.install?.command)
    const byName = (name: string) => `orca plugin install ${INSTALL_SOURCE} --environment "${name}"`
    const byId = (id: string) => `orca plugin install ${INSTALL_SOURCE} --environment=${id}`
    // `--environment local` is this computer, whatever the case, and quoted too.
    for (const name of ['local', 'LOCAL', 'Local', "'local'", "'Local'"]) {
      assert.deepEqual(commands(basicMachine('env-1', name)), [byId('env-1')], name)
      assert.equal(installCommand({ id: 'env-1', name }), byId('env-1'), name)
    }
    // Orca matches names trimmed, unquoted and ignoring case: these pairs are one name to it.
    assert.deepEqual(commands(basicMachine('env-1', 'Build Box'), basicMachine('env-2', 'build box')), [byId('env-1'), byId('env-2')])
    assert.deepEqual(commands(basicMachine('env-1', 'Build Box'), basicMachine('env-2', "'Build Box'")), [byId('env-1'), byId('env-2')])
    assert.deepEqual(commands(basicMachine('env-1', 'Build Box'), basicMachine('env-2', 'BUILD BOX ')), [byId('env-1'), byId('env-2')])
    // Orca takes an exact id before any name: a name that is another server's id is not its own.
    assert.deepEqual(commands(basicMachine('env-1', 'env-2'), basicMachine('env-2', 'Other')), [byId('env-1'), byName('Other')])
    // Different names, and a name like this computer's (not a selector), stay names.
    assert.deepEqual(commands(basicMachine('env-1', 'Build Box'), basicMachine('env-2', 'Build Box 2'), basicMachine('env-3', 'Desk')), [
      byName('Build Box'),
      byName('Build Box 2'),
      byName('Desk')
    ])
  })

  test('more cores than are drawn one by one are counted, not left out unsaid', () => {
    const many = only(machine({ host: { ...machine().host, cores: 300 }, cpu: { percent: 40, source: 'beacon', perCore: Array.from({ length: 300 }, () => 40), groups: null } }))
    assert.equal(many.cpu.groups, null)
    assert.equal(many.cpu.coresHidden, 300)
    const drawn = only(machine({ cpu: { percent: 40, source: 'beacon', perCore: Array.from({ length: 256 }, () => 40), groups: null } }))
    assert.equal(drawn.cpu.coresHidden, 0)
    assert.equal(drawn.cpu.groups?.[0]?.values.length, 256)
  })

  test('bidirectional controls in remote text are neutralized here too', () => {
    const rlo = '‮'
    const m = only(
      machine({
        name: `${rlo}evil`,
        error: `bad${rlo}thing`,
        host: { ...machine().host, cpuModel: `chip⁦x` },
        workspaces: { byCpu: [{ id: 'w1', name: `ws‏name`, repo: `re؜po`, cpu: 50, memory: 1, sessions: 1 }], byMemory: [] }
      })
    )
    const shown = [m.name, m.error, m.chip, m.workspaces[0]!.name, m.workspaces[0]!.repo].join(' ')
    assert.ok(!/[؜‎‏‪-‮⁦-⁩]/.test(shown), JSON.stringify(shown))
    assert.equal(m.name, '�evil')
  })

  test('names from the data never reach Object.prototype, and absurd figures are clamped', () => {
    const odd = only(
      machine({
        health: { level: 'toString' as 'ok', reasons: [], cpu: 'valueOf' as 'ok', memory: '__proto__' as 'ok' },
        cpu: { percent: 1e9, source: 'beacon', perCore: [1, 2], groups: [{ kind: 'constructor' as 'performance', start: 0, count: 2 }] },
        memory: { total: 1, used: 1, available: 0, percent: -5, source: 'orca', reliable: true },
        workspaces: { byCpu: [{ id: 'w', name: 'w', repo: '', cpu: 1e299, memory: 1, sessions: 1 }], byMemory: [] }
      })
    )
    // The bogus levels are dropped; the tones then follow the (clamped) figures themselves.
    assert.deepEqual([odd.health, odd.healthLabel, odd.cpu.tone, odd.mem.tone], ['unknown', 'Waiting', 'critical', 'ok'])
    assert.deepEqual(odd.cpu.groups?.map((g) => g.label), ['Cores'])
    assert.deepEqual([odd.cpu.pct, odd.mem.pct, odd.workspaces[0]?.cpuPct], [100, 0, 100])
    const many = only(machine({ cpu: { percent: 5, source: 'beacon', perCore: new Array(300).fill(5), groups: null } }))
    assert.equal(many.cpu.groups, null, 'too many cores to draw one by one')
  })

  test('a CLI error from resolution or from listing machines reaches the model', () => {
    assert.equal(toFleet({ ...view([]), cli: { path: null, source: null, error: 'not found' } }, NOW).cliError, 'not found')
    assert.equal(toFleet({ ...view([]), cli: { path: '/x', source: 'bundled', error: null, runError: 'spawn EACCES' } }, NOW).cliError, 'spawn EACCES')
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
  const ID = '00000000-1111-4222-8333-444444444444'
  const withId = `orca plugin install ${INSTALL_SOURCE} --environment=${ID}`

  test('quotes a plain ASCII name, the straight apostrophe included', () => {
    assert.equal(installCommand({ id: ID, name: "Example's Mac mini" }), `orca plugin install ${INSTALL_SOURCE} --environment "Example's Mac mini"`)
    assert.equal(installCommand({ id: ID, name: 'build-box_02.lan' }), `orca plugin install ${INSTALL_SOURCE} --environment "build-box_02.lan"`)
  })

  test('uses the id, in --environment=<id> form, for any name outside the allowlist', () => {
    const names = [
      'Build Box”; Write-Output injected; #', // curly quotes: PowerShell reads them as quote marks
      'x“; calc; ”y',
      'Example’s Mac', // a curly apostrophe
      'a„ b',
      '--approve ap1-abc', // read as options
      '-rf',
      '$(rm -rf ~)',
      '$HOME',
      'a"b',
      'back`tick`',
      'semi\\colon',
      'bang!',
      'pct%PATH%',
      'caret^',
      'a;b',
      'a&b',
      'a|b',
      'a>b',
      'a#b',
      'é漢字',
      '\u202eevil',
      'tab\there',
      'line\nbreak',
      ' lead',
      'trail ',
      'x'.repeat(65),
      ''
    ]
    for (const name of names) assert.equal(installCommand({ id: ID, name }), withId, JSON.stringify(name))
  })

  test('uses the id when another paired machine has the same name', () => {
    assert.equal(installCommand({ id: ID, name: 'Build Box' }, { ambiguous: true }), withId)
  })

  test('offers no command when neither the name nor the id is safe', () => {
    for (const id of ['--json', '-e', '', 'x y', 'a"b', '$(id)', '../..']) {
      assert.equal(installCommand({ id, name: '$bad' }), null, JSON.stringify(id))
    }
  })

  test('takes only a known launcher', () => {
    assert.equal(installCommand({ id: ID, name: 'Box' }, { launcher: 'orca-ide' }), `orca-ide plugin install ${INSTALL_SOURCE} --environment "Box"`)
    assert.equal(installCommand({ id: ID, name: 'Box' }, { launcher: 'evil; rm' }), `orca plugin install ${INSTALL_SOURCE} --environment "Box"`)
  })
})

test('the preview and the listing images are judged on the thresholds Fleet Monitor ships with', () => {
  const manifest = JSON.parse(readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8')) as {
    contributes: { settings: { key: string; default: unknown }[] }
  }
  const setting = (key: string) => manifest.contributes.settings.find((s) => s.key === key)?.default
  const shipped = {
    cpu: { busy: setting('cpuBusyPercent'), strained: setting('cpuStrainedPercent'), critical: setting('cpuCriticalPercent') },
    memory: { busy: setting('memoryBusyPercent'), strained: setting('memoryStrainedPercent'), critical: setting('memoryCriticalPercent') }
  }
  assert.deepEqual(DEFAULT_HEALTH, shipped)
  assert.deepEqual(SAMPLE_THRESHOLDS, shipped)
  const snapshot = sampleSnapshot('live', NOW)
  assert.deepEqual(snapshot.thresholds, shipped)
  const fleet = toFleet({ ready: true, error: null, ...snapshot }, NOW)
  const levels = Object.fromEntries(fleet.machines.map((m) => [m.name, m.health]))
  // Still a spread of health levels to show, each as the worker would judge it.
  assert.deepEqual(levels, { 'MacBook Pro': 'ok', 'Mac Studio': 'strained', 'Mac mini': 'busy', 'ci-runner-02': 'busy', 'MacBook Air': 'unknown' })
  for (const m of fleet.machines.filter((x) => x.online && !x.cpu.estimated)) {
    const worst = [levelFor(m.cpu.pct, shipped.cpu as typeof DEFAULT_HEALTH.cpu), levelFor(m.mem.pct, shipped.memory as typeof DEFAULT_HEALTH.memory)]
    const rank = ['ok', 'busy', 'strained', 'critical']
    assert.equal(m.health, worst.sort((a, b) => rank.indexOf(b) - rank.indexOf(a))[0], m.name)
  }
})

describe('chart geometry', () => {
  const frame = (points: [number, number][], count = points.length, end = 100): Frame => ({
    start: 0,
    end,
    count,
    points: points.map(([t, v], i) => ({ key: i === points.length - 1 ? ('live' as const) : i, t, v, lo: v, hi: v }))
  })

  test('x is time across the window, y is 0..100 down the box', () => {
    const runs = placeFrame(frame([[0, 0], [50, 100], [100, 50]]), 100, 10, 0)
    assert.deepEqual(runs.map((run) => run.map((p) => [p.x, p.y])), [[[0, 10], [50, 0], [100, 5]]])
  })

  test('a minute with no reading breaks the line; a lone point between gaps is a dot', () => {
    const runs = placeFrame({ start: 0, end: 4 * GAP_MS, count: 3, points: [
      { key: 1, t: 0, v: 50, lo: 50, hi: 50 },
      { key: 2, t: 2 * GAP_MS, v: 50, lo: 50, hi: 50 },
      { key: 3, t: 4 * GAP_MS, v: 50, lo: 50, hi: 50 }
    ] } as Frame, 100, 10, 0)
    assert.equal(runs.length, 3)
    assert.equal(linePath(runs), 'M0 5 L0 5 M50 5 L50 5 M100 5 L100 5')
  })

  test('a whole minute with no reading breaks the line, however close the readings either side', () => {
    // 00:59 and 02:01: 62 s apart, but minute 01 had no reading.
    const trend = trendOf({ t: [NOW + 59_000, NOW + 121_000, NOW + 150_000], cpu: [40, 50, 55], mem: [] }, 'cpu', NOW + 180_000)
    const runs = placeFrame(frameOf(trend, NOW + 180_000, 30 * MIN), 300, 96, 2)
    assert.equal(runs.length, 2)
  })

  test('a gap stays a gap while the chart glides', () => {
    const at = (end: number) => frameOf(trendOf({ t: [NOW + 59_000, NOW + 121_000, NOW + 150_000], cpu: [40, 50, 55], mem: [] }, 'cpu', end), end, 30 * MIN)
    const half = tweenFrame(at(NOW + 180_000), at(NOW + 185_000), 0.5)
    assert.equal(placeFrame(half, 300, 96, 2).length, 2)
  })

  test('a newest reading that is a whole minute alone is marked as the newest', () => {
    const trend = trendOf({ t: [NOW - 90_000, NOW - 30_000], cpu: [40, 94.96], mem: [] }, 'cpu', NOW)
    assert.equal(trend.live, null)
    assert.equal(trend.points[trend.points.length - 1]?.newest, true)
    assert.equal(frameOf(trend, NOW, 30 * MIN).points.at(-1)?.newest, true)
  })

  test('fewer than two readings in all draws nothing', () => {
    assert.deepEqual(placeFrame(frame([[90, 42]], 1), 100, 28, 2), [])
    assert.deepEqual(placeFrame(frameOf({ points: [], live: null, count: 0 }, 100, 100), 100, 28, 2), [])
    assert.equal(linePath(placeFrame(frame([[50, 40], [100, 42]]), 100, 28, 2)), 'M50 16.4 L100 15.9', 'two readings are a line')
  })

  test('the smooth line never overshoots a reading, nor leaves 0..100', () => {
    const values = [0, 100, 0, 100, 3, 97, 50, 50, 51, 0, 100, 100, 0]
    const runs = placeFrame(frame(values.map((v, i) => [i * 8, v])), 100, 100, 0)
    const d = monotone(runs[0]!)
    const numbers = d.replace(/[MC]/g, ' ').trim().split(/\s+/).map(Number)
    let [x0, y0] = [numbers[0]!, numbers[1]!]
    for (let i = 2; i < numbers.length; i += 6) {
      const [x1, y1, x2, y2, x3, y3] = numbers.slice(i, i + 6) as [number, number, number, number, number, number]
      for (let k = 0; k <= 1; k += 0.05) {
        const y = (1 - k) ** 3 * y0 + 3 * (1 - k) ** 2 * k * y1 + 3 * (1 - k) * k ** 2 * y2 + k ** 3 * y3
        assert.ok(y >= Math.min(y0, y3) - 0.11 && y <= Math.max(y0, y3) + 0.11, `segment to x=${x3} stays between its readings (${y})`)
      }
      ;[x0, y0] = [x3, y3]
    }
    assert.ok(x0 > 0)
  })

  test('the range band never crosses itself or the line', () => {
    const runs = placeFrame({ start: 0, end: 200, count: 3, points: [
      { key: 1, t: 0, v: 50, lo: 0, hi: 100 },
      { key: 2, t: 100, v: 50, lo: 50, hi: 50 },
      { key: 3, t: 200, v: 70, lo: 70, hi: 70 }
    ] } as Frame, 200, 100, 0)
    const d = rangePath(runs, 0, 100)
    // Forward along the highest readings, back along the lowest: sample both at the same x.
    const [forward, back] = d.split(' L')
    const curve = (path: string, reverse: boolean) => {
      const n = path.replace(/[MCLZ]/g, ' ').trim().split(/\s+/).map(Number)
      const segs: number[][] = []
      for (let i = 2; i + 5 < n.length; i += 6) segs.push([n[i - 1]!, n[i + 1]!, n[i + 3]!, n[i + 5]!])
      const ys = segs.map(([a, b, c, e]) => (k: number) => (1 - k) ** 3 * a + 3 * (1 - k) ** 2 * k * b + 3 * (1 - k) * k ** 2 * c + k ** 3 * e)
      return reverse ? ys.reverse().map((f) => (k: number) => f(1 - k)) : ys
    }
    const hi = curve(forward!, false)
    const lo = curve(`M${back}`, true)
    for (let s = 0; s < hi.length; s += 1) for (let k = 0; k <= 1; k += 0.1) assert.ok(hi[s]!(k) <= lo[s]!(k) + 0.11, `highest above lowest (segment ${s}, ${k.toFixed(1)})`)
  })

  test('the range band never rises above the readings either side of it', () => {
    // Minutes of [0], [0, 80], [80], [0]: the highest readings are 0, 80, 80, 0.
    const runs = placeFrame({ start: 0, end: 300, count: 5, points: [
      { key: 1, t: 0, v: 0, lo: 0, hi: 0 },
      { key: 2, t: 100, v: 40, lo: 0, hi: 80 },
      { key: 3, t: 200, v: 80, lo: 80, hi: 80 },
      { key: 4, t: 300, v: 0, lo: 0, hi: 0 }
    ] } as Frame, 300, 100, 0)
    const forward = rangePath(runs, 0, 100).split(' L')[0]!
    const n = forward.replace(/[MC]/g, ' ').trim().split(/\s+/).map(Number)
    const ys = n.filter((_, i) => i % 2 === 1)
    assert.ok(Math.min(...ys) >= 20 - 0.05, `no control point above 80 % (lowest y ${Math.min(...ys)})`)
  })

  test("the range band runs along each minute's highest reading and back along its lowest", () => {
    const runs = placeFrame({ start: 0, end: 100, count: 2, points: [
      { key: 1, t: 0, v: 50, lo: 40, hi: 60 },
      { key: 2, t: 100, v: 50, lo: 40, hi: 60 }
    ] } as Frame, 100, 100, 0)
    assert.equal(rangePath(runs), 'M0 40 L100 40 L100 60 L0 60 Z')
  })

  test('colour stops change level at each threshold, top to bottom', () => {
    const rule = [{ level: 'busy', at: 70 }, { level: 'strained', at: 85 }, { level: 'critical', at: 95 }] as const
    const stops = levelStops(rule as never, 100, 0)
    assert.deepEqual(stops.map((s) => [Math.round(s.offset * 100), s.level]), [
      [0, 'critical'], [5, 'critical'], [5, 'strained'], [15, 'strained'], [15, 'busy'], [30, 'busy'], [30, 'ok'], [100, 'ok']
    ])
    assert.equal(levelStops([{ level: 'busy', at: 90 }] as never, 100, 0).length, 8, 'always eight stops')
    assert.equal(levelOf(85, rule as never), 'strained')
    assert.equal(levelOf(84.9, rule as never), 'busy')
  })

  test('a frame in motion: points move, a new minute grows out of the old line, the window glides', () => {
    const from: Frame = { start: 0, end: 100, count: 3, points: [{ key: 1, t: 0, v: 0, lo: 0, hi: 0 }, { key: 'live', t: 100, v: 100, lo: 100, hi: 100 }] }
    const to: Frame = { start: 20, end: 120, count: 4, points: [
      { key: 1, t: 0, v: 0, lo: 0, hi: 0 },
      { key: 2, t: 50, v: 80, lo: 80, hi: 80 },
      { key: 'live', t: 120, v: 40, lo: 40, hi: 40 }
    ] }
    const half = tweenFrame(from, to, 0.5)
    assert.deepEqual([half.start, half.end], [10, 110])
    assert.deepEqual(half.points.map((p) => [p.key, p.t, p.v]), [[1, 0, 0], [2, 50, 65], ['live', 110, 70]], 'the new point starts at 50 on the old line')
    assert.equal(tweenFrame(from, to, 1), to)
    assert.equal(tweenFrame(from, to, 0), from)
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

describe('memory the panel must not misstate', () => {
  test("Orca's pressure reading of a Mac has no used bytes, and its free-memory figure no figure at all", () => {
    const pressure = only(machine({ memory: { total: 64 * GIB, used: 60 * GIB, available: 4 * GIB, percent: 94, source: 'orca', reliable: true, kind: 'pressure', pressurePercent: 94 } }))
    assert.equal(pressure.mem.usedBytes, null)
    assert.equal(pressure.mem.label, 'Memory pressure')
    const free = only(machine({ memory: { total: 64 * GIB, used: 63 * GIB, available: GIB, percent: 98.4, source: 'orca', reliable: false, kind: 'unavailable' } }))
    assert.deepEqual([free.mem.kind, free.mem.pct, free.mem.usedBytes, free.mem.reliable], ['unavailable', null, null, false])
  })

  test('a machine that stopped answering while elevated is drawn at its last level, with its last reading', () => {
    const lost = { how: 'unanswered' as const, since: NOW - 10_000, lastReadingAt: NOW - 25_000, level: 'critical' as const, summary: 'memory pressure critical, 15.8 of 16 GB used\nswap 9.1 GB' }
    const m = only(machine({ online: false, status: 'offline', lost, health: { level: 'unknown', reasons: ['offline', 'stopped answering; last reading: x'], cpu: null, memory: null } }))
    assert.deepEqual([m.health, m.healthLabel, m.lost?.label, m.lost?.level], ['critical', 'Stopped answering', 'Stopped answering', 'critical'])
    assert.equal(m.lost?.summary, 'memory pressure critical, 15.8 of 16 GB used swap 9.1 GB', 'on one line')
    assert.deepEqual(m.reasons, ['stopped answering; last reading: x'])
    const plain = only(machine({ online: false, status: 'offline', health: { level: 'unknown', reasons: ['offline'], cpu: null, memory: null } }))
    assert.deepEqual([plain.lost, plain.health, plain.reasons], [null, 'unknown', []])
  })
})

