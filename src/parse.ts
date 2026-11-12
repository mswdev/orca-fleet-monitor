// Parsers for the JSON the Orca CLI prints with --json. Answers about another machine carry that
// machine's text, so every string and list is bounded here, on the way in (src/bounds.ts).
import {
  boundedNumber,
  clipText,
  COUNT_LIMITS,
  firstEntries,
  isEnvironmentId,
  isPluginKey,
  lastEntries,
  TEXT_LIMITS
} from './bounds.ts'
import type { DiagnosticsSample, WorkspaceUsage } from './model.ts'

export type Envelope =
  | { ok: true; result: unknown; meta: Record<string, unknown> | null }
  | { ok: false; code: string; message: string }

/** The `{ ok, result | error }` envelope. The CLI prints it on stdout even when it exits 1. */
export function parseEnvelope(stdout: string, stderr = ''): Envelope {
  for (const text of [stdout, stderr]) {
    const parsed = parseJsonObject(text)
    if (!parsed) {
      continue
    }
    if (parsed.ok === true) {
      const meta = parsed._meta && typeof parsed._meta === 'object' ? (parsed._meta as Record<string, unknown>) : null
      return { ok: true, result: parsed.result, meta }
    }
    if (parsed.ok === false) {
      const error = (parsed.error ?? {}) as { code?: unknown; message?: unknown }
      return {
        ok: false,
        code: clipText(error.code, TEXT_LIMITS.label, 'cli_error') || 'cli_error',
        message: clipText(error.message, TEXT_LIMITS.message, 'The Orca CLI reported an error')
      }
    }
  }
  const hint = clipText((stderr || stdout).trim().split('\n')[0] ?? '', 200)
  return { ok: false, code: 'bad_output', message: hint || 'The Orca CLI printed no JSON' }
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  if (!trimmed) {
    return null
  }
  const candidates = [trimmed]
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first > 0 && last > first) {
    candidates.push(trimmed.slice(first, last + 1))
  }
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate)
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>
      }
    } catch {
      // try the next candidate
    }
  }
  return null
}

const num = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback
const text = (value: unknown, fallback = '', max: number = TEXT_LIMITS.name): string => clipText(value, max, fallback)
/** Bytes, percentages of one core and load averages beyond these are nonsense, not readings. */
const MAX_BYTES = 2 ** 52
const MAX_CORE_PERCENT = 1_000_000
const MAX_CORES = 4_096
const MAX_LOAD = 1_000_000
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

/** `orca diagnostics memory --json` → a sample, or null when the answer lacks its host block. */
export function parseDiagnostics(envelope: Envelope): DiagnosticsSample | null {
  if (!envelope.ok) {
    return null
  }
  const result = record(envelope.result)
  const host = record(result.host)
  if (!('totalMemory' in host) || num(host.totalMemory) <= 0) {
    return null
  }
  const bytes = (value: unknown, fallback = 0): number => boundedNumber(value, 0, MAX_BYTES, fallback)
  const share = (value: unknown): number => boundedNumber(value, 0, MAX_CORE_PERCENT, 0)
  const total = bytes(host.totalMemory)
  const available = Math.min(total, bytes(host.availableMemory, bytes(host.freeMemory)))
  const used = Math.min(total, bytes(host.usedMemory, total - available))
  const app = record(result.app)
  const workspaces: WorkspaceUsage[] = firstEntries(result.worktrees, COUNT_LIMITS.workspaces).map((entry) => {
    const w = record(entry)
    return {
      id: text(w.worktreeId),
      name: text(w.worktreeName, text(w.worktreeId)),
      repo: text(w.repoName),
      cpu: share(w.cpu),
      memory: bytes(w.memory),
      sessions: Array.isArray(w.sessions) ? w.sessions.length : 0
    }
  })
  const runtimeId = envelope.meta ? clipText(envelope.meta.runtimeId, TEXT_LIMITS.name) || null : null
  return {
    collectedAt: Math.max(0, num(result.collectedAt, 0)),
    runtimeId,
    host: {
      totalMemory: total,
      availableMemory: available,
      usedMemory: used,
      memoryPercent: boundedNumber(host.memoryUsagePercent, 0, 100, total > 0 ? (used / total) * 100 : 0),
      availableMemorySource: text(host.availableMemorySource, 'unknown', TEXT_LIMITS.label),
      cores: Math.round(boundedNumber(host.cpuCoreCount, 1, MAX_CORES, 1)),
      load1: boundedNumber(host.loadAverage1m, 0, MAX_LOAD, 0)
    },
    app: { cpu: share(app.cpu), memory: bytes(app.memory) },
    totalCpu: share(result.totalCpu),
    totalMemory: bytes(result.totalMemory),
    workspaces
  }
}

