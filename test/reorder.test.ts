// The overview's own order of cards (panel/reorder.mjs, drawn by panel/view.mjs): the order kept
// and applied, a card dragged by mouse or finger, moved with Alt and an arrow key, and a drag
// called off. The fake DOM has no layout: `column()` stands in for one. Every value is invented.
import { afterEach, assert, beforeEach, describe, test } from 'orca/testing'
import type { FleetReadyView, FleetView } from '../panel/fleet-binding.mjs'
import { createOrderStore, inOrder, mergeOrder, moved, ORDER_KEY, targetIndex, TOUCH_HOLD_MS, type OrderStore } from '../panel/reorder.mjs'
import { mountFleetView } from '../panel/view.mjs'
import { DEFAULT_HEALTH } from '../src/health.ts'
import type { MachineView } from '../src/model.ts'
import { installFakeDom, type FakeElement, type FakeEvent } from './fake-dom.ts'

const NOW = 1_800_000_000_000
const GIB = 2 ** 30

function machine(id: string, name: string, over: Partial<MachineView> = {}): MachineView {
  return {
    id,
    name,
    kind: 'remote',
    tier: 'full',
    status: 'online',
    online: true,
    lastSeenAt: NOW - 2_000,
    latencyMs: 300,
    error: null,
    host: { hostname: name, platform: 'linux', arch: 'x64', cpuModel: 'Example CPU', cores: 4, uptimeSec: 90_000 },
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

/** The worker's order: this computer, then the paired machines by name. */
const FLEET = [machine('local', 'This desk', { kind: 'local' }), machine('env-a', 'Alpha'), machine('env-b', 'Beta'), machine('env-c', 'Gamma')]

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

/** A store in memory that notes each save. */
function memoryStore(initial: string[] | null = null): OrderStore & { saves: string[][]; changed: (() => void) | null } {
  let kept = initial
  const store = {
    saves: [] as string[][],
    changed: null as (() => void) | null,
    load: () => kept,
    save: (ids: string[]) => {
      kept = [...ids]
      store.saves.push([...ids])
    },
    onChange: (listener: () => void) => {
      store.changed = listener
      return () => {
        store.changed = null
      }
    }
  }
  return store
}

let dom: ReturnType<typeof installFakeDom>
beforeEach(() => {
  dom = installFakeDom()
})
afterEach(() => {
  dom.restore()
})

const CARD_H = 100
const GAP = 10

/** One column of cards, each CARD_H tall (or as `heights` says), in their order on screen. The
 *  grid is at the page's origin, so a pointer's client place is its place in the grid. */
function column(heights: Record<string, number> = {}): void {
  dom.document.layout = (el) => {
    if (el.getAttribute('data-action') !== 'open' || !el.parentNode) return null
    let top = 0
    for (const sibling of el.parentNode.childNodes as FakeElement[]) {
      if (sibling === el) break
      top += (heights[sibling.getAttribute('data-id') ?? ''] ?? CARD_H) + GAP
    }
    return { left: 0, top, width: 300, height: heights[el.getAttribute('data-id') ?? ''] ?? CARD_H }
  }
}

function mount(first: FleetView, store = memoryStore(), extra: { frame?: (fn: () => void) => unknown; reducedMotion?: () => boolean } = {}) {
  const timers: { fn: () => void; ms: number }[] = []
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
    now: () => NOW,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: ((fn: () => void, ms: number) => {
      timers.push({ fn, ms })
      return 0
    }) as unknown as typeof setTimeout,
    order: store,
    ...extra
  })
  return {
    handle,
    store,
    root: dom.root,
    push(view: FleetView) {
      current = view
      listener?.(view)
    },
    runTimers() {
      for (const t of timers.splice(0)) t.fn()
    }
  }
}

const cards = (root: FakeElement): FakeElement[] => root.querySelectorAll('.fm-grid [data-action="open"]')
const ids = (root: FakeElement): string[] => cards(root).map((c) => c.getAttribute('data-id') ?? '')
const cardOf = (root: FakeElement, id: string): FakeElement => root.querySelector(`.fm-grid [data-id="${id}"]`)!

