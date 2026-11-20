// Boots the real panel (panel/view.mjs over panel/fleet-binding.mjs) on the fake window.orca,
// the way Orca's frame does: theme class on <html> and, optionally, host tokens in a style
// element ahead of the panel's stylesheet.
//
// Query: state=live|empty|connecting|loading|error  theme=light|dark  machine=<id> (opens its
// detail)  host=<token set> (pretend a user theme)  live=1 (moving data)  install=open (expands
// the basic machine's install row)  pair=open (opens the pairing hint)  version=<x.y.z> (the
// worker's version, at the foot)  ok=, busy=, strained=, critical=<colour> (the colour settings,
// such as ok=%230072b2 or critical=purple)
import { applyColors, colorsOf, COLOR_SETTINGS } from '../../panel/colors.mjs'
import { applyHealthContrast } from '../../panel/contrast.mjs'
import { createFleetBinding, externalOpener } from '../../panel/fleet-binding.mjs'
import { mountFleetView } from '../../panel/view.mjs'
import { createFakeOrca } from './fake-orca.mjs'

/** Invented host themes, to see that a user's theme wins over the design's fallbacks. The two
 *  `orca-*` ones are built the way Orca builds its own: primary is the text colour. */
const HOST_THEMES = {
  'orca-dark': {
    scheme: 'dark',
    tokens: {
      background: '#171717', foreground: '#fafafa', card: '#1c1c1c', 'card-foreground': '#fafafa', muted: '#262626',
      'muted-foreground': '#a3a3a3', accent: '#262626', primary: '#fafafa', 'primary-foreground': '#171717', border: '#2e2e2e', radius: '8px'
    }
  },
  'orca-light': {
    scheme: 'light',
    tokens: {
      background: '#fafafa', foreground: '#0a0a0a', card: '#ffffff', 'card-foreground': '#0a0a0a', muted: '#f5f5f5',
      'muted-foreground': '#737373', accent: '#f5f5f5', primary: '#171717', 'primary-foreground': '#fafafa', border: '#e5e5e5', radius: '8px'
    }
  },
  slate: {
    scheme: 'dark',
    tokens: {
      background: '#0f172a', foreground: '#e2e8f0', card: '#162033', 'card-foreground': '#e2e8f0', muted: '#1e293b',
      'muted-foreground': '#94a3b8', accent: '#243247', primary: '#38bdf8', 'primary-foreground': '#04121c', border: '#26344a', radius: '10px'
    }
  },
  mist: {
    scheme: 'light',
    tokens: {
      background: '#d3d6de', foreground: '#2e3446', card: '#d9dce3', 'card-foreground': '#2e3446', muted: '#c8ccd6',
      'muted-foreground': '#4c5266', accent: '#c4c8d3', primary: '#3554b8', 'primary-foreground': '#ffffff', border: '#bfc3cf', radius: '6px'
    }
  },
  paper: {
    scheme: 'light',
    tokens: {
      background: '#f4f1ea', foreground: '#2b2622', card: '#fbf9f4', 'card-foreground': '#2b2622', muted: '#ebe6dc',
      'muted-foreground': '#6b6157', accent: '#e4ddd0', primary: '#8a4b2a', 'primary-foreground': '#ffffff', border: '#ddd5c7', radius: '4px'
    }
  }
}

const params = new URLSearchParams(location.search)
const host = HOST_THEMES[params.get('host') ?? '']
const theme = host?.scheme ?? (params.get('theme') === 'dark' ? 'dark' : 'light')
document.documentElement.classList.add(theme)
if (host) {
  const style = document.getElementById('orca-design-tokens')
  style.textContent = `:root{${Object.entries(host.tokens).map(([k, v]) => `--orca-${k}:${v}`).join(';')}}`
}

applyColors(colorsOf(Object.fromEntries(Object.entries(COLOR_SETTINGS).map(([level, key]) => [key, params.get(level)]))))
applyHealthContrast()
const { orca } = createFakeOrca({
  state: params.get('state') ?? 'live',
  live: params.get('live') === '1',
  external: params.get('external') !== '0',
  version: params.get('version')
})
window.orca = orca
const binding = createFleetBinding(orca)
const view = mountFleetView(document.getElementById('app'), { binding, openExternal: externalOpener(orca) })

binding.ready.then(() => {
  const machine = params.get('machine')
  if (machine) view.show(machine)
  if (params.get('install') === 'open') document.querySelector('[data-action="install"]')?.click()
  if (params.get('pair') === 'open') document.querySelector('[data-action="pair"]')?.click()
  // Let the page settle a frame, then say so (the capture scripts wait for it).
  requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.setAttribute('data-preview-ready', '')))
})
if (params.get('state') === 'loading') {
  requestAnimationFrame(() => document.documentElement.setAttribute('data-preview-ready', ''))
}