/** The busiest workspaces by CPU and by memory. */
export function topWorkspaces(
  workspaces: readonly WorkspaceUsage[],
  limit = 5
): { byCpu: WorkspaceUsage[]; byMemory: WorkspaceUsage[] } {
  const byCpu = [...workspaces].filter((w) => w.cpu > 0).sort((a, b) => b.cpu - a.cpu).slice(0, limit)
  const byMemory = [...workspaces]
    .filter((w) => w.memory > 0)
    .sort((a, b) => b.memory - a.memory)
    .slice(0, limit)
  return { byCpu, byMemory }
}

export type EnvironmentEntry = { id: string; name: string; runtimeId: string | null }

/** Paired Orca servers from `orca environment list --json`, one per runtime, minus this one. */
export function parseEnvironments(envelope: Envelope, localRuntimeId: string | null = null): EnvironmentEntry[] {
  if (!envelope.ok) {
    return []
  }
  const list = record(envelope.result).environments
  const out: EnvironmentEntry[] = []
  const seenRuntimes = new Set<string>()
  const seenIds = new Set<string>()
  for (const entry of Array.isArray(list) ? list : []) {
    if (out.length >= COUNT_LIMITS.environments) break
    const e = record(entry)
    // Orca makes the id when a server is paired; anything else could not be passed to the CLI.
    const id = isEnvironmentId(e.id) ? e.id : ''
    if (!id || seenIds.has(id)) {
      continue
    }
    const runtimeId = text(e.runtimeId) || null
    if (runtimeId && (runtimeId === localRuntimeId || seenRuntimes.has(runtimeId))) {
      continue
    }
    seenIds.add(id)
    if (runtimeId) {
      seenRuntimes.add(runtimeId)
    }
    out.push({ id, name: text(e.name, id).trim() || id, runtimeId })
  }
  return out
}

/** The name Orca shows for this computer, from `orca host list --json`: the `local` host's
 *  `machineName`. Null when the answer has none (older Orca, or an error). */
export function parseLocalHostName(envelope: Envelope): string | null {
  if (!envelope.ok) {
    return null
  }
  const hosts = record(envelope.result).hosts
  for (const entry of Array.isArray(hosts) ? hosts : []) {
    const h = record(entry)
    if (h.kind !== 'local') continue
    const name = text(h.machineName).trim()
    return name ? name.slice(0, 128) : null
  }
  return null
}

export type RemotePluginInfo = {
  state: 'running' | 'installed' | 'absent'
  /** Keys to read beacons from, best first. */
  keys: string[]
}

const READABLE_STATUSES = ['running', 'idle']

/**
 * Where Fleet Monitor lives on a machine, from `orca plugin list --json`. The key differs by how
 * it was installed (`<owner>.fleet-monitor` from Git, `local.fleet-monitor` from a folder), so
 * match on the id after the first dot. Running copies come first.
 */
export function findPluginKeys(envelope: Envelope, pluginId: string): RemotePluginInfo | null {
  if (!envelope.ok) {
    return null
  }
  const list = record(envelope.result).plugins
  const matches: { key: string; status: string; isDev: boolean }[] = []
  for (const entry of firstEntries(list, COUNT_LIMITS.plugins)) {
    const p = record(entry)
    // The key goes into a CLI argument (`orca plugin logs <key>`), so only a well-formed one.
    if (!isPluginKey(p.pluginKey, pluginId)) {
      continue
    }
    matches.push({ key: p.pluginKey, status: text(p.status, '', TEXT_LIMITS.label), isDev: p.isDev === true })
  }
  if (matches.length === 0) {
    return { state: 'absent', keys: [] }
  }
  const rank = (status: string): number => {
    const index = READABLE_STATUSES.indexOf(status)
    return index === -1 ? READABLE_STATUSES.length : index
  }
  const readable = matches
    .filter((m) => READABLE_STATUSES.includes(m.status))
    .sort((a, b) => rank(a.status) - rank(b.status) || Number(b.isDev) - Number(a.isDev))
  return {
    state: matches.some((m) => m.status === 'running') ? 'running' : 'installed',
    keys: readable.map((m) => m.key)
  }
}

export type LogLines = { pluginKey: string; lines: unknown[] }

/** `orca plugin logs <key> --json`. An unknown key answers ok with no lines. */
export function parseLogs(envelope: Envelope): LogLines | null {
  if (!envelope.ok) {
    return null
  }
  const result = record(envelope.result)
  return { pluginKey: text(result.pluginKey), lines: lastEntries(result.lines, COUNT_LIMITS.logLines) }
}