type PointerInit = Partial<FakeEvent> & { x?: number; y?: number }
function pointer(target: FakeElement, type: string, { x = 0, y = 0, ...rest }: PointerInit = {}): FakeEvent & { prevented: boolean } {
  const event = {
    type,
    target,
    clientX: x,
    clientY: y,
    pointerId: 1,
    pointerType: 'mouse',
    button: 0,
    isPrimary: true,
    prevented: false,
    preventDefault() {
      event.prevented = true
    },
    ...rest
  }
  target.dispatchEvent(event)
  return event
}

/** Presses the card with `id` at its middle and drags it to (x, y), in steps, then lets go. */
function drag(root: FakeElement, id: string, to: { x: number; y: number }, { release = true } = {}): void {
  const card = cardOf(root, id)
  const start = { x: 150, y: card.offsetTop + 50 }
  pointer(card, 'pointerdown', start)
  for (let i = 1; i <= 4; i += 1) {
    pointer(root, 'pointermove', { x: start.x + ((to.x - start.x) * i) / 4, y: start.y + ((to.y - start.y) * i) / 4 })
  }
  if (release) pointer(root, 'pointerup', to)
}

const opened = (root: FakeElement): boolean => root.getAttribute('data-screen') === 'detail'

describe('the order', () => {
  test('machines follow the kept order; those it does not name come after, as they came', () => {
    const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
    assert.equal(inOrder(list, null), list, 'nothing kept: the order as it came')
    assert.equal(inOrder(list, []), list)
    assert.deepEqual(
      inOrder(list, ['c', 'gone', 'a']).map((m) => m.id),
      ['c', 'a', 'b', 'd']
    )
  })

  test('a card moves to a place, within bounds', () => {
    assert.deepEqual(moved(['a', 'b', 'c', 'd'], 'a', 2), ['b', 'c', 'a', 'd'])
    assert.deepEqual(moved(['a', 'b', 'c', 'd'], 'd', 0), ['d', 'a', 'b', 'c'])
    assert.deepEqual(moved(['a', 'b', 'c'], 'b', 9), ['a', 'c', 'b'])
    assert.deepEqual(moved(['a', 'b', 'c'], 'b', -3), ['b', 'a', 'c'])
  })

  test('what is kept: the cards as they stand, then machines kept before that are not on screen', () => {
    assert.deepEqual(mergeOrder(['b', 'a'], ['a', 'x', 'b', 'y']), ['b', 'a', 'x', 'y'])
    assert.deepEqual(mergeOrder(['a'], null), ['a'])
  })

  test('the store keeps ids only, and keeps the order in memory where storage refuses', () => {
    const items = new Map<string, string>()
    const storage = { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v) }
    const store = createOrderStore(storage)
    assert.equal(store.load(), null, 'nothing kept yet')
    store.save(['b', 'a'])
    assert.equal(items.get(ORDER_KEY), '["b","a"]')
    assert.deepEqual(createOrderStore(storage).load(), ['b', 'a'], 'a new panel reads it')
    items.set(ORDER_KEY, JSON.stringify(['a', 7, 'a', '', 'x'.repeat(600), { id: 'b' }, 'c']))
    assert.deepEqual(store.load(), ['a', 'c'], 'strings once each, within bounds')
    items.set(ORDER_KEY, '{not json')
    assert.deepEqual(store.load(), ['b', 'a'], 'unreadable: what this panel kept')

    const refusing = createOrderStore({
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('SecurityError')
      }
    })
    assert.equal(refusing.load(), null)
    refusing.save(['c', 'b'])
    assert.deepEqual(refusing.load(), ['c', 'b'], 'kept for as long as the panel is open')
    assert.deepEqual(createOrderStore(null).load(), null, 'no storage at all')
    assert.equal(typeof createOrderStore(null).onChange(() => {}), 'function')
  })

  test('a card swaps with the one under the pointer only past its middle, so heights never make two trade back', () => {
    const box = (top: number, height: number, left = 0) => ({ offsetLeft: left, offsetTop: top, offsetWidth: 300, offsetHeight: height })
    // A short card (60) above a tall one (130), in one column.
    const short = box(0, 60)
    const tall = box(70, 130)
    assert.equal(targetIndex([short, tall], short, { x: 150, y: 120 }), 0, 'over the tall card, above its middle (135)')
    assert.equal(targetIndex([short, tall], short, { x: 150, y: 140 }), 1, 'past its middle')
    // After the swap the tall card is first and the pointer, at 140, is over the short one: it stays.
    const tallFirst = box(0, 130)
    const shortSecond = box(140, 60)
    assert.equal(targetIndex([tallFirst, shortSecond], shortSecond, { x: 150, y: 140 }), 1)
    assert.equal(targetIndex([tallFirst, shortSecond], shortSecond, { x: 150, y: 70 }), 1, 'over the tall card, below its middle (65)')
    assert.equal(targetIndex([tallFirst, shortSecond], shortSecond, { x: 150, y: 60 }), 0, 'above it')
    // Side by side in one row, the middle is across.
    const left = box(0, 100, 0)
    const right = box(0, 100, 310)
    assert.equal(targetIndex([left, right], left, { x: 400, y: 10 }), 0, 'short of the middle (460)')
    assert.equal(targetIndex([left, right], left, { x: 470, y: 10 }), 1)
    assert.equal(targetIndex([left, right], right, { x: 100, y: 10 }), 0)
    assert.equal(targetIndex([left, right], left, { x: 150, y: 500 }), 0, 'off every card: it stays')
    assert.equal(targetIndex([left], right, { x: 0, y: 0 }), -1, 'not among them')
  })
})

