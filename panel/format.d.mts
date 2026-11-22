// Types for format.mjs.
export function pct(value: number | null | undefined): string
export function gb(bytes: number | null | undefined): string
export function size(bytes: number | null | undefined): string
export function celsius(value: number | null | undefined): string
export function fahrenheit(value: number | null | undefined): string
export function share(value: number | null | undefined): string
export function loads(load: { one: number; five: number | null; fifteen: number | null } | null | undefined): string
export function duration(seconds: number | null | undefined): string
export function ago(at: number | null | undefined, now?: number): string
export function agoShort(at: number | null | undefined, now?: number): string
export function fillAgo(template: string, at: number | null | undefined, now?: number): string
