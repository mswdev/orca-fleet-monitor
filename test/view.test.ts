// The panel's drawing (panel/view.mjs over panel/dom.mjs) in a small fake DOM (test/fake-dom.ts),
// which refuses and records any attempt to parse a string as markup. Every value is invented.
import { afterEach, assert, beforeEach, describe, test } from 'orca/testing'
import { externalOpener, type FleetReadyView, type FleetView } from '../panel/fleet-binding.mjs'
import { mountFleetView } from '../panel/view.mjs'
import { DEFAULT_HEALTH } from '../src/health.ts'
import type { MachineView } from '../src/model.ts'
import { installFakeDom, texts, type FakeDocument, type FakeElement } from './fake-dom.ts'

const NOW = 1_800_000_000_000
const GIB = 2 ** 30
const XSS = '<img src=x onerror="globalThis.__xss=1"><script>globalThis.__xss=1</script>'

function machine(over: Partial<MachineView> = {}): MachineView {
  return {
    id: 'env-a',
    name: 'Build Box',
    kind: 'remote',
    tier: 'full',
    status: 'online',
    online: true,
    lastSeenAt: NOW - 2_000,
    latencyMs: 300,
    error: null,
    host: { hostname: 'build-box', platform: 'linux', arch: 'x64', cpuModel: 'Example CPU', cores: 4, uptimeSec: 90_000 },
    cpu: { percent: 40, source: 'beacon', perCore: [40, 41, 39, 40], groups: null },
    memory: { total: 32 * GIB, used: 8 * GIB, available: 24 * GIB, percent: 25, source: 'orca', reliable: true },
    load: { one: 1.5, five: 1.25, fifteen: 1 },
    orca: { cpu: 8, memory: GIB, totalCpu: 20, totalMemory: 2 * GIB },
    workspaces: { byCpu: [], byMemory: [] },
    health: { level: 'ok', reasons: [], cpu: 'ok', memory: 'ok' },
    beacon: { state: 'fresh', ageMs: 1_000, seq: 9, pluginKey: 'local.fleet-monitor', remotePlugin: 'running' },
    updatedAt: NOW,
    history: { t: [], cpu: [], mem: [] },
    ...over
  }
}

const local = (over: Partial<MachineView> = {}): MachineView =>
  machine({ id: 'local', kind: 'local', name: 'This desk', host: { ...machine().host, platform: 'darwin' }, cpu: { percent: 12, source: 'sampler', perCore: [12, 12], groups: null }, ...over })

const basic = (over: Partial<MachineView> = {}): MachineView =>
  machine({
    tier: 'basic',
    cpu: { percent: 97, source: 'load', perCore: null, groups: null },
    load: { one: 3.9, five: null, fifteen: null },
    host: { hostname: null, platform: null, arch: null, cpuModel: null, cores: 4, uptimeSec: null },
    beacon: { state: 'absent', ageMs: null, seq: null, pluginKey: null, remotePlugin: 'absent' },
    ...over
  })

function viewOf(machines: MachineView[], over: Partial<FleetReadyView> = {}): FleetReadyView {
  return {
    ready: true,
    error: null,
    seq: 1,
    generatedAt: NOW,
    mode: 'fast',
    intervalMs: 5_000,
    historyWindowMs: 30 * 60_000,
    cli: { path: '/x/orca', source: 'bundled', error: null },
    thresholds: DEFAULT_HEALTH,
    machines,
    ...over
  }
}

let dom: ReturnType<typeof installFakeDom>

beforeEach(() => {
  dom = installFakeDom()
})

afterEach(() => {
  dom.restore()
})

