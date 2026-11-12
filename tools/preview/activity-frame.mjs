// Boots the real panel (panel/view.mjs) on the invented 1.2 sample (activity-sample.mjs) and puts
// it in one of the 1.2 states, the way a person would get there: open a machine, click Activity,
// type a search, pick a sort, open a row.
//
// Query: state=<one of STATES>, or machine=<id> [tab=activity] [install=open]; theme=light|dark
import { applyHealthContrast } from '../../panel/contrast.mjs'
import { createFleetBinding } from '../../panel/fleet-binding.mjs'
import { mountFleetView } from '../../panel/view.mjs'
import { sampleActivitySnapshot, sampleProcesses } from './activity-sample.mjs'
import { STATES } from './activity-states.mjs'

const params = new URLSearchParams(location.search)
const theme = params.get('theme') === 'dark' ? 'dark' : 'light'
document.documentElement.classList.add(theme)
applyHealthContrast()

// A named state, or the old frame's way of asking: machine=<id> (its detail), tab=activity,
// install=open (a basic machine's install row), and nothing for the overview.
const state = STATES[params.get('state') ?? ''] ?? {
  machine: params.get('machine') ?? null,
  tab: params.get('tab') === 'activity' ? 'activity' : undefined,
  install: params.get('install') === 'open'
}
// One clock for the page, so a process's start time (and so its row) is the same in every list.
const base = Date.now()
const snapshot = sampleActivitySnapshot(base, state.scene ?? '')
/** A stand-in for the frame's `window.orca`, answering as the worker does; the real binding
 *  (fleet-binding.mjs) runs over it, so the preview goes through toFleet and watchProcesses. */
const orca = {
  api: Object.freeze({ major: 1, minor: 6 }),
  host: { has: () => false },
  plugin: {
    request(name, input) {
      if (name === 'fleet.snapshot') return Promise.resolve({ ...snapshot, seq: 1 })
      if (name === 'fleet.heartbeat') return Promise.resolve({ ok: true, mode: 'fast', seq: 1 })
      if (name === 'fleet.processes') return state.loading ? new Promise(() => {}) : Promise.resolve(sampleProcesses(input?.id, base))
      return Promise.reject(Object.assign(new Error(`no handler for ${name}`), { code: 'unknown_method' }))
    },
    on: () => ({ dispose() {} })
  }
}
const binding = createFleetBinding(orca)
const panel = mountFleetView(document.getElementById('app'), { binding })
await binding.ready

const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()))
async function act() {
  if (state.machine) panel.show(state.machine)
  if (state.tab) panel.showTab(state.tab)
  if (state.install) document.querySelector('[data-action="install"]')?.click()
  await frame()
  if (state.search) {
    const input = document.querySelector('[data-input="search"]')
    input.value = state.search
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  if (state.sort) {
    const select = document.querySelector('[data-input="sort"]')
    select.value = state.sort
    select.dispatchEvent(new Event('change', { bubbles: true }))
  }
  // The first list arrives a moment after the tab opens.
  if (state.tab && !state.loading) for (let i = 0; i < 50 && !document.querySelector('.fm-proc-row, .fm-proc-empty'); i += 1) await frame()
  if (state.open !== undefined) document.querySelectorAll('.fm-proc-row')[state.open]?.click()
  // Nothing keeps focus or hover in a picture.
  document.activeElement?.blur?.()
  await frame()
  await frame()
  document.documentElement.setAttribute('data-preview-ready', '')
}
void act()
