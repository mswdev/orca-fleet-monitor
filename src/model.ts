// Shared data shapes for the worker, the panel bridge and the tests. Types only.

export type HealthLevel = 'ok' | 'busy' | 'strained' | 'critical'
export type Tier = 'full' | 'basic'
export type FleetMode = 'fast' | 'slow'

/** A run of `os.cpus()` entries of one kind: `perCore.slice(start, start + count)`. Only Apple
 *  silicon Macs report a split (see src/core-groups.ts); everywhere else there is none. */
export type CoreGroup = { kind: 'performance' | 'efficiency'; start: number; count: number }

/** macOS's own memory pressure (`kern.memorystatus_vm_pressure_level`): the green, yellow and red of
 *  Activity Monitor's pressure graph. */
export type PressureLevel = 'normal' | 'warning' | 'critical'

/**
 * One reading of a Mac's memory from `vm_stat` and `sysctl` (src/mac-memory.ts), counted as
 * Activity Monitor counts it. Bytes, except where it says pages.
 */
export type MacMemory = {
  /** `hw.memsize`. */
  total: number
  /** Activity Monitor's "Memory Used": app memory, wired (with what no page count accounts for)
   *  and compressed. */
  used: number
  /** Anonymous pages. */
  app: number
  /** Pages wired down, plus physical memory no page count accounts for. */
  wired: number
  /** Pages occupied by the compressor. */
  compressed: number
  /** Activity Monitor's "Cached Files": file-backed plus purgeable pages. */
  cached: number
  /** `vm.swapusage`; null when it could not be read. */
  swapUsed: number | null
  swapTotal: number | null
  pressure: PressureLevel | null
  /** `kern.memorystatus_level`: percent of memory the kernel counts as still available. */
  availablePercent: number | null
  /** `vm_stat`'s page size, for the page rates below. */
  pageSize: number
  /** Pages per second since the previous reading; null on the first one. */
  swapInsPerSec: number | null
  swapOutsPerSec: number | null
  /** Average swap-outs, pages per second, over about the last 30 s, when every reading in that
   *  time saw some (see SUSTAINED_SWAP in src/mac-memory.ts); null otherwise. */
  sustainedSwapOutsPerSec: number | null
  /** How old the RAM figures (`vm_stat`'s: used and its parts, the swap rates) are, in ms, when a
   *  read failed and they were carried from an earlier one; absent when this reading read them. */
  ageMs?: number
  /** How old the kernel's figures (`sysctl`'s: pressure level, percent available, swap used) are,
   *  in ms, when carried from an earlier read; absent when this reading read them. */
  pressureAgeMs?: number
}

/** The default network interface's traffic: `netstat -ibn` on a Mac (src/mac-system.ts),
 *  `/proc/net/dev` on Linux (src/linux-system.ts), .NET's interface statistics on Windows
 *  (src/win-system.ts). */
export type NetReading = {
  /** The interface the default route goes out of (`en0`, `eth0`; on Windows the adapter's name
   *  made to fit the beacon's rule for one, `Ethernet-3`). */
  iface: string
  /** Bytes per second since the previous reading; null on the first one, or when the counters
   *  went back (the interface reset, or the default route moved to another one). */
  rxBytesPerSec: number | null
  txBytesPerSec: number | null
  /** How old these figures are, in ms, when carried over a failed read; absent when fresh. */
  ageMs?: number
}

/** The main volume's space (`statfs`) and every disk's traffic: on a Mac `ioreg`'s block storage
 *  statistics, as Activity Monitor's Disk tab sums them; on Linux `/proc/diskstats` over physical
 *  disks; on Windows the PhysicalDisk counters' total. */
export type DiskReading = {
  /** The volume's size, and what is used of it: size minus what is available to this user, as
   *  `df` counts available. On a Mac that is the APFS container (space macOS could purge is not
   *  counted as available); on Linux `/`, where blocks reserved for root count as used; on Windows
   *  the system drive. */
  totalBytes: number | null
  usedBytes: number | null
  /** How old the space figures are, in ms; they are read about once a minute. */
  spaceAgeMs?: number
  /** Bytes per second read and written, over the time since the previous traffic reading. */
  readBytesPerSec: number | null
  writeBytesPerSec: number | null
  /** How old the traffic figures are, in ms; they are read about every 20 s. */
  ioAgeMs?: number
}