/** Mounts the view on a binding that always answers `view`; timers run only when told to. */
function mount(view: FleetView, openExternal: ((url: string) => unknown) | null = null) {
  const timers: (() => void)[] = []
  const retries: string[] = []
  const binding = {
    ready: Promise.resolve(),
    current: () => view,
    subscribe: (listener: (v: FleetView) => void) => {
      listener(view)
      return () => {}
    },
    refresh: () => Promise.resolve(),
    retry: (id: string) => {
      retries.push(id)
      return Promise.resolve(true)
    },
    dispose: () => {},
    _heartbeat: () => {}
  }
  const handle = mountFleetView(dom.root as unknown as HTMLElement, {
    binding,
    now: () => NOW,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: ((fn: () => void) => {
      timers.push(fn)
      return 0
    }) as unknown as typeof setTimeout,
    openExternal
  })
  const runTimers = () => {
    for (const fn of timers.splice(0)) fn()
  }
  return { handle, root: dom.root, document: dom.document as FakeDocument, runTimers, retries }
}

const $ = (root: FakeElement, selector: string): FakeElement | null => root.querySelector(selector)
const text = (root: FakeElement): string => texts(root).join('')
const settle = () => new Promise((resolve) => setImmediate(resolve))

describe('remote text is never parsed as markup', () => {
  test('names, errors, workspaces, chips and CLI errors from other machines are drawn as text', () => {
    const hostile = machine({
      id: 'env-x',
      name: XSS,
      host: { ...machine().host, cpuModel: XSS },
      workspaces: { byCpu: [{ id: `w${XSS}`, name: XSS, repo: XSS, cpu: 300, memory: 2 * GIB, sessions: 1 }], byMemory: [] },
      health: { level: 'strained', reasons: [XSS], cpu: 'strained', memory: 'ok' }
    })
    const offline = machine({ id: 'env-y', name: `${XSS} offline`, online: false, status: 'offline', error: XSS })
    const v = mount(viewOf([local(), hostile, offline, basic({ id: 'env-z', name: XSS })], { cli: { path: null, source: null, error: null, runError: XSS } }))
    const screens = [
      () => v.handle.show(null),
      () => v.handle.show('env-x'),
      () => v.handle.show('env-y'),
      () => {
        v.handle.show('env-z')
        $(v.root, '[data-action="install"]')!.click()
      }
    ]
    for (const show of screens) {
      show()
      assert.deepEqual(v.document.markupWrites, [], 'no string was parsed as markup')
      assert.ok(!v.document.created.includes('img') && !v.document.created.includes('script'), 'no element came from the text')
      assert.ok(text(v.root).includes(XSS) || v.root.querySelectorAll('[aria-label]').some((n) => (n.getAttribute('aria-label') ?? '').includes(XSS)))
    }
    v.handle.show('env-x')
    assert.ok(texts(v.root).includes(XSS), 'the name is one text node, verbatim')
    assert.equal((globalThis as { __xss?: number }).__xss, undefined)
  })
})

describe('the overview', () => {
  test('a CLI that cannot be found is shown as the problem, not as "nothing paired"', () => {
    const v = mount(viewOf([local()], { cli: { path: null, source: null, error: 'Could not find the Orca CLI; set its path in Fleet Monitor settings' } }))
    const all = text(v.root)
    assert.match(all, /Fleet Monitor cannot use the Orca CLI/)
    assert.match(all, /Could not find the Orca CLI/)
    assert.ok(!/No other machines paired|Nothing paired/.test(all))
    assert.equal($(v.root, '.fm-summary')?.textContent, 'Cannot use the Orca CLI')
  })

  test('a CLI that runs but fails to list paired machines is shown too', () => {
    const v = mount(viewOf([local()], { cli: { path: '/x/orca', source: 'bundled', error: null, runError: 'spawn EACCES' } }))
    assert.match(text(v.root), /spawn EACCES/)
    assert.ok(!/No other machines paired/.test(text(v.root)))
    const withRemotes = mount(viewOf([local(), machine()], { cli: { path: '/x/orca', source: 'bundled', error: null, runError: 'timed out' } }))
    assert.match($(withRemotes.root, '[data-key="cli-error"]')?.textContent ?? '', /timed out/)
  })

  test('nothing paired, with a working CLI, still says so', () => {
    const v = mount(viewOf([local()]))
    assert.match(text(v.root), /No other machines paired/)
  })

  test('the pairing hint exists while closed, so aria-controls always names an element', () => {
    const v = mount(viewOf([local(), machine()]))
    const button = $(v.root, '[data-action="pair"]')!
    const target = $(v.root, `#${button.getAttribute('aria-controls')}`)
    assert.ok(target, 'target present while collapsed')
    assert.equal(target.hasAttribute('hidden'), true)
    button.click()
    assert.equal(button.getAttribute('aria-expanded'), 'true')
    assert.equal($(v.root, '#fm-pair-hint')?.hasAttribute('hidden'), false)
  })

  test('machines left out of the snapshot are counted', () => {
    const v = mount(viewOf([local()], { omitted: 3 }))
    assert.match(text(v.root), /3 paired machines are not shown/)
  })

  test('health reasons are in the card label and the badge', () => {
    const strained = machine({ memory: { ...machine().memory!, percent: 90 }, health: { level: 'strained', reasons: ['memory 90% ≥ 88%'], cpu: 'ok', memory: 'strained' } })
    const v = mount(viewOf([local(), strained]))
    const card = $(v.root, '[data-action="open"][data-id="env-a"]')!
    assert.match(card.getAttribute('aria-label') ?? '', /Strained \(memory 90% ≥ 88%\)/)
    assert.equal($(card, '.fm-level')?.getAttribute('title'), 'memory 90% ≥ 88%')
  })
})

