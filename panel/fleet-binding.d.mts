// Types for fleet-binding.mjs: what a Fleet Monitor view is given. A machine is the worker's
// MachineState (src/model.ts) plus its history in columns; toFleet() turns a view into the
// panel's model, shaped like the design's sample FLEET object.
import type { CliInfo, FleetMode, FleetThresholds, HealthLevel, HealthThresholds, HistoryColumns, MachineView, ProcessList } from '../src/model.ts'

export const HEARTBEAT_MS: number
export const HISTORY_SLOTS: number
export const SLOT_MS: number
export const TOP_WORKSPACES: number
export const INSTALL_SOURCE: string
export const LAUNCHERS: readonly ['orca', 'orca-ide']
export const DEFAULT_THRESHOLDS: FleetThresholds
export const LEVEL_LABELS: Readonly<Record<HealthLevel | 'unknown', string>>
export const MAX_CORES_DRAWN: number

export type FleetReadyView = {
  ready: true
  error: string | null
  seq: number
  generatedAt: number
  mode: FleetMode
  intervalMs: number
  historyWindowMs: number
  cli: CliInfo | null
  thresholds: FleetThresholds
  /** Temperatures in °F (the person's setting); °C when false or absent. */
  fahrenheit?: boolean
  /** The overview's "Star on GitHub" link; shown when true or absent. */
  starLink?: boolean
  /** Machines the worker left out to fit its answer cap. */
  omitted?: number
  /** The worker's clock minus this frame's, from the newest answer or post. */
  clockOffsetMs?: number
  machines: MachineView[]
}
export type FleetView = { ready: false; error: string | null; machines: [] } | FleetReadyView

export type FleetBinding = {
  /** Settles once the first snapshot has arrived or failed. */
  ready: Promise<void>
  current(): FleetView
  refresh(): Promise<void>
  /** "Retry connection": true when the worker took the request. */
  retry(id: string): Promise<boolean>
  /** One machine's processes (`fleet.processes`), or `{ state: 'error', error }`. */
  processes(id: string): Promise<ProcessList | { state: 'error'; error: string; machineId: string }>
  /** Asks for one machine's processes now and every `intervalMs` while the panel is visible;
   *  returns a function that stops it. */
  watchProcesses(id: string, listener: (answer: ProcessList | { state: 'error'; error: string; machineId: string }) => void, options?: { intervalMs?: number }): () => void
  /** Calls `listener` at once with the current view, then after every change. */
  subscribe(listener: (view: FleetView) => void): () => void
  dispose(): void
  _heartbeat(): void
}

export type FleetBindingOptions = {
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
  isVisible?: () => boolean
  onVisibilityChange?: (handler: () => void) => () => void
  /** This frame's clock; Date.now when not given. */
  now?: () => number
}

export type FleetOrca = {
  plugin: {
    request(name: string, input?: unknown, options?: { timeoutMs?: number }): Promise<any>
    on(event: string, handler: (payload: any) => void): { dispose(): void }
  }
}

export type Level = HealthLevel
export type CoreGroupModel = { label: string; short: 'P' | 'E' | null; values: number[]; tones: Level[] }
export type WorkspaceModel = { id: string; name: string; repo: string; cpuPct: number; memBytes: number }
/** `command` is null when neither the machine's name nor its id can go into a command safely.
 *  `mac`: the machine is a Mac, where Fleet Monitor also adds RAM in use, swap and pressure. */
export type InstallHint = { reason: 'absent' | 'installed' | 'quiet'; command: string | null; launcher?: 'orca' | 'orca-ide'; mac?: boolean }
/** `peakAt`: when the peak was (its first time), worker clock. */
export type Stats = { avg: number; peak: number; peakAt: number | null }
/** One wall-clock minute of readings: their mean time, mean, lowest and highest. `key` is the
 *  minute's number since the epoch. */
export type TrendPoint = { key: number; t: number; v: number; lo: number; hi: number; newest?: true }
/** A history column as the charts draw it (trendOf): its minutes, the newest reading, and how many
 *  readings fell in the window. */
export type Trend = { points: TrendPoint[]; live: { t: number; v: number } | null; count: number }
export type ChartLevel = 'busy' | 'strained' | 'critical'
/** The levels a chart colours its line by and bands it with, lowest first. */
export type ChartRule = { level: ChartLevel; at: number }[]
/** A Mac's own memory reading, as the detail rows show it. Bytes unless named otherwise. */
export type MacDetail = {
  appBytes: number | null
  wiredBytes: number | null
  compressedBytes: number | null
  cachedBytes: number | null
  swapUsedBytes: number | null
  swapTotalBytes: number | null
  swapInsPerSec: number | null
  swapOutsPerSec: number | null
  pressure: 'normal' | 'warning' | 'critical' | null
  availablePct: number | null
}

