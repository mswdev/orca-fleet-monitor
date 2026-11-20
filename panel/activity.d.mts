// Types for activity.mjs: the view-model the Overview | Activity control, the tiles, the
// Processes card and the memory line draw from, and the one adapter that makes it.
import type { MachineModel, Trend } from './fleet-binding.mjs'

export const FIRST_ROWS: number
export const SUGGEST_FLOOR: number
export const SUGGEST_PAST_SEC: number
export const TAB_IDS: Readonly<{ overview: string; activity: string }>
export const TAB_PANEL_ID: string
export const SORT_SPOKEN: Readonly<Record<SortKey, string>>
export const CPU_HEAD: string
export const CPU_HEAD_COMPUTER: string

export type SortKey = 'cpu' | 'memory' | 'energy' | 'name'

/** `now`: the worker's clock, where the sparkline's window ends. */
export type NetworkTile = { down: number | null; up: number | null; downTrend: Trend | null; upTrend: Trend | null; downPeak: number | null; upPeak: number | null; now: number }
export type DiskTile = { usedBytes: number; totalBytes: number; readBps: number | null; writeBps: number | null }
export type GpuTile = { pct: number; peak: number | null; avg: number | null; trend: Trend | null; now: number }
export type BatteryTile = { pct: number; state: 'charging' | 'discharging' | 'charged' | 'not-charging'; minutes: number | null; watts: number | null }
export type Tiles = { network: NetworkTile | null; disk: DiskTile | null; gpu: GpuTile | null; battery: BatteryTile | null }

export type ProcRow = {
  key: string
  pid: number
  name: string
  user: string | null
  /** Percent of one core, as Activity Monitor shows it, so it can exceed 100; on a Windows machine
   *  (`cpuScale` is `computer`), percent of the whole computer, as Task Manager shows it. */
  cpu: number | null
  memory: number | null
  energy: number | null
  runningSec: number | null
  command: string | null
  hint: string | null
}

export type ProcessesModel = {
  state: 'loading' | 'ready' | 'failed'
  top: boolean
  truncated: boolean
  total: number | null
  listed: number
  energy: boolean
  /** What a row's CPU is a share of: one core, or (Windows, as Task Manager) the whole computer. */
  cpuScale: 'core' | 'computer'
  takenAt: number | null
  sort: SortKey
  query: string
  rows: ProcRow[]
}

export type ActivityModel = {
  tabs: boolean
  notice: string | null
  tiles: Tiles
  processes: ProcessesModel | null
  suggest: { name: string; memory: number; ageSec: number | null } | null
}

export function toActivityModel(input: { machine: MachineModel; list: unknown; ui?: { sort: SortKey; query: string }; now: number }): ActivityModel

export function procCpu(value: number | null | undefined): string
export function energyText(value: number | null | undefined): string
export function rate(bytesPerSec: number | null | undefined): { n: string; unit: string; text: string }
export function diskSpace(used: number, total: number): string
export function arrangeRows(rows: readonly ProcRow[], sort: SortKey, held?: readonly string[] | null): ProcRow[]
export function matchRows(rows: readonly ProcRow[], query: string): ProcRow[]
export function matchesSpoken(count: number, query: string): string

/** One card of tiles; null when the machine reports none. */
export function tilesSection(tiles: Tiles): HTMLElement | null
