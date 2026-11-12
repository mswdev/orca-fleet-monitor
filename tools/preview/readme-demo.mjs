// Drives readme-demo.html: the real panel (panel/view.mjs over panel/fleet-binding.mjs) on a
// stand-in for window.orca, with invented readings that are a fixed function of the frame number,
// so the animation is the same on every run.
//
// One reading arrives every TICK_FRAMES frames and stands for the 5 seconds between readings in
// Orca, so the clip runs at five times real speed. The panel's clock is the frame number too.
//
// Only CPU, load and the workspaces' CPU move. Memory stays as tools/preview/sample-fleet.mjs
// gives it, so this file needs no change when the sample's memory figures do. Network, disk, GPU,
// battery and the process lists are activity-sample.mjs's, and hold still.
//
// For the capture script (tools/preview/shoot-readme.mjs):
//   demo.ready, demo.fps, demo.frames
//   demo.pointer(n)  where the pointer is in frame n and whether it is pressed; the script replays
//                    it as real mouse input, so the panel's own hover and click handling runs
//   demo.frame(n)    draws frame n (ask for frames in order)
import { applyHealthContrast } from '../../panel/contrast.mjs'
import { createFleetBinding } from '../../panel/fleet-binding.mjs'
import { mountFleetView } from '../../panel/view.mjs'
import { sampleActivitySnapshot, sampleProcesses } from './activity-sample.mjs'
import * as sample from './sample-fleet.mjs'

const { FLEET, sampleSnapshot } = sample
const FPS = 10
const TICK_FRAMES = 10
const TICK_MS = 5_000
const START = Date.UTC(2026, 0, 15, 10, 0, 0)

const theme = new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light'
document.documentElement.classList.add(theme)
applyHealthContrast()

// --- invented readings ---------------------------------------------------------------------------

const BASE = structuredClone(FLEET.machines)
/** A smooth value in -1..1 for reading `k`, different for each `seed`. */
const sway = (seed, k) => 0.62 * Math.sin(k * 0.9 + seed * 2.3) + 0.38 * Math.sin(k * 0.41 + seed * 5.1)
const clamp = (value) => Math.min(100, Math.max(0, value))
const round1 = (value) => Math.round(value * 10) / 10

/** The CPU thresholds the sample is judged on. A machine's CPU moves only inside the level its
 *  sample figure is in, so its health and the reason shown for it never flip mid-clip. */
const LIMITS = sample.SAMPLE_THRESHOLDS?.cpu ?? { busy: 70, strained: 85, critical: 95 }
function cpuRange(pct) {
  const edges = [0, LIMITS.busy, LIMITS.strained, LIMITS.critical, 100.5]
  const i = Math.max(0, edges.findLastIndex((edge) => pct >= edge))
  const [low, high] = [edges[i], edges[Math.min(i + 1, edges.length - 1)]]
  const swing = Math.max(0.5, Math.min(i === 0 ? 5 : 2.6, (high - low) / 2 - 0.6))
  return { centre: Math.min(high - swing - 0.6, Math.max(low + swing + 0.6, pct)), swing }
}

/** Sets the sample fleet to reading `k`. */
function setReading(k) {
  FLEET.machines.forEach((machine, i) => {
    const base = BASE[i]
    if (!base?.online || typeof base.cpu?.pct !== 'number') return
    const { centre, swing } = cpuRange(base.cpu.pct)
    const pct = round1(centre + swing * sway(i + 1, k))
    const delta = pct - base.cpu.pct
    machine.cpu.pct = pct
    if (Array.isArray(base.cpu.cores)) {
      machine.cpu.cores = base.cpu.cores.map((group, g) => ({
        ...group,
        load: group.load.map((value, c) => Math.round(clamp(value + delta + 4 * sway(i * 31 + g * 17 + c + 7, k))))
      }))
    }
    // A full machine's load average drifts a little. A basic machine's CPU is its 1-minute load
    // average over its cores, so there the two move together.
    if (Array.isArray(base.load)) {
      machine.load = Array.isArray(base.cpu.cores)
        ? [Math.round((base.load[0] + 0.35 * sway(i + 40, k)) * 100) / 100, ...base.load.slice(1)]
        : [Math.round(pct * (base.cores ?? 1)) / 100]
    }
    if (Array.isArray(base.workspaces)) {
      machine.workspaces = base.workspaces.map((w, n) => ({ ...w, cpu: Math.max(1, Math.round(w.cpu * (pct / base.cpu.pct) + 0.8 * sway(i * 13 + n + 3, k))) }))
    }
  })
}

// --- a stand-in for window.orca and the clock ----------------------------------------------------

let clock = START
let seq = 1
const handlers = new Set()
const orca = {
  api: Object.freeze({ major: 1, minor: 6 }),
  locale: 'en',
  plugin: {
    request(name, input) {
      if (name === 'fleet.snapshot') return Promise.resolve({ ...sampleActivitySnapshot(clock), seq })
      if (name === 'fleet.processes') return Promise.resolve(sampleProcesses(input?.id, START))
      if (name === 'fleet.heartbeat') return Promise.resolve({ ok: true, mode: 'fast', seq })
      return Promise.resolve({ ok: true })
    },
    on(event, handler) {
      if (event === 'fleet.update') handlers.add(handler)
      return { dispose: () => handlers.delete(handler) }
    }
  }
}

