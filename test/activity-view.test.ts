// A machine's Overview | Activity tabs, its tiles, its Processes card and the memory line
// (panel/activity.mjs through panel/view.mjs), in the fake DOM (test/fake-dom.ts), which refuses
// and records any attempt to parse a string as markup. Every value is invented.
import { afterEach, assert, beforeEach, describe, test } from 'orca/testing'
import { arrangeRows, diskSpace, energyText, procCpu, rate, type ProcRow } from '../panel/activity.mjs'
import type { FleetReadyView, FleetView } from '../panel/fleet-binding.mjs'
import { mountFleetView } from '../panel/view.mjs'
import { DEFAULT_HEALTH } from '../src/health.ts'
import type { MachineView } from '../src/model.ts'
import { installFakeDom, texts, type FakeDocument, type FakeElement } from './fake-dom.ts'

const NOW = 1_800_000_000_000
const GIB = 2 ** 30
const XSS = '<img src=x onerror="globalThis.__xss=1"><script>globalThis.__xss=1</script>'

type Over = Partial<MachineView> & Record<string, unknown>

function base(over: Over = {}): MachineView {
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
    host: { hostname: 'build-box', platform: 'darwin', arch: 'arm64', cpuModel: 'Example Chip', cores: 8, uptimeSec: 90_000 },
    cpu: { percent: 40, source: 'beacon', perCore: [40, 41, 39, 40], groups: null },
    memory: { total: 32 * GIB, used: 8 * GIB, available: 24 * GIB, percent: 25, source: 'beacon', reliable: true },
    load: { one: 1.5, five: 1.25, fifteen: 1 },
    orca: { cpu: 8, memory: GIB, totalCpu: 20, totalMemory: 2 * GIB },
    workspaces: { byCpu: [], byMemory: [] },
    health: { level: 'ok', reasons: [], cpu: 'ok', memory: 'ok' },
    beacon: { state: 'fresh', ageMs: 1_000, seq: 9, pluginKey: 'local.fleet-monitor', remotePlugin: 'running' },
    updatedAt: NOW,
    history: { t: [], cpu: [], mem: [] },
    ...over
  } as MachineView
}

const SYSTEM = {
  net: { iface: 'en0', rxBytesPerSec: 4_200_000, txBytesPerSec: 310_000 },
  disk: { totalBytes: 994e9, usedBytes: 412e9, readBytesPerSec: 2_100_000, writeBytesPerSec: 640_000 },
  gpu: { percent: 12 },
  battery: { present: true, percent: 82, state: 'charging', source: 'ac', minutesRemaining: 38 }
} as const
const MIN = 60_000
const t30 = Array.from({ length: 30 }, (_, i) => NOW - (29 - i) * MIN)
const HISTORY = {
  t: t30,
  cpu: t30.map(() => 20),
  mem: t30.map(() => 25),
  rx: t30.map((_, i) => (i === 15 ? 12_600_000 : 1_000_000)),
  tx: t30.map(() => 100_000),
  gpu: t30.map((_, i) => (i === 16 ? 38 : 10))
}

/** This computer, a Mac with Fleet Monitor 1.2: every tile and the full process list. */
const local = (over: Over = {}): MachineView =>
  base({ id: 'local', kind: 'local', name: 'This desk', cpu: { percent: 12, source: 'sampler', perCore: [12, 12], groups: null }, system: SYSTEM, processes: { state: 'full', reason: null, takenAt: null }, history: HISTORY, ...over })

/** A remote Mac with 1.2: its own top list. */
const studio = (over: Over = {}): MachineView =>
  base({ id: 'env-studio', name: 'Studio', system: { ...SYSTEM, battery: { present: false, percent: null, state: null, source: 'ac', minutesRemaining: null } }, processes: { state: 'top', reason: null, takenAt: NOW - 8_000 }, history: HISTORY, ...over })