describe('a machine', () => {
  test('its health reasons are shown under its name', () => {
    const strained = machine({ health: { level: 'strained', reasons: ['CPU 88% ≥ 85%'], cpu: 'strained', memory: 'ok' } })
    const v = mount(viewOf([local(), strained]))
    v.handle.show('env-a')
    assert.equal($(v.root, '.fm-reasons')?.textContent, 'Strained: CPU 88% ≥ 85%')
    v.handle.show('local')
    assert.ok($(v.root, '.fm-reasons') === null, 'none for a machine that is fine')
  })

  test('an estimate is labelled and not coloured by the CPU thresholds', () => {
    const v = mount(viewOf([local(), basic()]))
    const card = $(v.root, '[data-action="open"][data-id="env-a"]')!
    assert.equal($(card, '.fm-metric')?.getAttribute('data-tone'), 'ok', '97% estimated is not critical')
    assert.match(card.getAttribute('aria-label') ?? '', /estimated, not counted in health/)
    v.handle.show('env-a')
    assert.match(text(v.root), /does not count towards health/)
  })

  test('a machine without a load average has no estimate rather than 0%', () => {
    const v = mount(viewOf([local(), basic({ cpu: { percent: null, source: 'load', perCore: null, groups: null }, load: null })]))
    v.handle.show('env-a')
    assert.match(text(v.root), /No estimate: this machine reports no load average/)
    assert.equal($(v.root, '[data-key="cpu"] .fm-big')?.textContent, '–%')
  })

  test('128 cores wrap onto rows of at most 32, so a narrow panel never scrolls sideways', () => {
    const perCore = Array.from({ length: 128 }, (_, i) => (i * 37) % 100)
    const v = mount(viewOf([local(), machine({ host: { ...machine().host, cores: 128 }, cpu: { percent: 50, source: 'beacon', perCore, groups: null } })]))
    v.handle.show('env-a')
    const rows = v.root.querySelectorAll('.fm-core-bars')
    assert.equal(rows.length, 4)
    assert.ok(rows.every((row) => row.querySelectorAll('.fm-core').length <= 32))
    assert.equal(v.root.querySelectorAll('.fm-core').length, 128)
  })

  test('with one reading so far, neither the sparklines nor the detail charts draw a lone dot', () => {
    const history = { t: [NOW - 1_000], cpu: [40], mem: [25] }
    const v = mount(viewOf([local({ history }), machine({ history })]))
    const card = $(v.root, '[data-action="open"][data-id="env-a"]')!
    const sparks = card.querySelectorAll('.fm-spark .fm-line').map((p) => p.getAttribute('d'))
    assert.deepEqual(sparks, ['M0 0', 'M0 0'])
    assert.deepEqual(card.querySelectorAll('.fm-spark .fm-area').map((p) => p.getAttribute('d')), ['M0 0', 'M0 0'])
    v.handle.show('env-a')
    const charts = v.root.querySelectorAll('.fm-plot .fm-line').map((p) => p.getAttribute('d'))
    assert.deepEqual(charts, ['M0 0', 'M0 0'])
    assert.equal($(v.root, '[data-key="cpu"] .fm-big')?.textContent, '40%', 'the reading itself is still shown')
  })

  test('more than 256 cores: one quiet line says per-core load is not drawn', () => {
    const perCore = Array.from({ length: 300 }, () => 40)
    const v = mount(viewOf([local(), machine({ host: { ...machine().host, cores: 300 }, cpu: { percent: 40, source: 'beacon', perCore, groups: null } })]))
    v.handle.show('env-a')
    assert.equal(v.root.querySelectorAll('.fm-core').length, 0)
    assert.equal($(v.root, '[data-key="cores-hidden"]')?.textContent, 'Per-core load is not drawn above 256 cores.')
    assert.match($(v.root, '[data-key="cpu"] .fm-section-head')?.textContent ?? '', /300 cores/)
  })

  test("an offline card's label says when it was last seen on the worker clock, as its text does", () => {
    // The worker's clock runs an hour ahead of this frame's; it last saw the machine 61 minutes ago.
    const ahead = 3_600_000
    const offline = machine({ online: false, status: 'offline', lastSeenAt: NOW + ahead - 61 * 60_000, health: { level: 'unknown', reasons: ['offline'], cpu: null, memory: null } })
    const v = mount(viewOf([local(), offline], { clockOffsetMs: ahead }))
    const card = $(v.root, '[data-action="open"][data-id="env-a"]')!
    assert.equal($(card, '.fm-card-note')?.textContent, 'Last seen 1h 1m ago')
    assert.match(card.getAttribute('aria-label') ?? '', /Last seen 1h 1m ago\./)
  })

  test('history on the worker clock is drawn against the worker clock', () => {
    // The worker's clock runs an hour ahead of this frame's (its wall clock was set back).
    const ahead = 3_600_000
    const t = Array.from({ length: 180 }, (_, i) => NOW + ahead - (179 - i) * 10_000)
    const history = { t, cpu: t.map(() => 30), mem: t.map(() => 40) }
    const v = mount(viewOf([local(), machine({ history, lastSeenAt: NOW + ahead })], { clockOffsetMs: ahead }))
    const line = $(v.root, '[data-id="env-a"] .fm-spark .fm-line')?.getAttribute('d') ?? ''
    assert.ok(line.split('L').length >= 25, `the spark spans the 30 minutes (${line.slice(0, 40)}…)`)
  })
})

