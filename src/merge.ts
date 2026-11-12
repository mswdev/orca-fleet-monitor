// Merges what we know about one machine (local sample, Orca diagnostics, remote beacon) into
// the single model the panel and status bar read.
import { assessHealth, rank, type HealthSettings, type MemoryRules } from './health.ts'
import type {
  BeaconRecord,
  BeaconState,
  DiagnosticsSample,
  HistoryPoint,
  LocalSample,
  LostReading,
  MacMemory,
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
    /** A Mac reading from one of the last two beacons, marked with its age, shown when the newest
     *  fresh beacon has none (a 1.1 build that drops it on a failed read). Display only. */
    carriedMac?: MacMemory | null
  } | null
  /** The reading that carries its memory stopped arriving while memory was elevated. */
  lost?: LostReading | null
  health: HealthSettings
  /** RAM used busy threshold, for a machine that reports RAM in use; the default when absent. */
  memoryRules?: MemoryRules
  topLimit?: number
  /** This computer's platform, which is known before its first sample (only for the local
   *  machine), so it is tagged "This Mac" or "This PC" from the first answer on. */
  platform?: string | null
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

  // Memory, best first: a Mac's own reading (this computer's sampler, or a fresh beacon from a Mac
  // with Fleet Monitor 1.1), which is RAM in use as Activity Monitor counts it; then Orca's
  // diagnostics, which on a Mac are memory pressure; then os.freemem().
  let memory: MachineState['memory'] = null
  const mac = local ? (local.macMemory ?? null) : (fresh?.macMemory ?? (fresh ? (beacon?.carriedMac ?? null) : null))
  if (mac && mac.total > 0) {
    memory = macMemoryState(mac, local ? 'sampler' : 'beacon', diag)
  } else if (diag) {
    const pressure = diag.host.availableMemorySource === 'memory-pressure'
    // Orca falls back to free memory on a Mac for the rest of its run after one slow
    // `memory_pressure` call (and on Linux when /proc/meminfo fails). Free memory is neither RAM in
    // use nor pressure, so it is shown as unavailable and never judged; only on Windows is it
    // Orca's usual figure.
    const unavailable = diag.host.availableMemorySource === 'free-memory' && !windowsHost(input, diag)
    memory = {
      total: diag.host.totalMemory,
      used: diag.host.usedMemory,
      available: diag.host.availableMemory,
      percent: diag.host.memoryPercent,
      source: 'orca',
      reliable: !unavailable,
      // On a Mac, Orca's figure is the kernel's memory pressure, not RAM in use.
      ...(pressure ? { kind: 'pressure' as const, pressurePercent: diag.host.memoryPercent } : unavailable ? { kind: 'unavailable' as const } : {})
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
      platform: known?.platform || (input.kind === 'local' ? input.platform || null : null),
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
  state.health = assessHealth({ online, cpu, memory }, input.health, input.memoryRules)
  const lost = input.kind === 'remote' ? (input.lost ?? null) : null
  if (lost) {
    state.lost = lost
    state.health = withLost(state.health, lost, online)
  }
  return state
}

/** Is the machine Windows, where free memory is Orca's usual figure? Its own platform when known;
 *  for a basic machine, whose diagnostics do not name one, a load average of exactly 0 (only
 *  Windows has none). */
function windowsHost(input: MergeInput, diag: DiagnosticsSample): boolean {
  const platform = input.local?.platform || input.beacon?.latest?.platform || (input.kind === 'local' ? input.platform : null) || null
  if (platform) return platform === 'win32'
  return diag.host.load1 === 0
}

/** "Stopped answering; last reading: …", in words the status bar, the panel and the notification
 *  share. */
export function lostReason(lost: LostReading): string {
  return `${lost.how === 'stale' ? 'readings stopped' : 'stopped answering'}; last reading: ${lost.summary}`
}

/** The level a machine that stopped answering while its memory was elevated is ranked at: its last
 *  memory level, and never below strained. */
export function lostLevel(lost: LostReading): MachineState['health']['level'] {
  return rank(lost.level) >= rank('strained') ? lost.level : 'strained'
}

/** Health with a lost reading said in it. Offline, it stays unknown, with the reason after
 *  "offline". Online (Orca still answers, the machine's own readings stopped), its level is at
 *  least the lost one, and the reason comes first. */
function withLost(health: MachineState['health'], lost: LostReading, online: boolean): MachineState['health'] {
  const reason = lostReason(lost)
  if (!online) return { ...health, reasons: [...health.reasons, reason] }
  const lostAt = lostLevel(lost)
  if (rank(lostAt) > rank(health.level)) return { ...health, level: lostAt, reasons: [reason] }
  return { ...health, reasons: [reason, ...health.reasons] }
}

/** A beacon's own Mac reading as a machine's memory, for judging that one beacon; null without one. */
export function beaconMemoryOf(r: BeaconRecord, diag: DiagnosticsSample | null | undefined): NonNullable<MachineState['memory']> | null {
  return r.macMemory && r.macMemory.total > 0 ? macMemoryState(r.macMemory, 'beacon', diag) : null
}

/** Memory pressure from a Mac's own reading: 100 − the percent the kernel counts as available. */
function macPressure(mac: MacMemory): number | null {
  return mac.availablePercent === null ? null : clampPercent(100 - mac.availablePercent)
}

/** A Mac's own reading as the machine's memory. Pressure falls back on Orca's figure (the same
 *  measure) when the kernel's percentage could not be read. */
function macMemoryState(mac: MacMemory, source: 'sampler' | 'beacon', diag: DiagnosticsSample | null | undefined): NonNullable<MachineState['memory']> {
  const orcaPressure = diag && diag.host.availableMemorySource === 'memory-pressure' ? diag.host.memoryPercent : null
  return {
    total: mac.total,
    used: mac.used,
    available: Math.max(0, mac.total - mac.used),
    percent: clampPercent((mac.used / mac.total) * 100),
    source,
    reliable: true,
    kind: 'used',
    pressurePercent: macPressure(mac) ?? orcaPressure,
    mac
  }
}

/** The history point a merged state contributes; memory only when it can be trusted. `mem` is
 *  memory pressure (or Orca's figure); `ram` is RAM in use, only where a Mac reported it. */
export function historyPointOf(state: MachineState, t: number): HistoryPoint | null {
  if (!state.online) return null
  const memory = state.memory && state.memory.reliable ? state.memory : null
  const used = memory?.kind === 'used'
  const mem = memory ? (used ? (memory.pressurePercent ?? null) : memory.percent) : null
  const ram = used ? memory!.percent : null
  if (state.cpu.percent === null && mem === null && ram === null) return null
  return ram === null ? { t, cpu: state.cpu.percent, mem } : { t, cpu: state.cpu.percent, mem, ram }
}

/** Memory from a beacon itself, when it can be trusted: a Mac's own pressure reading (1.1), or
 *  `os.freemem()` elsewhere; on macOS that leaves out reclaimable cache, so it is never used. */
export function beaconMemoryPercent(r: BeaconRecord): number | null {
  if (r.macMemory) return macPressure(r.macMemory)
  return r.platform === 'darwin' || r.memTotal <= 0 ? null : clampPercent(((r.memTotal - r.memFree) / r.memTotal) * 100)
}

/** RAM in use from a Mac's beacon (1.1), as a percentage; null for any other beacon. */
export function beaconRamPercent(r: BeaconRecord): number | null {
  const mac = r.macMemory
  return mac && mac.total > 0 ? clampPercent((mac.used / mac.total) * 100) : null
}

/** A history point from an older beacon, on the local clock (`offsetMs` = remote minus local). */
export function beaconPoint(r: BeaconRecord, offsetMs: number, fallbackMem: number | null = null): HistoryPoint {
  const ram = beaconRamPercent(r)
  const mem = beaconMemoryPercent(r) ?? fallbackMem
  return ram === null ? { t: r.t - offsetMs, cpu: r.cpu, mem } : { t: r.t - offsetMs, cpu: r.cpu, mem, ram }
}

/** Older beacons as history points on the local clock (`offsetMs` = remote minus local). */
export function backfillPoints(records: readonly BeaconRecord[], offsetMs: number): HistoryPoint[] {
  return records.filter((r) => r.cpu !== null).map((r) => beaconPoint(r, offsetMs))
}