describe('dragging a card', () => {
  test('nothing changes before anyone moves a card', () => {
    const v = mount(viewOf(FLEET))
    assert.deepEqual(ids(v.root), ['local', 'env-a', 'env-b', 'env-c'])
    assert.deepEqual(v.store.saves, [])
    assert.equal(cards(v.root)[0]!.getAttribute('aria-keyshortcuts'), 'Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight')
  })

  test('a mouse drags a card to a new place, which is kept; the release does not open it', () => {
    column()
    const v = mount(viewOf(FLEET))
    const card = cardOf(v.root, 'local')
    pointer(card, 'pointerdown', { x: 150, y: 50 })
    pointer(v.root, 'pointermove', { x: 152, y: 52 })
    assert.equal(card.hasAttribute('data-dragging'), false, 'a short move is still a click')
    pointer(v.root, 'pointermove', { x: 150, y: 60 })
    assert.equal(card.hasAttribute('data-dragging'), true, 'past the threshold it lifts')
    assert.equal(card.hasAttribute('data-flip'), false, 'it follows the pointer, so it does not slide')
    assert.equal(v.root.hasAttribute('data-reordering'), true)
    assert.equal(v.root.captured, 1, 'the root holds the pointer: no draw moves it')
    assert.equal(card.style.getPropertyValue('transform'), 'translate(0px, 10px)')

    // Past the middle of Alpha (110–210), then of Beta (220–320 once Alpha has moved up).
    pointer(v.root, 'pointermove', { x: 150, y: 150 })
    assert.deepEqual(ids(v.root), ['local', 'env-a', 'env-b', 'env-c'], 'over Alpha, short of its middle')
    pointer(v.root, 'pointermove', { x: 150, y: 170 })
    assert.deepEqual(ids(v.root), ['env-a', 'local', 'env-b', 'env-c'], 'past it')
    pointer(v.root, 'pointermove', { x: 150, y: 280 })
    assert.deepEqual(ids(v.root), ['env-a', 'env-b', 'local', 'env-c'])
    assert.equal(card.style.getPropertyValue('transform'), 'translate(0px, 10px)', 'still under the pointer in its new place')
    assert.deepEqual(v.store.saves, [], 'nothing kept until it is dropped')

    pointer(v.root, 'pointerup', { x: 150, y: 280 })
    card.dispatchEvent({ type: 'click', target: card, detail: 1 })
    assert.equal(opened(v.root), false, 'the release is not a press')
    assert.deepEqual(v.store.saves, [['env-a', 'env-b', 'local', 'env-c']])
    assert.equal(card.hasAttribute('data-dragging'), false)
    assert.equal(card.style.getPropertyValue('transform'), '', 'back in its place')
    assert.equal(v.root.hasAttribute('data-reordering'), false)
    assert.equal(v.root.captured, null)
    assert.equal(v.root.querySelector('[data-key="order-status"]')!.textContent, 'This desk, place 3 of 4')

    // The next press opens it as before.
    pointer(card, 'pointerdown', { x: 150, y: 270 })
    pointer(v.root, 'pointerup', { x: 150, y: 270 })
    card.dispatchEvent({ type: 'click', target: card, detail: 1 })
    assert.equal(opened(v.root), true)
  })

  test('a drag down and back again keeps nothing', () => {
    column()
    const v = mount(viewOf(FLEET))
    drag(v.root, 'env-a', { x: 150, y: 290 }, { release: false })
    assert.deepEqual(ids(v.root), ['local', 'env-b', 'env-a', 'env-c'])
    pointer(v.root, 'pointermove', { x: 150, y: 150 })
    pointer(v.root, 'pointermove', { x: 150, y: 100 })
    assert.deepEqual(ids(v.root), ['local', 'env-a', 'env-b', 'env-c'])
    pointer(v.root, 'pointerup', { x: 150, y: 100 })
    assert.deepEqual(v.store.saves, [], 'put back where it was')
  })

  test('Escape, a lost pointer and the window losing focus put the card back', () => {
    column()
    const v = mount(viewOf(FLEET))
    drag(v.root, 'local', { x: 150, y: 400 }, { release: false })
    assert.deepEqual(ids(v.root), ['env-a', 'env-b', 'env-c', 'local'])
    const escape = {
      type: 'keydown',
      target: v.root,
      key: 'Escape',
      prevented: false,
      preventDefault: () => {
        escape.prevented = true
      }
    }
    v.root.dispatchEvent(escape)
    assert.equal(escape.prevented, true)
    assert.deepEqual(ids(v.root), ['local', 'env-a', 'env-b', 'env-c'])
    pointer(v.root, 'pointerup', { x: 150, y: 400 })
    const card = cardOf(v.root, 'local')
    card.dispatchEvent({ type: 'click', target: card, detail: 1 })
    assert.equal(opened(v.root), false, 'letting go after Escape does not open it')

    drag(v.root, 'local', { x: 150, y: 400 }, { release: false })
    pointer(v.root, 'pointercancel', { x: 150, y: 400 })
    assert.deepEqual(ids(v.root), ['local', 'env-a', 'env-b', 'env-c'])
    assert.deepEqual(v.store.saves, [])
  })

  test('a machine that leaves the fleet mid-drag calls the drag off', () => {
    column()
    const v = mount(viewOf(FLEET))
    drag(v.root, 'env-c', { x: 150, y: 20 }, { release: false })
    assert.deepEqual(ids(v.root), ['env-c', 'local', 'env-a', 'env-b'])
    v.push(viewOf(FLEET.filter((m) => m.id !== 'env-c'), { seq: 2 }))
    assert.deepEqual(ids(v.root), ['local', 'env-a', 'env-b'])
    assert.equal(v.root.hasAttribute('data-reordering'), false)
    pointer(v.root, 'pointerup', { x: 150, y: 20 })
    assert.deepEqual(v.store.saves, [])
  })

  test('a reading mid-drag keeps the lifted card where it is and under the pointer', () => {
    column()
    const v = mount(viewOf(FLEET))
    drag(v.root, 'local', { x: 160, y: 290 }, { release: false })
    const card = cardOf(v.root, 'local')
    const transform = card.style.getPropertyValue('transform')
    assert.notEqual(transform, '')
    v.push(viewOf(FLEET, { seq: 2 }))
    assert.deepEqual(ids(v.root), ['env-a', 'env-b', 'local', 'env-c'])
    assert.equal(card.hasAttribute('data-dragging'), true)
    assert.equal(card.style.getPropertyValue('transform'), transform, 'the draw took it away; the drag put it back')
  })

  test('only a plain primary press on a card, on the overview, with more than one machine', () => {
    column()
    const v = mount(viewOf(FLEET))
    const card = cardOf(v.root, 'local')
    for (const press of [{ button: 2 }, { ctrlKey: true }, { metaKey: true }, { isPrimary: false }]) {
      pointer(card, 'pointerdown', { x: 150, y: 50, ...press })
      pointer(v.root, 'pointermove', { x: 150, y: 300 })
      assert.equal(card.hasAttribute('data-dragging'), false, JSON.stringify(press))
      pointer(v.root, 'pointerup', { x: 150, y: 300 })
    }
    pointer(v.root.querySelector('[data-action="pair"]')!, 'pointerdown', { x: 5, y: 5 })
    pointer(v.root, 'pointermove', { x: 150, y: 300 })
    assert.equal(v.root.hasAttribute('data-reordering'), false, 'not a card')
    pointer(v.root, 'pointerup', { x: 150, y: 300 })
  })

  test('one machine alone has nothing to move among', () => {
    column()
    const one = mount(viewOf([FLEET[0]!]))
    const only = cardOf(one.root, 'local')
    assert.equal(only.getAttribute('aria-keyshortcuts'), null)
    pointer(only, 'pointerdown', { x: 150, y: 50 })
    pointer(one.root, 'pointermove', { x: 150, y: 300 })
    assert.equal(only.hasAttribute('data-dragging'), false, 'nothing to move it among')
  })

  test('a finger lifts a card after a short hold; a swipe before then scrolls', () => {
    column()
    const v = mount(viewOf(FLEET))
    const card = cardOf(v.root, 'local')
    pointer(card, 'pointerdown', { x: 150, y: 50, pointerType: 'touch' })
    pointer(v.root, 'pointermove', { x: 150, y: 80, pointerType: 'touch' })
    v.runTimers()
    assert.equal(card.hasAttribute('data-dragging'), false, 'a swipe')
    pointer(v.root, 'pointercancel', { x: 150, y: 80, pointerType: 'touch' })

    pointer(card, 'pointerdown', { x: 150, y: 50, pointerType: 'touch' })
    const menu = pointer(card, 'contextmenu')
    assert.equal(menu.prevented, true, 'no menu while it may lift')
    pointer(v.root, 'pointermove', { x: 152, y: 54, pointerType: 'touch' })
    assert.equal(card.hasAttribute('data-dragging'), false, 'not yet')
    v.runTimers()
    assert.equal(card.hasAttribute('data-dragging'), true, `lifted after ${TOUCH_HOLD_MS} ms`)
    const scroll = pointer(v.root, 'touchmove')
    assert.equal(scroll.prevented, true, 'the page holds still under the finger')
    pointer(v.root, 'pointermove', { x: 150, y: 280, pointerType: 'touch' })
    pointer(v.root, 'pointerup', { x: 150, y: 280, pointerType: 'touch' })
    assert.deepEqual(v.store.saves, [['env-a', 'env-b', 'local', 'env-c']])
    assert.equal(pointer(v.root, 'touchmove').prevented, false, 'scrolling again')
  })

  test('the kept order is drawn from the start; a machine paired since comes last', () => {
    const v = mount(viewOf(FLEET), memoryStore(['env-c', 'gone', 'local', 'env-a']))
    assert.deepEqual(ids(v.root), ['env-c', 'local', 'env-a', 'env-b'])
    v.store.save(['env-b', 'env-a'])
    v.store.changed?.()
    assert.deepEqual(ids(v.root), ['env-b', 'env-a', 'local', 'env-c'], 'another panel moved a card')
  })

  test('leaving for a machine calls a drag off and forgets what was said', () => {
    column()
    const v = mount(viewOf(FLEET))
    drag(v.root, 'local', { x: 150, y: 400 })
    assert.notEqual(v.root.querySelector('[data-key="order-status"]')!.textContent, '')
    v.handle.show('env-a')
    v.handle.show(null)
    assert.equal(v.root.querySelector('[data-key="order-status"]')!.textContent, '')
  })
})

