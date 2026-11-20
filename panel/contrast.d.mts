// Types for contrast.mjs.
export type Rgb = readonly [number, number, number] | number[]
export const LEVELS: readonly string[]
export const MIN_TEXT_CONTRAST: number
export const MIN_GRAPHIC_CONTRAST: number
export function luminance(rgb: Rgb): number
export function contrastRatio(a: Rgb, b: Rgb): number
export function needsStrongerHealth(health: (Rgb | null)[], surfaces: (Rgb | null)[], min?: number): boolean
export function worstContrast(colour: Rgb | null, surfaces: (Rgb | null)[]): number
export function bestOn(candidates: (Rgb | null)[], surfaces: (Rgb | null)[]): Rgb | null
export function applyHealthContrast(doc?: Document): boolean
