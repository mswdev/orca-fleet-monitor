// Geometry for the panel's charts, with no DOM: where a trend's points fall in a w by h box over a
// time window, the paths that draw them, the stops that give each part of a line the colour of its
// level, and the in-between frames a chart shows while it moves from one reading to the next.
//
// A frame is { start, end, count, points }: the window's two ends (worker clock), how many readings
// fell in the window, and points { key, t, v, lo, hi } oldest first, where `key` is the minute's
// number or 'live' for the newest reading (fleet-binding.mjs trendOf). x is time, so as time passes
// the whole line glides left and a minute already drawn keeps its shape. Values are 0..100.
//
// Gaps: where a whole minute had no reading, the line stops and starts again around it; a lone
// point between gaps is a dot (a zero-length segment with round caps). A frame with fewer than two
// readings in all draws nothing: one dot alone reads as a glitch, and the big figure beside the
// chart already shows that reading.

/** For points that do not say which minute they are in: further apart than this, a gap. */
export const GAP_MS = 100_000
const MINUTE_MS = 60_000

const clamp = (value) => Math.min(100, Math.max(0, value))
const fmt = (n) => (Math.round(n * 10) / 10).toString()
const finite = (value) => typeof value === 'number' && Number.isFinite(value)
const lerp = (a, b, k) => a + (b - a) * k

/** A trend (trendOf) as a frame over the window that ends at `end`. Each point keeps the number of
 *  its minute (`slotMs` long), so a gap is a minute with no reading, however far apart the readings
 *  either side of it fall. */
export function frameOf(trend, end, windowMs, slotMs = MINUTE_MS) {
  const points = []
  for (const p of trend?.points ?? []) {
    if (!finite(p?.t) || !finite(p?.v)) continue
    const minute = finite(p.key) ? p.key : Math.floor(p.t / slotMs)
    const point = { key: p.key, minute, t: p.t, v: clamp(p.v), lo: clamp(finite(p.lo) ? p.lo : p.v), hi: clamp(finite(p.hi) ? p.hi : p.v) }
    if (p.newest === true) point.newest = true
    points.push(point)
  }
  const live = trend?.live
  if (live && finite(live.t) && finite(live.v)) {
    points.push({ key: 'live', minute: Math.floor(live.t / slotMs), t: live.t, v: clamp(live.v), lo: clamp(live.v), hi: clamp(live.v), newest: true })
  }
  return { start: end - windowMs, end, count: finite(trend?.count) ? trend.count : points.length, points }
}

/** Whether a whole minute with no reading lies between two neighbouring points. */
function gapBetween(a, b) {
  if (finite(a.minute) && finite(b.minute)) return b.minute - a.minute > 1
  return b.t - a.t > GAP_MS
}

/** y of a value in a box `h` tall with `pad` above and below. */
export function yOf(value, h, pad) {
  return pad + (h - pad * 2) * (1 - clamp(value) / 100)
}

/**
 * The frame's points placed in a `w` by `h` box: runs of { key, t, v, lo, hi, x, y, yLo, yHi },
 * split at gaps. A point to the left of the window is kept (the box clips it) so the line enters
 * from the edge; the newest never sits past the right edge.
 */
export function placeFrame(frame, w, h, pad = 0) {
  if (!frame || frame.count < 2 || frame.points.length === 0) return []
  const span = Math.max(1, frame.end - frame.start)
  const runs = []
  let run = []
  let prev = null
  for (const p of frame.points) {
    const x = Math.min(w, ((p.t - frame.start) / span) * w)
    // Two points at one place (a frame in motion) would make a vertical step: the later one wins.
    if (prev && x - prev.x < 0.05 && !gapBetween(prev, p)) run.pop()
    else if (prev && gapBetween(prev, p)) {
      runs.push(run)
      run = []
    }
    const placed = { ...p, x, y: yOf(p.v, h, pad), yLo: yOf(p.lo, h, pad), yHi: yOf(p.hi, h, pad) }
    run.push(placed)
    prev = placed
  }
  if (run.length > 0) runs.push(run)
  return runs.filter((r) => r.length > 0)
}

