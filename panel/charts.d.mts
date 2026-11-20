// Types for charts.mjs.
import type { ChartRule, ChartLevel, Trend } from './fleet-binding.mjs'

/** A point of a frame: `key` is its minute's number, or 'live' for the newest reading. */
export type FramePoint = { key: number | 'live'; t: number; v: number; lo: number; hi: number }
/** What a chart shows: the window's ends (worker clock), the readings in it, and its points. */
export type Frame = { start: number; end: number; count: number; points: FramePoint[] }
export type PlacedPoint = FramePoint & { x: number; y: number; yLo: number; yHi: number }
export type Stop = { offset: number; level: ChartLevel | 'ok'; opacity: number }

export const GAP_MS: number
export function frameOf(trend: Trend | null | undefined, end: number, windowMs: number): Frame
export function yOf(value: number, h: number, pad: number): number
export function placeFrame(frame: Frame | null | undefined, w: number, h: number, pad?: number): PlacedPoint[][]
export function monotone(points: readonly { x: number; [y: string]: number | string }[], yKey?: string): string
export function linePath(runs: readonly PlacedPoint[][]): string
export function areaPath(runs: readonly PlacedPoint[][], base: number): string
export function rangePath(runs: readonly PlacedPoint[][]): string
export function levelStops(rule: ChartRule | null | undefined, h: number, pad: number, options?: { top?: number; bottom?: number; bias?: number }): Stop[]
export function levelOf(value: number, rule: ChartRule | null | undefined): ChartLevel | 'ok'
export function tweenFrame(from: Frame | null | undefined, to: Frame, k: number): Frame
export function easeOut(k: number): number