describe('the install row', () => {
  const absent = (name: string, id = '00000000-0000-4000-8000-000000000001') => basic({ id, name })

  test('quotes a plain name; uses the id for a name a shell would read as code', () => {
    const v = mount(viewOf([local(), absent('Build Box'), absent('Build Box”; Write-Output injected; #', 'env-b')]))
    v.handle.show('00000000-0000-4000-8000-000000000001')
    $(v.root, '[data-action="install"]')!.click()
    assert.equal($(v.root, '[data-command]')?.textContent, 'orca plugin install mswdev.fleet-monitor --environment "Build Box"')
    v.handle.show('env-b')
    $(v.root, '[data-action="install"]')!.click()
    assert.equal($(v.root, '[data-command]')?.textContent, 'orca plugin install mswdev.fleet-monitor --environment=env-b')
  })

  test('with neither a safe name nor a safe id there is no command, only words', () => {
    const v = mount(viewOf([local(), absent('$(id)', '-bad id')]))
    v.handle.show('-bad id')
    $(v.root, '[data-action="install"]')!.click()
    assert.ok($(v.root, '[data-command]') === null, 'no command')
    assert.ok($(v.root, '[data-action="copy"]') === null, 'no copy button')
    assert.match(text(v.root), /cannot be put in a command safely/)
  })

  test('uses the launcher this computer has (orca-ide on Linux)', () => {
    const v = mount(viewOf([local(), absent('Build Box')], { cli: { path: '/x', source: 'bundled', error: null, launcher: 'orca-ide' } }))
    v.handle.show('00000000-0000-4000-8000-000000000001')
    $(v.root, '[data-action="install"]')!.click()
    assert.match($(v.root, '[data-command]')?.textContent ?? '', /^orca-ide plugin install /)
  })

  test('the body exists while collapsed, and "Copied" is announced', () => {
    const v = mount(viewOf([local(), absent('Build Box')]))
    v.handle.show('00000000-0000-4000-8000-000000000001')
    const toggle = $(v.root, '[data-action="install"]')!
    const body = $(v.root, `#${toggle.getAttribute('aria-controls')}`)
    assert.ok(body, 'aria-controls names an element while collapsed')
    assert.equal(body.hasAttribute('hidden'), true)
    toggle.click()
    const status = $(v.root, '[role="status"][aria-live="polite"]')
    assert.ok(status, 'the live region is there before anything is copied')
    assert.equal(status.textContent, '')
    $(v.root, '[data-action="copy"]')!.click()
    assert.equal(v.document.copied[0], 'orca plugin install mswdev.fleet-monitor --environment "Build Box"')
    assert.equal($(v.root, '[role="status"][aria-live="polite"]')?.textContent, 'Command copied')
  })
})

