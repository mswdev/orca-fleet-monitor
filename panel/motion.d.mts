// Types for motion.mjs.
export const COUNT_MS: number
export const SLIDE_MS: number
export const MAX_SLIDING: number

export function createMotion(options?: {
  frame?: ((fn: () => void) => unknown) | null
  clock?: () => number
  motion?: () => boolean
  hidden?: () => boolean
}): {
  measure(root: ParentNode): void
  settle(root: ParentNode, options?: { moved?: boolean }): void
  counting(): number
}