describe('moving a card from the keyboard', () => {
  function key(target: FakeElement, name: string, mods: Partial<FakeEvent> = {}) {
    const event = {
      type: 'keydown',
      target,
      key: name,
      prevented: false,
      preventDefault: () => {
        event.prevented = true
      },
      ...mods
    }
    target.dispatchEvent(event)
    return event
  }

  test('Alt and an arrow key move the focused card one place, kept and said; focus stays on it', () => {
    const v = mount(viewOf(FLEET))
    const card = cardOf(v.root, 'env-a')
    card.focus()
    const down = key(card, 'ArrowDown', { altKey: true })
    assert.equal(down.prevented, true)
    assert.deepEqual(ids(v.root), ['local', 'env-b', 'env-a', 'env-c'])
    assert.deepEqual(v.store.saves, [['local', 'env-b', 'env-a', 'env-c']])
    assert.equal(v.root.querySelector('[data-key="order-status"]')!.textContent, 'Alpha, place 3 of 4')
    assert.equal(dom.document.activeElement, cardOf(v.root, 'env-a'))
    key(card, 'ArrowRight', { altKey: true })
    assert.deepEqual(ids(v.root), ['local', 'env-b', 'env-c', 'env-a'])
    key(card, 'ArrowDown', { altKey: true })
    assert.equal(v.store.saves.length, 2, 'already last')
    key(card, 'ArrowLeft', { altKey: true })
    key(card, 'ArrowUp', { altKey: true })
    key(card, 'ArrowUp', { altKey: true })
    key(card, 'ArrowUp', { altKey: true })
    assert.deepEqual(ids(v.root), ['env-a', 'local', 'env-b', 'env-c'])
    assert.equal(v.store.saves.length, 5, 'already first')
  })

  test('without Alt, or with another modifier, arrows leave the order alone', () => {
    const v = mount(viewOf(FLEET))
    const card = cardOf(v.root, 'env-a')
    for (const mods of [{}, { altKey: true, shiftKey: true }, { altKey: true, metaKey: true }, { altKey: true, ctrlKey: true }]) {
      assert.equal(key(card, 'ArrowDown', mods).prevented, false)
    }
    assert.equal(key(v.root.querySelector('[data-action="pair"]')!, 'ArrowDown', { altKey: true }).prevented, false, 'not a card')
    assert.deepEqual(ids(v.root), ['local', 'env-a', 'env-b', 'env-c'])
    assert.deepEqual(v.store.saves, [])
  })

  test('a click from the keyboard after a drag still opens the card', () => {
    column()
    const v = mount(viewOf(FLEET))
    drag(v.root, 'local', { x: 150, y: 400 })
    const card = cardOf(v.root, 'local')
    card.dispatchEvent({ type: 'click', target: card, detail: 0 })
    assert.equal(opened(v.root), true)
  })
})