/** A Windows computer's memory as Task Manager's memory page shows it. Bytes. */
export type WinDetail = {
  inUseBytes: number | null
  availableBytes: number
  committedBytes: number | null
  commitLimitBytes: number | null
  cachedBytes: number | null
  pagedPoolBytes: number | null
  nonPagedPoolBytes: number | null
}

export type MachineModel = {
  id: string
  name: string
  kind: 'local' | 'remote'
  local: boolean
  status: 'online' | 'offline' | 'connecting'
  online: boolean
  tier: 'full' | 'basic'
  /** `This Mac` on the local machine, `Basic` on a basic-tier one, else empty. */
  tag: string
  health: Level | 'unknown'
  healthLabel: string
  reasons: string[]
  /** It stopped answering (`unanswered`) or its readings stopped (`stale`) while its memory was
   *  elevated: its last reading, and the level it is drawn at (strained or critical). */
  lost: {
    how: 'unanswered' | 'stale'
    label: string
    summary: string
    level: 'strained' | 'critical'
    lastReadingAt: number | null
    since: number | null
  } | null
  /** Local clock: the newest reading of any kind. */
  updatedAt: number | null
  /** The newest CPU or memory reading in its history (worker clock); null before the first. */
  readingAt: number | null
  lastSeenAt: number | null
  error: string | null
  platform: string | null
  chip: string | null
  cores: number | null
  uptimeSec: number | null
  load: { one: number; five: number | null; fifteen: number | null } | null
  cpu: {
    /** With `estimated`, null means the machine reports no load average, so no estimate. */
    pct: number | null
    /** Basic tier: estimated from the 1-minute load average, not measured, never judged. */
    estimated: boolean
    tone: Level
    trend: Trend
    stats: Stats | null
    /** CPU's thresholds; null for an estimate, which is not judged. */
    rule: ChartRule | null
    groups: CoreGroupModel[] | null
    /** How many cores there are when more than MAX_CORES_DRAWN (then `groups` is null); else 0. */
    coresHidden: number
  }
  mem: {
    /** `used`: RAM in use from a Mac's own reading. `pressure`: Orca's memory pressure reading of a
     *  Mac. `orca`: Orca's figure elsewhere, shown as before. */
    kind: 'used' | 'pressure' | 'unavailable' | 'orca'
    /** `Memory pressure` for the `pressure` kind, else `Memory`. */
    label: string
    /** RAM used % (`used`), memory pressure % (`pressure`), or Orca's figure. */
    pct: number | null
    reliable: boolean
    /** Null for the `pressure` kind: Orca's "used" there is not RAM in use. */
    usedBytes: number | null
    totalBytes: number | null
    tone: Level
    /** From history's `ram` column for the `used` kind, its `mem` column otherwise. */
    trend: Trend
    stats: Stats | null
    /** RAM in use's own rule (busy at `ramUsedBusy`) for the `used` kind, else the memory
     *  thresholds; null where memory is not judged. */
    rule: ChartRule | null
    mac: MacDetail | null
    /** A Windows computer running Fleet Monitor 1.3: Task Manager's memory figures. */
    win: WinDetail | null
    /** For the `used` kind, how many seconds old figures carried over a failed read are. */
    carriedSec: number | null
    /** Memory pressure % beside RAM in use, for the `used` kind. */
    pressurePct: number | null
    /** For the `pressure` kind, what would add RAM in use: install, enable or update Fleet
     *  Monitor there, wait for its readings, or (this Mac) its own reading is missing. */
    pressureNote: 'install' | 'enable' | 'quiet' | 'update' | 'own' | null
  }
  orca: { cpuPct: number; memBytes: number | null } | null
  workspaces: WorkspaceModel[]
  install: InstallHint | null
  /** The Fleet Monitor it runs, against the newest any machine runs; null where it runs none (basic
   *  tier, offline). `version` is null for one older than FIRST_VERSIONED, which does not say;
   *  `newestOn` names a machine running `newest` when this one is behind; `update` is the command,
   *  typed on this computer, that updates it (null where it cannot be named safely). */
  fleetMonitor: {
    version: string | null
    /** Too old to say: a Fleet Monitor before FIRST_VERSIONED. */
    legacy: boolean
    outdated: boolean
    newest: string | null
    newestOn: string | null
    update: string | null
  } | null
  lastKnown: { cpuPct: number | null; memPct: number | null }
  /** Network, disk, GPU and battery (1.2): each null unless the machine is online and is this Mac
   *  or a Mac running Fleet Monitor 1.2. Rates are bytes per second. */
  net: NetModel | null
  disk: DiskModel | null
  gpu: GpuModel | null
  battery: BatteryModel | null
  /** CPU and GPU temperature (1.5): null unless the machine is online and reports one. */
  temp: TempModel | null
  processes: ProcessSummary
}

