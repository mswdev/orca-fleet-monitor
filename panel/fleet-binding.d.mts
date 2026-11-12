// Types for fleet-binding.mjs: what a Fleet Monitor view is given. A machine is the worker's
// MachineState (src/model.ts) plus its history in columns; toFleet() turns a view into the
// panel's model, shaped like the design's sample FLEET object.
import type { CliInfo, FleetMode, FleetThresholds, HealthLevel, HealthThresholds, HistoryColumns, MachineView } from '../src/model.ts'

export const HEARTBEAT_MS: number
export const HISTORY_SLOTS: number
export const SLOT_MS: number
export const TOP_WORKSPACES: number
export const INSTALL_SOURCE: string
export const DEFAULT_THRESHOLDS: FleetThresholds
export const LEVEL_LABELS: Readonly<Record<HealthLevel | 'unknown', string>>

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
export type InstallHint = { reason: 'absent' | 'installed' | 'quiet'; command: string | null }
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
    pct: number | null
    /** Basic tier: estimated from the 1-minute load average, not measured. */
    estimated: boolean
    tone: Level
    /** HISTORY_SLOTS one-minute points, oldest first; null where there was no reading. */
    history: (number | null)[]
    stats: Stats | null
    groups: CoreGroupModel[] | null
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
  cliError: string | null
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
export function installCommand(machine: { id: string; name: string }): string
export function toFleet(view: FleetView | null | undefined, now?: number): FleetModel
