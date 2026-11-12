// Types for view.mjs.
import type { FleetBinding, FleetModel } from './fleet-binding.mjs'

export const PAIR_PATH: string

export type FleetViewOptions = {
  binding: Pick<FleetBinding, 'current' | 'subscribe' | 'retry' | 'refresh'>
  /** This frame's clock; Date.now when not given. */
  now?: () => number
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
  setTimeout?: (fn: () => void, ms: number) => unknown
}

export type FleetViewHandle = {
  /** The model last drawn. */
  model(): FleetModel
  /** Shows one machine's detail, or the overview with no id, without moving focus. */
  show(id: string | null): void
  dispose(): void
}

export function mountFleetView(root: HTMLElement, options: FleetViewOptions): FleetViewHandle
