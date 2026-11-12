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

/** CPU estimated from the 1-minute load average when nothing measures it directly. */
export function loadEstimate(load1: number, cores: number): number {
  return clampPercent((load1 / Math.max(1, cores)) * 100)
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
    cpu = { percent: loadEstimate(diag.host.load1, diag.host.cores), source: 'load', perCore: null, groups: null }
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
  if (loadSource) {
    load = { one: loadSource[0], five: loadSource[1], fifteen: loadSource[2] }
  } else if (diag) {
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
    lastSeenAt: input.kind === 'local' ? (local?.t ?? input.now) : input.lastSeenAt,
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

/** Older beacons as history points on the local clock (`offsetMs` = remote minus local). */
export function backfillPoints(records: readonly BeaconRecord[], offsetMs: number): HistoryPoint[] {
  return records
    .filter((r) => r.cpu !== null)
    .map((r) => ({
      t: r.t - offsetMs,
      cpu: r.cpu,
      mem: r.platform === 'darwin' || r.memTotal <= 0 ? null : clampPercent(((r.memTotal - r.memFree) / r.memTotal) * 100)
    }))
}
