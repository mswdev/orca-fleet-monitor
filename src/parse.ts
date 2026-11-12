// Parsers for the JSON the Orca CLI prints with --json.
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
        code: typeof error.code === 'string' ? error.code : 'cli_error',
        message: typeof error.message === 'string' ? error.message : 'The Orca CLI reported an error'
      }
    }
  }
  const hint = (stderr || stdout).trim().split('\n')[0]?.slice(0, 200) ?? ''
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
const text = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback)
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
  const total = num(host.totalMemory)
  const available = Math.min(total, Math.max(0, num(host.availableMemory, num(host.freeMemory))))
  const used = Math.max(0, num(host.usedMemory, total - available))
  const app = record(result.app)
  const worktrees = Array.isArray(result.worktrees) ? result.worktrees : []
  const workspaces: WorkspaceUsage[] = worktrees.map((entry) => {
    const w = record(entry)
    return {
      id: text(w.worktreeId),
      name: text(w.worktreeName, text(w.worktreeId)),
      repo: text(w.repoName),
      cpu: Math.max(0, num(w.cpu)),
      memory: Math.max(0, num(w.memory)),
      sessions: Array.isArray(w.sessions) ? w.sessions.length : 0
    }
  })
  const runtimeId = envelope.meta && typeof envelope.meta.runtimeId === 'string' ? envelope.meta.runtimeId : null
  return {
    collectedAt: num(result.collectedAt, 0),
    runtimeId,
    host: {
      totalMemory: total,
      availableMemory: available,
      usedMemory: used,
      memoryPercent: Math.min(100, Math.max(0, num(host.memoryUsagePercent, total > 0 ? (used / total) * 100 : 0))),
      availableMemorySource: text(host.availableMemorySource, 'unknown'),
      cores: Math.max(1, Math.round(num(host.cpuCoreCount, 1))),
      load1: Math.max(0, num(host.loadAverage1m))
    },
    app: { cpu: Math.max(0, num(app.cpu)), memory: Math.max(0, num(app.memory)) },
    totalCpu: Math.max(0, num(result.totalCpu)),
    totalMemory: Math.max(0, num(result.totalMemory)),
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
    const e = record(entry)
    const id = text(e.id)
    if (!id || seenIds.has(id)) {
      continue
    }
    const runtimeId = typeof e.runtimeId === 'string' && e.runtimeId ? e.runtimeId : null
    if (runtimeId && (runtimeId === localRuntimeId || seenRuntimes.has(runtimeId))) {
      continue
    }
    seenIds.add(id)
    if (runtimeId) {
      seenRuntimes.add(runtimeId)
    }
    out.push({ id, name: text(e.name, id) || id, runtimeId })
  }
  return out
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
  for (const entry of Array.isArray(list) ? list : []) {
    const p = record(entry)
    const key = text(p.pluginKey)
    const dot = key.indexOf('.')
    if (dot <= 0 || key.slice(dot + 1) !== pluginId) {
      continue
    }
    matches.push({ key, status: text(p.status), isDev: p.isDev === true })
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
  return { pluginKey: text(result.pluginKey), lines: Array.isArray(result.lines) ? result.lines : [] }
}
