// Types for chart-view.mjs.
import type { Frame } from './charts.mjs'
import type { ChartRule } from './fleet-binding.mjs'

export type ChartSpec = {
  kind: 'detail' | 'spark'
  frame: Frame
  /** Spark only: a second, muted line (upload). */
  second?: Frame | null
  rule: ChartRule | null
  /** The chart's accessible name; null hides it from screen readers. */
  label: string | null
  /** Detail: the window's highest reading, marked where it was. */
  peak?: { t: number; v: number } | null
  /** Detail: a band from each minute's lowest reading to its highest. */
  range?: boolean
  /** Detail: the name of a slider that reads one minute at a time. */
  scrub?: string | null
}

export const MOVE_MS: number
export const RISE_MS: number
export const MAX_GLIDE_MS: number

export function chartSlot(spec: ChartSpec, props?: Record<string, unknown>): HTMLElement

export function createCharts(options?: {
  frame?: ((fn: () => void) => unknown) | null
  clock?: () => number
  motion?: () => boolean
  hidden?: () => boolean
}): {
  sync(root: ParentNode): void
  moving(): number
}
