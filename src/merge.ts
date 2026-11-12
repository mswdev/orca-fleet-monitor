// Merges what we know about one machine (local sample, Orca diagnostics, remote beacon) into
// the single model the panel and status bar read.
import { assessHealth, type HealthSettings } from './health.ts'
import type {
  BeaconRecord,
  BeaconState,
  DiagnosticsSample,
  HistoryPoint,
  LocalSample,
  MachineState
} from './model.ts'
import { topWorkspaces } from './parse.ts'
import { clampPercent } from './sampler.ts'

export type MergeInput = {
  id: string
  name: string
  kind: 'local' | 'remote'
  now: number
  status: MachineState['status']
  lastSeenAt: number | null
  latencyMs: number | null
  error: string | null
  /** This machine's own sampler; only for the local machine. */
  local?: LocalSample | null
  /** The last good diagnostics, carried forward between polls. */
  diag?: DiagnosticsSample | null
  beacon?: {
    latest: BeaconRecord | null
    fresh: boolean
    ageMs: number | null
    pluginKey: string | null
    remotePlugin: BeaconState['remotePlugin']
  } | null
  health: HealthSettings
  topLimit?: number
}

/** CPU estimated from the 1-minute load average when nothing measures it directly. Load is not
 *  CPU use (it counts waiting threads too), so this is shown labelled and never judged. */
export function loadEstimate(load1: number, cores: number): number {
  return clampPercent((load1 / Math.max(1, cores)) * 100)
}

/**
 * Whether a machine's diagnostics carry a real load average. Windows has none: Node reports 0 there,
 * and so does Orca. Orca's diagnostics do not name the platform, but they do say how available
 * memory was measured, and only Windows (or a Unix host whose own measure failed) reports
 * `free-memory`. So a load of exactly 0 from such a host, or from a machine whose last beacon said
 * win32, is "not reported" rather than idle.
 */
export function loadReported(host: DiagnosticsSample['host'], platformHint: string | null = null): boolean {
  if (host.load1 > 0) return true
  return platformHint !== 'win32' && host.availableMemorySource !== 'free-memory'
}

export function mergeMachine(input: MergeInput): MachineState {
  const { local, diag } = input
  const beacon = input.beacon ?? null
  const fresh = beacon?.fresh && beacon.latest ? beacon.latest : null
  const known = local ?? beacon?.latest ?? null

  let cpu: MachineState['cpu'] = { percent: null, source: null, perCore: null, groups: null }
  if (local?.cpu) {
    cpu = { percent: local.cpu.total, source: 'sampler', perCore: local.cpu.perCore, groups: local.coreGroups ?? null }
  } else if (fresh && fresh.cpu !== null) {
    cpu = {
      percent: fresh.cpu,
      source: 'beacon',
      perCore: fresh.perCore,
      groups: fresh.perCore ? fresh.coreGroups : null
    }
  } else if (diag) {
    const reported = loadReported(diag.host, beacon?.latest?.platform ?? null)
    cpu = { percent: reported ? loadEstimate(diag.host.load1, diag.host.cores) : null, source: 'load', perCore: null, groups: null }
  }

  let memory: MachineState['memory'] = null
  if (diag) {
    memory = {
      total: diag.host.totalMemory,
      used: diag.host.usedMemory,
      available: diag.host.availableMemory,
      percent: diag.host.memoryPercent,
      source: 'orca',
      reliable: true
    }
  } else {
    const os = local
      ? { total: local.memory.total, free: local.memory.free, platform: local.platform }
      : fresh
        ? { total: fresh.memTotal, free: fresh.memFree, platform: fresh.platform }
        : null
    if (os && os.total > 0) {
      memory = {
        total: os.total,
        used: os.total - os.free,
        available: os.free,
        percent: clampPercent(((os.total - os.free) / os.total) * 100),
        source: 'os',
        // os.freemem() on macOS leaves out reclaimable cache, so it reads near full.
        reliable: os.platform !== 'darwin'
      }
    }
  }

  let load: MachineState['load'] = null
  const loadSource = local?.load ?? fresh?.load ?? null
  // Windows has no load average; Node reports 0s there, which are not readings.
  if (loadSource && (local?.platform ?? fresh?.platform) !== 'win32') {
    load = { one: loadSource[0], five: loadSource[1], fifteen: loadSource[2] }
  } else if (diag && loadReported(diag.host, beacon?.latest?.platform ?? null)) {
    load = { one: diag.host.load1, five: null, fifteen: null }
  }

  const online = input.kind === 'local' ? true : input.status === 'online'
  const state: MachineState = {
    id: input.id,
    name: input.name,
    kind: input.kind,
    tier: input.kind === 'local' || fresh ? 'full' : 'basic',
    status: input.kind === 'local' ? 'online' : input.status,
    online,
    // The local machine is always reachable; its readings are as new as its last sample (the
    // poller passes when it saw that sample, on its own clock).
    lastSeenAt: input.kind === 'local' ? (input.lastSeenAt ?? input.now) : input.lastSeenAt,
    latencyMs: input.latencyMs,
    error: input.error,
    host: {
      hostname: known?.hostname || null,
      platform: known?.platform || null,
      arch: known?.arch || null,
      cpuModel: known?.cpuModel || null,
      cores: known?.cores ?? diag?.host.cores ?? null,
      uptimeSec: local ? local.uptimeSec : fresh ? fresh.uptimeSec : null
    },
    cpu,
    memory,
    load,
    orca: diag
      ? { cpu: diag.app.cpu, memory: diag.app.memory, totalCpu: diag.totalCpu, totalMemory: diag.totalMemory }
      : null,
    workspaces: diag ? topWorkspaces(diag.workspaces, input.topLimit ?? 5) : { byCpu: [], byMemory: [] },
    health: { level: 'unknown', reasons: [], cpu: null, memory: null },
    beacon: {
      state: input.kind === 'local' ? 'fresh' : fresh ? 'fresh' : beacon?.latest ? 'stale' : 'absent',
      ageMs: input.kind === 'local' ? 0 : (beacon?.ageMs ?? null),
      seq: beacon?.latest?.seq ?? null,
      pluginKey: beacon?.pluginKey ?? null,
      remotePlugin: input.kind === 'local' ? 'running' : (beacon?.remotePlugin ?? 'unknown')
    },
    updatedAt: input.now
  }
  state.health = assessHealth({ online, cpu, memory }, input.health)
  return state
}

/** The history point a merged state contributes; memory only when it can be trusted. */
export function historyPointOf(state: MachineState, t: number): HistoryPoint | null {
  if (!state.online) return null
  const mem = state.memory && state.memory.reliable ? state.memory.percent : null
  if (state.cpu.percent === null && mem === null) return null
  return { t, cpu: state.cpu.percent, mem }
}

/** Memory from a beacon itself, when it can be trusted: `os.freemem()` on macOS leaves out
 *  reclaimable cache, so a Mac's beacon carries none. */
export function beaconMemoryPercent(r: BeaconRecord): number | null {
  return r.platform === 'darwin' || r.memTotal <= 0 ? null : clampPercent(((r.memTotal - r.memFree) / r.memTotal) * 100)
}

/** Older beacons as history points on the local clock (`offsetMs` = remote minus local). */
export function backfillPoints(records: readonly BeaconRecord[], offsetMs: number): HistoryPoint[] {
  return records
    .filter((r) => r.cpu !== null)
    .map((r) => ({ t: r.t - offsetMs, cpu: r.cpu, mem: beaconMemoryPercent(r) }))
}
