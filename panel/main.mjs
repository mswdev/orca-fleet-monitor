// Entry point of the Fleet Monitor panel: binds to the worker through window.orca and draws.
import { applyHealthContrast } from './contrast.mjs'
import { createFleetBinding, externalOpener } from './fleet-binding.mjs'
import { mountFleetView } from './view.mjs'

const root = document.getElementById('app')
if (root && window.orca?.plugin) {
  applyHealthContrast()
  // Orca restyles the frame in place when the person switches theme, then says so.
  window.orca.on?.('theme', () => applyHealthContrast())
  mountFleetView(root, { binding: createFleetBinding(window.orca), openExternal: externalOpener(window.orca) })
} else if (root) {
  root.textContent = 'Fleet Monitor runs inside Orca.'
}