/** The busiest GPU's utilisation. A Mac: `ioreg`'s "Device Utilization %" (Apple silicon and most
 *  Intel GPUs). Linux: the driver's `gpu_busy_percent` (AMD) or `nvidia-smi`; Intel reports none.
 *  Windows: its busiest engine, from the "GPU Engine" counters, as Task Manager shows one figure. */
export type GpuReading = {
  percent: number
  /** How old it is, in ms; it is read about every 30 s. */
  ageMs?: number
}

/** The power source, and the internal battery when there is one: `pmset -g batt` on a Mac,
 *  `/sys/class/power_supply` on Linux, the system's power status on Windows. */
export type BatteryReading = {
  /** False on a machine without a battery (a desktop): the other battery fields are then null. */
  present: boolean
  percent: number | null
  state: 'charging' | 'discharging' | 'charged' | 'not-charging' | null
  /** `ac` (AC power), `battery`, or `ups`; null when pmset did not say. */
  source: 'ac' | 'battery' | 'ups' | null
  /** Minutes until full (charging) or empty (discharging), when the system gives an estimate
   *  (Windows gives one only while discharging). */
  minutesRemaining: number | null
  /** How old it is, in ms; it is read about once a minute. */
  ageMs?: number
}

/** A machine's network, disk, GPU and battery readings (the name is from 1.2, when only a Mac
 *  had them; Linux and Windows have since 1.3). Each part is null when it could not be read or
 *  the machine has no such thing. */
export type MacSystem = {
  net: NetReading | null
  disk: DiskReading | null
  gpu: GpuReading | null
  battery: BatteryReading | null
}

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
  /** On a Mac, its memory as Activity Monitor counts it; absent elsewhere or when it could not be read. */
  macMemory?: MacMemory | null
  /** On a Mac, its network, disk, GPU and battery (1.2); absent elsewhere. */
  system?: MacSystem | null
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
  /** Only from a Mac running Fleet Monitor 1.1 or later; absent or null otherwise. */
  macMemory?: MacMemory | null
  /** From a machine whose Fleet Monitor reads them (1.2 on a Mac, 1.3 on Linux and Windows);
   *  absent or null otherwise. */
  system?: MacSystem | null
  /** The beacon says its writer also publishes process lines (publishing on; 1.2 on a Mac, 1.3 on
   *  Linux and Windows). */
  publishesProcesses?: boolean
  /** The beacon says its writer cannot list its processes at all (1.3: a Windows machine whose
   *  PowerShell cannot run the reader). */
  cannotListProcesses?: boolean
  /** When the remote Orca appended the log line (remote clock). */
  loggedAt: number
}

// --- Processes ------------------------------------------------------------------------------

/** One process, as the worker reads it (src/processes.ts on a Mac, src/linux-processes.ts,
 *  src/win-processes.ts). */
export type ProcessRow = {
  pid: number
  ppid: number | null
  /** The program's name, never a path or an argument, so nothing secret it was started with can
   *  show up here. A Mac: the kernel's short name (`ps -o ucomm`), the executable's file name cut
   *  to 16 characters (`Google Chrome He`). Linux: the executable's file name where this user may
   *  read it, else the kernel's short name (15 characters, which a process can set itself).
   *  Windows: the image's file name without `.exe`. */
  name: string
  /** The owner's user name; null on Windows, where it cannot be read without elevation. */
  user: string | null
  /** Percent of one core over the list's `cpuWindowMs` (Activity Monitor's "% CPU"): it can pass 100. */
  cpu: number | null
  /** Bytes, as the system's own tool shows a process's memory. A Mac: physical footprint, Activity
   *  Monitor's "Memory" column (`top`'s MEM). Windows: private working set, Task Manager's
   *  "Memory" column. Linux: resident set size (`top`'s RES), which counts shared pages in every
   *  process that maps them. */
  mem: number | null
  /** `top`'s POWER, which is meant to be Activity Monitor's "Energy Impact" (not checked). A Mac
   *  only; null elsewhere. */
  energy: number | null
  /** Start time, epoch seconds. */
  start: number | null
}

