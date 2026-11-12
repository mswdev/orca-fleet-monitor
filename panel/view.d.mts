// Types for view.mjs.
import type { FleetBinding, FleetModel } from './fleet-binding.mjs'

export const PAIR_PATH: string
export const REPOSITORY_URL: string

export type FleetViewOptions = {
  /** `watchProcesses` feeds a machine's Activity tab; without it the list stays loading. */
  binding: Pick<FleetBinding, 'current' | 'subscribe' | 'retry' | 'refresh'> & Partial<Pick<FleetBinding, 'watchProcesses'>>
  /** This frame's clock; Date.now when not given. */
  now?: () => number
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
  setTimeout?: (fn: () => void, ms: number) => unknown
  /** Opens a URL in the browser (the frame's `orca.shell.openExternal`); with none, no link is drawn. */
  openExternal?: ((url: string) => unknown) | null
}

export type FleetViewHandle = {
  /** The model last drawn. */
  model(): FleetModel
  /** Shows one machine's detail, or the overview with no id, without moving focus. */
  show(id: string | null): void
  /** Shows a tab of the machine on screen (when it has tabs), without moving focus. */
  showTab(tab: 'overview' | 'activity'): void
  dispose(): void
}

export function mountFleetView(root: HTMLElement, options: FleetViewOptions): FleetViewHandle
