// Types for fleet-binding.mjs: what a Fleet Monitor view is given. A machine is the worker's
// MachineState (src/model.ts) plus its history in columns; toFleet() turns a view into the
// panel's model, shaped like the design's sample FLEET object.
import type { CliInfo, FleetMode, FleetThresholds, HealthLevel, HealthThresholds, HistoryColumns, MachineView } from '../src/model.ts'

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
/** `command` is null when neither the machine's name nor its id can go into a command safely. */
export type InstallHint = { reason: 'absent' | 'installed' | 'quiet'; command: string | null; launcher?: 'orca' | 'orca-ide' }
export type Stats = { avg: number; peak: number }

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
    pct: number | null
    reliable: boolean
    usedBytes: number | null
    totalBytes: number | null
    tone: Level
    history: (number | null)[]
    stats: Stats | null
  }
  orca: { cpuPct: number; memBytes: number | null } | null
  workspaces: WorkspaceModel[]
  install: InstallHint | null
  lastKnown: { cpuPct: number | null; memPct: number | null }
}

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
  key: 'cpu' | 'mem',
  end: number,
  slots?: number,
  slotMs?: number
): (number | null)[]
export function windowStats(
  columns: HistoryColumns | null | undefined,
  key: 'cpu' | 'mem',
  end: number,
  windowMs?: number
): Stats | null
export function newestReading(columns: HistoryColumns | null | undefined, key: 'cpu' | 'mem'): { value: number; t: number } | null
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
