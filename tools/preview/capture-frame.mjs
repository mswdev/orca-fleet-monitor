// Boots the real panel on a snapshot captured from a real worker (tools/capture-snapshot.ts), so a
// computer's own view of every machine, and another computer's view of it, can be looked at with
// real figures. The page's clock is set back to when the capture was taken, so nothing reads as
// old. Captures hold real names: keep them under .orca/ (ignored by git).
//
// Query: file=<path from the repository root>  machine=<id> (opens its detail)  tab=activity
//        open=<row index> (opens a process)  theme=light|dark  all=1 (Show all)
import { applyHealthContrast } from '../../panel/contrast.mjs'
import { createFleetBinding } from '../../panel/fleet-binding.mjs'
import { mountFleetView } from '../../panel/view.mjs'

const params = new URLSearchParams(location.search)
const theme = params.get('theme') === 'dark' ? 'dark' : 'light'
document.documentElement.classList.add(theme)
applyHealthContrast()

const capture = await (await fetch(`/${params.get('file')}`)).json()
const realNow = Date.now.bind(Date)
const offset = realNow() - capture.capturedAt
Date.now = () => realNow() - offset

const orca = {
  api: Object.freeze({ major: 1, minor: 6 }),
  host: { has: () => false },
  plugin: {
    request(name, input) {
      if (name === 'fleet.snapshot') return Promise.resolve({ ...capture.snapshot, seq: 1 })
      if (name === 'fleet.heartbeat') return Promise.resolve({ ok: true, mode: 'fast', seq: 1 })
      if (name === 'fleet.processes') {
        const answer = capture.processes[input?.id]
        return answer ? Promise.resolve(answer) : Promise.reject(Object.assign(new Error('not captured'), { code: 'unavailable' }))
      }
      return Promise.reject(Object.assign(new Error(`no handler for ${name}`), { code: 'unknown_method' }))
    },
    on: () => ({ dispose() {} })
  }
}
const binding = createFleetBinding(orca)
const panel = mountFleetView(document.getElementById('app'), { binding })
await binding.ready

const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()))
const machine = params.get('machine')
if (machine) panel.show(machine)
if (params.get('tab') === 'activity') panel.showTab('activity')
await frame()
if (params.get('tab') === 'activity') for (let i = 0; i < 50 && !document.querySelector('.fm-proc-row, .fm-proc-empty'); i += 1) await frame()
if (params.get('all') === '1') document.querySelector('[data-action="show-all"], [data-action="more"]')?.click()
if (params.get('open') !== null) document.querySelectorAll('.fm-proc-row')[Number(params.get('open'))]?.click()
document.activeElement?.blur?.()
await frame()
await frame()
document.documentElement.setAttribute('data-preview-ready', '')
