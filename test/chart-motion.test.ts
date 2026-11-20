// The charts (panel/chart-view.mjs) and the panel's motion (panel/motion.mjs, view.mjs's screen
// changes) in the fake DOM, with a frame scheduler and a clock the test drives. Every value is
// invented.
import { afterEach, assert, beforeEach, describe, test } from 'orca/testing'
import { chartSlot, createCharts, MOVE_MS, RISE_MS } from '../panel/chart-view.mjs'
import { frameOf } from '../panel/charts.mjs'
import type { FleetReadyView, FleetView } from '../panel/fleet-binding.mjs'
import { COUNT_MS } from '../panel/motion.mjs'
import { tilesSection } from '../panel/activity.mjs'
import { mountFleetView } from '../panel/view.mjs'
import { DEFAULT_HEALTH } from '../src/health.ts'
import type { MachineView } from '../src/model.ts'
import { installFakeDom, type FakeElement, type FakeEvent } from './fake-dom.ts'

const NOW = 1_800_000_000_000
const GIB = 2 ** 30

/** Readings every 10 s for 30 minutes up to `end`, CPU climbing from 30 to 90. */
function history(end: number, last = 90) {
  const t = Array.from({ length: 180 }, (_, i) => end - (179 - i) * 10_000)
  const cpu = t.map((_, i) => (i === 179 ? last : 30 + (i / 179) * 60 + (i % 6) * 0.5))
  return { t, cpu, mem: t.map(() => 40) }
}

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
    cpu: { percent: 90, source: 'beacon', perCore: [90, 88, 91, 89], groups: null },
    memory: { total: 32 * GIB, used: 8 * GIB, available: 24 * GIB, percent: 40, source: 'orca', reliable: true },
    load: { one: 1.5, five: 1.25, fifteen: 1 },
    orca: { cpu: 8, memory: GIB, totalCpu: 20, totalMemory: 2 * GIB },
    workspaces: { byCpu: [], byMemory: [] },
    health: { level: 'strained', reasons: [], cpu: 'strained', memory: 'ok' },
    beacon: { state: 'fresh', ageMs: 1_000, seq: 9, pluginKey: 'local.fleet-monitor', remotePlugin: 'running' },
    updatedAt: NOW,
    history: history(NOW),
    ...over
  }
}

const local = (): MachineView =>
  machine({ id: 'local', kind: 'local', name: 'This desk', host: { ...machine().host, platform: 'darwin' }, health: { level: 'ok', reasons: [], cpu: 'ok', memory: 'ok' } })

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

/**
 * Mounts the view with motion: `frames` holds the callbacks waiting for a frame, `step(ms)` moves
 * the motion clock on and runs them; `push(view)` delivers a new view, as the worker's posts do.
 * `now` is the frame's clock, which history is drawn against.
 */
function mount(first: FleetView, { reduced = false } = {}) {
  const frames: (() => void)[] = []
  let clock = 0
  let now = NOW
  let current = first
  let listener: ((v: FleetView) => void) | null = null
  const binding = {
    ready: Promise.resolve(),
    current: () => current,
    subscribe: (fn: (v: FleetView) => void) => {
      listener = fn
      fn(current)
      return () => {}
    },
    refresh: () => Promise.resolve(),
    retry: () => Promise.resolve(true),
    dispose: () => {}
  }
  const handle = mountFleetView(dom.root as unknown as HTMLElement, {
    binding,
    now: () => now,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: (() => 0) as unknown as typeof setTimeout,
    frame: (fn) => frames.push(fn),
    clock: () => clock,
    reducedMotion: () => reduced
  })
  return {
    handle,
    root: dom.root,
    frames,
    push(view: FleetView, at: number) {
      now = at
      current = view
      listener?.(view)
    },
    step(ms: number) {
      clock += ms
      for (const fn of frames.splice(0)) fn()
    },
    settle() {
      for (let i = 0; i < 100 && frames.length > 0; i += 1) this.step(50)
    }
  }
}

const $ = (root: FakeElement, selector: string): FakeElement | null => root.querySelector(selector)
const d = (root: FakeElement, selector: string): string => $(root, selector)?.getAttribute('d') ?? ''
const key = (target: FakeElement, name: string): void => {
  const event: FakeEvent = { type: 'keydown', target, key: name, preventDefault: () => {} }
  target.dispatchEvent(event)
}

