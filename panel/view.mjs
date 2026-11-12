// Placeholder presentation: lists each machine and its numbers to prove the data flows. The real
// design replaces this file (and index.html, style.css); fleet-binding.mjs stays.
import { createFleetBinding } from './fleet-binding.mjs'

const app = document.getElementById('app')
const SVG = 'http://www.w3.org/2000/svg'

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value
    else node.setAttribute(key, value)
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

const pct = (v) => (typeof v === 'number' ? `${Math.round(v)}%` : '–')
const gib = (bytes) => (typeof bytes === 'number' ? `${(bytes / 2 ** 30).toFixed(1)} GiB` : '–')
const mib = (bytes) => (typeof bytes === 'number' ? `${Math.round(bytes / 2 ** 20)} MiB` : '–')
const num = (v, d = 2) => (typeof v === 'number' ? v.toFixed(d) : '–')

function sparkline(history, windowMs, key) {
  const width = 240
  const height = 32
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
  svg.setAttribute('class', `spark spark-${key}`)
  svg.setAttribute('aria-hidden', 'true')
  const t = history?.t ?? []
  if (t.length < 2) return svg
  const end = t[t.length - 1]
  const start = end - windowMs
  const points = []
  for (let i = 0; i < t.length; i += 1) {
    const v = history[key][i]
    if (typeof v !== 'number') continue
    const x = ((t[i] - start) / windowMs) * width
    const y = height - (Math.min(100, Math.max(0, v)) / 100) * height
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`)
  }
  const line = document.createElementNS(SVG, 'polyline')
  line.setAttribute('points', points.join(' '))
  svg.append(line)
  return svg
}

function cores(perCore) {
  if (!Array.isArray(perCore) || perCore.length === 0) return null
  return el(
    'div',
    { class: 'cores', title: 'Per-core CPU' },
    perCore.map((v) => {
      const bar = el('span', { class: 'core' })
      bar.style.setProperty('--v', String(Math.min(100, Math.max(0, v))))
      return bar
    })
  )
}

function workspaceList(title, list, format) {
  if (!list || list.length === 0) return null
  return el('div', { class: 'ws' }, [
    el('div', { class: 'label' }, title),
    el(
      'ol',
      {},
      list.slice(0, 3).map((w) => el('li', {}, [el('span', { class: 'ws-name' }, w.name), ' ', el('span', { class: 'muted' }, format(w))]))
    )
  ])
}

function machineCard(m, view) {
  const cpuLabel = m.cpu.source === 'load' ? 'CPU (load est.)' : 'CPU'
  const memNote = m.memory && !m.memory.reliable ? ' (os, unreliable)' : ''
  return el('section', { class: `machine level-${m.health.level} ${m.online ? '' : 'is-offline'}` }, [
    el('header', {}, [
      el('span', { class: 'name' }, m.name),
      el('span', { class: `badge tier-${m.tier}` }, m.tier),
      el('span', { class: `badge health` }, m.online ? m.health.level : m.status)
    ]),
    m.error ? el('p', { class: 'error' }, m.error) : null,
    el('dl', {}, [
      el('dt', {}, cpuLabel),
      el('dd', {}, pct(m.cpu.percent)),
      el('dt', {}, 'Memory'),
      el('dd', {}, m.memory ? `${pct(m.memory.percent)} of ${gib(m.memory.total)}${memNote}` : '–'),
      el('dt', {}, 'Load'),
      el('dd', {}, m.load ? `${num(m.load.one)} ${num(m.load.five)} ${num(m.load.fifteen)}` : '–'),
      el('dt', {}, 'Round trip'),
      el('dd', {}, typeof m.latencyMs === 'number' ? `${m.latencyMs} ms` : '–'),
      el('dt', {}, 'Orca'),
      el('dd', {}, m.orca ? `${num(m.orca.cpu / Math.max(1, m.host.cores ?? 1), 1)}% CPU · ${mib(m.orca.memory)}` : '–')
    ]),
    cores(m.cpu.perCore),
    el('div', { class: 'sparks' }, [sparkline(m.history, view.historyWindowMs, 'cpu'), sparkline(m.history, view.historyWindowMs, 'mem')]),
    workspaceList('Busiest workspaces (CPU)', m.workspaces.byCpu, (w) => `${num(w.cpu / Math.max(1, m.host.cores ?? 1), 1)}%`),
    workspaceList('Largest workspaces (memory)', m.workspaces.byMemory, (w) => mib(w.memory)),
    m.health.reasons.length && m.online ? el('p', { class: 'muted' }, m.health.reasons.join('; ')) : null,
    m.kind === 'remote' && m.beacon.state !== 'fresh'
      ? el('p', { class: 'muted' }, `Basic tier: beacon ${m.beacon.state}, Fleet Monitor on that machine: ${m.beacon.remotePlugin}`)
      : null
  ])
}

function render(view) {
  if (!view.ready) {
    app.replaceChildren(el('p', { class: view.error ? 'error' : 'muted' }, view.error ? `Cannot reach the worker: ${view.error}` : 'Loading…'))
    return
  }
  const footer = el('footer', { class: 'muted' }, [
    `${view.mode} polling every ${Math.round(view.intervalMs / 1000)} s`,
    view.cli?.error ? el('span', { class: 'error' }, ` · ${view.cli.error}`) : ` · CLI: ${view.cli?.source ?? '–'}`
  ])
  app.replaceChildren(...view.machines.map((m) => machineCard(m, view)), footer)
}

createFleetBinding(window.orca).subscribe(render)
