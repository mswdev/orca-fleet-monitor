// Keeps the four health colours readable on whatever theme the person uses. The design's colours
// are kept when they reach 4.5:1 against the panel's card and background; when the theme's
// surfaces are tinted enough to drop any of them below that, the panel switches to a stronger
// set (html[data-fm-contrast="more"], see style.css). Checked once at start and on every theme
// change Orca reports.

export const LEVELS = ['ok', 'busy', 'strained', 'critical']
export const MIN_TEXT_CONTRAST = 4.5
export const MIN_GRAPHIC_CONTRAST = 3

function channel(value) {
  const v = value / 255
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

/** WCAG relative luminance of [r, g, b] in 0..255. */
export function luminance([r, g, b]) {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** WCAG contrast ratio of two [r, g, b] colours, 1..21. */
export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** True when any health colour falls below `min` against any of the surfaces. Unknown
 *  (unparseable) colours are left out rather than guessed. */
export function needsStrongerHealth(health, surfaces, min = MIN_TEXT_CONTRAST) {
  const known = surfaces.filter(Boolean)
  return health.filter(Boolean).some((colour) => known.some((surface) => contrastRatio(colour, surface) < min))
}

/** [r, g, b] for any CSS colour the browser understands (hex, rgb(), oklch(), ...), or null. */
function makeResolver(doc) {
  const canvas = doc.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  return (css) => {
    if (!ctx || !css) return null
    const sentinel = '#010203'
    ctx.fillStyle = sentinel
    ctx.fillStyle = css
    if (ctx.fillStyle === sentinel && css.toLowerCase() !== sentinel) return null
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
    return a === 0 ? null : [r, g, b]
  }
}

/**
 * Measures the live theme and sets or clears html[data-fm-contrast] (stronger health and data
 * colours) and html[data-fm-data] (`text`: data drawn in the text colour, where even the stronger
 * blue misses 3:1 on some surface it is drawn on). The data colour is never text, so its marks need
 * 3:1 (WCAG non-text contrast), against the card and page and against the muted tracks that bars
 * and meters fill.
 */
export function applyHealthContrast(doc = document) {
  const html = doc.documentElement
  html.removeAttribute('data-fm-contrast')
  html.removeAttribute('data-fm-data')
  const resolve = makeResolver(doc)
  const read = (name) => resolve(getComputedStyle(html).getPropertyValue(name).trim())
  const surfaces = [read('--fm-card'), read('--fm-bg')]
  const tracks = [...surfaces, read('--fm-muted')]
  const health = LEVELS.map((level) => read(`--fm-health-${level}`))
  const dataFails = () => needsStrongerHealth([read('--fm-data')], tracks, MIN_GRAPHIC_CONTRAST)
  if (needsStrongerHealth(health, surfaces) || dataFails()) {
    html.setAttribute('data-fm-contrast', 'more')
    // Checked again on the colour now in force: a theme can defeat the stronger blue too.
    if (dataFails()) html.setAttribute('data-fm-data', 'text')
  }
  return html.getAttribute('data-fm-contrast') === 'more'
}
