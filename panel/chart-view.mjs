// The panel's charts, as islands (dom.mjs ISLAND). view.mjs and activity.mjs draw a placeholder with
// chartSlot(); morphing keeps it and leaves its inside alone; after each draw, sync() draws every
// chart from its spec, or moves it there. A chart owns its inside so that it can glide from one
// reading to the next instead of jumping, and keep a hover or keyboard focus across redraws.
//
// Spec = {
//   kind: 'detail' | 'spark'
//   frame: Frame                    // charts.mjs frameOf(): the line, values 0..100
//   second?: Frame | null           // spark only: a second line (upload), muted, with no fill
//   rule: [{ level, at }] | null    // each part of the line takes the colour of its level, and a
//                                   // detail chart draws a band per level; null: one colour (tone)
//   label: string | null            // the chart's accessible name; null hides it from screen readers
//   peak?: { t, v } | null          // detail: the window's highest reading, marked where it was
//   range?: boolean                 // detail: a band from each minute's lowest reading to its highest
//   scrub?: string | null           // detail: the name of a slider that reads one minute at a time
// }
//
// Text from other machines never reaches a chart: specs hold numbers and the panel's own words.
import { areaPath, easeOut, levelOf, levelStops, linePath, placeFrame, rangePath, tweenFrame, yOf } from './charts.mjs'
import { h, ISLAND, s } from './dom.mjs'

const BOX = Object.freeze({
  detail: Object.freeze({ w: 300, h: 96, pad: 2 }),
  spark: Object.freeze({ w: 100, h: 28, pad: 2 })
})
const LEVEL_COLOR = Object.freeze({
  ok: 'var(--fm-primary)',
  busy: 'var(--fm-health-busy)',
  strained: 'var(--fm-health-strained)',
  critical: 'var(--fm-health-critical)'
})
const LEVEL_WORD = Object.freeze({ ok: 'OK', busy: 'busy', strained: 'strained', critical: 'critical' })
/** How long a chart takes to move to a new reading, and to rise from its baseline when it opens. */
export const MOVE_MS = 600
export const RISE_MS = 700
/** A step longer than this (the panel was hidden, the clock jumped) is drawn at once, not swept. */
export const MAX_GLIDE_MS = 30_000

let nextId = 0

/** The placeholder view.mjs draws: `props` (class, data-key) on an empty element holding `spec`.
 *  A sparkline is a span, so it can sit inside a card's button. */
export function chartSlot(spec, props = {}) {
  const node = h(spec.kind === 'spark' ? 'span' : 'div', { ...props, 'data-island': '' })
  node[ISLAND] = spec
  return node
}

const pctOf = (value, of) => `${Math.round((value / of) * 10_000) / 100}%`
const setD = (node, d) => node.setAttribute('d', d || 'M0 0')

function show(node, on) {
  if (on) node.removeAttribute('hidden')
  else node.setAttribute('hidden', '')
}

function place(node, x, y, box) {
  node.style.setProperty('left', pctOf(x, box.w))
  node.style.setProperty('top', pctOf(y, box.h))
}

/** A frame flattened onto its baseline: where a chart rises from when it first opens. */
function flat(frame) {
  return frame ? { ...frame, points: frame.points.map((p) => ({ ...p, v: 0, lo: 0, hi: 0 })) } : frame
}

/** What a frame shows, coarsely: the same signature twice means nothing new to draw (a redraw for
 *  a click or a keystroke moves no chart). */
function signature(target) {
  const one = (f) => {
    if (!f) return '-'
    const last = f.points[f.points.length - 1]
    return `${Math.round(f.end / 1_000)}|${f.count}|${f.points.length}|${last ? `${last.key}:${last.t}:${last.v}` : ''}`
  }
  return `${one(target.main)}/${one(target.second)}`
}

const fadeStops = (top, bottom) => Array.from({ length: 8 }, (_, i) => ({ offset: i / 7, level: null, opacity: Math.round((top + (bottom - top) * (i / 7)) * 1000) / 1000 }))

