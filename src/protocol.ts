// The panel <-> worker contract, declared once so the worker type-checks against it.
// The html panel (panel/*.mjs) follows the same names by hand.
import type { FleetSnapshot, FleetUpdate } from './model.ts'

export {}

declare module 'orca' {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- declaration merging needs an interface
  interface PluginRequests {
    /** The whole fleet with its history. Counts as a heartbeat. */
    'fleet.snapshot': { output: FleetSnapshot }
    /** "A panel is open": keeps fast polling on for about 15 s more. */
    'fleet.heartbeat': { output: { ok: true; mode: 'fast' | 'slow'; seq: number } }
  }
  // oxlint-disable-next-line typescript/consistent-type-definitions -- declaration merging needs an interface
  interface PluginPanelEvents {
    /** Posted after a poll changes anything, at most about once a second. */
    'fleet.update': FleetUpdate
  }
}