/** One history series, as the charts take it. */
export type Series = { trend: Trend; stats: Stats | null }
/** `ageSec` is set only on a figure carried from an earlier read (1 s or older). */
export type NetModel = { iface: string; rxBytesPerSec: number | null; txBytesPerSec: number | null; ageSec: number | null; rx: Series; tx: Series }
export type DiskModel = {
  /** The main volume's APFS container; used = size − available. Null when not read. */
  totalBytes: number | null
  usedBytes: number | null
  freeBytes: number | null
  usedPct: number | null
  spaceAgeSec: number | null
  /** Every disk's traffic, summed. */
  readBytesPerSec: number | null
  writeBytesPerSec: number | null
  ioAgeSec: number | null
  read: Series
  write: Series
  /** Every local volume (1.4), the main one first; empty where they are not reported. */
  volumes: VolumeModel[]
}
/** One local volume: its name as the machine shows it ("Macintosh HD", "/home", "Data (D:)"). */
export type VolumeModel = { name: string; totalBytes: number; usedBytes: number; usedPct: number; main: boolean }
export const MAX_VOLUMES: number
export type GpuModel = { pct: number; ageSec: number | null } & Series
/** Whole °C. `cpuZone`: the CPU figure is an ACPI thermal zone (Windows). `gpuOff`: the GPU has
 *  sensors but is at rest with them off, so it has no figure. */
export type TempModel = { cpuC: number | null; gpuC: number | null; cpuZone: boolean; gpuOff: boolean; ageSec: number | null }
export type BatteryModel = {
  /** False on a Mac without a battery: then only `source` means anything. */
  present: boolean
  pct: number | null
  state: 'charging' | 'discharging' | 'charged' | 'not-charging' | null
  source: 'ac' | 'battery' | 'ups' | null
  /** To full while charging, to empty while discharging, when macOS has an estimate. */
  minutesRemaining: number | null
  ageSec: number | null
} & Series
export type ProcessSummary = {
  /** `full`: this computer, every process. `top`: a paired Mac's own top list. `waiting`: one is
   *  coming. `unavailable`: see `reason`. */
  state: 'full' | 'top' | 'waiting' | 'unavailable'
  /** `outdated`: Fleet Monitor there is older than 1.2 ("Update Fleet Monitor to 1.2").
   *  `publishing-off`: it runs there but its readings are not arriving. `basic`: not installed or
   *  not running there. `not-read-yet`: not known yet. `not-mac`, `offline`, `unknown-machine`,
   *  and `failed` (this computer's list could not be read just now). */
  reason: 'not-mac' | 'basic' | 'outdated' | 'publishing-off' | 'not-read-yet' | 'offline' | 'unknown-machine' | 'failed' | null
  topList: boolean
  takenAt: number | null
  ageSec: number | null
  /** How old `largest`'s memory figure is now. It is the last known, carried through a pause of
   *  the sampling (memory critical) for up to 15 minutes, so it can be much older than `ageSec`
   *  ("3 min ago"); null with no `largest`. */
  memAgeSec: number | null
  /** The process using the most memory in the newest list, with its share of RAM. */
  largest: { pid: number; name: string; memBytes: number; memPct: number | null } | null
}

export type ProcessSortKey = 'name' | 'pid' | 'user' | 'cpu' | 'mem' | 'energy'
export type ProcessRowModel = {
  pid: number
  ppid: number | null
  name: string
  user: string | null
  /** Percent of one core (can pass 100), over `cpuWindowSec`. */
  cpuPct: number | null
  /** Physical footprint: Activity Monitor's Memory column. */
  memBytes: number | null
  /** Energy impact (`top`'s POWER), over `energyWindowSec`. */
  energy: number | null
  /** Start time, epoch seconds. */
  start: number | null
  /** The process using the most memory in the whole list (filter or not). */
  largest: boolean
}
export type ProcessListModel = {
  state: 'loading' | 'ok' | 'waiting' | 'unavailable' | 'error'
  reason: ProcessSummary['reason']
  error: string | null
  machineId: string | null
  scope: 'full' | 'top' | null
  topList: boolean
  takenAt: number | null
  ageSec: number | null
  cpuWindowSec: number | null
  memAgeSec: number | null
  energyWindowSec: number | null
  /** Processes on the machine (more than `count` for a top list). */
  total: number | null
  truncated: boolean
  /** Rows in the answer, and rows after the filter. */
  count: number
  shown: number
  sort: { key: ProcessSortKey; dir: 'asc' | 'desc' }
  query: string
  largest: { pid: number; name: string; memBytes: number } | null
  rows: ProcessRowModel[]
}