/**
 * Charts for one panel. `frame` schedules a callback before the next paint (requestAnimationFrame);
 * `clock` is a monotonic clock in ms; `motion()` says whether to move at all (false under reduced
 * motion); `hidden()` says the panel is not on screen. Without `frame`, or with motion off, every
 * chart is drawn at once at its newest reading.
 */
export function createCharts({ frame = null, clock = () => Date.now(), motion = () => false, hidden = () => false } = {}) {
  const states = new WeakMap()
  const moving = new Set()
  let scheduled = false

  const canMove = () => typeof frame === 'function' && motion() && !hidden()

  function schedule() {
    if (scheduled || moving.size === 0 || typeof frame !== 'function') return
    scheduled = true
    frame(tick)
  }

  function tick() {
    scheduled = false
    const now = clock()
    for (const st of moving) {
      if (!st.el.isConnected) {
        moving.delete(st)
        continue
      }
      const k = (now - st.t0) / st.duration
      if (k >= 1) {
        st.shown = st.target
        moving.delete(st)
      } else {
        const e = easeOut(k)
        st.shown = {
          main: tweenFrame(st.from.main, st.target.main, e),
          second: st.from.second && st.target.second ? tweenFrame(st.from.second, st.target.second, e) : st.target.second
        }
      }
      paint(st)
    }
    schedule()
  }

  function build(el, spec) {
    const box = BOX[spec.kind]
    const id = `fm-chart-${(nextId += 1)}`
    const stops = () => Array.from({ length: 8 }, () => s('stop', { offset: '0' }))
    const fillStops = stops()
    const lineStops = stops()
    const fillGrad = s('linearGradient', { id: `${id}-fill`, x1: 0, y1: 0, x2: 0, y2: 1 }, fillStops)
    const lineGrad = s('linearGradient', { id: `${id}-line`, gradientUnits: 'userSpaceOnUse', x1: 0, y1: 0, x2: 0, y2: box.h }, lineStops)
    const nodes = {
      area: s('path', { class: 'fm-area', fill: `url(#${id}-fill)`, d: 'M0 0' }),
      line: s('path', { class: 'fm-line', d: 'M0 0' }),
      end: h('span', { class: spec.kind === 'spark' ? 'fm-end fm-end--sm' : 'fm-end', 'aria-hidden': 'true', hidden: true })
    }
    const defs = s('defs', {}, fillGrad, lineGrad)
    let svg
    if (spec.kind === 'spark') {
      // A second line (upload) only where there is one: a card's sparkline has one line.
      nodes.second = spec.second ? s('path', { class: 'fm-line fm-line--second', d: 'M0 0' }) : null
      svg = s(
        'svg',
        { class: 'fm-spark', viewBox: `0 0 ${box.w} ${box.h}`, preserveAspectRatio: 'none', focusable: 'false' },
        defs,
        s('path', { class: 'fm-spark-rail', d: `M0 ${box.h - box.pad} L${box.w} ${box.h - box.pad}` }),
        nodes.area,
        nodes.second,
        nodes.line
      )
      el.append(svg, nodes.end)
    } else {
      nodes.range = s('path', { class: 'fm-range', d: 'M0 0' })
      nodes.bands = h('div', { class: 'fm-bands', 'aria-hidden': 'true' })
      nodes.peakLabel = h('span', { class: 'fm-peak-label' })
      nodes.peak = h('span', { class: 'fm-peak', 'aria-hidden': 'true', hidden: true }, nodes.peakLabel)
      nodes.hit = h('div', { class: 'fm-hit', tabindex: '0', role: 'slider', 'aria-orientation': 'horizontal', 'aria-valuemin': '0' })
      nodes.xhair = h('span', { class: 'fm-xhair', 'aria-hidden': 'true', hidden: true })
      nodes.dot = h('span', { class: 'fm-hdot', 'aria-hidden': 'true', hidden: true })
      nodes.when = h('span', { class: 'fm-tip-when' })
      nodes.key = h('span', { class: 'fm-tip-key' })
      nodes.value = h('span', {})
      nodes.range2 = h('span', { class: 'fm-tip-range' })
      nodes.tip = h('div', { class: 'fm-tip', 'aria-hidden': 'true', hidden: true }, nodes.when, h('span', { class: 'fm-tip-val' }, nodes.key, nodes.value), nodes.range2)
      const grid = (value, cls) => s('line', { class: cls, x1: 0, x2: box.w, y1: yOf(value, box.h, box.pad), y2: yOf(value, box.h, box.pad) })
      svg = s(
        'svg',
        { viewBox: `0 0 ${box.w} ${box.h}`, preserveAspectRatio: 'none', focusable: 'false' },
        defs,
        grid(50, 'fm-gridline fm-gridline--soft'),
        grid(0, 'fm-gridline'),
        nodes.range,
        nodes.area,
        nodes.line
      )
      const label = (text, value) => h('span', { class: 'fm-ylab', 'aria-hidden': 'true', style: { top: pctOf(yOf(value, box.h, box.pad), box.h) } }, text)
      // The axis figures sit over the line, haloed in the card's colour, so a line through them never
      // makes them unreadable.
      el.append(nodes.bands, svg, label('100', 100), label('50', 50), nodes.peak, nodes.end, nodes.xhair, nodes.dot, nodes.hit, nodes.tip)
    }
    nodes.svg = svg
    const st = { el, kind: spec.kind, box, id, nodes, fillGrad, fillStops, lineStops, spec, ruleKey: null, sig: null, target: null, shown: null, from: null, t0: 0, duration: MOVE_MS, placed: [], hover: null, focused: false }
    if (nodes.hit) listen(st)
    return st
  }

  /** Colours for a rule: the fill and the line by level, or one colour (the tone) without one. */
  function restyle(st, rule) {
    const { h: height, pad } = st.box
    const color = (level) => (level ? LEVEL_COLOR[level] : 'currentColor')
    const fill = rule ? levelStops(rule, height, pad, { top: st.kind === 'detail' ? 0.2 : 0.3, bottom: 0.02 }) : fadeStops(st.kind === 'detail' ? 0.24 : 0.34, 0.02)
    const line = rule ? levelStops(rule, height, pad, { bias: st.kind === 'detail' ? 1 : 0.9 }) : fadeStops(1, 1)
    const write = (nodes, stops) =>
      nodes.forEach((stop, i) => {
        stop.setAttribute('offset', String(Math.round(stops[i].offset * 10_000) / 10_000))
        stop.style.setProperty('stop-color', color(stops[i].level))
        stop.style.setProperty('stop-opacity', String(stops[i].opacity))
      })
    write(st.fillStops, fill)
    write(st.lineStops, line)
    // Without a rule the fill fades over the area's own height, so a low line still has some.
    if (rule) {
      st.fillGrad.setAttribute('gradientUnits', 'userSpaceOnUse')
      st.fillGrad.setAttribute('y2', String(height))
    } else {
      st.fillGrad.removeAttribute('gradientUnits')
      st.fillGrad.setAttribute('y2', '1')
    }
    const stroke = rule ? `url(#${st.id}-line)` : 'currentColor'
    st.nodes.line.setAttribute('stroke', stroke)
    if (st.nodes.range) st.nodes.range.setAttribute('fill', stroke)
    if (st.nodes.bands) {
      st.nodes.bands.textContent = ''
      const levels = [...(rule ?? [])].sort((a, b) => a.at - b.at)
      levels.forEach((r, i) => {
        const upper = i + 1 < levels.length ? levels[i + 1].at : 100
        const top = yOf(upper, height, pad)
        const bottom = yOf(r.at, height, pad)
        st.nodes.bands.append(
          h(
            'div',
            { class: 'fm-band', data: { level: r.level }, style: { top: pctOf(top, height), height: pctOf(bottom - top, height) } },
            h('span', { class: 'fm-band-label' }, String(Math.round(r.at)))
          )
        )
      })
    }
  }

  function paint(st) {
    const { w, h: height, pad } = st.box
    const { main, second } = st.shown
    const runs = placeFrame(main, w, height, pad)
    st.placed = runs.flat()
    const rule = st.spec.rule
    setD(st.nodes.line, linePath(runs))
    setD(st.nodes.area, areaPath(runs, height - pad))
    if (st.nodes.range) setD(st.nodes.range, st.spec.range ? rangePath(runs) : '')
    if (st.nodes.second) setD(st.nodes.second, second ? linePath(placeFrame(second, w, height, pad)) : '')
    const last = st.placed[st.placed.length - 1]
    show(st.nodes.end, Boolean(last))
    if (last) {
      place(st.nodes.end, last.x, last.y, st.box)
      if (rule) st.nodes.end.style.setProperty('background', LEVEL_COLOR[levelOf(last.v, rule)])
      else st.nodes.end.style.removeProperty?.('background')
    }
    if (st.nodes.peak) {
      const peak = st.spec.peak
      const x = peak && main && runs.length > 0 ? ((peak.t - main.start) / Math.max(1, main.end - main.start)) * w : -1
      const on = x >= 0 && x <= w
      show(st.nodes.peak, on)
      if (on) {
        place(st.nodes.peak, x, yOf(peak.v, height, pad), st.box)
        st.nodes.peak.style.setProperty('border-color', rule ? LEVEL_COLOR[levelOf(peak.v, rule)] : 'var(--fm-tone)')
        const text = `peak ${Math.round(peak.v)}`
        if (st.nodes.peakLabel.textContent !== text) st.nodes.peakLabel.textContent = text
      }
    }
    if (st.nodes.hit) paintHover(st)
  }

  /** The minute under the pointer or the keys: a line, a dot and a note, and the slider's value. */
  function paintHover(st) {
    const { hit, xhair, dot, tip } = st.nodes
    hit.setAttribute('aria-valuemax', String(Math.max(0, st.placed.length - 1)))
    const index = st.hover === null ? -1 : st.placed.findIndex((p) => p.key === st.hover)
    const p = index >= 0 ? st.placed[index] : null
    for (const node of [xhair, dot, tip]) show(node, Boolean(p))
    if (!p) {
      st.hover = null
      hit.removeAttribute('aria-valuenow')
      hit.removeAttribute('aria-valuetext')
      return
    }
    // The figures of the reading itself, not of a frame in motion.
    const exact = st.target?.main?.points.find((q) => q.key === p.key) ?? p
    const rule = st.spec.rule
    const level = rule ? levelOf(exact.v, rule) : null
    const end = st.target?.main?.end ?? st.shown.main.end
    const when = p.key === 'live' ? 'Now' : `${Math.max(1, Math.round((end - exact.t) / 60_000))} min ago`
    const value = `${Math.round(exact.v)}%`
    const spread = p.key !== 'live' && exact.hi - exact.lo >= 0.5 ? `${Math.round(exact.lo)}–${Math.round(exact.hi)}% that minute` : ''
    const left = pctOf(p.x, st.box.w)
    xhair.style.setProperty('left', left)
    place(dot, p.x, p.y, st.box)
    dot.style.setProperty('background', level ? LEVEL_COLOR[level] : 'var(--fm-tone)')
    st.nodes.key.style.setProperty('background', level ? LEVEL_COLOR[level] : 'var(--fm-tone)')
    st.nodes.when.textContent = when
    st.nodes.value.textContent = level ? `${value} · ${level === 'ok' ? 'OK' : level.charAt(0).toUpperCase() + level.slice(1)}` : value
    st.nodes.range2.textContent = spread
    show(st.nodes.range2, Boolean(spread))
    if (p.x / st.box.w > 0.5) {
      tip.style.setProperty('right', pctOf(st.box.w - p.x, st.box.w))
      tip.style.setProperty('left', 'auto')
      tip.setAttribute('data-side', 'left')
    } else {
      tip.style.setProperty('left', left)
      tip.style.setProperty('right', 'auto')
      tip.setAttribute('data-side', 'right')
    }
    hit.setAttribute('aria-valuenow', String(index))
    hit.setAttribute('aria-valuetext', `${when}: ${value}${level ? `, ${LEVEL_WORD[level]}` : ''}${spread ? `, ${spread}` : ''}`)
  }

  function setHover(st, key) {
    st.hover = key
    paintHover(st)
  }

  function listen(st) {
    const { hit } = st.nodes
    const at = (event) => {
      const rect = typeof hit.getBoundingClientRect === 'function' ? hit.getBoundingClientRect() : null
      if (!rect || !(rect.width > 0) || st.placed.length === 0) return
      const x = ((event.clientX - rect.left) / rect.width) * st.box.w
      let best = st.placed[0]
      for (const p of st.placed) if (Math.abs(p.x - x) < Math.abs(best.x - x)) best = p
      if (best.key !== st.hover) setHover(st, best.key)
    }
    hit.addEventListener('pointermove', at)
    hit.addEventListener('pointerdown', at)
    hit.addEventListener('pointerleave', () => {
      if (!st.focused) setHover(st, null)
    })
    hit.addEventListener('focus', () => {
      st.focused = true
      if (st.hover === null && st.placed.length > 0) setHover(st, st.placed[st.placed.length - 1].key)
    })
    hit.addEventListener('blur', () => {
      st.focused = false
      setHover(st, null)
    })
    hit.addEventListener('keydown', (event) => {
      const count = st.placed.length
      if (count === 0) return
      const now = st.placed.findIndex((p) => p.key === st.hover)
      const from = now < 0 ? count - 1 : now
      const to = { ArrowLeft: from - 1, ArrowDown: from - 1, ArrowRight: from + 1, ArrowUp: from + 1, Home: 0, End: count - 1, PageUp: from - 5, PageDown: from + 5 }[event.key]
      if (to === undefined) return
      event.preventDefault?.()
      setHover(st, st.placed[Math.max(0, Math.min(count - 1, to))].key)
    })
  }

  function update(st, spec) {
    st.spec = spec
    const ruleKey = JSON.stringify(spec.rule ?? null)
    const restyled = ruleKey !== st.ruleKey
    if (restyled) {
      st.ruleKey = ruleKey
      restyle(st, spec.rule ?? null)
    }
    if (spec.label) {
      st.nodes.svg.setAttribute('role', 'img')
      st.nodes.svg.setAttribute('aria-label', spec.label)
      st.nodes.svg.removeAttribute('aria-hidden')
    } else {
      st.nodes.svg.removeAttribute('role')
      st.nodes.svg.removeAttribute('aria-label')
      st.nodes.svg.setAttribute('aria-hidden', 'true')
    }
    if (st.nodes.hit) {
      show(st.nodes.hit, Boolean(spec.scrub))
      if (spec.scrub) st.nodes.hit.setAttribute('aria-label', spec.scrub)
    }
    const target = { main: spec.frame, second: spec.second ?? null }
    const sig = signature(target)
    if (sig === st.sig) {
      if (restyled && st.shown) paint(st)
      return
    }
    st.sig = sig
    const step = st.target ? target.main.end - st.target.main.end : null
    const first = st.target === null
    st.target = target
    if (!first && step !== null && step > 0 && step <= MAX_GLIDE_MS && canMove()) {
      st.from = st.shown
      st.t0 = clock()
      st.duration = MOVE_MS
      moving.add(st)
      schedule()
      return
    }
    if (first && st.kind === 'detail' && canMove()) {
      st.from = { main: flat(target.main), second: flat(target.second) }
      st.shown = st.from
      st.t0 = clock()
      st.duration = RISE_MS
      paint(st)
      moving.add(st)
      schedule()
      return
    }
    moving.delete(st)
    st.shown = target
    paint(st)
  }

  return {
    /** Draws every chart under `root` from its spec, or starts it moving there. */
    sync(root) {
      for (const el of root.querySelectorAll('[data-island]')) {
        const spec = el[ISLAND]
        if (!spec || !BOX[spec.kind]) continue
        let st = states.get(el)
        if (!st || st.kind !== spec.kind || Boolean(st.nodes.second) !== Boolean(spec.kind === 'spark' && spec.second)) {
          el.textContent = ''
          st = build(el, spec)
          states.set(el, st)
        }
        update(st, spec)
      }
    },
    /** Charts mid-move, for tests. */
    moving: () => moving.size
  }
}
