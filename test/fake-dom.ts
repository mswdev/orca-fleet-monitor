// A small DOM, just enough for panel/dom.mjs and panel/view.mjs to run in Node. Every way to turn
// a string into markup (innerHTML, outerHTML, insertAdjacentHTML, document.write, a contextual
// fragment, DOMParser) throws and is recorded in `markupWrites`, so a test can prove remote text
// never becomes elements. Focus follows the browser's rules the panel depends on: a focused
// element that becomes disabled, or is removed, hands focus back to the body.

type Listener = (event: FakeEvent) => void
export type FakeEvent = { type: string; target: FakeNode; key?: string; defaultPrevented?: boolean; preventDefault?: () => void }

export class FakeNode {
  nodeType: number
  nodeName: string
  parentNode: FakeElement | null = null
  childNodes: FakeNode[] = []
  ownerDocument: FakeDocument
  nodeValue: string | null = null
  private listeners = new Map<string, Listener[]>()

  constructor(doc: FakeDocument, nodeType: number, nodeName: string) {
    this.ownerDocument = doc
    this.nodeType = nodeType
    this.nodeName = nodeName
  }

  get textContent(): string {
    if (this.nodeType === 3) return this.nodeValue ?? ''
    return this.childNodes.map((c) => c.textContent).join('')
  }

  set textContent(value: string) {
    if (this.nodeType === 3) {
      this.nodeValue = String(value)
      return
    }
    for (const child of [...this.childNodes]) child.remove()
    if (value) (this as unknown as FakeElement).append(this.ownerDocument.createTextNode(String(value)))
  }

  get isConnected(): boolean {
    let node: FakeNode | null = this
    while (node) {
      if (node === this.ownerDocument.documentElement) return true
      node = node.parentNode
    }
    return false
  }

  contains(other: FakeNode | null): boolean {
    for (let node = other; node; node = node.parentNode) if (node === this) return true
    return false
  }

  remove(): void {
    const parent = this.parentNode
    if (!parent) return
    const active = this.ownerDocument.activeElement
    parent.childNodes.splice(parent.childNodes.indexOf(this), 1)
    this.parentNode = null
    if (active && this.contains(active)) this.ownerDocument.activeElement = this.ownerDocument.body
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l !== listener))
  }

  /** Calls this node's listeners, then its ancestors' and the document's (bubbling). */
  dispatchEvent(event: FakeEvent): void {
    const chain: FakeNode[] = []
    for (let node: FakeNode | null = this; node; node = node.parentNode) chain.push(node)
    if (!chain.includes(this.ownerDocument)) chain.push(this.ownerDocument)
    for (const node of chain) for (const listener of node.listeners.get(event.type) ?? []) listener(event)
  }
}

export class FakeText extends FakeNode {
  constructor(doc: FakeDocument, text: string) {
    super(doc, 3, '#text')
    this.nodeValue = text
  }
}

const kebab = (name: string): string => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

function markup(doc: FakeDocument, what: string): never {
  doc.markupWrites.push(what)
  throw new Error(`markup parsed from a string (${what})`)
}

export class FakeElement extends FakeNode {
  readonly tagName: string
  readonly namespaceURI: string | null
  private attrs = new Map<string, string>()
  value = ''
  readonly style: Record<string, unknown> & { setProperty(name: string, value: string): void; getPropertyValue(name: string): string }
  readonly dataset: Record<string, string>

  constructor(doc: FakeDocument, tag: string, namespaceURI: string | null) {
    super(doc, 1, namespaceURI ? tag : tag.toUpperCase())
    this.tagName = this.nodeName
    this.namespaceURI = namespaceURI
    const element = this
    const props = new Map<string, string>()
    const write = (): void => {
      const text = [...props].map(([k, v]) => `${k}: ${v}`).join('; ')
      if (text) element.attrs.set('style', text)
      else element.attrs.delete('style')
    }
    this.style = new Proxy(
      {
        setProperty(name: string, value: string) {
          props.set(name, String(value))
          write()
        },
        getPropertyValue(name: string) {
          return props.get(name) ?? ''
        },
        _read(text: string) {
          props.clear()
          for (const part of text.split(';')) {
            const at = part.indexOf(':')
            if (at > 0) props.set(part.slice(0, at).trim(), part.slice(at + 1).trim())
          }
        }
      } as Record<string, unknown> & { setProperty(name: string, value: string): void; getPropertyValue(name: string): string },
      {
        set(target, key, value) {
          if (typeof key === 'string' && !(key in target)) {
            props.set(kebab(key), String(value))
            write()
            return true
          }
          return Reflect.set(target, key, value)
        }
      }
    )
    this.dataset = new Proxy({} as Record<string, string>, {
      get: (_t, key) => (typeof key === 'string' ? (element.getAttribute(`data-${kebab(key)}`) ?? undefined) : undefined),
      set: (_t, key, value) => {
        if (typeof key === 'string') element.setAttribute(`data-${kebab(key)}`, String(value))
        return true
      }
    })
  }