describe('a chart glides to each new reading', () => {
  test('a new reading moves the line over a few frames, then it rests where a still chart would be', () => {
    const v = mount(viewOf([local(), machine()]))
    v.handle.show('env-a')
    v.settle()
    const before = d(v.root, '[data-key="chart:cpu"] .fm-line')
    const later = NOW + 5_000
    v.push(viewOf([local(), machine({ history: history(later, 60) })], { seq: 2, generatedAt: later }), later)
    assert.ok(v.frames.length > 0, 'a frame is asked for')
    assert.equal(d(v.root, '[data-key="chart:cpu"] .fm-line'), before, 'nothing jumps before the first frame')
    v.step(MOVE_MS / 3)
    const between = d(v.root, '[data-key="chart:cpu"] .fm-line')
    assert.notEqual(between, before, 'it is on its way')
    v.settle()
    const moved = d(v.root, '[data-key="chart:cpu"] .fm-line')
    assert.notEqual(moved, between)
    assert.equal(v.frames.length, 0, 'at rest, no frame is asked for')

    // The same reading drawn without motion lands on exactly the same line.
    dom.restore()
    dom = installFakeDom()
    const still = mount(viewOf([local(), machine({ history: history(later, 60) })]), { reduced: true })
    still.push(viewOf([local(), machine({ history: history(later, 60) })]), later)
    still.handle.show('env-a')
    assert.equal(d(still.root, '[data-key="chart:cpu"] .fm-line'), moved)
  })

  test('a detail chart rises from its baseline when it opens; a sparkline is drawn at once', () => {
    const v = mount(viewOf([local(), machine()]))
    const spark = d(v.root, '[data-id="env-a"] .fm-spark .fm-line')
    assert.ok(spark.length > 20, 'the card sparkline is drawn at once')
    v.handle.show('env-a')
    const flat = d(v.root, '[data-key="chart:cpu"] .fm-line')
    const ys = (path: string) => (path.match(/-?\d+(\.\d+)?/g) ?? []).map(Number).filter((_, i) => i % 2 === 1)
    assert.ok(ys(flat).every((y) => y === 94), `it starts on the baseline (${flat.slice(0, 30)})`)
    v.step(RISE_MS)
    v.settle()
    assert.ok(Math.min(...ys(d(v.root, '[data-key="chart:cpu"] .fm-line'))) < 20, 'and rises to the readings')
  })

  test('a long step (the panel was away) is drawn at once, not swept', () => {
    const v = mount(viewOf([local(), machine()]))
    v.handle.show('env-a')
    v.settle()
    const later = NOW + 10 * 60_000
    v.push(viewOf([local(), machine({ history: history(later, 50) })], { seq: 2, generatedAt: later }), later)
    assert.equal(v.frames.length, 0)
  })

  test('under reduced motion nothing moves: no frame is ever asked for', () => {
    const v = mount(viewOf([local(), machine()]), { reduced: true })
    v.handle.show('env-a')
    const later = NOW + 5_000
    v.push(viewOf([local(), machine({ history: history(later, 60), cpu: { percent: 60, source: 'beacon', perCore: [60], groups: null } })], { seq: 2 }), later)
    assert.equal(v.frames.length, 0)
    assert.equal($(v.root, '[data-key="cpu"] .fm-num')?.textContent, '60')
  })
})

describe('reading one minute', () => {
  test('the arrow keys step through the minutes, and the reading survives redraws', () => {
    const v = mount(viewOf([local(), machine()]), { reduced: true })
    v.handle.show('env-a')
    const hit = $(v.root, '[data-key="chart:cpu"] .fm-hit')!
    assert.equal(hit.getAttribute('role'), 'slider')
    assert.equal(hit.getAttribute('aria-label'), 'CPU, minute by minute')
    hit.dispatchEvent({ type: 'focus', target: hit })
    assert.match(hit.getAttribute('aria-valuetext') ?? '', /^Now: 90%, strained$/, 'focus starts on the newest reading')
    key(hit, 'ArrowLeft')
    key(hit, 'ArrowLeft')
    assert.match(hit.getAttribute('aria-valuetext') ?? '', /^2 min ago: \d+%, (busy|strained), \d+–\d+% that minute$/)
    assert.equal($(v.root, '[data-key="chart:cpu"] .fm-tip')?.hasAttribute('hidden'), false, 'the note is shown')
    const read = hit.getAttribute('aria-valuetext')
    // A redraw a few seconds on, with no new reading: the same minute, its same figures.
    v.push(viewOf([local(), machine()], { seq: 2 }), NOW + 5_000)
    assert.equal($(v.root, '[data-key="chart:cpu"] .fm-hit'), hit, 'the same slider, not a new one')
    assert.equal(hit.getAttribute('aria-valuetext'), read, 'still on that minute')
    key(hit, 'Home')
    assert.match(hit.getAttribute('aria-valuetext') ?? '', /^30 min ago/)
    hit.dispatchEvent({ type: 'blur', target: hit })
    assert.equal(hit.getAttribute('aria-valuetext'), 'Now: 90%, strained', 'unfocused, the slider still has a value: the newest reading')
    assert.equal($(v.root, '[data-key="chart:cpu"] .fm-tip')?.hasAttribute('hidden'), true)
  })
})