test('Retry keeps keyboard focus while it works and after', async () => {
  const v = mount(viewOf([local(), machine({ online: false, status: 'offline', error: 'timed out' })]))
  v.handle.show('env-a')
  const button = $(v.root, '[data-action="retry"]')!
  button.focus()
  assert.ok(v.document.activeElement === button, 'focused')
  button.click()
  assert.deepEqual(v.retries, ['env-a'])
  assert.equal(button.textContent, 'Retrying…')
  assert.equal(button.getAttribute('aria-disabled'), 'true')
  assert.ok(v.document.activeElement === button, 'focus stays while retrying')
  button.click()
  assert.deepEqual(v.retries, ['env-a'], 'a second press while retrying does nothing')
  await settle()
  v.runTimers()
  assert.equal(button.textContent, 'Retry connection')
  assert.ok(v.document.activeElement === button, 'and after')
})

test('morphing keeps a focused card focused across redraws', () => {
  const v = mount(viewOf([local(), machine()]))
  const card = $(v.root, '[data-action="open"][data-id="env-a"]')!
  card.focus()
  v.handle.show(null)
  v.handle.show(null)
  assert.ok(v.document.activeElement === card, 'still focused')
})

describe('memory (1.1)', () => {
  const reading = {
    total: 16 * GIB,
    used: 15.1 * GIB,
    app: 9.6 * GIB,
    wired: 2.5 * GIB,
    compressed: 3 * GIB,
    cached: 1.2 * GIB,
    swapUsed: 6.2 * GIB,
    swapTotal: 7 * GIB,
    pressure: 'warning' as const,
    availablePercent: 12,
    pageSize: 16_384,
    swapInsPerSec: 2,
    swapOutsPerSec: 120,
    sustainedSwapOutsPerSec: 100
  }
  const history = { t: [NOW - 120_000, NOW - 60_000, NOW - 1_000], cpu: [20, 21, 22], mem: [80, 85, 88], ram: [90, 92, 94.4] }
  /** A remote Mac with Fleet Monitor 1.1: RAM in use from its own reading. */
  const mini = (over: Partial<MachineView> = {}): MachineView =>
    machine({
      id: 'env-mini',
      name: 'Mac mini',
      host: { ...machine().host, platform: 'darwin' },
      memory: { total: 16 * GIB, used: 15.1 * GIB, available: 0.9 * GIB, percent: 94.4, source: 'beacon', reliable: true, kind: 'used', pressurePercent: 88, mac: reading },
      health: { level: 'strained', reasons: ['macOS memory pressure warning, 12% available'], cpu: 'ok', memory: 'strained' },
      history,
      ...over
    })
  /** A Mac without Fleet Monitor: Orca's memory pressure reading. */
  const pressureMac = (over: Partial<MachineView> = {}): MachineView =>
    basic({
      id: 'env-b',
      name: 'Studio Two',
      memory: { total: 32 * GIB, used: 28.8 * GIB, available: 3.2 * GIB, percent: 90, source: 'orca', reliable: true, kind: 'pressure', pressurePercent: 90 },
      health: { level: 'strained', reasons: ['memory pressure 90% ≥ 88%'], cpu: null, memory: 'strained' },
      history: { t: [NOW - 60_000, NOW - 1_000], cpu: [50, 60], mem: [89, 90] },
      ...over
    })

  test('a card with RAM in use: used %, used / total GB, and a quiet pressure marker', () => {
    const v = mount(viewOf([local(), mini()]))
    const card = $(v.root, '[data-action="open"][data-id="env-mini"]')!
    const memory = card.querySelectorAll('.fm-metric')[1]!
    assert.equal(text($(memory, '.fm-metric-label')!), 'Memorypressure warning')
    assert.equal($(memory, '.fm-pressure')?.getAttribute('data-health'), 'strained')
    assert.equal(text($(memory, '.fm-big')!), '94%')
    assert.equal(text($(memory, '.fm-sub')!), '15.1/16 GB')
    assert.equal(memory.getAttribute('data-tone'), 'strained')
    assert.match(card.getAttribute('aria-label') ?? '', /RAM 94% used \(15\.1 of 16 GB\), memory pressure warning/)
    const fine = mount(viewOf([local(), mini({ memory: { ...mini().memory!, mac: { ...reading, pressure: 'normal' } } })]))
    assert.equal($(fine.root, '.fm-pressure'), null, 'no marker while pressure is normal')
  })

  test("a card with only Orca's reading of a Mac: memory pressure, and nothing called used", () => {
    const v = mount(viewOf([local(), pressureMac()]))
    const card = $(v.root, '[data-action="open"][data-id="env-b"]')!
    const memory = card.querySelectorAll('.fm-metric')[1]!
    assert.equal(text($(memory, '.fm-metric-label')!), 'Memory pressure')
    assert.equal(text($(memory, '.fm-big')!), '90%')
    assert.equal(text($(memory, '.fm-sub')!), '32 GB', 'how much RAM there is, not a "used" figure')
    assert.ok(!/used|28\.8/i.test(text(card) + (card.getAttribute('aria-label') ?? '')))
    assert.match(card.getAttribute('aria-label') ?? '', /memory pressure 90%/)
  })

  test('the detail of a Mac with RAM in use: used % with average and peak, its chart, and the rows', () => {
    const v = mount(viewOf([local(), mini()]))
    v.handle.show('env-mini')
    const section = $(v.root, '[data-key="memory"]')!
    assert.equal(text($(section, 'h2')!), 'Memory')
    assert.equal(text($(section, '.fm-section-head .fm-sub')!), '15.1 / 16 GB')
    assert.equal(text($(section, '.fm-reading')!), '94%usedavg 92% · peak 94%')
    assert.equal(
      $(section, '.fm-plot svg')?.getAttribute('aria-label'),
      'RAM used over the last 30 minutes: now 94%, average 92%, peak 94%',
      'drawn from RAM in use, not from pressure'
    )
    const rows = $(section, '[data-key="mem-facts"]')!.querySelectorAll('.fm-fact').map((row) => [text($(row, 'dt')!), text($(row, 'dd')!)])
    assert.deepEqual(rows, [
      ['App memory', '9.6 GB'],
      ['Wired', '2.5 GB'],
      ['Compressed', '3 GB'],
      ['Cached files', '1.2 GB'],
      ['Swap used', '6.2 GBof 7 GB · 2 in · 120 out pages/s'],
      ['Memory pressure', 'Warning · 12% available']
    ])
    assert.equal($(section, '.fm-pressure-value')?.getAttribute('data-health'), 'strained')
    assert.equal(text($(v.root, '.fm-reasons')!), 'Strained: macOS memory pressure warning, 12% available')
  })

  test('the detail of a basic Mac: memory pressure, and what installing Fleet Monitor there adds', () => {
    const v = mount(viewOf([local(), pressureMac()]))
    v.handle.show('env-b')
    const section = $(v.root, '[data-key="memory"]')!
    assert.equal(text($(section, 'h2')!), 'Memory pressure')
    // The install row says what installing adds; the note beside the figure does not repeat it.
    assert.equal(text($(section, '[data-key="pressure-note"]')!), 'Memory pressure as Orca reads it, not RAM in use.')
    assert.equal(text($(v.root, '.fm-install-text')!), 'Install Fleet Monitor on this machine for real RAM usage, swap and pressure')
    assert.equal($(section, '[data-key="mem-facts"]'), null)
    assert.ok(!/\bused\b/i.test(text(section).replace('not RAM in use', '')))
    // Not known yet whether Fleet Monitor is there (no install row): the note says it instead.
    const unknown = mount(viewOf([local(), pressureMac({ beacon: { state: 'absent', ageMs: null, seq: null, pluginKey: null, remotePlugin: 'unknown' } })]))
    unknown.handle.show('env-b')
    assert.equal($(unknown.root, '[data-action="install"]'), null)
    assert.equal(
      text($(unknown.root, '[data-key="pressure-note"]')!),
      'Memory pressure as Orca reads it, not RAM in use. Installing Fleet Monitor on that machine adds real RAM usage, swap and pressure.'
    )
    const installed = mount(viewOf([local(), pressureMac({ beacon: { state: 'absent', ageMs: null, seq: null, pluginKey: null, remotePlugin: 'installed' } })]))
    installed.handle.show('env-b')
    assert.match(text($(installed.root, '[data-key="pressure-note"]')!), /Turning Fleet Monitor on there adds real RAM usage, swap and pressure\.$/)
  })

  test('a Mac still on 1.0.0 is full tier with only the pressure reading: updating there adds RAM in use', () => {
    const old = machine({
      id: 'env-old',
      host: { ...machine().host, platform: 'darwin' },
      memory: { total: 16 * GIB, used: 9 * GIB, available: 7 * GIB, percent: 56, source: 'orca', reliable: true, kind: 'pressure', pressurePercent: 56 }
    })
    const v = mount(viewOf([local(), old]))
    v.handle.show('env-old')
    assert.match(text($(v.root, '[data-key="pressure-note"]')!), /Updating Fleet Monitor there to 1\.1 or later adds real RAM usage, swap and pressure\.$/)
  })

  test('Linux and other machines keep their memory figure and its wording', () => {
    const v = mount(viewOf([local(), machine(), basic({ id: 'env-l', name: 'Linux Box' })]))
    const card = $(v.root, '[data-action="open"][data-id="env-a"]')!
    const memory = card.querySelectorAll('.fm-metric')[1]!
    assert.deepEqual([text($(memory, '.fm-metric-label')!), text($(memory, '.fm-big')!), text($(memory, '.fm-sub')!)], ['Memory', '25%', '8/32 GB'])
    v.handle.show('env-l')
    assert.equal(text($(v.root, '.fm-install-text')!), 'Install Fleet Monitor on this machine for full detail')
    assert.equal($(v.root, '[data-key="pressure-note"]'), null)
  })

  test('an offline Mac: its last known RAM in use comes from its own history column', () => {
    const v = mount(viewOf([local(), mini({ online: false, status: 'offline', health: { level: 'unknown', reasons: ['offline'], cpu: null, memory: null } })]))
    v.handle.show('env-mini')
    const facts = $(v.root, '[data-key="facts:Last known"]')!.querySelectorAll('.fm-fact').map((row) => [text($(row, 'dt')!), text($(row, 'dd')!)])
    assert.deepEqual(facts.find((f) => f[0] === 'Memory'), ['Memory', '94% · 15.1 / 16 GB'])
  })
})