  get attributes(): { name: string; value: string }[] {
    return [...this.attrs].map(([name, value]) => ({ name, value }))
  }

  get id(): string {
    return this.getAttribute('id') ?? ''
  }

  get disabled(): boolean {
    return this.hasAttribute('disabled')
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name)
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, String(value))
    if (name === 'style') (this.style as unknown as { _read(text: string): void })._read(String(value))
    if (name === 'disabled' && this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name)
    if (name === 'style') (this.style as unknown as { _read(text: string): void })._read('')
  }

  append(...children: (FakeNode | string)[]): void {
    for (const child of children) this.insertBefore(typeof child === 'string' ? this.ownerDocument.createTextNode(child) : child, null)
  }

  insertBefore(node: FakeNode, ref: FakeNode | null): FakeNode {
    if (node.parentNode) {
      // Moving a node removes it first, and in a browser that drops focus held inside it
      // (Element.moveBefore exists to avoid exactly that).
      node.remove()
    }
    const index = ref ? this.childNodes.indexOf(ref) : -1
    if (index === -1) this.childNodes.push(node)
    else this.childNodes.splice(index, 0, node)
    node.parentNode = this
    return node
  }

  focus(): void {
    if (this.isConnected && !this.disabled) this.ownerDocument.activeElement = this
  }

  /** Selecting a field's text focuses it, as in a browser. */
  select(): void {
    this.focus()
  }

  click(): void {
    this.dispatchEvent({ type: 'click', target: this })
  }

  matches(selector: string): boolean {
    return matchesSelector(this, selector)
  }

  closest(selector: string): FakeElement | null {
    for (let node: FakeNode | null = this; node; node = node.parentNode) {
      if (node instanceof FakeElement && node.matches(selector)) return node
    }
    return null
  }

  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = []
    const walk = (node: FakeNode): void => {
      for (const child of node.childNodes) {
        if (child instanceof FakeElement) {
          if (child.matches(selector)) out.push(child)
          walk(child)
        }
      }
    }
    walk(this)
    return out
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null
  }

  set innerHTML(_value: string) {
    markup(this.ownerDocument, 'innerHTML')
  }

  get innerHTML(): string {
    return this.textContent
  }

  set outerHTML(_value: string) {
    markup(this.ownerDocument, 'outerHTML')
  }

  insertAdjacentHTML(): void {
    markup(this.ownerDocument, 'insertAdjacentHTML')
  }
}

export class FakeHTMLElement extends FakeElement {}

/** Compound selectors (tag, #id, .class, [attr], [attr="value"]) joined by spaces (descendant). */
function matchesSelector(element: FakeElement, selector: string): boolean {
  const parts = splitCompound(selector.trim())
  const last = parts.pop()
  if (last === undefined || !matchesCompound(element, last)) return false
  let node: FakeNode | null = element.parentNode
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    while (node && !(node instanceof FakeElement && matchesCompound(node, parts[i]!))) node = node.parentNode
    if (!node) return false
    node = node.parentNode
  }
  return true
}

function splitCompound(selector: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: string | null = null
  let bracket = 0
  for (let i = 0; i < selector.length; i += 1) {
    const c = selector[i]!
    if (quote) {
      current += c
      if (c === '\\') current += selector[++i] ?? ''
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") quote = c
    if (c === '[') bracket += 1
    if (c === ']') bracket -= 1
    if (c === ' ' && bracket === 0) {
      if (current) out.push(current)
      current = ''
      continue
    }
    current += c
  }
  if (current) out.push(current)
  return out
}

function matchesCompound(element: FakeElement, compound: string): boolean {
  const re = /\[([\w-]+)(?:="((?:[^"\\]|\\.)*)")?\]|#([\w-]+)|\.([\w-]+)|^([a-zA-Z][\w-]*)/g
  let consumed = 0
  for (let m = re.exec(compound); m; m = re.exec(compound)) {
    consumed += m[0].length
    if (m[1] !== undefined) {
      const actual = element.getAttribute(m[1])
      if (actual === null) return false
      if (m[2] !== undefined && actual !== m[2].replace(/\\(.)/g, '$1')) return false
    } else if (m[3] !== undefined) {
      if (element.getAttribute('id') !== m[3]) return false
    } else if (m[4] !== undefined) {
      if (!(element.getAttribute('class') ?? '').split(/\s+/).includes(m[4])) return false
    } else if (m[5] !== undefined) {
      if (element.tagName.toLowerCase() !== m[5].toLowerCase()) return false
    }
  }
  if (consumed !== compound.length) throw new Error(`fake DOM cannot read the selector ${compound}`)
  return true
}