const basicMac = (over: Over = {}): MachineView =>
  base({
    id: 'env-basic',
    name: 'Basic Mac',
    tier: 'basic',
    cpu: { percent: 60, source: 'load', perCore: null, groups: null },
    memory: { total: 32 * GIB, used: 20 * GIB, available: 12 * GIB, percent: 62, source: 'orca', reliable: true, kind: 'pressure', pressurePercent: 62 },
    beacon: { state: 'absent', ageMs: null, seq: null, pluginKey: null, remotePlugin: 'absent' },
    processes: { state: 'unavailable', reason: 'basic', takenAt: null },
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

type Proc = { pid: number; name: string; cpu: number | null; mem: number | null; energy?: number | null; user?: string | null; start?: number | null; command?: string }

/** A `fleet.processes` answer in columns. */
function listOf(procs: Proc[], over: Record<string, unknown> = {}) {
  return {
    machineId: 'local',
    state: 'ok',
    reason: null,
    scope: 'full',
    takenAt: NOW - 1_000,
    ageMs: 1_000,
    total: procs.length,
    columns: {
      pid: procs.map((p) => p.pid),
      ppid: procs.map(() => 1),
      name: procs.map((p) => p.name),
      user: procs.map((p) => (p.user === undefined ? 'sam' : p.user)),
      cpu: procs.map((p) => p.cpu),
      mem: procs.map((p) => p.mem),
      energy: procs.map((p) => (p.energy === undefined ? 1 : p.energy)),
      start: procs.map((p) => (p.start === undefined ? (NOW - 3 * 3_600_000 - 12 * MIN) / 1000 : p.start)),
      protected: procs.map(() => null),
      ...(procs.some((p) => p.command) ? { command: procs.map((p) => p.command ?? '') } : {})
    },
    ...over
  }
}

/** `n` invented processes, busiest first by CPU: proc-0 at 40%, then less. */
function many(n: number): Proc[] {
  return Array.from({ length: n }, (_, i) => ({ pid: 1000 + i, name: `proc-${i}`, cpu: Math.max(0, 40 - i * 0.1), mem: (n - i) * 10 * 2 ** 20, energy: (i * 7) % 50 }))
}

let dom: ReturnType<typeof installFakeDom>
beforeEach(() => {
  dom = installFakeDom()
})
afterEach(() => {
  dom.restore()
})

/** Mounts the view on a binding whose watchProcesses answers with `answer(id)` at once (after a
 *  tick) and again at every `v.reading()`; timers run only when told to. */
function mount(initial: FleetView, answer: (id: string) => unknown = () => listOf(many(30))) {
  let view = initial
  let listener: ((v: FleetView) => void) | null = null
  const timers: { fn: () => void; ms: number }[] = []
  /** Every watch started, in order; `live` until the view stops it. */
  const watches: { id: string; live: boolean; send: () => void }[] = []
  const binding = {
    ready: Promise.resolve(),
    current: () => view,
    subscribe: (l: (v: FleetView) => void) => {
      listener = l
      l(view)
      return () => {}
    },
    refresh: () => Promise.resolve(),
    retry: () => Promise.resolve(true),
    watchProcesses: (id: string, onAnswer: (a: never) => void) => {
      const w = {
        id,
        live: true,
        send: () => {
          if (!w.live) return
          let value: unknown
          try {
            value = answer(id)
          } catch (err) {
            value = { state: 'error', error: String(err), machineId: id }
          }
          onAnswer(value as never)
        }
      }
      watches.push(w)
      void Promise.resolve().then(w.send)
      return () => {
        w.live = false
      }
    },
    dispose: () => {},
    _heartbeat: () => {}
  }
  const handle = mountFleetView(dom.root as unknown as HTMLElement, {
    binding,
    now: () => NOW,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: ((fn: () => void, ms: number) => {
      timers.push({ fn, ms })
      return 0
    }) as unknown as typeof setTimeout
  })
  return {
    handle,
    root: dom.root,
    document: dom.document as FakeDocument,
    timers,
    watches,
    /** The ids of the watches still running. */
    watching: () => watches.filter((w) => w.live).map((w) => w.id),
    /** A new list for every watch still running, as the binding's next ask brings. */
    reading: () => watches.forEach((w) => w.send()),
    push(next: FleetView) {
      view = next
      listener?.(next)
    },
    /** Runs the timers set so far whose delay is `ms` (all with no `ms`). */
    run(ms?: number) {
      const due = timers.filter((t) => ms === undefined || t.ms === ms)
      for (const t of due) timers.splice(timers.indexOf(t), 1)
      for (const t of due) t.fn()
    }
  }
}

const $ = (root: FakeElement, selector: string): FakeElement | null => root.querySelector(selector)
const $$ = (root: FakeElement, selector: string): FakeElement[] => root.querySelectorAll(selector)
const text = (node: FakeElement | null): string => (node ? texts(node).join('') : '')
const settle = () => new Promise((resolve) => setImmediate(resolve))
const names = (root: FakeElement) => $$(root, '.fm-proc-name').map((n) => text(n))
function key(target: FakeElement, k: string) {
  let prevented = false
  target.dispatchEvent({ type: 'keydown', key: k, target, preventDefault: () => (prevented = true) } as never)
  return prevented
}
function type(v: ReturnType<typeof mount>, value: string) {
  const input = $(v.root, '[data-input="search"]')!
  input.value = value
  input.dispatchEvent({ type: 'input', target: input })
}
function sortBy(v: ReturnType<typeof mount>, value: string) {
  const select = $(v.root, '[data-input="sort"]')!
  select.value = value
  select.dispatchEvent({ type: 'change', target: select })
}
/** Opens a machine and its Activity tab, and lets the first list arrive. */
async function activity(v: ReturnType<typeof mount>, id: string) {
  v.handle.show(id)
  $(v.root, '[data-tab="activity"]')!.click()
  await settle()
}

describe('Overview | Activity', () => {
  test('a Mac with 1.2 gets the two tabs under its name, and opens on Overview, card for card as before', () => {
    const v = mount(viewOf([local()]))
    v.handle.show('local')
    const seg = $(v.root, '.fm-top--detail [role="tablist"]')!
    assert.ok(seg, 'the control is in the sticky header')
    assert.equal(seg.getAttribute('aria-label'), 'This desk')
    const tabs = $$(seg, '[role="tab"]')
    assert.deepEqual(tabs.map((t) => [text(t), t.getAttribute('aria-selected'), t.getAttribute('tabindex')]), [
      ['Overview', 'true', null],
      ['Activity', 'false', '-1']
    ])
    const panel = $(v.root, '.fm-sections')!
    assert.equal(panel.getAttribute('role'), 'tabpanel')
    assert.equal(panel.getAttribute('aria-labelledby'), 'fm-tab-overview')
    assert.equal(tabs[0]!.getAttribute('aria-controls'), panel.getAttribute('id'))
    assert.deepEqual(panel.childNodes.map((n) => (n as FakeElement).getAttribute('data-key')), ['cpu', 'memory', 'facts:System'])
    assert.equal($(v.root, '.fm-tiles'), null, 'tiles live on Activity, not Overview')
    assert.equal(v.watches.length, 0, 'no process list is asked for on Overview')
  })

  test('clicking Activity shows the tiles and the Processes card; clicking Overview brings today’s view back', async () => {
    const v = mount(viewOf([local()]))
    await activity(v, 'local')
    const panel = $(v.root, '.fm-sections')!
    assert.equal(panel.getAttribute('aria-labelledby'), 'fm-tab-activity')
    assert.deepEqual(panel.childNodes.map((n) => (n as FakeElement).getAttribute('data-key')), ['tiles', 'procs-card'])
    assert.equal($(v.root, '#fm-tab-activity')!.getAttribute('aria-selected'), 'true')
    $(v.root, '[data-tab="overview"]')!.click()
    assert.deepEqual($(v.root, '.fm-sections')!.childNodes.map((n) => (n as FakeElement).getAttribute('data-key')), ['cpu', 'memory', 'facts:System'])
  })

  test('arrow keys, Home and End move between the tabs and select at once', () => {
    const v = mount(viewOf([local()]))
    v.handle.show('local')
    const overview = $(v.root, '#fm-tab-overview')!
    overview.focus()
    assert.equal(key(overview, 'ArrowRight'), true)
    assert.equal($(v.root, '#fm-tab-activity')!.getAttribute('aria-selected'), 'true')
    assert.ok(v.document.activeElement === $(v.root, '#fm-tab-activity'), 'focus follows')
    key($(v.root, '#fm-tab-activity')!, 'Home')
    assert.equal($(v.root, '#fm-tab-overview')!.getAttribute('aria-selected'), 'true')
    key($(v.root, '#fm-tab-overview')!, 'End')
    assert.equal($(v.root, '#fm-tab-activity')!.getAttribute('aria-selected'), 'true')
    key($(v.root, '#fm-tab-activity')!, 'ArrowLeft')
    assert.equal($(v.root, '#fm-tab-overview')!.getAttribute('aria-selected'), 'true')
  })

  test('opening a machine always lands on Overview; the choice is not remembered', async () => {
    const v = mount(viewOf([local(), studio()]))
    await activity(v, 'local')
    v.handle.show(null)
    v.handle.show('local')
    assert.equal($(v.root, '#fm-tab-overview')!.getAttribute('aria-selected'), 'true')
    await activity(v, 'local')
    v.handle.show('env-studio')
    assert.equal($(v.root, '#fm-tab-overview')!.getAttribute('aria-selected'), 'true')
  })

  test('no tabs on a basic machine (the install hint says what installing adds), offline, connecting, or a machine with nothing to show', () => {
    // A platform Fleet Monitor reads no activity on (it reads a Mac, Linux and Windows).
    const linux = base({ id: 'env-linux', name: 'BSD Box', host: { ...base().host, platform: 'freebsd' }, processes: { state: 'unavailable', reason: 'not-mac', takenAt: null } })
    const v = mount(
      viewOf([
        local(),
        basicMac(),
        studio({ id: 'env-off', online: false, status: 'offline', health: { level: 'unknown', reasons: ['offline'], cpu: null, memory: null } }),
        studio({ id: 'env-wait', online: false, status: 'connecting' }),
        linux
      ])
    )
    for (const id of ['env-basic', 'env-off', 'env-wait', 'env-linux']) {
      v.handle.show(id)
      assert.equal($(v.root, '[role="tablist"]'), null, `${id}: no tabs`)
      assert.equal($(v.root, '.fm-sections')!.getAttribute('role'), null)
      assert.equal($(v.root, '[data-key="activity-notice"]'), null, `${id}: no update notice`)
    }
    v.handle.show('env-basic')
    assert.equal(text($(v.root, '.fm-install-text')), 'Install Fleet Monitor on this machine for real RAM usage, activity and processes')
    assert.equal($(v.root, '.fm-procs-card'), null, 'no empty tables')
  })

  test('a Mac whose Fleet Monitor publishes no activity gets one notice, and no tabs', () => {
    const v = mount(viewOf([local(), studio({ system: null, processes: { state: 'unavailable', reason: 'outdated', takenAt: null } })]))
    v.handle.show('env-studio')
    assert.equal($(v.root, '[role="tablist"]'), null)
    assert.equal(text($(v.root, '[data-key="activity-notice"]')), 'Update Fleet Monitor on Studio to 1.2 or later to see its network, disk and processes here.')
  })

  test('a Linux or Windows machine needs 1.3 for it, and the notice says so', () => {
    for (const platform of ['linux', 'win32']) {
      const box = base({ id: 'env-box', name: 'Box', host: { ...base().host, platform }, system: null, processes: { state: 'unavailable', reason: 'outdated', takenAt: null } })
      const v = mount(viewOf([local(), box]))
      v.handle.show('env-box')
      assert.equal($(v.root, '[role="tablist"]'), null)
      assert.equal(text($(v.root, '[data-key="activity-notice"]')), 'Update Fleet Monitor on Box to 1.3 or later to see its network, disk and processes here.', platform)
    }
  })

  test('a Windows machine whose PowerShell cannot run the reader says that, and does not ask for an update', () => {
    const box = base({ id: 'env-box', name: 'Locked Box', host: { ...base().host, platform: 'win32' }, system: null, processes: { state: 'unavailable', reason: 'no-reader', takenAt: null } })
    const v = mount(viewOf([local(), box]))
    v.handle.show('env-box')
    assert.equal($(v.root, '[role="tablist"]'), null)
    assert.match(text($(v.root, '[data-key="activity-notice"]')), /^Fleet Monitor on Locked Box cannot read its network, disk traffic, GPU, battery and processes: Windows PowerShell/)
  })

  test('disk space is read without PowerShell, so that machine may have a tab: the notice is in it too', async () => {
    const space = { net: null, gpu: null, battery: null, disk: { totalBytes: 500 * GIB, usedBytes: 200 * GIB, readBytesPerSec: null, writeBytesPerSec: null } }
    const box = base({ id: 'env-box', name: 'Locked Box', host: { ...base().host, platform: 'win32' }, system: space, processes: { state: 'unavailable', reason: 'no-reader', takenAt: null } })
    const v = mount(viewOf([local(), box]))
    await activity(v, 'env-box')
    assert.ok($(v.root, '[role="tablist"]'), 'the disk tile gives it an Activity tab')
    assert.match(text($(v.root, '[data-key="activity-notice"]')), /cannot read its network, disk traffic, GPU, battery and processes/)
    assert.equal($(v.root, '.fm-procs-card'), null)
  })
})

describe('tiles', () => {
  test('network, disk, GPU and battery, each with its figure, its line and its slot', async () => {
    const v = mount(viewOf([local()]))
    await activity(v, 'local')
    const tiles = $$(v.root, '.fm-tile')
    assert.deepEqual(tiles.map((t) => text($(t, '.fm-metric-label'))), ['Network', 'Disk', 'GPU', 'Battery'])
    assert.equal($(v.root, '.fm-tiles')!.getAttribute('aria-label'), 'Network, disk, GPU, battery')
    const [net, disk, gpu, battery] = tiles as [FakeElement, FakeElement, FakeElement, FakeElement]
    assert.equal(text($(net, '.fm-big')), '4.2MB/s')
    assert.equal(text($(net, '.fm-sub')), '310 KB/s')
    assert.equal(net.getAttribute('aria-label'), 'Network: down 4.2 MB/s, up 310 KB/s')
    assert.equal(net.getAttribute('role'), 'group')
    assert.equal($(net, 'svg.fm-spark')!.getAttribute('aria-label'), 'Network over the last 30 minutes: download peaked at 13 MB/s')
    assert.ok($(net, '.fm-line--second'), 'upload drawn as a second line')
    // Both series on one scale with headroom: the peak sits below the top of the box.
    const ys = $$(net, '.fm-spark path').flatMap((path) =>
      (path.getAttribute('d') ?? '')
        .split(/[MLZ]/)
        .map((pair) => pair.trim())
        .filter(Boolean)
        .map((pair) => Number(pair.split(' ')[1]))
    )
    const lowest = Math.min(...ys)
    assert.ok(lowest > 2, `the peak is not clipped (${lowest})`)
    assert.equal(text($(disk, '.fm-big')), '41%')
    assert.equal(text($(disk, '.fm-sub')), '412 / 994 GB')
    assert.equal(text($(disk, '.fm-tile-cap')), 'R 2.1 MB/s · W 640 KB/s')
    assert.equal($(disk, '.fm-ws-bar')!.getAttribute('aria-hidden'), 'true')
    assert.equal(disk.getAttribute('aria-label'), 'Disk: 41% used, 412 / 994 GB; reading 2.1 MB/s, writing 640 KB/s')
    assert.equal(text($(gpu, '.fm-big')), '12%')
    assert.equal(text($(gpu, '.fm-sub')), 'peak 38%')
    assert.equal(text($(battery, '.fm-sub')), 'Charging')
    assert.equal(text($(battery, '.fm-tile-cap')), '38m to full')
    assert.equal(battery.getAttribute('data-tone'), 'ok')
  })

  test('a machine without a GPU reading or a battery has neither tile; with no readings at all, no card', async () => {
    const v = mount(viewOf([local({ system: { ...SYSTEM, gpu: null, battery: { present: false, percent: null, state: null, source: 'ac', minutesRemaining: null } } })]))
    await activity(v, 'local')
    assert.deepEqual($$(v.root, '.fm-tile .fm-metric-label').map(text), ['Network', 'Disk'])
    assert.equal($(v.root, '.fm-tiles')!.getAttribute('aria-label'), 'Network, disk')
    const w = mount(viewOf([local({ system: null })]))
    await activity(w, 'local')
    assert.equal($(w.root, '.fm-tiles'), null)
    assert.ok($(w.root, '.fm-procs-card'), 'the list is still there')
  })

  test('a battery running low on battery is coloured; a full disk is too; health is not touched', async () => {
    const v = mount(
      viewOf([
        local({
          system: {
            ...SYSTEM,
            disk: { ...SYSTEM.disk, totalBytes: 2e12, usedBytes: 1.92e12 },
            battery: { present: true, percent: 18, state: 'discharging', source: 'battery', minutesRemaining: 52 }
          }
        })
      ])
    )
    await activity(v, 'local')
    const [, disk, , battery] = $$(v.root, '.fm-tile') as [FakeElement, FakeElement, FakeElement, FakeElement]
    assert.equal(text($(disk, '.fm-sub')), '1.92 / 2 TB')
    assert.equal(disk.getAttribute('data-tone'), 'strained')
    assert.equal(text($(battery, '.fm-sub')), 'On battery')
    assert.equal(text($(battery, '.fm-tile-cap')), '52m left')
    assert.equal(battery.getAttribute('data-tone'), 'busy')
    assert.equal($(v.root, '.fm-level')!.getAttribute('data-health'), 'ok', 'the machine is still OK')
  })
})

describe('the Processes card', () => {
  test('loading, and a remote list still on its way: a skeleton with its own label, and no rows', async () => {
    for (const answer of [() => undefined, () => listOf([], { state: 'waiting', scope: 'top', total: null })]) {
      const v = mount(viewOf([local(), studio()]), answer)
      await activity(v, 'env-studio')
      assert.equal($(v.root, '.fm-procs-card')!.getAttribute('aria-busy'), 'true')
      assert.equal($(v.root, '.fm-proc-skel')!.getAttribute('aria-label'), 'Loading processes')
      assert.equal($$(v.root, '.fm-proc').length, 0)
      dom.restore()
      dom = installFakeDom()
    }
  })

  test('this computer’s list cut at the answer’s size: the count and "Show all" agree, and a note says why', async () => {
    const v = mount(viewOf([local()]), () => listOf(many(40), { total: 900, truncated: true }))
    await activity(v, 'local')
    assert.equal(text($(v.root, '.fm-proc-top .fm-sub')), 'top 40 of 900')
    assert.equal(text($(v.root, '[data-action="show-all"]')), 'Show all 40')
    assert.equal(text($(v.root, '.fm-proc-note')), 'This computer has more processes than one answer holds, so its 40 busiest are listed.')
  })

  test('a process with no memory figure yet shows it as absent, not zero, and sorts last by memory', async () => {
    const v = mount(viewOf([local()]), () => listOf([{ pid: 1, name: 'new', cpu: 9, mem: null }, { pid: 2, name: 'old', cpu: 1, mem: 2 ** 20 }]))
    await activity(v, 'local')
    assert.equal(text($$(v.root, '.fm-proc-row .fm-proc-mem')[0]!), '–')
    sortBy(v, 'memory')
    assert.deepEqual(names(v.root), ['old', 'new'])
  })

  test('the first 25 rows, sorted by CPU; "Show all N" draws the rest', async () => {
    const v = mount(viewOf([local()]), () => listOf(many(30), { total: 30 }))
    await activity(v, 'local')
    assert.equal(text($(v.root, '.fm-proc-top .fm-sub')), '30')
    assert.equal($$(v.root, '.fm-proc').length, 25)
    assert.deepEqual(names(v.root).slice(0, 3), ['proc-0', 'proc-1', 'proc-2'])
    const more = $(v.root, '[data-action="show-all"]')!
    assert.equal(text(more), 'Show all 30')
    more.click()
    assert.equal($$(v.root, '.fm-proc').length, 30)
    assert.equal($(v.root, '[data-action="show-all"]'), null)
  })

  test('"Show fewer" goes back to the first 25, closing a row opened further down', async () => {
    const v = mount(viewOf([local()]), () => listOf(many(30), { total: 30 }))
    await activity(v, 'local')
    assert.equal($(v.root, '[data-action="show-fewer"]'), null, 'nothing to go back from yet')
    $(v.root, '[data-action="show-all"]')!.click()
    const fewer = $(v.root, '[data-action="show-fewer"]')!
    assert.equal(text(fewer), 'Show fewer')
    // Open the last row, which the short list does not hold.
    const rows = $$(v.root, '.fm-proc')
    rows.at(-1)!.querySelector('[data-action="proc"]')?.click()
    fewer.click()
    assert.equal($$(v.root, '.fm-proc').length, 25)
    assert.equal(text($(v.root, '[data-action="show-all"]')), 'Show all 30')
    assert.equal($(v.root, '[data-action="show-fewer"]'), null)
    assert.equal($(v.root, '.fm-proc-more'), null, 'no open row left behind')
  })

  test('a list of 25 or fewer has neither button', async () => {
    const v = mount(viewOf([local()]), () => listOf(many(25), { total: 25 }))
    await activity(v, 'local')
    assert.equal($(v.root, '[data-action="show-all"]'), null)
    assert.equal($(v.root, '[data-action="show-fewer"]'), null)
  })

  test('CPU is percent of one core, labelled so, and can pass 100', async () => {
    const v = mount(viewOf([local()]), () => listOf([{ pid: 7, name: 'compiler', cpu: 312.4, mem: 3 * GIB }, { pid: 8, name: 'idle', cpu: 0.04, mem: 2 ** 20 }]))
    await activity(v, 'local')
    assert.equal(text($(v.root, '.fm-proc-head .fm-proc-cpu')), '% of core')
    const rows = $$(v.root, '.fm-proc-row')
    assert.equal(text($(rows[0]!, '.fm-proc-cpu')), '312%')
    assert.equal(text($(rows[1]!, '.fm-proc-cpu')), '<0.1%')
    assert.equal(rows[0]!.getAttribute('aria-label'), 'compiler, CPU 312% of one core, memory 3 GB')
    assert.deepEqual([procCpu(5.43), procCpu(38.4), procCpu(0), procCpu(null)], ['5.4%', '38%', '0%', '–'])
  })

  test('sort by memory, energy and name; the live region says so, and energy is offered only where it is reported', async () => {
    const v = mount(viewOf([local()]), () =>
      listOf([
        { pid: 1, name: 'beta', cpu: 9, mem: 100, energy: 3 },
        { pid: 2, name: 'Alpha', cpu: 1, mem: 300, energy: 1 },
        { pid: 3, name: 'gamma', cpu: 5, mem: 200, energy: 9 }
      ])
    )
    await activity(v, 'local')
    assert.deepEqual($$(v.root, '[data-input="sort"] option').map((o) => o.getAttribute('value')), ['cpu', 'memory', 'energy', 'name'])
    assert.deepEqual(names(v.root), ['beta', 'gamma', 'Alpha'])
    sortBy(v, 'memory')
    assert.deepEqual(names(v.root), ['Alpha', 'gamma', 'beta'])
    assert.equal(text($(v.root, '[data-key="proc-status"]')), 'Sorted by memory, highest first')
    assert.equal($(v.root, '.fm-procs-card')!.getAttribute('data-sort'), 'memory')
    assert.ok($(v.root, '.fm-proc-head .fm-proc-mem.is-key'), 'the sorted column is marked')
    sortBy(v, 'energy')
    assert.deepEqual(names(v.root), ['gamma', 'beta', 'Alpha'])
    sortBy(v, 'name')
    assert.deepEqual(names(v.root), ['Alpha', 'beta', 'gamma'])
    assert.equal(text($(v.root, '[data-key="proc-status"]')), 'Sorted by name, A to Z')
    const linuxLike = mount(viewOf([local()]), () => listOf([{ pid: 1, name: 'a', cpu: 1, mem: 1, energy: null }]))
    await activity(linuxLike, 'local')
    assert.deepEqual($$(linuxLike.root, '[data-input="sort"] option').map((o) => o.getAttribute('value')), ['cpu', 'memory', 'name'])
    assert.equal($(linuxLike.root, '.fm-procs-card')!.hasAttribute('data-energy'), false)
    assert.equal($(linuxLike.root, '.fm-proc-energy'), null)
  })

  test('search covers every row, shown or not, by name (case ignored) and by process ID; the count says how many', async () => {
    const procs = [...many(40), { pid: 77_123, name: 'Chrome Helper', cpu: 0, mem: 1 }, { pid: 5, name: 'chrome', cpu: 0, mem: 1 }]
    const v = mount(viewOf([local()]), () => listOf(procs, { total: 412 }))
    await activity(v, 'local')
    type(v, 'CHROME')
    assert.deepEqual(names(v.root).sort(), ['Chrome Helper', 'chrome'])
    assert.equal(text($(v.root, '.fm-proc-top .fm-sub')), '2 of 412')
    assert.ok($(v.root, '[data-action="clear-search"]'), 'a clear button once there is text')
    assert.equal(text($(v.root, '[data-key="proc-status"]')), '', 'announced only once typing stops')
    v.run(500)
    assert.equal(text($(v.root, '[data-key="proc-status"]')), '2 processes match CHROME')
    type(v, '7712')
    assert.deepEqual(names(v.root), ['Chrome Helper'])
    type(v, 'proc-3')
    assert.equal($$(v.root, '.fm-proc').length, 11, 'proc-3 and proc-30…39, past the first 25')
  })

  test('no results: says so, says what is searched, and offers to clear', async () => {
    const v = mount(viewOf([local()]))
    await activity(v, 'local')
    type(v, 'blendr')
    const empty = $(v.root, '.fm-proc-empty')!
    assert.equal(text($(empty, 'h3')), 'No process matches “blendr”')
    assert.equal(text($(empty, 'p')), 'Names and process IDs are searched.')
    v.run(500)
    assert.equal(text($(v.root, '[data-key="proc-status"]')), 'No process matches blendr')
    $(empty, '[data-action="clear-search"]')!.click()
    assert.equal($(v.root, '.fm-proc-empty'), null)
    assert.equal($(v.root, '[data-input="search"]')!.value, '')
    assert.ok(v.document.activeElement === $(v.root, '[data-input="search"]'), 'focus goes to the field')
  })

  test('a remote machine: its top list, counted and explained, and its own no-results sentence', async () => {
    const v = mount(viewOf([local(), studio()]), () => listOf(many(60), { machineId: 'env-studio', scope: 'top', total: 387, takenAt: NOW - 8_000 }))
    await activity(v, 'env-studio')
    assert.equal(text($(v.root, '.fm-proc-top .fm-sub')), 'top 60 of 387')
    assert.equal(text($(v.root, '.fm-proc-note')), 'Studio sends its 60 busiest processes by memory and CPU, not the full list. Updated 8s ago.')
    assert.equal(text($(v.root, '[data-action="show-all"]')), 'Show all 60')
    type(v, 'proc-1')
    assert.equal(text($(v.root, '.fm-proc-top .fm-sub')), '11 of 60')
    type(v, 'blendr')
    assert.equal(text($(v.root, '.fm-proc-empty p')), 'Only Studio’s 60 busiest processes are listed, so it may still be running there.')
    const unknownTotal = mount(viewOf([local(), studio()]), () => listOf(many(40), { scope: 'top', total: null }))
    await activity(unknownTotal, 'env-studio')
    assert.equal(text($(unknownTotal.root, '.fm-proc-top .fm-sub')), 'top 40')
  })

  test('a list that could not be read says so rather than showing an empty table', async () => {
    const v = mount(viewOf([local()]), () => {
      throw new Error('worker away')
    })
    await activity(v, 'local')
    assert.match(text($(v.root, '[data-key="proc-failed"]')), /could not be read just now/)
    assert.equal($(v.root, '.fm-procs'), null)
  })

  test('this computer, where PowerShell cannot run the reader: said once, not as a passing failure', async () => {
    const v = mount(viewOf([local()]), () => listOf([], { state: 'unavailable', reason: 'no-reader', takenAt: null, ageMs: null, total: null }))
    await activity(v, 'local')
    assert.match(text($(v.root, '[data-key="proc-blocked"]')), /cannot be read on this computer: Windows PowerShell/)
    assert.equal($(v.root, '[data-key="proc-failed"]'), null)
    assert.equal($(v.root, '[data-key="proc-loading"]'), null)
  })
})

describe('a row', () => {
  test('opens to show the process ID, user, how long it has run and the numbers the row leaves out; one at a time', async () => {
    const v = mount(viewOf([local()]), () => listOf([{ pid: 48_211, name: 'node', cpu: 5.4, mem: 2.1 * GIB, energy: 48.6 }, { pid: 9, name: 'other', cpu: 1, mem: 1 }]))
    await activity(v, 'local')
    const row = $$(v.root, '.fm-proc-row')[0]!
    assert.equal(row.getAttribute('aria-expanded'), 'false')
    assert.equal(row.getAttribute('aria-controls'), null)
    row.click()
    assert.equal(row.getAttribute('aria-expanded'), 'true')
    const region = $(v.root, `#${row.getAttribute('aria-controls')}`)!
    assert.equal(region.getAttribute('role'), 'region')
    assert.equal(region.getAttribute('aria-label'), 'node, process 48211')
    const facts = $$(region, '.fm-fact').map((f) => [text($(f, 'dt')), text($(f, 'dd'))])
    assert.deepEqual(facts, [
      ['CPU', '5.4% of one core'],
      ['Memory', '2.1 GB'],
      ['Energy impact', '48.6'],
      ['PID', '48211'],
      ['User', 'sam'],
      ['Running for', '3h 12m']
    ])
    assert.equal($(region, 'button'), null, 'nothing to press')
    assert.equal($(region, '.fm-proc-cmd'), null, 'no command line when none is reported')
    $$(v.root, '.fm-proc-row')[1]!.click()
    assert.equal($$(v.root, '.fm-proc.is-open').length, 1)
    assert.equal(row.getAttribute('aria-expanded'), 'false')
  })

  test('one tab stop for the list; Up, Down, Home and End move it', async () => {
    const v = mount(viewOf([local()]), () => listOf(many(5)))
    await activity(v, 'local')
    const stops = () => $$(v.root, '.fm-proc-row').map((r) => r.getAttribute('tabindex'))
    assert.deepEqual(stops(), ['0', '-1', '-1', '-1', '-1'])
    const rows = $$(v.root, '.fm-proc-row')
    rows[0]!.focus()
    assert.equal(key(rows[0]!, 'ArrowDown'), true)
    assert.ok(v.document.activeElement === rows[1])
    assert.deepEqual(stops(), ['-1', '0', '-1', '-1', '-1'])
    key(rows[1]!, 'End')
    assert.ok(v.document.activeElement === rows[4])
    key(rows[4]!, 'Home')
    assert.ok(v.document.activeElement === rows[0])
    key(rows[0]!, 'ArrowUp')
    assert.ok(v.document.activeElement === rows[0], 'stays at the top')
  })
})

describe('the list across readings', () => {
  /** A list source the test changes between readings. */
  function source(first: Proc[]) {
    let procs = first
    return { set: (next: Proc[]) => (procs = next), answer: () => listOf(procs) }
  }
  const p = (pid: number, cpu: number): Proc => ({ pid, name: `p${pid}`, cpu, mem: 1, start: 100 })
  async function reading(v: ReturnType<typeof mount>) {
    v.reading()
    await settle()
  }

  test('rows are kept, not rebuilt, when new numbers arrive; numbers change in place', async () => {
    const s = source([p(1, 30), p(2, 20), p(3, 10)])
    const v = mount(viewOf([local()]), s.answer)
    await activity(v, 'local')
    const before = $$(v.root, '.fm-proc')
    s.set([p(1, 31), p(2, 21), p(3, 11)])
    await reading(v)
    const after = $$(v.root, '.fm-proc')
    assert.ok(after.every((li, i) => li === before[i]), 'the same elements')
    assert.equal(text($(after[0]!, '.fm-proc-cpu')), '31%')
  })

  test('re-sorts on a new reading when nothing holds it', async () => {
    const s = source([p(1, 30), p(2, 20), p(3, 10)])
    const v = mount(viewOf([local()]), s.answer)
    await activity(v, 'local')
    s.set([p(1, 5), p(2, 20), p(3, 40)])
    await reading(v)
    assert.deepEqual(names(v.root), ['p3', 'p2', 'p1'])
  })

  test('holds its order while a row is open, then re-sorts on the first reading after it closes', async () => {
    const s = source([p(1, 30), p(2, 20), p(3, 10)])
    const v = mount(viewOf([local()]), s.answer)
    await activity(v, 'local')
    $$(v.root, '.fm-proc-row')[1]!.click()
    s.set([p(1, 5), p(2, 20), p(3, 40), p(4, 90)])
    await reading(v)
    assert.deepEqual(names(v.root), ['p1', 'p2', 'p3', 'p4'], 'held, with the new row at the end')
    assert.equal(text($$(v.root, '.fm-proc-row .fm-proc-cpu')[2]!), '40%', 'numbers still update')
    key($(v.root, '.fm-proc-row')!, 'Escape')
    assert.equal($$(v.root, '.fm-proc.is-open').length, 0)
    await reading(v)
    assert.deepEqual(names(v.root), ['p4', 'p3', 'p2', 'p1'])
  })

  test('holds its order while focus is inside the list, and focus stays put when a row above it goes', async () => {
    const s = source([p(1, 50), p(2, 40), p(3, 30), p(4, 20), p(5, 10)])
    const v = mount(viewOf([local()]), s.answer)
    await activity(v, 'local')
    const fourth = $$(v.root, '.fm-proc-row')[3]!
    fourth.focus()
    s.set([p(1, 1), p(3, 30), p(4, 99), p(5, 10)])
    await reading(v)
    assert.deepEqual(names(v.root), ['p1', 'p3', 'p4', 'p5'], 'held; p2 is gone')
    assert.ok(v.document.activeElement === fourth, 'the same element keeps focus')
    v.document.activeElement = v.document.body
    await reading(v)
    assert.deepEqual(names(v.root), ['p4', 'p3', 'p5', 'p1'])
  })

  test('a sort a person chooses applies at once, even with a row open', async () => {
    const s = source([p(1, 30), p(2, 20), p(3, 10)])
    const v = mount(viewOf([local()]), s.answer)
    await activity(v, 'local')
    $$(v.root, '.fm-proc-row')[0]!.click()
    sortBy(v, 'name')
    assert.deepEqual(names(v.root), ['p1', 'p2', 'p3'])
    sortBy(v, 'cpu')
    assert.deepEqual(names(v.root), ['p1', 'p2', 'p3'])
  })

  test('arrangeRows keeps a held order, drops rows that went and appends new ones sorted', () => {
    const row = (pid: number, cpu: number): ProcRow => ({ key: `${pid}:1`, pid, name: `p${pid}`, user: null, cpu, memory: null, energy: null, runningSec: null, command: null, hint: null })
    const out = arrangeRows([row(1, 1), row(3, 3), row(4, 4), row(5, 5)], 'cpu', ['1:1', '2:1', '3:1'])
    assert.deepEqual(out.map((r) => r.pid), [1, 3, 5, 4])
  })
})

describe('keys', () => {
  test('Esc: clears the search first (focus stays in the field), then closes the open row, then goes back', async () => {
    const v = mount(viewOf([local(), studio()]))
    await activity(v, 'local')
    $$(v.root, '.fm-proc-row')[0]!.click()
    const field = $(v.root, '[data-input="search"]')!
    field.focus()
    type(v, 'proc')
    key(field, 'Escape')
    assert.equal(field.value, '')
    assert.ok(v.document.activeElement === field, 'focus stays in the field')
    assert.equal($$(v.root, '.fm-proc.is-open').length, 1, 'the row is still open')
    key(field, 'Escape')
    assert.equal($$(v.root, '.fm-proc.is-open').length, 0)
    assert.ok(v.document.activeElement === $$(v.root, '.fm-proc-row')[0], 'focus returns to the row')
    key($$(v.root, '.fm-proc-row')[0]!, 'Escape')
    assert.equal(v.root.getAttribute('data-screen'), 'overview')
  })

  test('"/" focuses the search field on Activity, and is left alone in a field or on Overview', async () => {
    const v = mount(viewOf([local()]))
    v.handle.show('local')
    assert.equal(key(v.document.body, '/'), false, 'not on Overview')
    $(v.root, '[data-tab="activity"]')!.click()
    await settle()
    assert.equal(key(v.document.body, '/'), true)
    const field = $(v.root, '[data-input="search"]')!
    assert.ok(v.document.activeElement === field)
    assert.equal(key(field, '/'), false, 'typed into the field as text')
  })
})

describe('asking for the list', () => {
  test('watched only while a machine’s Activity tab is on screen; stopped on Overview, on another machine, and on Back', async () => {
    const v = mount(viewOf([local(), studio()]))
    v.handle.show('local')
    assert.equal(v.watches.length, 0, 'not on Overview')
    $(v.root, '[data-tab="activity"]')!.click()
    await settle()
    assert.deepEqual(v.watching(), ['local'])
    v.reading()
    await settle()
    assert.equal(v.watches.length, 1, 'one watch, not one per reading or redraw')
    $(v.root, '[data-tab="overview"]')!.click()
    assert.deepEqual(v.watching(), [], 'stopped on Overview')
    $(v.root, '[data-tab="activity"]')!.click()
    await settle()
    assert.deepEqual(v.watching(), ['local'])
    v.handle.show('env-studio')
    assert.deepEqual(v.watching(), [], 'stopped when the machine changes')
    $(v.root, '[data-tab="activity"]')!.click()
    await settle()
    assert.deepEqual(v.watching(), ['env-studio'])
    v.handle.show(null)
    assert.deepEqual(v.watching(), [], 'stopped on Back')
    assert.deepEqual(v.watches.map((w) => w.id), ['local', 'local', 'env-studio'])
  })

  test('coming back to Activity loads again rather than showing the old list as current', async () => {
    const v = mount(viewOf([local()]))
    await activity(v, 'local')
    assert.equal($$(v.root, '.fm-proc').length, 25)
    $(v.root, '[data-tab="overview"]')!.click()
    $(v.root, '[data-tab="activity"]')!.click()
    assert.ok($(v.root, '.fm-proc-skel'), 'loading until the new answer')
    await settle()
    assert.equal($$(v.root, '.fm-proc').length, 25)
  })

  test('the first answer can take a few seconds: the card shows loading until then', async () => {
    const v = mount(viewOf([local()]))
    v.handle.show('local')
    $(v.root, '[data-tab="activity"]')!.click()
    assert.ok($(v.root, '.fm-proc-skel'), 'loading before the first answer')
    await settle()
    assert.equal($(v.root, '.fm-proc-skel'), null)
    assert.equal($$(v.root, '.fm-proc').length, 25)
  })
})

describe('the memory line (Overview)', () => {
  const short = (top: { pid: number; name: string; mem: number } | null, percent = 96) =>
    local({
      memory: { total: 128 * GIB, used: (128 * GIB * percent) / 100, available: 4 * GIB, percent, source: 'sampler', reliable: true },
      health: { level: 'critical', reasons: ['memory 96% ≥ 95%'], cpu: 'ok', memory: 'critical' },
      processes: { state: 'full', reason: null, takenAt: NOW - 1_000, largest: top }
    })
  /** The largest process as last known `ageMs` ago (a machine under pressure can pause its sampling). */
  const known = (top: { pid: number; name: string; mem: number }, ageMs: number): MachineView => ({
    ...short(top),
    processes: { state: 'full', reason: null, takenAt: NOW - ageMs, memAgeMs: 0, largest: top }
  })

  test('names the process using the most memory, and how much, with nothing to press', () => {
    const v = mount(viewOf([short({ pid: 71_204, name: 'python3.12', mem: 28.4 * GIB })]))
    v.handle.show('local')
    const line = $(v.root, '[data-key="memory"] .fm-suggest')!
    assert.equal(text(line), 'python3.12 is using 28.4 GB, more than any other process.')
    assert.deepEqual($$(line, 'strong').map(text), ['python3.12', '28.4 GB'])
    assert.equal($(line, 'button'), null)
    const reading = $(v.root, '[data-key="memory"] .fm-reading')!
    assert.ok(reading.parentNode!.childNodes.indexOf(line) === reading.parentNode!.childNodes.indexOf(reading) + 1, 'right under the reading')
  })

  test('a figure a minute old or more is spoken of in the past, with its age; under a minute, in the present', () => {
    const cases: [number, string][] = [
      [59_000, 'python3.12 is using 28.4 GB, more than any other process.'],
      [60_000, 'python3.12 was using 28.4 GB 1 min ago, more than any other process.'],
      [3 * 60_000 + 20_000, 'python3.12 was using 28.4 GB 3 min ago, more than any other process.'],
      [14 * 60_000, 'python3.12 was using 28.4 GB 14 min ago, more than any other process.']
    ]
    for (const [ageMs, expected] of cases) {
      const v = mount(viewOf([known({ pid: 71_204, name: 'python3.12', mem: 28.4 * GIB }, ageMs)]))
      v.handle.show('local')
      assert.equal(text($(v.root, '.fm-suggest')), expected)
      assert.deepEqual($$(v.root, '.fm-suggest strong').map(text), ['python3.12', '28.4 GB'])
      dom.restore()
      dom = installFakeDom()
    }
  })

  test('stays away under the 5 % floor, while memory is fine, or with no process named', () => {
    for (const [m, why] of [
      [short({ pid: 1, name: 'small', mem: 6 * GIB }), 'under 5 % of 128 GB'],
      [local({ processes: { state: 'full', reason: null, takenAt: NOW, largest: { pid: 1, name: 'big', mem: 20 * GIB } } }), 'memory is fine'],
      [short(null), 'nothing named']
    ] as const) {
      const v = mount(viewOf([m]))
      v.handle.show('local')
      assert.equal($(v.root, '.fm-suggest'), null, why)
      dom.restore()
      dom = installFakeDom()
    }
  })
})

describe('remote text is never parsed as markup (1.2)', () => {
  test('process names, users, commands and machine names in rows, facts, notes, the empty state and the memory line', async () => {
    const hostileList = () =>
      listOf([{ pid: 66, name: XSS, cpu: 1, mem: 1, user: XSS, command: `${XSS} --flag ${XSS}` }], { scope: 'top', total: 10 })
    const remote = studio({
      name: XSS,
      memory: { total: 128 * GIB, used: 125 * GIB, available: 3 * GIB, percent: 97, source: 'beacon', reliable: true },
      health: { level: 'critical', reasons: [XSS], cpu: 'ok', memory: 'critical' },
      processes: { state: 'top', reason: null, takenAt: NOW - 8_000, largest: { pid: 66, name: XSS, mem: 50 * GIB } }
    })
    const v = mount(viewOf([local(), remote]), hostileList)
    v.handle.show('env-studio')
    assert.ok(texts($(v.root, '.fm-suggest')!).includes(XSS), 'the memory line names it as text')
    assert.equal($(v.root, '[role="tablist"]')!.getAttribute('aria-label'), XSS)
    $(v.root, '[data-tab="activity"]')!.click()
    await settle()
    $(v.root, '.fm-proc-row')!.click()
    assert.ok(texts(v.root).includes(XSS))
    assert.match(text($(v.root, '.fm-proc-note')), /^<img src=x/)
    assert.equal($(v.root, '.fm-proc-more')!.getAttribute('aria-label'), `${XSS}, process 66`)
    type(v, 'nothing-matches')
    assert.ok(text($(v.root, '.fm-proc-empty')).includes(XSS))
    assert.deepEqual(v.document.markupWrites, [])
    assert.ok(!v.document.created.includes('img') && !v.document.created.includes('script'))
    assert.equal((globalThis as { __xss?: number }).__xss, undefined)
  })
})

describe('numbers', () => {
  test('rates, disk space and energy as the design writes them', () => {
    assert.deepEqual([rate(4_200_000).text, rate(310_000).text, rate(12_400_000).text, rate(400).text, rate(999_600).text, rate(2.5e9).text], [
      '4.2 MB/s',
      '310 KB/s',
      '12 MB/s',
      '0 KB/s',
      '1.0 MB/s',
      '2.5 GB/s'
    ])
    assert.deepEqual([diskSpace(412e9, 994e9), diskSpace(1.42e12, 2e12), diskSpace(1.5e12, 2e12)], ['412 / 994 GB', '1.42 / 2 TB', '1.5 / 2 TB'])
    assert.deepEqual([energyText(48.62), energyText(212.4), energyText(0), energyText(null)], ['48.6', '212', '0.0', '–'])
  })
})