/** A process list in columns (each the same length), as it crosses the panel bridge: one object
 *  per column rather than per process, far inside Orca's 10,000-object limit. */
export type ProcessColumns = {
  pid: number[]
  ppid: (number | null)[]
  name: string[]
  user: (string | null)[]
  cpu: (number | null)[]
  mem: (number | null)[]
  energy: (number | null)[]
  start: (number | null)[]
}

/** Why there is no process list for a machine. */
export type ProcessUnavailable =
  | 'not-mac' // a platform Fleet Monitor lists no processes on (the name is from 1.2, when only macOS did)
  | 'basic' // Fleet Monitor is not installed there, or installed but not running
  | 'outdated' // Fleet Monitor there is too old to list them: before 1.2 on a Mac, 1.3 elsewhere
  | 'no-reader' // the machine cannot read its own list (Windows, when PowerShell cannot run the reader)
  | 'publishing-off' // it runs there, but its readings are not arriving (publishing off)
  | 'not-read-yet' // not known yet: still connecting, or its plugins or log not read yet
  | 'offline'
  | 'unknown-machine'
  | 'failed' // this computer's list could not be read just now

/** The answer to `fleet.processes`. */
export type ProcessList = {
  machineId: string
  /** `ok` with a list; `waiting` while the first one is on its way (a remote publishes every 30 s);
   *  `unavailable` with a `reason`. */
  state: 'ok' | 'waiting' | 'unavailable'
  reason: ProcessUnavailable | null
  /** `full`: every process on this computer. `top`: the remote's own top list, about 40 by memory
   *  and 20 by CPU, out of `total`. */
  scope: 'full' | 'top'
  /** When the list was taken, on the worker's clock (a remote's time moved onto it). */
  takenAt: number | null
  /** How old it was when this answer was made. */
  ageMs: number | null
  /** What `cpu` is averaged over (the time between two process readings). */
  cpuWindowMs: number | null
  /** How old the memory figures were at `takenAt`: `top` reads them on its own beat. */
  memAgeMs: number | null
  /** What `energy` is averaged over (`top`'s interval); null when there is none. */
  energyWindowMs: number | null
  /** Processes on the machine; more than the list holds when `scope` is `top`. */
  total: number | null
  columns: ProcessColumns
  /** Set when this computer has more processes than an answer carries (the busiest are kept). */
  truncated?: true
}

/** The process using the most memory, from a machine's newest list. */
export type TopProcess = { pid: number; name: string; mem: number }

