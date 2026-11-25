// Types for reorder.mjs.
export const ORDER_KEY: string
export const DRAG_PX: number
export const TOUCH_HOLD_MS: number
export const TOUCH_SLOP_PX: number
export const DROP_MS: number

export function inOrder<T extends { id: string }>(machines: T[], order: string[] | null | undefined): T[]
export function moved(ids: string[], id: string, to: number): string[]
export function mergeOrder(shown: string[], saved: string[] | null | undefined): string[]

export type OrderStore = {
  /** The kept order, or null when nothing was kept. */
  load(): string[] | null
  save(ids: string[]): void
  /** Another panel changed it; returns a function that stops listening. */
  onChange?(listener: () => void): () => void
}

export function createOrderStore(storage?: Pick<Storage, 'getItem' | 'setItem'> | null): Required<OrderStore>

type Box = { offsetLeft: number; offsetTop: number; offsetWidth: number; offsetHeight: number }
export function targetIndex<T extends Box>(cards: T[], dragged: T, point: { x: number; y: number }): number

export type CardDrag = {
  dragging(): string | null
  sync(): void
  consumeClick(event?: { detail?: number }): boolean
  cancel(): boolean
  dispose(): void
}

export function createCardDrag(options: {
  root: HTMLElement
  doc?: Document
  win?: Window | null
  canDrag?: () => boolean
  begin?: (id: string) => void
  move?: (ids: string[]) => void
  end?: (commit: boolean) => void
  later?: (fn: () => void, ms: number) => unknown
  frame?: ((fn: () => void) => unknown) | null
  motion?: () => boolean
}): CardDrag