function linear(points, yKey = 'y') {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${fmt(p.x)} ${fmt(p[yKey])}`).join(' ')
}

/**
 * A smooth path through `points` that never overshoots: monotone cubic interpolation (Fritsch and
 * Carlson, as d3's curveMonotoneX), so a peak is never drawn higher than the reading and the line
 * never leaves 0..100. Between two readings it can only run from one to the other.
 */
export function monotone(points, yKey = 'y') {
  if (points.length < 3) return linear(points, yKey)
  return pathOf(points, segments(points, yKey))
}

/**
 * The cubic segments of the monotone curve through `points`: for each, the y of its two ends and
 * of its two control points (x runs evenly along a segment: its ends and the thirds between).
 * Each tangent is at most three times the smaller neighbouring slope, which keeps every segment
 * between the readings at its ends.
 */
function segments(points, yKey) {
  const n = points.length
  const dx = []
  const m = []
  for (let i = 0; i < n - 1; i += 1) {
    dx.push(points[i + 1].x - points[i].x)
    m.push((points[i + 1][yKey] - points[i][yKey]) / dx[i])
  }
  const tangent = [m[0]]
  for (let i = 1; i < n - 1; i += 1) {
    if (m[i - 1] * m[i] <= 0) tangent.push(0)
    else {
      const w1 = 2 * dx[i] + dx[i - 1]
      const w2 = dx[i] + 2 * dx[i - 1]
      tangent.push((w1 + w2) / (w1 / m[i - 1] + w2 / m[i]))
    }
  }
  tangent.push(m[n - 2])
  const out = []
  for (let i = 0; i < n - 1; i += 1) {
    const third = dx[i] / 3
    const a = points[i][yKey]
    const b = points[i + 1][yKey]
    out.push([a, a + tangent[i] * third, b - tangent[i + 1] * third, b])
  }
  return out
}

/** A path through `points` along `ys` (segments()), forwards or, with `back`, from the last point. */
function pathOf(points, ys, back = false, lead = 'M') {
  const n = points.length
  const x = (i) => fmt(points[i].x)
  const third = (i, k) => fmt(points[i].x + ((points[i + 1].x - points[i].x) * k) / 3)
  if (!back) {
    let d = `${lead}${x(0)} ${fmt(ys[0][0])}`
    for (let i = 0; i < n - 1; i += 1) d += ` C${third(i, 1)} ${fmt(ys[i][1])} ${third(i, 2)} ${fmt(ys[i][2])} ${x(i + 1)} ${fmt(ys[i][3])}`
    return d
  }
  let d = `${lead}${x(n - 1)} ${fmt(ys[n - 2][3])}`
  for (let i = n - 2; i >= 0; i -= 1) d += ` C${third(i, 2)} ${fmt(ys[i][2])} ${third(i, 1)} ${fmt(ys[i][1])} ${x(i)} ${fmt(ys[i][0])}`
  return d
}

/** The line: each run smoothed, a lone point as a dot. */
export function linePath(runs) {
  return runs
    .map((run) => (run.length === 1 ? `M${fmt(run[0].x)} ${fmt(run[0].y)} L${fmt(run[0].x)} ${fmt(run[0].y)}` : monotone(run)))
    .join(' ')
}

/** The fill under the line, down to `base`. */
export function areaPath(runs, base) {
  return runs
    .filter((run) => run.length > 1)
    .map((run) => `${monotone(run)} L${fmt(run[run.length - 1].x)} ${fmt(base)} L${fmt(run[0].x)} ${fmt(base)} Z`)
    .join(' ')
}

/**
 * The band from each minute's lowest reading to its highest. Its edges follow the line's own curve,
 * offset by the distance to each minute's highest and lowest reading (varying evenly between
 * minutes), so the band never crosses itself or the line: lowest <= mean <= highest everywhere.
 * Edges are kept inside the box `top`..`bottom`.
 */
export function rangePath(runs, top = Number.NEGATIVE_INFINITY, bottom = Number.POSITIVE_INFINITY) {
  const keep = (y) => Math.min(bottom, Math.max(top, y))
  return runs
    .filter((run) => run.length > 1)
    .map((run) => {
      if (run.length === 2) {
        const [a, b] = run
        return `M${fmt(a.x)} ${fmt(a.yHi)} L${fmt(b.x)} ${fmt(b.yHi)} L${fmt(b.x)} ${fmt(b.yLo)} L${fmt(a.x)} ${fmt(a.yLo)} Z`
      }
      const mean = segments(run, 'y')
      // Each edge also stays within the readings either side of it: the highest edge never rises
      // above the higher of two minutes' highest readings, nor the lowest sinks below the lower of
      // their lowest. The line lies within both bounds, so the order holds.
      const edge = (key) =>
        mean.map((ys, i) => {
          const from = run[i][key] - run[i].y
          const to = run[i + 1][key] - run[i + 1].y
          const bound = key === 'yHi' ? (y) => Math.max(y, Math.min(run[i].yHi, run[i + 1].yHi)) : (y) => Math.min(y, Math.max(run[i].yLo, run[i + 1].yLo))
          return ys.map((y, k) => keep(bound(y + from + ((to - from) * k) / 3)))
        })
      return `${pathOf(run, edge('yHi'))} ${pathOf(run, edge('yLo'), true, 'L')} Z`
    })
    .join(' ')
}

/**
 * Stops for a vertical gradient over a box `h` tall (in its own units, top to bottom) that gives
 * each height the colour of its level under `rule` ([{ level, at }], lowest first): hard edges at
 * each threshold. `bias` moves each edge down by that much, about half a line's width, so a line
 * sitting on a threshold reads as the level it has reached (health counts `>=`). Opacity runs from
 * `top` to `bottom`. Always eight stops (padded with the last), so the DOM never changes shape.
 */
export function levelStops(rule, h, pad, { top = 1, bottom = 1, bias = 0 } = {}) {
  const levels = [...(rule ?? [])].filter((r) => finite(r?.at)).sort((a, b) => a.at - b.at)
  const opacity = (offset) => Math.round((top + (bottom - top) * offset) * 1000) / 1000
  const at = (value) => Math.min(1, Math.max(0, (yOf(value, h, pad) + bias) / h))
  let level = levels.length > 0 ? levels[levels.length - 1].level : 'ok'
  const stops = [{ offset: 0, level, opacity: opacity(0) }]
  for (let i = levels.length - 1; i >= 0; i -= 1) {
    const offset = at(levels[i].at)
    stops.push({ offset, level, opacity: opacity(offset) })
    level = i > 0 ? levels[i - 1].level : 'ok'
    stops.push({ offset, level, opacity: opacity(offset) })
  }
  stops.push({ offset: 1, level, opacity: opacity(1) })
  while (stops.length < 8) stops.push(stops[stops.length - 1])
  return stops.slice(0, 8)
}

/** The level of `value` under `rule`, or 'ok' below them all. */
export function levelOf(value, rule) {
  let level = 'ok'
  for (const r of [...(rule ?? [])].sort((a, b) => a.at - b.at)) if (finite(value) && value >= r.at) level = r.level
  return level
}

/** The value (and range) of the frame's line at time `t`: between two points, along the straight
 *  line between them; past either end, that end's. */
function valueAt(points, t) {
  if (points.length === 0) return null
  if (t <= points[0].t) return points[0]
  for (let i = 1; i < points.length; i += 1) {
    const b = points[i]
    if (t <= b.t) {
      const a = points[i - 1]
      const k = b.t === a.t ? 1 : (t - a.t) / (b.t - a.t)
      return { v: lerp(a.v, b.v, k), lo: lerp(a.lo, b.lo, k), hi: lerp(a.hi, b.hi, k) }
    }
  }
  return points[points.length - 1]
}

/**
 * The frame a chart shows a fraction `k` (0..1) of the way from `from` to `to`. A point in both
 * moves; a new one (a minute just finished) grows out of the old line where it will stand; one
 * that is going stays put until the move ends. The window's ends move too, which is the glide.
 */
export function tweenFrame(from, to, k) {
  if (!from || k >= 1) return to
  if (k <= 0) return from
  const before = new Map(from.points.map((p) => [p.key, p]))
  const keys = new Set(to.points.map((p) => p.key))
  const points = to.points.map((p) => {
    const q = before.get(p.key) ?? { t: p.t, ...(valueAt(from.points, p.t) ?? p) }
    // Which minute a point is in, and whether it is the newest reading, hold through the move:
    // a gap stays a gap while the chart glides.
    return { ...p, t: lerp(q.t, p.t, k), v: lerp(q.v, p.v, k), lo: lerp(q.lo, p.lo, k), hi: lerp(q.hi, p.hi, k) }
  })
  for (const p of from.points) if (!keys.has(p.key)) points.push(p)
  points.sort((a, b) => a.t - b.t)
  return { start: lerp(from.start, to.start, k), end: lerp(from.end, to.end, k), count: Math.max(from.count, to.count), points }
}

/** Ease-out cubic: quick to start, settling softly. */
export function easeOut(k) {
  const x = Math.min(1, Math.max(0, k))
  return 1 - (1 - x) ** 3
}
