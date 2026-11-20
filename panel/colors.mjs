// The person's own health colours (the colorOk, colorBusy, colorStrained and colorCritical
// settings), for anyone who cannot tell Fleet Monitor's apart, or would rather have others. The
// panel reads them from Orca's settings itself, checks them, and sets each one chosen on <html>
// over Fleet Monitor's own, in light and dark themes alike. A reading at an OK level is drawn in
// the OK colour, so that one setting colours healthy charts too.

export const LEVELS = Object.freeze(['ok', 'busy', 'strained', 'critical'])

/** Each level's setting key. */
export const COLOR_SETTINGS = Object.freeze({ ok: 'colorOk', busy: 'colorBusy', strained: 'colorStrained', critical: 'colorCritical' })

const SETTING_KEYS = new Set(Object.values(COLOR_SETTINGS))
const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i
const NAME = /^[a-z]{3,24}$/
/** Words CSS takes as a colour that are no colour of their own. */
const NOT_A_COLOR = new Set(['transparent', 'currentcolor', 'inherit', 'initial', 'unset', 'revert', 'none'])

const cssKnows = (name) => typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('color', name)

/**
 * A colour as a person typed it: a hex code (`#0072b2`, `0072B2`, `#07b`) as `#rrggbb`, or a CSS
 * colour name (`purple`) that `knows` (CSS.supports) takes; null for anything else, so nothing but
 * a colour ever reaches the page's styles.
 */
export function colorOf(value, knows = cssKnows) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  const hex = HEX.exec(text)
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((d) => d + d).join('') : hex[1]
    return `#${digits.toLowerCase()}`
  }
  const name = text.toLowerCase()
  return NAME.test(name) && !NOT_A_COLOR.has(name) && knows(name) ? name : null
}

/** Each level's chosen colour from Orca's settings, or null for Fleet Monitor's own. */
export function colorsOf(settings, knows = cssKnows) {
  const out = {}
  for (const level of LEVELS) out[level] = colorOf(settings?.[COLOR_SETTINGS[level]], knows)
  return out
}

/** Sets each chosen colour on <html>, inline so no theme rule can override it, and clears the
 *  others; html[data-fm-colors] lists the levels chosen. Each is checked again (colorOf), so
 *  nothing but a colour is ever set. Returns them. */
export function applyColors(colors, doc = document, knows = cssKnows) {
  const html = doc.documentElement
  const chosen = []
  for (const level of LEVELS) {
    const color = colorOf(colors?.[level] ?? null, knows)
    if (color) {
      html.style.setProperty(`--fm-health-${level}`, color)
      chosen.push(level)
    } else {
      html.style.removeProperty(`--fm-health-${level}`)
    }
  }
  if (chosen.length > 0) html.setAttribute('data-fm-colors', chosen.join(' '))
  else html.removeAttribute('data-fm-colors')
  return chosen
}

/** Whether the person chose the colour of `level` (applyColors). */
export function chosenColor(level, doc = document) {
  return (doc.documentElement.getAttribute('data-fm-colors') ?? '').split(' ').includes(level)
}

/**
 * Follows the person's colour settings through `orca.settings` (the frame's window.orca): applies
 * them now and whenever one changes, then calls `after` (the contrast check, which leaves a chosen
 * colour as chosen). Settings that cannot be read leave the colours as they are. A frame without
 * settings keeps Fleet Monitor's own.
 */
export function followColors(orca, after = () => {}, doc = document, knows = cssKnows) {
  const settings = orca?.settings
  if (!settings || typeof settings.get !== 'function') return { ready: Promise.resolve(), dispose() {} }
  let latest = 0
  let disposed = false
  const read = async () => {
    if (disposed) return
    const mine = (latest += 1)
    let all
    try {
      all = await settings.get()
    } catch {
      return
    }
    // A slower, older read never undoes a newer one, and none lands after dispose.
    if (disposed || mine !== latest || !all || typeof all !== 'object') return
    applyColors(colorsOf(all, knows), doc, knows)
    after()
  }
  const ready = read()
  let subscription = null
  try {
    subscription = settings.onDidChange?.((change) => {
      if (!change || typeof change.key !== 'string' || SETTING_KEYS.has(change.key)) void read()
    })
  } catch {
    // Changes cannot be heard: the colours read now stand, and the panel still opens.
  }
  return {
    ready,
    dispose() {
      disposed = true
      try {
        subscription?.dispose?.()
      } catch {
        // Already gone.
      }
    }
  }
}