describe('around a drag', () => {
  type FakeWindow = Record<string, unknown> & { scrollY: number }

  test('near the bottom of the panel a dragged card scrolls it, until there is no more to scroll', () => {
    column()
    const win = (globalThis as unknown as { window: FakeWindow }).window
    const scrolls: number[] = []
    win.innerHeight = 300
    win.scrollBy = ({ top }: { top: number }) => {
      scrolls.push(top)
      win.scrollY = Math.min(40, win.scrollY + top)
    }
    const frames: (() => void)[] = []
    const v = mount(viewOf(FLEET), memoryStore(), { frame: (fn) => frames.push(fn) })
    drag(v.root, 'local', { x: 150, y: 290 }, { release: false })
    // 38 px into the bottom 48: about 0.8 of the most, 14 px a 60 Hz frame.
    assert.deepEqual(scrolls, [12], 'down, the closer the faster')
    ;(frames.shift() as (at?: number) => void)(1_000)
    ;(frames.shift() as (at?: number) => void)(1_008)
    assert.deepEqual(scrolls, [12, 12, 6], 'by time, not by frame: half as far in a frame half as long')
    for (let i = 0; i < 20 && frames.length > 0; i += 1) frames.shift()!()
    assert.equal(win.scrollY, 40)
    assert.equal(frames.length, 0, 'at the end it stops asking for frames')
    pointer(v.root, 'pointerup', { x: 150, y: 290 })
  })

  test('a dropped card settles from under the pointer into its place, unless motion is unwelcome', () => {
    column()
    const proto = Object.getPrototypeOf(dom.root) as Record<string, unknown>
    const settles: { id: string | null; from: string }[] = []
    proto.animate = function (this: FakeElement, keyframes: { transform: string }[]) {
      settles.push({ id: this.getAttribute('data-id'), from: keyframes[0]!.transform })
      return {}
    }
    try {
      const v = mount(viewOf(FLEET), memoryStore(), { frame: () => 0, reducedMotion: () => false })
      drag(v.root, 'local', { x: 160, y: 290 })
      assert.deepEqual(settles, [{ id: 'local', from: 'translate(10px, 20px)' }])
      dom.restore()
      dom = installFakeDom()
      column()
      const still = mount(viewOf(FLEET), memoryStore(), { frame: () => 0, reducedMotion: () => true })
      drag(still.root, 'local', { x: 160, y: 290 })
      assert.equal(settles.length, 1, 'reduced motion: it is in its place at once')
    } finally {
      delete proto.animate
    }
  })

  test('the window losing focus calls a drag off; disposing the panel stops listening', () => {
    column()
    const win = (globalThis as unknown as { window: FakeWindow }).window
    const listeners = new Map<string, () => void>()
    win.addEventListener = (type: string, fn: () => void) => void listeners.set(type, fn)
    win.removeEventListener = (type: string) => void listeners.delete(type)
    const v = mount(viewOf(FLEET))
    drag(v.root, 'local', { x: 150, y: 400 }, { release: false })
    assert.deepEqual(ids(v.root), ['env-a', 'env-b', 'env-c', 'local'])
    listeners.get('scroll')?.()
    listeners.get('blur')?.()
    assert.deepEqual(ids(v.root), ['local', 'env-a', 'env-b', 'env-c'])
    assert.deepEqual(v.store.saves, [])
    v.handle.dispose()
    assert.equal(listeners.size, 0)
    assert.equal(v.store.changed, null)
    drag(v.root, 'local', { x: 150, y: 400 })
    assert.deepEqual(v.store.saves, [], 'nothing drags once it is gone')
  })
})

