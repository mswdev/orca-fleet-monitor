// Shared data shapes for the worker, the panel bridge and the tests. Types only.

export type HealthLevel = 'ok' | 'busy' | 'strained' | 'critical'
export type Tier = 'full' | 'basic'
export type FleetMode = 'fast' | 'slow'

/** A run of `os.cpus()` entries of one kind: `perCore.slice(start, start + count)`. Only Apple
 *  silicon Macs report a split (see src/core-groups.ts); everywhere else there is none. */
export type CoreGroup = { kind: 'performance' | 'efficiency'; start: number; count: number }

/** One reading of the machine this worker runs on, from `node:os` only. */
export type LocalSample = {
  /** Epoch ms on this machine's clock. */
  t: number
  hostname: string
  platform: string
  arch: string
  release: string
  cpuModel: string
  cores: number
  uptimeSec: number
  /** Percent busy since the previous reading, 0..100; null on the first reading. */
  cpu: { total: number; perCore: number[] } | null
  /** `os.freemem()` is not "available" memory on macOS, so this is a fallback only. */
  memory: { total: number; free: number }
  load: [number, number, number]
  /** How `cpu.perCore` splits into performance and efficiency cores; absent when unknown. */
  coreGroups?: CoreGroup[] | null
}

/** A beacon read back from a remote worker's log. Times are on the remote's clock. */
export type BeaconRecord = {
  /** Random id of the worker run that wrote it; a new id means the worker restarted. */
  run: string
  seq: number
  t: number
  intervalMs: number
  hostname: string
  platform: string
  arch: string
  release: string
  cpuModel: string
  cores: number
  uptimeSec: number
  cpu: number | null
  perCore: number[] | null
  memTotal: number
  memFree: number
  load: [number, number, number]
  /** Only from beacons written by a Fleet Monitor that knows its core split; older ones have none. */
  coreGroups: CoreGroup[] | null
  /** When the remote Orca appended the log line (remote clock). */
  loggedAt: number
}

export type WorkspaceUsage = {
  id: string
  name: string
  repo: string
  /** Percent of one core, as Orca reports it (can exceed 100). */
  cpu: number
  memory: number
  sessions: number
}

/** What `orca diagnostics memory --json` tells us about one Orca host. */
export type DiagnosticsSample = {
  /** Remote clock, epoch ms. */
  collectedAt: number
  runtimeId: string | null
  host: {
    totalMemory: number
    availableMemory: number
    usedMemory: number
    memoryPercent: number
    availableMemorySource: string
    cores: number
    load1: number
  }
  /** Orca's own processes (main, renderer, helpers). cpu is percent of one core. */
  app: { cpu: number; memory: number }
  totalCpu: number
  totalMemory: number
  workspaces: WorkspaceUsage[]
}

export type HistoryPoint = { t: number; cpu: number | null; mem: number | null }

/** Column form of a history ring, which is what crosses the panel bridge. */
export type HistoryColumns = { t: number[]; cpu: (number | null)[]; mem: (number | null)[] }

export type HealthThresholds = { busy: number; strained: number; critical: number }

/** `level` is the worse of the CPU and memory levels; each is null when it cannot be judged. */
export type Health = {
  level: HealthLevel | 'unknown'
  reasons: string[]
  cpu: HealthLevel | null
  memory: HealthLevel | null
}

export type BeaconState = {
  state: 'fresh' | 'stale' | 'absent'
  /** Age of the newest beacon on the remote's clock, when it can be judged. */
  ageMs: number | null
  seq: number | null
  pluginKey: string | null
  /** What `orca plugin list` said about Fleet Monitor on that machine. */
  remotePlugin: 'running' | 'installed' | 'absent' | 'unknown'
}

