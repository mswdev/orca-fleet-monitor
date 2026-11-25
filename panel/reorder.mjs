// The overview's own order of machines. A card is dragged to a new place (a mouse or a pen moves
// it at once, a finger after a short press, so a swipe still scrolls), or moved with Alt and an
// arrow key while it has focus. Nothing turns it on: before anyone moves a card the overview keeps
// the worker's order (this computer first, then by name), and machines the saved order does not
// name (paired since) follow the ones it does.
//
// The order is this frame's to keep: localStorage, which Orca's desktop app gives each plugin's
// frames in a partition of their own that lasts across updates. Where a frame has no storage of
// its own (Orca's browser and mobile clients), it lasts until the panel closes.

/** Where the order is kept. */
export const ORDER_KEY = 'fleet-monitor.order'
/** More ids than any fleet has, and longer than any id: a stored value past these is cut. */
const MAX_IDS = 500
const MAX_ID_LENGTH = 512

/** How far a mouse or pen moves before a press becomes a drag (a shorter move is still a click). */
export const DRAG_PX = 5
/** How long a finger rests on a card before it lifts, and how far it may stray meanwhile. */
export const TOUCH_HOLD_MS = 350
export const TOUCH_SLOP_PX = 10
/** How close to the top or bottom of the panel a dragged card scrolls it, and how fast at most:
 *  per millisecond, so a 120 Hz display scrolls no faster than a 60 Hz one (about 840 px/s). */
const EDGE_PX = 48
const SCROLL_PX_PER_MS = 14 / 16.7
/** The room a card moved from the keyboard keeps from the header and from the panel's foot. */
export const REVEAL_PX = 8
/** How long a dropped card takes to settle into its place. */
export const DROP_MS = 180

/** Ids only, as stored: strings, no repeats, within bounds. */
function cleanIds(value) {
  if (!Array.isArray(value)) return []
  const out = []
  const seen = new Set()
  for (const id of value) {
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LENGTH || seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= MAX_IDS) break
  }
  return out
}

/** `machines` (anything with an `id`) in `order`; those it does not name follow, as they came. */
export function inOrder(machines, order) {
  if (!Array.isArray(order) || order.length === 0) return machines
  const rank = new Map(order.map((id, i) => [id, i]))
  const named = machines.filter((m) => rank.has(m.id)).sort((a, b) => rank.get(a.id) - rank.get(b.id))
  return [...named, ...machines.filter((m) => !rank.has(m.id))]
}

/** `ids` with `id` taken out and put back at index `to`. */
export function moved(ids, id, to) {
  const rest = ids.filter((x) => x !== id)
  const at = Math.max(0, Math.min(rest.length, to))
  return [...rest.slice(0, at), id, ...rest.slice(at)]
}

/** The order to keep: the cards as they now stand, then machines saved before that are not on
 *  screen now (unpaired for a while), so they come back where they were last. */
export function mergeOrder(shown, saved) {
  const here = new Set(shown)
  return cleanIds([...shown, ...(saved ?? []).filter((id) => !here.has(id))])
}

function frameStorage() {
  try {
    // Reading the property throws in a frame with an opaque origin. The window's, not a global:
    // Node's own (in tests) warns when read.
    return globalThis.window?.localStorage ?? null
  } catch {
    return null
  }
}

/** The kept order: `load()` is null when nothing was kept. A frame whose storage refuses keeps it
 *  in memory instead, for as long as the panel is open. */
export function createOrderStore(storage = frameStorage()) {
  let memory = null
  return {
    load() {
      try {
        const raw = storage?.getItem(ORDER_KEY)
        if (typeof raw === 'string') return cleanIds(JSON.parse(raw))
      } catch {
        // Unreadable or refused: what this panel kept, if anything.
      }
      return memory
    },
    save(ids) {
      memory = cleanIds(ids)
      try {
        storage?.setItem(ORDER_KEY, JSON.stringify(memory))
      } catch {
        // Refused (no storage here, or full): kept in memory.
      }
    },
    /** Another Fleet Monitor panel (another window) changed the order. */
    onChange(listener) {
      const target = globalThis.window
      if (!storage || typeof target?.addEventListener !== 'function') return () => {}
      const handler = (event) => {
        if (event.key === ORDER_KEY || event.key === null) listener()
      }
      target.addEventListener('storage', handler)
      return () => target.removeEventListener?.('storage', handler)
    }
  }
}