describe('a machine that stopped answering while its memory was short', () => {
  const lost = { how: 'unanswered' as const, since: NOW - 10_000, lastReadingAt: NOW - 25_000, level: 'critical' as const, summary: 'memory pressure critical, 15.8 of 16 GB used, swap 9.1 GB' }

  test('its card says so, at the level of its last reading, with that reading', () => {
    const off = machine({ online: false, status: 'offline', lost, health: { level: 'unknown', reasons: ['offline', 'stopped answering; last reading: memory pressure critical, 15.8 of 16 GB used, swap 9.1 GB'], cpu: null, memory: null } })
    const v = mount(viewOf([local(), off]))
    const card = $(v.root, '[data-action="open"][data-id="env-a"]')!
    assert.equal(card.getAttribute('data-health'), 'critical')
    assert.match(text(card), /Stopped answering/)
    assert.equal($(card, '.fm-lost-note')?.textContent, 'Last reading 25s ago: memory pressure critical, 15.8 of 16 GB used, swap 9.1 GB')
    assert.match(card.getAttribute('aria-label') ?? '', /Stopped answering while its memory was elevated\. Last reading 25s ago: memory pressure critical/)
  })

  test('its detail opens on what stopped, and an online one whose readings stopped says so above its figures', async () => {
    const stale = machine({ lost: { ...lost, how: 'stale', level: 'strained' }, health: { level: 'strained', reasons: ['readings stopped; last reading: memory pressure warning'], cpu: 'ok', memory: 'ok' } })
    const v = mount(viewOf([local(), stale]))
    const card = $(v.root, '[data-action="open"][data-id="env-a"]')!
    assert.match($(card, '.fm-lost-line')?.textContent ?? '', /^Readings stopped · Last reading 25s ago: memory pressure critical/)
    card.click()
    await settle()
    const section = $(v.root, '.fm-lost')!
    assert.ok(section, 'a notice at the top of the detail')
    assert.match(text(section), /Build Box’s readings stopped/)
  })

  test('memory Orca cannot give for a Mac is said to be unavailable', async () => {
    const m = machine({ memory: { total: 64 * GIB, used: 63 * GIB, available: GIB, percent: 98, source: 'orca', reliable: false, kind: 'unavailable' }, health: { level: 'ok', reasons: [], cpu: 'ok', memory: null } })
    const v = mount(viewOf([local(), m]))
    $(v.root, '[data-action="open"][data-id="env-a"]')!.click()
    await settle()
    assert.match(text($(v.root, '[data-key="unavailable-note"]')!), /^Memory unavailable/)
    assert.ok(!/98/.test(text($(v.root, '[data-key="memory"]')!)), 'no figure shown')
  })
})