describe('what the review found', () => {
  test('a count in flight never writes over a reading that became unknown', () => {
    const v = mount(viewOf([local(), machine()]))
    const figure = () => $(v.root, '[data-id="env-a"] .fm-num')!
    v.push(viewOf([local(), machine({ cpu: { percent: 50, source: 'beacon', perCore: [50], groups: null } })], { seq: 2 }), NOW + 5_000)
    v.step(COUNT_MS / 4)
    v.push(viewOf([local(), machine({ cpu: { percent: null, source: 'beacon', perCore: null, groups: null } })], { seq: 3 }), NOW + 6_000)
    v.settle()
    assert.equal(figure().textContent, '–')
  })

  test('turning reduced motion on mid-move ends every move at once', () => {
    let reduced = false
    const frames: (() => void)[] = []
    const handle = mountFleetView(dom.root as unknown as HTMLElement, {
      binding: { current: () => viewOf([local(), machine()]), subscribe: () => () => {}, refresh: () => Promise.resolve(), retry: () => Promise.resolve(true) },
      now: () => NOW,
      setInterval: () => 0,
      clearInterval: () => {},
      setTimeout: (() => 0) as unknown as typeof setTimeout,
      frame: (fn) => frames.push(fn),
      clock: () => 0,
      reducedMotion: () => reduced
    })
    handle.show('env-a')
    assert.ok(frames.length > 0, 'the detail chart is rising')
    reduced = true
    for (const fn of frames.splice(0)) fn()
    assert.equal(frames.length, 0, 'no further frame')
    const ys = (d(dom.root, '[data-key="chart:cpu"] .fm-line').match(/-?\d+(\.\d+)?/g) ?? []).map(Number).filter((_, i) => i % 2 === 1)
    assert.ok(Math.min(...ys) < 20, 'and the chart stands at its readings')
  })

  test('empty sparklines do not move', () => {
    const none = { t: [], cpu: [], mem: [] }
    const fleet = () => viewOf([{ ...local(), history: none }, machine({ history: none })])
    const v = mount(fleet())
    v.settle()
    v.push(fleet(), NOW + 5_000)
    assert.equal(v.frames.length, 0, 'no frame is asked for to redraw nothing')
  })

  test('a machine measured for the first time redraws at once: its old estimates never glide through the new colours', () => {
    const t = [NOW - 120_000, NOW - 60_000, NOW - 1_000]
    const estimated = machine({ tier: 'basic', cpu: { percent: 98, source: 'load', perCore: null, groups: null }, history: { t, cpu: [98, 98, 98], mem: [40, 40, 40], ce: [1, 1, 1] } })
    const v = mount(viewOf([local(), estimated]))
    v.settle()
    const measured = machine({ cpu: { percent: 10, source: 'beacon', perCore: [10], groups: null }, history: { t: [...t, NOW + 4_000], cpu: [98, 98, 98, 10], mem: [40, 40, 40, 40], ce: [1, 1, 1, null] } })
    v.push(viewOf([local(), measured], { seq: 2 }), NOW + 5_000)
    for (const fn of v.frames.splice(0)) fn()
    assert.equal(d(v.root, '[data-id="env-a"] .fm-spark .fm-line'), 'M0 0', 'one measured reading: nothing drawn, at once')
  })

  test('the newest reading alone in its minute, just under a threshold, is judged unrounded, peak ring too', () => {
    const v = mount(viewOf([local(), machine({ history: { t: [NOW - 90_000, NOW - 30_000], cpu: [40, 95], mem: [40, 40] }, cpu: { percent: 94.96, source: 'beacon', perCore: [95], groups: null } })]), { reduced: true })
    v.handle.show('env-a')
    const hit = $(v.root, '[data-key="chart:cpu"] .fm-hit')!
    hit.dispatchEvent({ type: 'focus', target: hit })
    assert.equal(hit.getAttribute('aria-valuetext'), 'Now: 95%, strained')
    assert.equal($(v.root, '[data-key="chart:cpu"] .fm-peak')!.style.getPropertyValue('border-color'), 'var(--fm-health-strained)')
  })

  test('a network tile with only upload history names its upload peak, and moves', () => {
    const up = { points: [{ key: 1, t: NOW - 90_000, v: 2e6, lo: 2e6, hi: 2e6 }], live: { t: NOW - 1_000, v: 1e6 }, count: 4 }
    const tiles = tilesSection({ network: { down: null, up: 1e6, downTrend: null, upTrend: up, downPeak: null, upPeak: 2e6, now: NOW }, disk: null, gpu: null, battery: null })!
    dom.root.append(tiles as unknown as FakeElement)
    assert.equal($(dom.root, 'svg.fm-spark') ?? null, null, 'drawn by the chart layer, not yet synced')
    const frames: (() => void)[] = []
    const charts = createCharts({ frame: (fn) => frames.push(fn), clock: () => 0, motion: () => true })
    charts.sync(dom.root as unknown as ParentNode)
    assert.equal($(dom.root, 'svg.fm-spark')?.getAttribute('aria-label'), 'Network over the last 30 minutes: upload peaked at 2.0 MB/s')
    assert.notEqual(d(dom.root, '.fm-line--second'), 'M0 0', 'the upload line is drawn')
  })

  test('changing only the slider or the range band redraws the chart', () => {
    const charts = createCharts()
    const trend = { points: [{ key: 1, t: NOW - 90_000, v: 40, lo: 30, hi: 50 }, { key: 2, t: NOW - 30_000, v: 45, lo: 35, hi: 55 }], live: null, count: 6 }
    const spec = { kind: 'detail' as const, frame: frameOf(trend, NOW, 30 * 60_000), rule: null, label: 'CPU', range: true, scrub: 'CPU, minute by minute' }
    const slot = chartSlot(spec, { 'data-key': 'chart:x' }) as unknown as FakeElement
    dom.root.append(slot)
    charts.sync(dom.root as unknown as ParentNode)
    assert.notEqual(d(dom.root, '.fm-range'), 'M0 0')
    ;(slot as unknown as Record<symbol, unknown>)[Object.getOwnPropertySymbols(slot).find((sym) => sym.description === 'fm-island')!] = { ...spec, range: false, scrub: null }
    charts.sync(dom.root as unknown as ParentNode)
    assert.equal(d(dom.root, '.fm-range'), 'M0 0')
    assert.equal($(dom.root, '.fm-hit')?.hasAttribute('hidden'), true)
    assert.equal($(dom.root, '.fm-hit')?.getAttribute('aria-label'), null)
  })

  test('a history rewrite that keeps the count and the newest reading still redraws the chart', () => {
    const v = mount(viewOf([local(), machine()]), { reduced: true })
    v.handle.show('env-a')
    const h = history(NOW)
    const rewritten = { ...h, cpu: h.cpu.map((x, i) => (i === 10 ? 100 : x)) }
    v.push(viewOf([local(), machine({ history: rewritten })], { seq: 2 }), NOW + 200)
    assert.equal($(v.root, '[data-key="chart:cpu"] .fm-peak')?.textContent, 'peak 100')
  })

  test('the slider says how old a stale newest reading is, and keeps to the window', () => {
    const stale = history(NOW - 301_000)
    const v = mount(viewOf([local(), machine({ history: stale })]), { reduced: true })
    v.handle.show('env-a')
    const hit = $(v.root, '[data-key="chart:cpu"] .fm-hit')!
    hit.dispatchEvent({ type: 'focus', target: hit })
    assert.match(hit.getAttribute('aria-valuetext') ?? '', /^5 min ago: /)
    key(hit, 'Home')
    assert.ok(!/^3[1-9] min ago/.test(hit.getAttribute('aria-valuetext') ?? ''), 'never a point kept only to enter from the edge')
    assert.ok(Number.parseFloat($(v.root, '[data-key="chart:cpu"] .fm-xhair')!.style.getPropertyValue('left')) >= 0)
  })

  test('with nothing to read, there is no slider to reach', () => {
    const v = mount(viewOf([local(), machine({ history: { t: [NOW - 1_000], cpu: [40], mem: [25] } })]), { reduced: true })
    v.handle.show('env-a')
    assert.equal($(v.root, '[data-key="chart:cpu"] .fm-hit')?.hasAttribute('hidden'), true)
  })

  test('a reading just under a threshold is not promoted by history\'s rounding', () => {
    // 94.96 % is strained (critical is 95); history carries it as 95.0.
    const h = history(NOW, 95)
    const v = mount(viewOf([local(), machine({ history: h, cpu: { percent: 94.96, source: 'beacon', perCore: [95], groups: null } })]), { reduced: true })
    v.handle.show('env-a')
    const hit = $(v.root, '[data-key="chart:cpu"] .fm-hit')!
    hit.dispatchEvent({ type: 'focus', target: hit })
    assert.equal(hit.getAttribute('aria-valuetext'), 'Now: 95%, strained')
  })

  test('a screen change cut short does not clear the next one\'s direction', async () => {
    const v = mount(viewOf([local(), machine({ cpu: { percent: 90, source: 'beacon', perCore: [90], groups: null }, processes: { state: 'full', reason: null, takenAt: NOW } as never })]))
    const doc = dom.document as unknown as { startViewTransition?: (update: () => void) => unknown; documentElement: FakeElement }
    const finishes: (() => void)[] = []
    doc.startViewTransition = (update) => {
      const done = Promise.resolve().then(update)
      return { updateCallbackDone: done, ready: Promise.resolve(), finished: new Promise<void>((resolve) => finishes.push(resolve)) }
    }
    $(v.root, '[data-action="open"][data-id="env-a"]')!.click()
    await new Promise((resolve) => setImmediate(resolve))
    $(v.root, '[data-action="back"]')!.click()
    finishes[0]!()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(doc.documentElement.dataset.fmNav, 'back', 'the first one finishing late leaves the second its direction')
    finishes[1]!()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(doc.documentElement.dataset.fmNav, undefined)
  })
})

