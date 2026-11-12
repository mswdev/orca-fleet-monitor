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
export type Stats = { avg: number; peak: number }
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
    /** HISTORY_SLOTS one-minute points, oldest first; null where there was no reading. */
    history: (number | null)[]
    stats: Stats | null
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
    history: (number | null)[]
    stats: Stats | null
    mac: MacDetail | null
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
  lastKnown: { cpuPct: number | null; memPct: number | null }
  /** Network, disk, GPU and battery (1.2): each null unless the machine is online and is this Mac
   *  or a Mac running Fleet Monitor 1.2. Rates are bytes per second. */
  net: NetModel | null
  disk: DiskModel | null
  gpu: GpuModel | null
  battery: BatteryModel | null
  processes: ProcessSummary
}

/** One history series, as the charts take it. */
export type Series = { history: (number | null)[]; stats: Stats | null }
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
}
export type GpuModel = { pct: number; ageSec: number | null } & Series
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
  /** The CLI cannot be found or run, or listing paired machines with it failed. */
  cliError: string | null
  /** What a person types for Orca's CLI here. */
  launcher: 'orca' | 'orca-ide'
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
export function bucketHistory(
  columns: HistoryColumns | null | undefined,
  key: 'cpu' | 'mem' | 'ram' | 'rx' | 'tx' | 'dr' | 'dw' | 'gpu' | 'bat',
  end: number,
  slots?: number,
  slotMs?: number
): (number | null)[]
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

/** `orca.shell.openExternal` when the frame's `orca.host.has('shell.openExternal')` says it is
 *  offered (the desktop app), else null. */
export function externalOpener(orca: unknown): ((url: string) => Promise<unknown>) | null
