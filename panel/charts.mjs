// SVG paths for the history charts: points 0..100 spread evenly across a w by h box, as in the
// design. A null is a gap: the line and its fill stop and start again around it, and a lone
// reading between gaps is drawn as a dot (a zero-length segment with round caps).

const clamp = (value) => Math.min(100, Math.max(0, value))
const fmt = (n) => (Math.round(n * 10) / 10).toString()

export function seriesPaths(values, w, h, pad = 0) {
  const last = Math.max(1, values.length - 1)
  const runs = []
  let run = []
  values.forEach((value, i) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      if (run.length > 0) runs.push(run)
      run = []
      return
    }
    run.push([(i / last) * w, pad + (h - pad * 2) * (1 - clamp(value) / 100)])
  })
  if (run.length > 0) runs.push(run)
  let line = ''
  let area = ''
  for (const points of runs) {
    const [x0, y0] = points[0]
    const body = points.map(([x, y]) => `${fmt(x)} ${fmt(y)}`).join(' L')
    line += points.length === 1 ? `M${fmt(x0)} ${fmt(y0)} L${fmt(x0)} ${fmt(y0)} ` : `M${body} `
    if (points.length > 1) {
      const xn = points[points.length - 1][0]
      area += `M${body} L${fmt(xn)} ${h} L${fmt(x0)} ${h} Z `
    }
  }
  return { line: line.trim(), area: area.trim(), points: runs.reduce((n, r) => n + r.length, 0) }
}