const num = (value) => (Number.isFinite(value) ? value : 0)

/** A card's place in the grid's layout, which a transform (its own, or a neighbour's slide) does
 *  not change: the grid is the cards' offset parent. */
function box(el) {
  return { x: num(el.offsetLeft), y: num(el.offsetTop), w: num(el.offsetWidth), h: num(el.offsetHeight) }
}

/** Where an element is in the panel's window, or 0s where that cannot be told (no layout). */
function rectOf(el) {
  const r = typeof el?.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null
  return { top: num(r?.top), bottom: num(r?.bottom), left: num(r?.left) }
}

/**
 * Scrolls the panel just enough that `card` (moved from the keyboard) is in view, clear of the
 * sticky header. Measured from the card's place in the layout, not from where a slide has it now.
 */
export function revealCard(root, card, win = globalThis.window) {
  const height = num(win?.innerHeight)
  if (!card || height <= 0 || typeof win?.scrollBy !== 'function') return
  const above = rectOf(root.querySelector('.fm-top')).bottom
  const top = rectOf(root.querySelector('.fm-grid')).top + box(card).y
  const bottom = top + box(card).h
  let by = 0
  if (top < above + REVEAL_PX) by = top - above - REVEAL_PX
  // Its top stays in view however tall it is.
  else if (bottom > height - REVEAL_PX) by = Math.min(bottom - height + REVEAL_PX, top - above - REVEAL_PX)
  if (by !== 0) win.scrollBy({ top: by, behavior: 'instant' })
}

/**
 * The index the dragged card should move to with the pointer at `p` (grid coordinates): that of
 * the card under the pointer, once the pointer is past its middle in the direction of travel
 * (across, within a row; down or up, between rows). Short of the middle, or off every card, the
 * dragged card stays: past the middle, the swap leaves the pointer over the dragged card, so cards
 * of different heights never trade back and forth.
 */
export function targetIndex(cards, dragged, p) {
  const from = cards.indexOf(dragged)
  if (from < 0) return -1
  const home = box(dragged)
  for (let j = 0; j < cards.length; j += 1) {
    if (j === from) continue
    const r = box(cards[j])
    if (p.x < r.x || p.x > r.x + r.w || p.y < r.y || p.y > r.y + r.h) continue
    const sameRow = Math.abs(r.y - home.y) < 1
    const mid = sameRow ? r.x + r.w / 2 : r.y + r.h / 2
    const at = sameRow ? p.x : p.y
    return (j > from ? at > mid : at < mid) ? j : from
  }
  return from
}

/**
 * Drags the overview's cards. The view keeps the order and draws it; this follows the pointer:
 * `begin(id)` when a card lifts, `move(ids)` each time it should take another place, `end(commit)`
 * when it is dropped (`true`) or the drag is called off (`false`: Escape, a lost pointer, the
 * window losing focus). `sync()` runs after every draw, which puts the lifted card back under the
 * pointer (a draw rewrites its attributes).
 */
