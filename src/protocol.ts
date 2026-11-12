// The panel <-> worker contract, declared once so the worker type-checks against it.
// The html panel (panel/*.mjs) follows the same names by hand.
import type { FleetSnapshot, FleetUpdate, ProcessList } from './model.ts'

export {}

declare module 'orca' {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- declaration merging needs an interface
  interface PluginRequests {
    /** The whole fleet with its history. Counts as a heartbeat. */
    'fleet.snapshot': { output: FleetSnapshot }
    /** "A panel is open": keeps fast polling on for about 15 s more. */
    'fleet.heartbeat': { output: { ok: true; mode: 'fast' | 'slow'; seq: number } }
    /** "Retry connection" on an offline machine: read it now rather than after its back-off. */
    'fleet.retry': { input: { id: string }; output: { ok: boolean } }
    /** One machine's processes: this computer's whole list (read while asked), or a paired Mac's
     *  newest top list. Counts as a heartbeat. */
    'fleet.processes': { input: { id: string }; output: ProcessList }
  }
  // oxlint-disable-next-line typescript/consistent-type-definitions -- declaration merging needs an interface
  interface PluginPanelEvents {
    /** Posted after a poll changes anything, at most about once a second. */
    'fleet.update': FleetUpdate
  }
}
