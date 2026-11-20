// Entry point of the Fleet Monitor panel: binds to the worker through window.orca and draws.
import { followColors } from './colors.mjs'
import { applyHealthContrast } from './contrast.mjs'
import { createFleetBinding, externalOpener } from './fleet-binding.mjs'
import { mountFleetView } from './view.mjs'

const root = document.getElementById('app')
if (root && window.orca?.plugin) {
  applyHealthContrast()
  // The person's own health colours, from Orca's settings, now and whenever they change.
  try {
    followColors(window.orca, () => applyHealthContrast())
  } catch {
    // Fleet Monitor's own colours: never a reason for the panel not to open.
  }
  // Orca restyles the frame in place when the person switches theme, then says so.
  window.orca.on?.('theme', () => applyHealthContrast())
  mountFleetView(root, { binding: createFleetBinding(window.orca), openExternal: externalOpener(window.orca) })
} else if (root) {
  root.textContent = 'Fleet Monitor runs inside Orca.'
}