describe('bands and colours follow what health judges', () => {
  const thresholds = { cpu: { busy: 60, strained: 80, critical: 90 }, memory: { busy: 70, strained: 85, critical: 92 }, ramUsedBusy: 93 }
  const bands = (root: FakeElement, chart: string) =>
    root.querySelectorAll(`[data-key="${chart}"] .fm-band`).map((b) => [b.getAttribute('data-level'), b.querySelector('.fm-band-label')?.textContent])

  test("CPU and Orca's memory figure are banded at the person's thresholds", () => {
    const v = mount(viewOf([local(), machine()], { thresholds: thresholds as never }), { reduced: true })
    v.handle.show('env-a')
    assert.deepEqual(bands(v.root, 'chart:cpu'), [['busy', '60'], ['strained', '80'], ['critical', '90']])
    assert.deepEqual(bands(v.root, 'chart:mem'), [['busy', '70'], ['strained', '85'], ['critical', '92']])
    assert.match($(v.root, '[data-key="chart:cpu"] .fm-line')?.getAttribute('stroke') ?? '', /^url\(#fm-chart-\d+-line\)$/, 'coloured by level')
    assert.ok($(v.root, '[data-key="cpu"] .fm-chart--ruled'), 'room for the band figures')
  })

  test('a CPU estimate is one colour with no bands; RAM in use has its one band', () => {
    const mac = machine({
      id: 'env-mac',
      host: { ...machine().host, platform: 'darwin' },
      tier: 'basic',
      cpu: { percent: 97, source: 'load', perCore: null, groups: null },
      memory: { total: 16 * GIB, used: 15 * GIB, available: GIB, percent: 94, source: 'beacon', reliable: true, kind: 'used', pressurePercent: 80, mac: { total: 16 * GIB, used: 15 * GIB, app: 9 * GIB, wired: 2 * GIB, compressed: 3 * GIB, cached: GIB, swapUsed: 0, swapTotal: 0, pressure: 'normal', availablePercent: 20, pageSize: 16_384, swapInsPerSec: 0, swapOutsPerSec: 0, sustainedSwapOutsPerSec: null } as never },
      history: { ...history(NOW), ram: history(NOW).cpu }
    })
    const v = mount(viewOf([local(), mac], { thresholds: thresholds as never }), { reduced: true })
    v.handle.show('env-mac')
    assert.deepEqual(bands(v.root, 'chart:cpu'), [])
    assert.equal($(v.root, '[data-key="chart:cpu"] .fm-line')?.getAttribute('stroke'), 'currentColor')
    assert.deepEqual(bands(v.root, 'chart:mem'), [['busy', '93']])
  })

  test('the peak is marked where it was, with its figure', () => {
    const v = mount(viewOf([local(), machine()]), { reduced: true })
    v.handle.show('env-a')
    const peak = $(v.root, '[data-key="chart:cpu"] .fm-peak')!
    assert.equal(peak.hasAttribute('hidden'), false)
    // The highest reading is the one before the newest: 91.7, ten seconds before the window's end.
    assert.equal(peak.textContent, 'peak 92')
    assert.equal(peak.style.getPropertyValue('left'), '99.44%')
  })
})

describe('rows that change place slide there', () => {
  test('re-sorted workspaces slide from where they were; nothing slides on a change of screen', () => {
    // The fake DOM has no layout: a row's top is its place in its list, and animations are noted.
    const proto = Object.getPrototypeOf(dom.root) as Record<string, unknown>
    const slides: { key: string | null; from: string }[] = []
    proto.getBoundingClientRect = function (this: FakeElement) {
      const index = this.parentNode ? this.parentNode.childNodes.indexOf(this) : 0
      return { top: index * 30, left: 0, width: 300, height: 30 }
    }
    proto.animate = function (this: FakeElement, keyframes: { transform: string }[]) {
      slides.push({ key: this.getAttribute('data-key'), from: keyframes[0]!.transform })
      return {}
    }
    try {
      const ws = (a: number, b: number) => ({
        byCpu: [
          { id: 'w-a', name: 'alpha', repo: null, cpu: a, memory: GIB, sessions: 1 },
          { id: 'w-b', name: 'beta', repo: null, cpu: b, memory: GIB, sessions: 1 }
        ].sort((x, y) => y.cpu - x.cpu),
        byMemory: []
      })
      const v = mount(viewOf([local(), machine({ workspaces: ws(200, 100) as never })]))
      v.handle.show('env-a')
      assert.equal(slides.length, 0, 'opening a machine slides no row')
      v.push(viewOf([local(), machine({ workspaces: ws(100, 200) as never })], { seq: 2 }), NOW + 5_000)
      assert.deepEqual(
        slides.filter((x) => x.key?.startsWith('ws:')),
        [
          { key: 'ws:w-b', from: 'translateY(30px)' },
          { key: 'ws:w-a', from: 'translateY(-30px)' }
        ]
      )
    } finally {
      delete proto.getBoundingClientRect
      delete proto.animate
    }
  })
})

describe('figures and screens', () => {
  test('a figure counts to its new reading', () => {
    const v = mount(viewOf([local(), machine()]))
    const figure = () => $(v.root, '[data-id="env-a"] .fm-num')!.textContent
    assert.equal(figure(), '90')
    v.push(viewOf([local(), machine({ cpu: { percent: 50, source: 'beacon', perCore: [50], groups: null } })], { seq: 2 }), NOW + 5_000)
    assert.equal(figure(), '90', 'it starts where it was')
    v.step(COUNT_MS / 4)
    const between = Number(figure())
    assert.ok(between < 90 && between > 50, `on its way (${between})`)
    v.settle()
    assert.equal(figure(), '50')
  })

  test('opening a machine slides screens where the browser can, and moves focus once the new one is in', async () => {
    const v = mount(viewOf([local(), machine()]))
    const doc = dom.document as unknown as { startViewTransition?: (update: () => void) => unknown; documentElement: FakeElement }
    const calls: string[] = []
    let finish: () => void = () => {}
    doc.startViewTransition = (update) => {
      calls.push(doc.documentElement.dataset.fmNav ?? '')
      const done = Promise.resolve().then(update)
      return { updateCallbackDone: done, finished: new Promise<void>((resolve) => (finish = resolve)) }
    }
    $(v.root, '[data-action="open"][data-id="env-a"]')!.click()
    assert.deepEqual(calls, ['forward'])
    assert.equal(v.root.dataset.screen, 'overview', 'the new screen comes in the transition, not before')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(v.root.dataset.screen, 'detail')
    assert.equal(dom.document.activeElement?.getAttribute('data-action'), 'back', 'focus moved after the update')
    finish()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(doc.documentElement.dataset.fmNav, undefined, 'the direction is cleared afterwards')
    // Code that shows a machine (the preview) changes at once.
    v.handle.show(null)
    assert.equal(v.root.dataset.screen, 'overview')
  })
})
