// Limits for what other machines send, and the last check on what crosses to the panel.
//
// A paired Orca server, the answers its CLI relays and the lines in its plugin log are not
// trusted: a hostile or broken machine must not be able to grow the panel's snapshot past Orca's
// limits, slip anything but plain data into it, or turn its text into a command-line argument.

/** Longest text kept from another machine, by what it is. */
export const TEXT_LIMITS = {
  /** Machine, workspace and repository names, and ids. */
  name: 128,
  /** Short labels: an error code, a plugin status, a memory source. */
  label: 64,
  /** Error and diagnostic messages. */
  message: 500
} as const

/** Most entries kept from one list in a CLI answer. */
export const COUNT_LIMITS = {
  /** `orca environment list`: each entry becomes a polled machine. */
  environments: 64,
  /** `orca diagnostics memory`: workspaces on one machine (only the busiest few are shown). */
  workspaces: 1_000,
  /** `orca plugin list`: plugins on one machine. */
  plugins: 256,
  /** `orca plugin logs`: Orca keeps the last 200 lines of a plugin's log. */
  logLines: 400
} as const

/** `value` when it is a string, cut to `max` characters without splitting a surrogate pair. */
export function clipText(value: unknown, max: number, fallback = ''): string {
  if (typeof value !== 'string') return fallback
  if (value.length <= max) return value
  const code = value.charCodeAt(max - 1)
  return value.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max)
}

/** A finite number within [min, max], or `fallback` for anything else. */
export function boundedNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/** The last `max` entries of a list, or none when it is not one. */
export function lastEntries(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value)) return []
  return value.length > max ? value.slice(value.length - max) : value
}

/** The first `max` entries of a list, or none when it is not one. */
export function firstEntries(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value)) return []
  return value.length > max ? value.slice(0, max) : value
}

/** A plugin key Fleet Monitor will pass to `orca plugin logs`: `<publisher>.<pluginId>`, where the
 *  publisher is what Orca derives from a repository owner or `local`. Nothing that could read as
 *  an option (a leading `-`), contain a space or a quote, or run long. */
export function isPluginKey(key: unknown, pluginId: string): key is string {
  if (typeof key !== 'string' || key.length > TEXT_LIMITS.name) return false
  const suffix = `.${pluginId}`
  if (!key.endsWith(suffix)) return false
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(key.slice(0, key.length - suffix.length))
}

/** An environment id Fleet Monitor will pass to `--environment`: letters, digits, `.`, `_` and `-`,
 *  not starting with `-`. Orca makes these ids itself (UUIDs) when a server is paired. */
export function isEnvironmentId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)
}

export type PlainJson = null | boolean | number | string | PlainJson[] | { [key: string]: PlainJson }

const MAX_DEPTH = 32

/**
 * A deep copy holding only what JSON can: null, booleans, finite numbers, strings, arrays and
 * plain objects. Everything else (functions, symbols, class instances, `undefined`, NaN and
 * Infinity) is left out of objects and becomes null in arrays, as JSON.stringify does; so do
 * `__proto__` keys and anything nested deeper than 32 levels. What it returns can always be
 * structured-cloned, which is how Orca hands answers and posts to a panel.
 */
export function plainJson(value: unknown, depth = 0): PlainJson | undefined {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'object' || depth >= MAX_DEPTH) return undefined
  if (Array.isArray(value)) return value.map((item) => plainJson(item, depth + 1) ?? null)
  const proto = Object.getPrototypeOf(value) as unknown
  if (proto !== Object.prototype && proto !== null) return undefined
  const out: { [key: string]: PlainJson } = {}
  for (const key of Object.keys(value)) {
    if (key === '__proto__') continue
    const item = plainJson((value as Record<string, unknown>)[key], depth + 1)
    if (item !== undefined) out[key] = item
  }
  return out
}