export type MachineState = {
  id: string
  name: string
  kind: 'local' | 'remote'
  tier: Tier
  status: 'connecting' | 'online' | 'offline'
  online: boolean
  /** Local clock, epoch ms, of the last successful read. */
  lastSeenAt: number | null
  /** Wall time of the last CLI round trip to this machine, CLI start-up included. */
  latencyMs: number | null
  error: string | null
  host: {
    hostname: string | null
    platform: string | null
    arch: string | null
    cpuModel: string | null
    cores: number | null
    uptimeSec: number | null
  }
  cpu: {
    /** Whole-machine busy percent: measured (`sampler`, `beacon`) or estimated from load (`load`).
     *  An estimate is never used to judge health. With `load` and null, the machine reports no
     *  load average (Windows), so there is no estimate either. */
    percent: number | null
    source: 'sampler' | 'beacon' | 'load' | null
    perCore: number[] | null
    /** How `perCore` splits by core kind; null means one group. */
    groups: CoreGroup[] | null
  }
  memory: {
    total: number
    used: number
    available: number
    percent: number
    /** `orca`: Orca's own measure (memory pressure / MemAvailable). `os`: `os.freemem()`. */
    source: 'orca' | 'os'
    /** False for `os` memory on macOS, which counts reclaimable cache as used. */
    reliable: boolean
  } | null
  load: { one: number; five: number | null; fifteen: number | null } | null
  /** Orca's own usage on that machine. cpu is percent of one core. */
  orca: { cpu: number; memory: number; totalCpu: number; totalMemory: number } | null
  workspaces: { byCpu: WorkspaceUsage[]; byMemory: WorkspaceUsage[] }
  health: Health
  beacon: BeaconState
  updatedAt: number
  /** Set by the panel bridge on a machine it sent without its per-core values and workspaces, to
   *  fit Orca's size caps; a panel keeps the ones it already holds for it. */
  lean?: true
}

export type MachineView = MachineState & { history: HistoryColumns }

export type CliInfo = {
  path: string | null
  source: string | null
  /** The CLI could not be found, or the path in settings cannot run. */
  error: string | null
  /** The CLI was found, but listing paired machines with it failed: why. */
  runError?: string | null
  /** The command a person types for Orca's CLI on this computer: `orca-ide` on Linux, where
   *  `orca` is GNOME's screen reader; `orca` elsewhere. */
  launcher?: 'orca' | 'orca-ide'
}

/** The person's thresholds, so a panel can colour each metric and core the way health is judged. */
export type FleetThresholds = { cpu: HealthThresholds; memory: HealthThresholds }

export type FleetSnapshot = {
  v: 1
  seq: number
  generatedAt: number
  mode: FleetMode
  intervalMs: number
  historyWindowMs: number
  cli: CliInfo
  thresholds: FleetThresholds
  /** Rises whenever history older than a post's recent window changes (a back-fill). */
  historyRev: number
  /** Random id of this worker run; `seq` starts again when it changes. */
  run: string
  machines: MachineView[]
  /** Machines left out because even without their detail they would not fit Orca's answer cap. */
  omitted?: number
  /** Set when some machines came without their per-core values and workspaces, to fit the cap
   *  (each is marked `lean`); a panel keeps the ones it already holds (fleet-binding.mjs). */
  lean?: true
}

/** Posted as `fleet.update`: current states without history, plus each machine's most recent
 *  points (`recentMs` of them), which the panel merges by time. A gap in `seq` that spans more
 *  than `recentMs` means the panel missed points and should ask for a snapshot. */
export type FleetUpdate = {
  v: 1
  seq: number
  generatedAt: number
  mode: FleetMode
  intervalMs: number
  cli: CliInfo
  thresholds: FleetThresholds
  /** A different value from the panel's snapshot means older history changed: re-fetch. */
  historyRev: number
  /** A different run from the panel's snapshot means the worker restarted: re-fetch. */
  run: string
  machines: MachineState[]
  recentMs: number
  appended: Record<string, HistoryColumns>
  /** Set when a full update would be too large to post; the panel should re-fetch. */
  resync?: true
  /** Set when some states came without their per-core values and workspaces, to fit the cap
   *  (each is marked `lean`); a panel keeps the ones it already holds rather than drop them. */
  lean?: true
}