/** Posts reading `k` the way the worker posts a `fleet.update`. */
function post(k) {
  setReading(k)
  seq += 1
  const snapshot = sampleActivitySnapshot(clock)
  const appended = {}
  for (const m of snapshot.machines) {
    if (!m.online) continue
    appended[m.id] = { t: [clock], cpu: [m.cpu?.percent ?? null], mem: [m.memory?.percent ?? null] }
    for (const key of ['rx', 'tx', 'gpu']) if (Array.isArray(m.history[key])) appended[m.id][key] = [m.history[key].at(-1)]
  }
  const machines = snapshot.machines.map(({ history, ...m }) => ({ ...m, lastSeenAt: m.online ? clock : m.lastSeenAt }))
  const update = { ...snapshot, seq, generatedAt: clock, recentMs: 30_000, machines, appended }
  for (const handler of handlers) handler(update)
}

setReading(0)
/** The machine the clip opens: the busiest remote one at the full level, whatever its id. */
const opened = sampleSnapshot('live', clock)
  .machines.filter((m) => m.kind === 'remote' && m.online && m.tier === 'full')
  .sort((a, b) => (b.cpu?.percent ?? 0) - (a.cpu?.percent ?? 0))[0]
if (!opened) {
  document.documentElement.setAttribute('data-error', 'demo: the sample fleet has no online remote machine at the full level')
  throw new Error('no machine to open')
}

window.orca = orca
// The panel's timers are run by hand, once a frame, so nothing depends on how long a capture takes.
let everySecond = () => {}
const binding = createFleetBinding(orca, { now: () => clock, setInterval: () => 0, clearInterval: () => {} })
mountFleetView(document.getElementById('app'), {
  binding,
  now: () => clock,
  setInterval: (fn) => {
    everySecond = fn
    return 0
  },
  clearInterval: () => {}
})

// --- the script: where the pointer goes, what it clicks, when the page scrolls ---------------------

/** Off the right edge: the pointer comes in from there and leaves that way. */
const REST = { x: window.innerWidth + 24, y: Math.round(window.innerHeight * 0.64) }
const centreOf = (selector) => {
  const rect = document.querySelector(selector)?.getBoundingClientRect()
  return rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } : null
}
/** Pointer moves, each over frames `from`..`to`, to where `target` is when the move starts: in to
 *  a machine's card, to its Activity tab, out of the way while the list scrolls, to Overview, in
 *  to Back, and out again. */
const MOVES = [
  { from: 9, to: 19, target: () => centreOf(`[data-action="open"][data-id="${CSS.escape(opened.id)}"]`) },
  { from: 27, to: 35, target: () => centreOf('[data-tab="activity"]') },
  { from: 41, to: 47, target: () => REST },
  { from: 63, to: 71, target: () => centreOf('[data-tab="overview"]') },
  { from: 79, to: 87, target: () => centreOf('[data-action="back"]') },
  { from: 93, to: 100, target: () => REST }
]
/** Frames on which the button is held down; the click lands when it comes up. */
const PRESSES = [22, 38, 74, 90]
/** The Activity tab is taller than the panel: its list scrolls part of the way over these frames. */
const SCROLL = { from: 49, to: 59, share: 0.5 }
const FRAMES = 104

const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)
const positions = [REST]
function pointerAt(n) {
  for (let i = positions.length; i <= n; i += 1) {
    const move = MOVES.find((m) => i >= m.from && i <= m.to)
    if (!move) {
      positions[i] = positions[i - 1]
      continue
    }
    if (i === move.from) {
      move.start = positions[i - 1]
      move.end = move.target()
      if (!move.end) throw new Error(`demo: nothing to point at in frame ${i} (the panel's markup changed?)`)
    }
    const t = ease((i - move.from + 1) / (move.to - move.from + 1))
    positions[i] = { x: Math.round(move.start.x + (move.end.x - move.start.x) * t), y: Math.round(move.start.y + (move.end.y - move.start.y) * t) }
  }
  return positions[n]
}

const pointer = document.getElementById('pointer')
const ring = document.getElementById('ring')
const painted = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))

await binding.ready
window.demo = {
  ready: true,
  fps: FPS,
  frames: FRAMES,
  pointer(n) {
    return { ...pointerAt(n), down: PRESSES.includes(n) }
  },
  async frame(n) {
    clock = START + Math.round((n * TICK_MS) / TICK_FRAMES)
    if (n % TICK_FRAMES === 0) post(n / TICK_FRAMES)
    everySecond()
    if (document.querySelector('#fm-tab-activity[aria-selected="true"]') && n >= SCROLL.from && n <= SCROLL.to) {
      const end = document.documentElement.scrollHeight - window.innerHeight
      const t = ease(Math.min(1, (n - SCROLL.from + 1) / (SCROLL.to - SCROLL.from + 1)))
      window.scrollTo(0, Math.round(end * SCROLL.share * t))
    }
    const at = pointerAt(n)
    const sincePress = Math.min(...PRESSES.map((p) => (n >= p ? n - p : Infinity)))
    pointer.style.transform = `translate(${at.x - 2}px, ${at.y - 1}px) scale(${sincePress === 0 ? 0.86 : 1})`
    ring.style.transform = `translate(${at.x}px, ${at.y}px) scale(${0.5 + 0.28 * sincePress})`
    ring.style.opacity = sincePress <= 3 ? String(0.9 - 0.25 * sincePress) : '0'
    await painted()
  }
}
