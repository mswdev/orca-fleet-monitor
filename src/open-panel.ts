// "Show Fleet Monitor", the command behind the status bar item. Orca has no host call that opens a
// plugin's panel, but its CLI does (`orca plugin open <key> --panel <id>`, documented for exactly
// this: showing a panel to the person), and the worker already runs that CLI for everything else.
//
// The CLI needs this copy's plugin key, which a worker is not told. An installed copy lives in
// Orca's data folder as `plugins/<publisher>.<id>/<content hash>/`; a development folder loads as
// `local.<id>`. The worker's own file path gives the first guess, and `orca plugin list` (this
// machine) confirms it.
import type { CommandRunner } from './cli.ts'
import { parseEnvelope } from './parse.ts'

export const SHOW_COMMAND_ID = 'fleet.show'
export const PANEL_ID = 'fleet'

/** The key implied by where the worker file is, or null for anything that is not an install. */
export function pluginKeyFromPath(file: string, pluginId: string): string | null {
  const parts = file.split(/[\\/]+/)
  for (let i = parts.length - 2; i >= 1; i -= 1) {
    const segment = parts[i]!
    const next = parts[i + 1] ?? ''
    if (parts[i - 1] === 'plugins' && segment.endsWith(`.${pluginId}`) && /^([0-9a-f]{16,}|current)$/i.test(next)) {
      return segment
    }
  }
  return null
}

type Listed = { key: string; status: string; isDev: boolean; panels: boolean }

function listed(stdout: string, stderr: string, pluginId: string): Listed[] {
  const envelope = parseEnvelope(stdout, stderr)
  if (!envelope.ok) return []
  const result = envelope.result as { plugins?: unknown } | null
  const plugins = Array.isArray(result?.plugins) ? result.plugins : []
  const out: Listed[] = []
  for (const entry of plugins) {
    const p = (entry ?? {}) as Record<string, unknown>
    const key = typeof p.pluginKey === 'string' ? p.pluginKey : ''
    if (!key.endsWith(`.${pluginId}`)) continue
    out.push({
      key,
      status: typeof p.status === 'string' ? p.status : '',
      isDev: p.isDev === true,
      panels: Array.isArray(p.panels) ? p.panels.length > 0 : true
    })
  }
  return out
}

/** Picks this copy among the Fleet Monitors Orca lists: the path's key when listed, else the only
 *  running one, else the development copy when this is not an install. */
export function chooseOwnKey(candidates: readonly Listed[], pathKey: string | null, pluginId: string): string | null {
  const usable = candidates.filter((c) => (c.status === 'running' || c.status === 'idle') && c.panels)
  if (pathKey && usable.some((c) => c.key === pathKey)) return pathKey
  if (usable.length === 1) return usable[0]!.key
  if (!pathKey) {
    const dev = usable.find((c) => c.isDev) ?? usable.find((c) => c.key === `local.${pluginId}`)
    if (dev) return dev.key
  }
  return usable[0]?.key ?? pathKey ?? null
}

/** Shows this plugin's panel in Orca's right sidebar. Throws when it cannot (Orca then says the
 *  command failed); never brings the window forward, as `orca plugin open` never does. */
export async function openOwnPanel(run: CommandRunner, pluginId: string, workerFile: string | null): Promise<void> {
  const pathKey = workerFile ? pluginKeyFromPath(workerFile, pluginId) : null
  const list = await run(['plugin', 'list', '--json'], { timeoutMs: 10_000 })
  const key = chooseOwnKey(listed(list.stdout, list.stderr, pluginId), pathKey, pluginId)
  if (!key) throw new Error('Fleet Monitor could not find itself in `orca plugin list`')
  const opened = await run(['plugin', 'open', key, '--panel', PANEL_ID, '--json'], { timeoutMs: 10_000 })
  const envelope = parseEnvelope(opened.stdout, opened.stderr)
  if (!envelope.ok) throw new Error(`orca plugin open failed: ${envelope.message}`)
}