export const PROCESS_POLL_MS: Readonly<{ local: number; remote: number }>
export const PROCESS_SORT_KEYS: Readonly<Record<ProcessSortKey, 'asc' | 'desc'>>
export const MAX_PROCESS_ROWS: number
export const EXTRA_HISTORY_KEYS: readonly ['rx', 'tx', 'dr', 'dw', 'gpu', 'bat']
export function toProcessList(answer: unknown, options?: { query?: string; sort?: ProcessSortKey; dir?: 'asc' | 'desc' }, now?: number): ProcessListModel
export function compareProcesses(key: ProcessSortKey, dir: 'asc' | 'desc'): (a: ProcessRowModel, b: ProcessRowModel) => number

export type FleetModel = {
  state: 'loading' | 'error' | 'live'
  error: string | null
  thresholds: FleetThresholds
  /** Temperatures in °F (the person's setting); °C otherwise. */
  fahrenheit: boolean
  /** The overview's "Star on GitHub" link (the person's setting). */
  starLink: boolean
  /** The CLI cannot be found or run, or listing paired machines with it failed. */
  cliError: string | null
  /** What a person types for Orca's CLI here. */
  launcher: 'orca' | 'orca-ide'
  /** The running worker's version, from its manifest; null from a worker that does not say. */
  version: string | null
  omitted: number
  online: number
  total: number
  remotes: number
  machines: MachineModel[]
}

export function mergeColumns(
  base: HistoryColumns | undefined,
  extra: HistoryColumns | undefined,
  windowMs: number
): HistoryColumns

export function createFleetBinding(orca: FleetOrca, options?: FleetBindingOptions): FleetBinding

export function levelFor(value: number | null | undefined, thresholds: HealthThresholds): Level
export function trendOf(
  columns: HistoryColumns | null | undefined,
  key: 'cpu' | 'mem' | 'ram' | 'rx' | 'tx' | 'dr' | 'dw' | 'gpu' | 'bat',
  end: number,
  windowMs?: number,
  slotMs?: number
): Trend
export function chartRule(
  metric: 'cpu' | 'memory',
  model: { estimated?: boolean; kind?: string; reliable?: boolean; stale?: boolean },
  thresholds: FleetThresholds
): ChartRule | null
/** The CPU column without readings marked as load-average estimates (`ce`): then only `t` and
 *  `cpu` (with an empty `mem`); without `ce`, the columns as given. */
export function measuredCpu(columns: HistoryColumns): HistoryColumns
export function measuredCpu(columns: HistoryColumns | null | undefined): HistoryColumns | null | undefined
export const MAC_FIGURES_MAX_AGE_MS: number
export function windowStats(
  columns: HistoryColumns | null | undefined,
  key: 'cpu' | 'mem' | 'ram' | 'rx' | 'tx' | 'dr' | 'dw' | 'gpu' | 'bat',
  end: number,
  windowMs?: number
): Stats | null
export function newestReading(columns: HistoryColumns | null | undefined, key: 'cpu' | 'mem' | 'ram' | 'rx' | 'tx' | 'dr' | 'dw' | 'gpu' | 'bat'): { value: number; t: number } | null
export function safeMachineName(name: unknown): boolean
/** A server name as Orca's CLI compares it: trimmed, unquoted, case ignored. */
export function typedName(name: unknown): string
/** A lean machine state with the per-core values and workspaces the panel already holds. */
export function keepDetail<T extends Partial<MachineView>>(state: T, previous: Partial<MachineView> | undefined): T
export function installCommand(
  machine: { id: string; name: string },
  options?: { launcher?: string; ambiguous?: boolean }
): string | null
export function toFleet(view: FleetView | null | undefined, now?: number): FleetModel
export function versionOf(value: unknown): string | null
export function compareVersions(a: string, b: string): number
export const PLUGIN_VERSION_MAX: number
export const FIRST_VERSIONED: string

/** `orca.shell.openExternal` when the frame's `orca.host.has('shell.openExternal')` says it is
 *  offered (the desktop app), else null. */
export function externalOpener(orca: unknown): ((url: string) => Promise<unknown>) | null
