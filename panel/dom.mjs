// DOM helpers for the panel. Everything that comes from data (machine and workspace names, error
// text) reaches the page as text nodes or attribute values, never as markup.

const SVG_NS = 'http://www.w3.org/2000/svg'

function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === true) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

function applyProps(node, props) {
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue
    if (key === 'class') node.setAttribute('class', Array.isArray(value) ? value.filter(Boolean).join(' ') : value)
    else if (key === 'style' && typeof value === 'object') {
      for (const [name, v] of Object.entries(value)) if (v !== null && v !== undefined) node.style.setProperty(name, String(v))
    } else if (key === 'data' && typeof value === 'object') {
      for (const [name, v] of Object.entries(value)) if (v !== null && v !== undefined) node.dataset[name] = String(v)
    } else node.setAttribute(key, value === true ? '' : String(value))
  }
  return node
}

/** An HTML element: h('span', { class: 'x', 'aria-label': name }, 'text', child). */
export function h(tag, props, ...children) {
  return append(applyProps(document.createElement(tag), props), children)
}

/** An SVG element. */
export function s(tag, props, ...children) {
  return append(applyProps(document.createElementNS(SVG_NS, tag), props), children)
}

/** The key that pairs an old node with its replacement in morph(). */
function keyOf(node) {
  return node.nodeType === 1 ? node.getAttribute('data-key') : null
}

function sameKind(a, b) {
  return a.nodeType === b.nodeType && a.nodeName === b.nodeName && keyOf(a) === keyOf(b)
}

function syncAttributes(from, to) {
  for (const attr of [...from.attributes]) {
    if (!to.hasAttribute(attr.name)) from.removeAttribute(attr.name)
  }
  for (const attr of [...to.attributes]) {
    if (from.getAttribute(attr.name) !== attr.value) from.setAttribute(attr.name, attr.value)
  }
}

/**
 * Makes the live children of `parent` match `next` (detached nodes) while keeping every node that
 * stays the same kind in place, so focus, hover, text selection and running animations survive a
 * redraw. Event handlers live on the panel root (delegation), never on the nodes morphed here.
 */
export function morphChildren(parent, next) {
  const old = [...parent.childNodes]
  const byKey = new Map()
  for (const node of old) {
    const key = keyOf(node)
    if (key !== null) byKey.set(key, node)
  }
  const used = new Set()
  let cursor = 0
  next.forEach((incoming, index) => {
    const key = keyOf(incoming)
    let match = null
    if (key !== null) {
      match = byKey.get(key) ?? null
    } else {
      while (cursor < old.length && (used.has(old[cursor]) || keyOf(old[cursor]) !== null)) cursor += 1
      if (cursor < old.length && sameKind(old[cursor], incoming)) match = old[cursor]
    }
    if (match && sameKind(match, incoming) && !used.has(match)) {
      used.add(match)
      if (key === null) cursor += 1
      morph(match, incoming)
    } else {
      match = incoming
    }
    const at = parent.childNodes[index] ?? null
    if (at !== match) parent.insertBefore(match, at)
  })
  for (const node of old) if (!used.has(node) && node.parentNode === parent) node.remove()
}

function morph(from, to) {
  if (from.nodeType === 3 || from.nodeType === 8) {
    if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue
    return
  }
  syncAttributes(from, to)
  morphChildren(from, [...to.childNodes])
}

/**
 * Copies text from inside a click handler. `navigator.clipboard` is refused in plugin frames, but
 * `document.execCommand('copy')` works during a user gesture. Returns whether it worked.
 */
export function copyText(text) {
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  area.style.pointerEvents = 'none'
  document.body.append(area)
  const active = document.activeElement
  area.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  area.remove()
  if (active instanceof HTMLElement) active.focus({ preventScroll: true })
  return ok
}

/** Selects the text of `node`, for copying by hand when copying failed. */
export function selectText(node) {
  const range = document.createRange()
  range.selectNodeContents(node)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}
