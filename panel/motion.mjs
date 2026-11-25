// Motion besides the charts (chart-view.mjs): a figure counts to its new reading rather than
// jumping, and a row that changes place (a workspace or a process re-sorted, a machine's card
// moved in the overview's grid) slides there.
//
// Both work around morphing: measure() runs before a draw and settle() after it. Morphing writes
// every figure's final text; a figure still counting is written over on the next frame, so a
// redraw never shows it out of step. Nothing moves without `frame` (requestAnimationFrame), or
// while `motion()` is false (reduced motion), or while the panel is hidden.
import { easeOut } from './charts.mjs'

/** How long a figure takes to count to a new reading, and a row to slide to its new place. */
export const COUNT_MS = 400
export const SLIDE_MS = 280
/** More rows than this on screen (a long process list, "Show all"): none slides, so a draw never
 *  measures hundreds of rows or sets most of a list moving at once. */
export const MAX_SLIDING = 60

export function createMotion({ frame = null, clock = () => Date.now(), motion = () => false, hidden = () => false } = {}) {
  /** Figure element → the value on screen. */
  const shown = new WeakMap()
  /** Figures counting: element → { from, to, t0 }. */
  const counting = new Map()
  let scheduled = false
  /** Rows' places before this draw: data-key → { left, top }. */
  let before = null

  const canMove = () => typeof frame === 'function' && motion() && !hidden()

  function schedule() {
    if (scheduled || counting.size === 0) return
    scheduled = true
    frame(tick)
  }

  /** A count still owns its figure only while the figure is connected and still heading for the
   *  value the count is heading for: an unknown reading (no data-num, "–") or a new one ends it. */
  const owns = (el, c) => el.isConnected && el.getAttribute('data-num') === String(c.to)

  function tick() {
    scheduled = false
    const on = canMove()
    const now = clock()
    for (const [el, c] of counting) {
      if (!owns(el, c)) {
        counting.delete(el)
        continue
      }
      if (!on) {
        // Motion was turned off mid-count: the figure is the reading, at once.
        shown.set(el, c.to)
        el.textContent = String(c.to)
        counting.delete(el)
        continue
      }
      const k = (now - c.t0) / COUNT_MS
      const value = k >= 1 ? c.to : c.from + (c.to - c.from) * easeOut(k)
      shown.set(el, value)
      const text = String(Math.round(value))
      if (el.textContent !== text) el.textContent = text
      if (k >= 1) counting.delete(el)
    }
    schedule()
  }

  return {
    /** Before a draw: where each sliding row is. */
    measure(root) {
      before = null
      if (!canMove()) return
      const rows = root.querySelectorAll('[data-flip]')
      if (rows.length > MAX_SLIDING) return
      for (const el of rows) {
        const key = el.getAttribute('data-key')
        if (key === null || typeof el.getBoundingClientRect !== 'function') continue
        before ??= new Map()
        const { left, top } = el.getBoundingClientRect()
        before.set(key, { left, top })
      }
    },
    /** After a draw: figures count from what was on screen, and rows slide from where they were.
     *  `moved` is false when the draw changed screens, where nothing should slide. */
    settle(root, { moved = true } = {}) {
      const on = canMove()
      const now = clock()
      // A figure whose reading became unknown (or that left the page) is no longer counted.
      for (const el of counting.keys()) {
        if (!el.isConnected || el.getAttribute('data-num') === null) {
          counting.delete(el)
          shown.delete(el)
        }
      }
      for (const el of root.querySelectorAll('[data-num]')) {
        const to = Number(el.getAttribute('data-num'))
        const going = counting.get(el)
        const was = shown.get(el)
        if (going && going.to === to) {
          // Still on its way there: morphing just wrote the final text; the next frame writes over it.
          continue
        }
        if (on && Number.isFinite(was) && Number.isFinite(to) && Math.round(was) !== Math.round(to)) {
          counting.set(el, { from: was, to, t0: now })
          el.textContent = String(Math.round(was))
        } else {
          counting.delete(el)
          shown.set(el, to)
        }
      }
      schedule()
      const places = before
      before = null
      if (!places || !moved || !on) return
      for (const el of root.querySelectorAll('[data-flip]')) {
        const from = places.get(el.getAttribute('data-key'))
        if (from === undefined || typeof el.animate !== 'function') continue
        const now = el.getBoundingClientRect()
        const dx = from.left - now.left
        const dy = from.top - now.top
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue
        // A row in a list moves only up or down; a card in a grid may change column too.
        const transform = Math.abs(dx) < 1 ? `translateY(${dy}px)` : `translate(${dx}px, ${dy}px)`
        el.animate([{ transform }, { transform: 'none' }], { duration: SLIDE_MS, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' })
      }
    },
    /** Figures counting, for tests. */
    counting: () => counting.size
  }
}