export function createCardDrag({
  root,
  doc = root.ownerDocument,
  win = globalThis.window,
  canDrag = () => true,
  begin = () => {},
  move = () => {},
  end = () => {},
  later = setTimeout,
  frame = null,
  motion = () => false
}) {
  /** A press that may become a drag: { id, pointerId, touch, x, y, token }. */
  let press = null
  /** The drag: { id, pointerId, grab: {x, y}, x, y, offset: {x, y} }. */
  let drag = null
  /** A drag just ended: the click its release makes must not open the card. */
  let swallow = false
  let scrolling = false

  const grid = () => root.querySelector('.fm-grid')
  const cards = () => [...root.querySelectorAll('.fm-grid [data-action="open"][data-id]')]
  const cardOf = (id) => cards().find((c) => c.getAttribute('data-id') === id) ?? null

  /** The pointer in the grid's coordinates (the page may have scrolled since it moved). */
  function local(x, y) {
    const g = grid()
    const r = typeof g?.getBoundingClientRect === 'function' ? g.getBoundingClientRect() : { left: 0, top: 0 }
    return { x: x - r.left, y: y - r.top }
  }

  /** Puts the lifted card under the pointer, wherever the layout has its place now. It stays
   *  within the grid: past its edge it would widen the page, or lengthen it as it scrolls. */
  function follow() {
    if (!drag) return
    const card = cardOf(drag.id)
    if (!card) return
    const p = local(drag.x, drag.y)
    const home = box(card)
    const g = box(grid() ?? card)
    const within = (value, size, room) => (room > 0 ? Math.max(0, Math.min(Math.max(0, room - size), value)) : value)
    const x = within(p.x - drag.grab.x, home.w, g.w)
    const y = within(p.y - drag.grab.y, home.h, g.h)
    drag.offset = { x: x - home.x, y: y - home.y }
    card.style.setProperty('transform', `translate(${drag.offset.x}px, ${drag.offset.y}px)`)
  }

  /** Moves the lifted card to the place under the pointer, if that is another one. */
  function track() {
    if (!drag) return
    const all = cards()
    const card = all.find((c) => c.getAttribute('data-id') === drag.id)
    if (!card) return
    const to = targetIndex(all, card, local(drag.x, drag.y))
    const from = all.indexOf(card)
    if (to >= 0 && to !== from) {
      move(moved(all.map((c) => c.getAttribute('data-id')), drag.id, to))
    }
    follow()
  }

  function start(id, pointerId, x, y) {
    const card = cardOf(id)
    if (!card) return
    const home = box(card)
    const p = local(press.x, press.y)
    drag = { id, pointerId, grab: { x: p.x - home.x, y: p.y - home.y }, x, y, offset: { x: 0, y: 0 } }
    press = null
    try {
      // The root, which no draw moves: a card that changes place could lose the capture.
      root.setPointerCapture?.(pointerId)
    } catch {
      // Not capturable (the pointer is already gone): moves still bubble from where it is.
    }
    root.dataset.reordering = ''
    begin(id)
    follow()
  }

  function finish(commit) {
    if (!drag) {
      press = null
      return
    }
    const { id, pointerId, offset } = drag
    // Where the card is on screen now: its place in the layout, and the pointer's offset from it.
    const lifted = cardOf(id)
    const from = lifted ? box(lifted) : null
    drag = null
    scrolling = false
    // Until the next press: the click the release makes is the only one in between.
    swallow = true
    delete root.dataset.reordering
    try {
      root.releasePointerCapture?.(pointerId)
    } catch {
      // Released already.
    }
    end(commit)
    // The draw just took the card's transform away and put it in its place: dropped, the one it
    // took; called off, the one it had. It settles there from where it was on screen.
    const card = cardOf(id)
    const to = card ? box(card) : null
    const dx = from && to ? from.x + offset.x - to.x : 0
    const dy = from && to ? from.y + offset.y - to.y : 0
    if (card && typeof card.animate === 'function' && motion() && (dx !== 0 || dy !== 0)) {
      card.animate([{ transform: `translate(${dx}px, ${dy}px)`, zIndex: 1 }, { transform: 'none', zIndex: 1 }], {
        duration: DROP_MS,
        easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)'
      })
    }
  }

  /** The frame time edgeScroll last ran at, for a step that follows time rather than frames. */
  let scrolledAt = null

  /** Near the top or bottom of the panel, a dragged card scrolls it, faster the closer it is.
   *  `at` is the frame's time; the first step, from a pointer move, has none. */
  function edgeScroll(at) {
    if (!drag || typeof frame !== 'function' || typeof win?.scrollBy !== 'function') {
      scrolling = false
      scrolledAt = null
      return
    }
    const elapsed = Number.isFinite(at) && scrolledAt !== null ? Math.max(0, Math.min(50, at - scrolledAt)) : 16.7
    scrolledAt = Number.isFinite(at) ? at : null
    const most = SCROLL_PX_PER_MS * elapsed
    const height = num(win.innerHeight)
    const topEdge = rectOf(root.querySelector('.fm-top')).bottom + EDGE_PX
    const bottomEdge = height - EDGE_PX
    let by = 0
    if (drag.y < topEdge) by = -Math.ceil(Math.min(1, (topEdge - drag.y) / EDGE_PX) * most)
    else if (height > 0 && drag.y > bottomEdge) by = Math.ceil(Math.min(1, (drag.y - bottomEdge) / EDGE_PX) * most)
    if (by === 0) {
      scrolling = false
      scrolledAt = null
      return
    }
    const before = win.scrollY
    win.scrollBy({ top: by, behavior: 'instant' })
    if (win.scrollY === before) {
      // At the end already.
      scrolling = false
      scrolledAt = null
      return
    }
    track()
    frame(edgeScroll)
  }

  function onPointerDown(event) {
    swallow = false
    if (drag || !event.isPrimary || event.button !== 0 || event.ctrlKey || event.metaKey) return
    const card = event.target instanceof Element ? event.target.closest('.fm-grid [data-action="open"][data-id]') : null
    if (!card || !root.contains(card) || !canDrag()) return
    const touch = event.pointerType === 'touch'
    const token = {}
    press = { id: card.getAttribute('data-id'), pointerId: event.pointerId, touch, x: event.clientX, y: event.clientY, token }
    if (touch) {
      later(() => {
        if (press?.token === token && canDrag()) start(press.id, press.pointerId, press.x, press.y)
      }, TOUCH_HOLD_MS)
    }
  }

  function onPointerMove(event) {
    // A mouse moving with no button held: the release was missed (it happened outside the panel).
    const released = event.pointerType === 'mouse' && event.buttons === 0
    if (drag) {
      if (event.pointerId !== drag.pointerId) return
      if (released) {
        finish(true)
        return
      }
      drag.x = event.clientX
      drag.y = event.clientY
      track()
      if (!scrolling) {
        scrolling = true
        edgeScroll()
      }
      return
    }
    if (!press || event.pointerId !== press.pointerId) return
    if (released) {
      press = null
      return
    }
    const far = Math.hypot(event.clientX - press.x, event.clientY - press.y)
    if (press.touch) {
      // Moved before the hold: a swipe, which scrolls.
      if (far > TOUCH_SLOP_PX) press = null
      return
    }
    if (far >= DRAG_PX) {
      if (!canDrag()) {
        press = null
        return
      }
      start(press.id, press.pointerId, event.clientX, event.clientY)
      track()
    }
  }

  function onPointerUp(event) {
    if (drag && event.pointerId === drag.pointerId) finish(true)
    else if (press && event.pointerId === press.pointerId) press = null
  }

  function onPointerCancel(event) {
    if (drag && event.pointerId === drag.pointerId) finish(false)
    else if (press && event.pointerId === press.pointerId) press = null
  }

  /** A lifted card holds the page still under a finger: the move is the card's, not a scroll. */
  function onTouchMove(event) {
    if (drag) event.preventDefault?.()
  }

  /** A long press is a right-click on some touch screens: not while it lifts a card. */
  function onContextMenu(event) {
    if (drag || swallow || press?.touch) event.preventDefault?.()
  }

  function onDragStart(event) {
    const target = event.target instanceof Element ? event.target : null
    if (target?.closest('.fm-grid')) event.preventDefault?.()
  }

  const onBlur = () => finish(false)
  const onScroll = () => {
    if (drag) track()
  }

  root.addEventListener('pointerdown', onPointerDown)
  root.addEventListener('contextmenu', onContextMenu)
  root.addEventListener('dragstart', onDragStart)
  doc.addEventListener('pointermove', onPointerMove)
  doc.addEventListener('pointerup', onPointerUp)
  doc.addEventListener('pointercancel', onPointerCancel)
  doc.addEventListener('touchmove', onTouchMove, { passive: false })
  win?.addEventListener?.('blur', onBlur)
  win?.addEventListener?.('scroll', onScroll, { passive: true })

  return {
    /** The id of the lifted card, or null. */
    dragging: () => drag?.id ?? null,
    /** After a draw: the lifted card back under the pointer, or the drag called off when its
     *  card is gone (the machine left the fleet, or the screen changed). */
    sync() {
      if (!drag) return
      if (!cardOf(drag.id)) finish(false)
      else follow()
    },
    /** True for the click a drag's release makes (or a release after Escape called the drag off),
     *  which must not open the card. A click from the keyboard (`detail` 0) is never one. */
    consumeClick(event) {
      if (!swallow || event?.detail === 0) return false
      swallow = false
      return true
    },
    /** Escape: calls a drag off. True when there was one. */
    cancel() {
      if (!drag) return false
      finish(false)
      return true
    },
    dispose() {
      press = null
      if (drag) finish(false)
      root.removeEventListener('pointerdown', onPointerDown)
      root.removeEventListener('contextmenu', onContextMenu)
      root.removeEventListener('dragstart', onDragStart)
      doc.removeEventListener('pointermove', onPointerMove)
      doc.removeEventListener('pointerup', onPointerUp)
      doc.removeEventListener('pointercancel', onPointerCancel)
      doc.removeEventListener('touchmove', onTouchMove)
      win?.removeEventListener?.('blur', onBlur)
      win?.removeEventListener?.('scroll', onScroll)
    }
  }
}