export class FakeDocument extends FakeNode {
  readonly documentElement: FakeElement
  readonly head: FakeElement
  readonly body: FakeElement
  activeElement: FakeElement | null
  visibilityState: 'visible' | 'hidden' = 'visible'
  /** Every attempt to parse a string as markup. */
  readonly markupWrites: string[] = []
  /** Every element created, by lower-case tag name. */
  readonly created: string[] = []
  copyWorks = true
  copied: string[] = []

  constructor() {
    super(null as unknown as FakeDocument, 9, '#document')
    this.ownerDocument = this
    this.documentElement = this.createElement('html')
    this.head = this.createElement('head')
    this.body = this.createElement('body')
    this.documentElement.append(this.head, this.body)
    this.documentElement.parentNode = null
    this.activeElement = this.body
  }

  createElement(tag: string): FakeElement {
    this.created.push(tag.toLowerCase())
    return new FakeHTMLElement(this, tag, null)
  }

  createElementNS(ns: string, tag: string): FakeElement {
    this.created.push(tag.toLowerCase())
    return new FakeElement(this, tag, ns)
  }

  createTextNode(text: string): FakeText {
    return new FakeText(this, String(text))
  }

  createRange(): { selectNodeContents(node: FakeNode): void; createContextualFragment(): never } {
    return {
      selectNodeContents: () => {},
      createContextualFragment: () => markup(this, 'createContextualFragment')
    }
  }

  execCommand(command: string): boolean {
    if (command !== 'copy' || !this.copyWorks) return false
    const area = this.activeElement
    this.copied.push(area && 'value' in area ? String((area as FakeElement).value) : '')
    return true
  }

  write(): void {
    markup(this, 'document.write')
  }

  querySelector(selector: string): FakeElement | null {
    return this.documentElement.matches(selector) ? this.documentElement : this.documentElement.querySelector(selector)
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.documentElement.querySelectorAll(selector)
  }
}

/** Puts a fresh document and the globals the panel reads (document, window, Node, Element,
 *  HTMLElement, CSS, DOMParser) on globalThis. Returns the document and a function that removes
 *  them again. */
export function installFakeDom(): { document: FakeDocument; root: FakeElement; restore: () => void } {
  const document = new FakeDocument()
  const root = document.createElement('main')
  root.setAttribute('id', 'app')
  document.body.append(root)
  const g = globalThis as Record<string, unknown>
  const names = ['document', 'window', 'Node', 'Element', 'HTMLElement', 'CSS', 'DOMParser'] as const
  const before = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(g, name)]))
  const window = {
    scrollY: 0,
    scrollTo: () => {},
    getSelection: () => ({ removeAllRanges: () => {}, addRange: () => {} })
  }
  const define = (name: string, value: unknown): void => {
    Object.defineProperty(g, name, { value, configurable: true, writable: true })
  }
  define('document', document)
  define('window', window)
  define('Node', FakeNode)
  define('Element', FakeElement)
  define('HTMLElement', FakeHTMLElement)
  define('CSS', { escape: (text: string) => String(text).replace(/["\\]/g, (c) => `\\${c}`) })
  define(
    'DOMParser',
    class {
      parseFromString(): never {
        return markup(document, 'DOMParser')
      }
    }
  )
  return {
    document,
    root,
    restore: () => {
      for (const [name, descriptor] of before) {
        if (descriptor) Object.defineProperty(g, name, descriptor)
        else delete g[name]
      }
    }
  }
}

/** Every text node's value under `node`, in order. */
export function texts(node: FakeNode): string[] {
  const out: string[] = []
  const walk = (n: FakeNode): void => {
    for (const child of n.childNodes) {
      if (child.nodeType === 3) out.push(child.nodeValue ?? '')
      else walk(child)
    }
  }
  walk(node)
  return out
}