describe('fixes from the review of the first version', () => {
  type FakeWindow = Record<string, unknown> & { scrollY: number }
  const win = () => (globalThis as unknown as { window: FakeWindow }).window

  test('a card that changes place never moves the page (Chromium scrolls to a moved, focused card)', () => {
    column()
    const w = win()
    w.scrollY = 50
    w.scrollTo = (_x: number, y: number) => {
      w.scrollY = y
    }
    const proto = Object.getPrototypeOf(dom.root) as { insertBefore: (node: unknown, ref: unknown) => unknown }
    const insert = proto.insertBefore
    proto.insertBefore = function (this: FakeElement, node: unknown, ref: unknown) {
      // What the browser does when a focused card is moved, or a card anchoring the scroll moves.
      if ((node as FakeElement).getAttribute?.('data-action') === 'open' && (node as FakeElement).parentNode === this) w.scrollY += 44
      return insert.call(this, node, ref)
    }
    try {
      const v = mount(viewOf(FLEET))
      const card = cardOf(v.root, 'env-a')
      card.focus()
      card.dispatchEvent({ type: 'keydown', target: card, key: 'ArrowDown', altKey: true, preventDefault: () => {} })
      assert.deepEqual(ids(v.root), ['local', 'env-b', 'env-a', 'env-c'])
      assert.equal(w.scrollY, 50, 'from the keyboard')
      drag(v.root, 'env-c', { x: 150, y: 20 })
      assert.deepEqual(ids(v.root)[0], 'env-c')
      assert.equal(w.scrollY, 50, 'by drag')
    } finally {
      proto.insertBefore = insert
    }
  })

  test('a card moved from the keyboard is scrolled into view, clear of the header', () => {
    column()
    const w = win()
    const scrolls: number[] = []
    w.innerHeight = 300
    w.scrollBy = ({ top }: { top: number }) => void scrolls.push(top)
    const v = mount(viewOf(FLEET))
    const card = cardOf(v.root, 'env-b')
    card.focus()
    card.dispatchEvent({ type: 'keydown', target: card, key: 'ArrowDown', altKey: true, preventDefault: () => {} })
    // Now last: 330–430 in a 300 px panel, with 8 px to spare.
    assert.deepEqual(scrolls, [138])
    // Scrolled down 300, the grid starts above the panel: the first place is under the header.
    const grid = v.root.querySelector('.fm-grid') as FakeElement & { getBoundingClientRect?: () => unknown }
    const header = v.root.querySelector('.fm-top') as FakeElement & { getBoundingClientRect?: () => unknown }
    grid.getBoundingClientRect = () => ({ top: -300, bottom: 130, left: 0 })
    header.getBoundingClientRect = () => ({ top: 0, bottom: 51, left: 0 })
    const first = cardOf(v.root, 'env-a')
    first.dispatchEvent({ type: 'keydown', target: first, key: 'ArrowUp', altKey: true, preventDefault: () => {} })
    assert.deepEqual(ids(v.root)[0], 'env-a')
    assert.deepEqual(scrolls, [138, -359], 'up to 8 px under the header')
  })

  test('a drag called off settles back from where the card was on screen, not from its old place', () => {
    column()
    const proto = Object.getPrototypeOf(dom.root) as Record<string, unknown>
    const settles: string[] = []
    proto.animate = function (this: FakeElement, keyframes: { transform: string }[]) {
      settles.push(keyframes[0]!.transform)
      return {}
    }
    try {
      const v = mount(viewOf(FLEET), memoryStore(), { frame: () => 0, reducedMotion: () => false })
      // Lifted to the third place (220), 20 px below it under the pointer, then Escape: home is 0.
      drag(v.root, 'local', { x: 150, y: 290 }, { release: false })
      assert.deepEqual(ids(v.root), ['env-a', 'env-b', 'local', 'env-c'])
      v.root.dispatchEvent({ type: 'keydown', target: v.root, key: 'Escape', preventDefault: () => {} })
      assert.deepEqual(settles, ['translate(0px, 240px)'])
    } finally {
      delete proto.animate
    }
  })

  test('a mouse that moves with no button held has let go: a press is dropped, a drag ends there', () => {
    column()
    const v = mount(viewOf(FLEET))
    const card = cardOf(v.root, 'local')
    pointer(card, 'pointerdown', { x: 150, y: 50, buttons: 1 })
    pointer(v.root, 'pointermove', { x: 150, y: 300, buttons: 0 })
    assert.equal(card.hasAttribute('data-dragging'), false)
    drag(v.root, 'local', { x: 150, y: 290 }, { release: false })
    assert.equal(card.hasAttribute('data-dragging'), true)
    pointer(v.root, 'pointermove', { x: 150, y: 290, buttons: 0 })
    assert.equal(card.hasAttribute('data-dragging'), false)
    assert.deepEqual(v.store.saves, [['env-a', 'env-b', 'local', 'env-c']])
    pointer(card, 'pointerdown', { x: 150, y: 250, pointerType: 'touch', buttons: 0 })
    pointer(v.root, 'pointermove', { x: 150, y: 252, pointerType: 'touch', buttons: 0 })
    v.runTimers()
    assert.equal(card.hasAttribute('data-dragging'), true, 'a finger reports no buttons while it holds')
  })

  test('the place said is counted among the cards as they stand when it is dropped', () => {
    column()
    const v = mount(viewOf(FLEET))
    drag(v.root, 'local', { x: 150, y: 290 }, { release: false })
    v.push(viewOf(FLEET.filter((m) => m.id !== 'env-c'), { seq: 2 }))
    pointer(v.root, 'pointerup', { x: 150, y: 290 })
    assert.equal(v.root.querySelector('[data-key="order-status"]')!.textContent, 'This desk, place 3 of 3')
  })
})
