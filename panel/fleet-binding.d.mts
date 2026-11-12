// Types for fleet-binding.mjs: what a Fleet Monitor view is given. A machine is the worker's
// MachineState (src/model.ts) plus its history in columns.
import type { CliInfo, FleetMode, HistoryColumns, MachineView } from '../src/model.ts'

export const HEARTBEAT_MS: number

export type FleetView =
  | { ready: false; error: string | null; machines: [] }
  | {
      ready: true
      error: string | null
      seq: number
      generatedAt: number
      mode: FleetMode
      intervalMs: number
      historyWindowMs: number
      cli: CliInfo | null
      machines: MachineView[]
    }

export type FleetBinding = {
  /** Settles once the first snapshot has arrived or failed. */
  ready: Promise<void>
  current(): FleetView
  refresh(): Promise<void>
  /** Calls `listener` at once with the current view, then after every change. */
  subscribe(listener: (view: FleetView) => void): () => void
  dispose(): void
  _heartbeat(): void
}

export type FleetBindingOptions = {
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
  isVisible?: () => boolean
  onVisibilityChange?: (handler: () => void) => () => void
}

export function mergeColumns(
  base: HistoryColumns | undefined,
  extra: HistoryColumns | undefined,
  windowMs: number
): HistoryColumns

export function createFleetBinding(
  orca: { plugin: { request(name: string, input?: unknown, options?: { timeoutMs?: number }): Promise<any>; on(event: string, handler: (payload: any) => void): { dispose(): void } } },
  options?: FleetBindingOptions
): FleetBinding
