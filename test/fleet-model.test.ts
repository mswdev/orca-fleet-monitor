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
    assert.deepEqual(m.install, { reason: 'absent', command: `orca plugin install ${INSTALL_SOURCE} --environment "Build Box"`, launcher: 'orca' })
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

  test('a single reading in all (a worker just started) draws no lone dot', () => {
    const one = [...new Array(29).fill(null), 42]
    assert.deepEqual(seriesPaths(one, 100, 28, 2), { line: '', area: '', points: 1 })
    assert.deepEqual(seriesPaths([42], 300, 72), { line: '', area: '', points: 1 })
    assert.equal(seriesPaths([...new Array(28).fill(null), 40, 42], 100, 28, 2).line, 'M96.6 16.4 L100 15.9', 'two readings are a line')
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