describe('the "Star on GitHub" link', () => {
  /** A frame API as Orca gives it, offering `shell.openExternal` or not. */
  const frame = (offered: boolean) => {
    const opened: string[] = []
    const orca = {
      host: { has: (name: string) => offered && name === 'shell.openExternal', call: async () => null },
      shell: { openExternal: async (url: string) => {
        opened.push(url)
        return { opened: true }
      } }
    }
    return { orca, opened }
  }

  test('is drawn only where the frame offers shell.openExternal, and opens exactly the repository', () => {
    const offered = frame(true)
    const v = mount(viewOf([local()]), externalOpener(offered.orca))
    const link = $(v.root, '[data-action="star"]')!
    assert.ok(link, 'drawn')
    assert.equal(link.textContent, 'Star on GitHub')
    assert.equal(link.getAttribute('href'), null, 'a button, so the frame itself never navigates')
    link.click()
    assert.deepEqual(offered.opened, ['https://github.com/mswdev/orca-fleet-monitor'])
    dom.restore()
    dom = installFakeDom()
    const missing = frame(false)
    assert.equal(externalOpener(missing.orca), null)
    const w = mount(viewOf([local()]), externalOpener(missing.orca))
    assert.equal($(w.root, '[data-action="star"]'), null, 'not drawn without it')
    assert.equal(externalOpener({}), null, 'an Orca without host.has')
    assert.equal(externalOpener({ host: { has: () => true } }), null, 'or without shell.openExternal')
  })

  test('sits at the foot of the overview, not on a machine’s detail', async () => {
    const v = mount(viewOf([local(), machine()]), externalOpener(frame(true).orca))
    const nodes = v.root.childNodes as FakeElement[]
    assert.equal(nodes[nodes.length - 1]?.getAttribute('data-key'), 'foot', 'last on the overview')
    $(v.root, '[data-action="open"][data-id="env-a"]')!.click()
    await settle()
    assert.equal($(v.root, '[data-action="star"]'), null)
  })
})

