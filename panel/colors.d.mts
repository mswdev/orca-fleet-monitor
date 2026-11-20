export type Level = 'ok' | 'busy' | 'strained' | 'critical'
export type Colors = Record<Level, string | null>
type Doc = { documentElement: { style: { setProperty(name: string, value: string): void; removeProperty(name: string): string }; getAttribute(name: string): string | null; setAttribute(name: string, value: string): void; removeAttribute(name: string): void } }
type Settings = { get(): Promise<Record<string, unknown>>; onDidChange?(listener: (change: { key: string }) => void): { dispose(): void } }

export const LEVELS: readonly Level[]
export const COLOR_SETTINGS: Readonly<Record<Level, string>>
export function colorOf(value: unknown, knows?: (name: string) => boolean): string | null
export function colorsOf(settings: Record<string, unknown> | null | undefined, knows?: (name: string) => boolean): Colors
export function applyColors(colors: Partial<Colors> | null | undefined, doc?: Doc): Level[]
export function chosenColor(level: Level, doc?: Doc): boolean
export function followColors(orca: { settings?: Settings } | null | undefined, after?: () => void, doc?: Doc, knows?: (name: string) => boolean): { ready: Promise<void>; dispose(): void }