/** What `fleet.processes` can give for a machine, without fetching it (on each machine state). */
export type ProcessAvailability = {
  state: 'full' | 'top' | 'waiting' | 'unavailable'
  reason: ProcessUnavailable | null
  /** When the newest list was taken (worker clock); null before the first. */
  takenAt: number | null
  /** The process using the most memory, last known: from the newest reading that had memory
   *  figures, kept while sampling pauses (memory critical, here or on that machine) or the
   *  machine stops publishing, for up to 15 minutes. Null (or absent) when none is known. */
  largest?: TopProcess | null
  /** When `largest`'s memory figure was read (worker clock), and its age when this state was
   *  made, in ms. A figure carried through a pause grows old here; it is never shown as new. */
  largestAt?: number | null
  memAgeMs?: number | null
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

/** `mem` is the memory figure Orca measures (memory pressure on a Mac, MemAvailable on Linux), or
 *  the same pressure from a Mac's own reading. `ram` is RAM in use as Activity Monitor counts it,
 *  present only where a Mac reported it, so the two never mix on one chart. */
export type HistoryPoint = {
  t: number
  cpu: number | null
  mem: number | null
  ram?: number | null
  /** A Mac's network bytes per second received and sent (1.2). */
  rx?: number | null
  tx?: number | null
  /** A Mac's disk bytes per second read and written (1.2). */
  dr?: number | null
  dw?: number | null
  /** A Mac's GPU utilisation %, and its battery charge % (1.2). */
  gpu?: number | null
  bat?: number | null
}

/** The history keys added in 1.2, each present in columns only when some point has it
 *  (EXTRA_HISTORY_KEYS in src/history.ts lists them). */
export type ExtraHistoryKey = 'rx' | 'tx' | 'dr' | 'dw' | 'gpu' | 'bat'

/** Column form of a history ring, which is what crosses the panel bridge. `ram` and the 1.2
 *  columns are there only when some point has them. */
export type HistoryColumns = {
  t: number[]
  cpu: (number | null)[]
  mem: (number | null)[]
  ram?: (number | null)[]
} & { [K in ExtraHistoryKey]?: (number | null)[] }

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
    /** With `kind: 'used'`, RAM in use as Activity Monitor counts it. Otherwise what Orca reports,
     *  which on a Mac is memory pressure (`total × (1 − available %)`), not RAM in use. */
    used: number
    available: number
    /** `used` as a percentage of `total`: the figure shown for the machine. */
    percent: number
    /** `orca`: Orca's own measure (memory pressure / MemAvailable). `os`: `os.freemem()`.
     *  `sampler` / `beacon`: a Mac's own reading (`mac`), here or in a remote's beacon. */
    source: 'orca' | 'os' | 'sampler' | 'beacon'
    /** False for `os` memory on macOS, which counts reclaimable cache as used. */
    reliable: boolean
    /** `used`: a Mac's own reading (`mac` is set). `pressure`: Orca's memory pressure reading of a
     *  Mac (its `availableMemorySource` is `memory-pressure`), never to be called "used".
     *  `unavailable`: Orca reports only free memory (`free-memory`) for a machine that is not
     *  Windows, which is neither RAM in use nor pressure; never judged (`reliable` is false).
     *  Absent: as before 1.1 (Linux MemAvailable, Windows free memory, `os.freemem()`). */
    kind?: 'used' | 'pressure' | 'unavailable'
    /** Memory pressure, 100 − percent available, which the memory thresholds judge. */
    pressurePercent?: number | null
    mac?: MacMemory | null
  } | null
  load: { one: number; five: number | null; fifteen: number | null } | null
  /** Orca's own usage on that machine. cpu is percent of one core. */
  orca: { cpu: number; memory: number; totalCpu: number; totalMemory: number } | null
  workspaces: { byCpu: WorkspaceUsage[]; byMemory: WorkspaceUsage[] }
  health: Health
  beacon: BeaconState
  /** Set when the reading that carries this machine's memory stopped arriving while its memory was
   *  elevated (src/health.ts `memoryElevated`): what the last one said. It clears once that reading
   *  comes again (src/poller.ts). */
  lost?: LostReading
  /** Network, disk, GPU and battery: this Mac's own (sampler), or a fresh beacon's from a Mac
   *  running Fleet Monitor 1.2. Absent or null for every other machine. */
  system?: MacSystem | null
  /** Whether `fleet.processes` has a list for this machine, and what kind. */
  processes?: ProcessAvailability
  updatedAt: number
  /** Set by the panel bridge on a machine it sent without its per-core values and workspaces, to
   *  fit Orca's size caps; a panel keeps the ones it already holds for it. */
  lean?: true
}

/** A machine that stopped answering, or whose own readings stopped arriving, while its memory was
 *  elevated. Times are on the worker's clock. */
export type LostReading = {
  /** `unanswered`: a call to it failed or timed out, or it went offline: it stopped answering.
   *  `stale`: it still answers, but its Fleet Monitor readings stopped moving. */
  how: 'unanswered' | 'stale'
  /** When that was noticed. */
  since: number
  /** When the last reading was taken. */
  lastReadingAt: number | null
  /** The memory level that reading gave (`ok` or `busy` when only elevated). */
  level: HealthLevel
  /** That reading in words, for example "memory pressure critical, 15.8 of 16 GB used, swap 9.1 GB". */
  summary: string
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
