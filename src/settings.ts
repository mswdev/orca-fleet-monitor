// The person's settings (contributes.settings), read defensively: Orca checks types against the
// manifest, but values can still be out of range or in the wrong order.
import { DEFAULT_HEALTH, DEFAULT_MEMORY_RULES, orderedThresholds, type HealthSettings, type MemoryRules } from './health.ts'

export type FleetSettings = {
  fastIntervalMs: number
  slowIntervalMs: number
  /** CPU thresholds, and the memory ones, which judge memory pressure on every machine. */
  health: HealthSettings
  /** For machines that report RAM in use (Macs with Fleet Monitor 1.1): when that counts as busy. */
  memoryRules: MemoryRules
  cliPath: string | null
  beacon: boolean
  /** Read machines on the slow interval while no panel is open (for the status bar). Off, they
   *  are read only while a Fleet Monitor panel is open here; the beacon is not affected. */
  backgroundMonitoring: boolean
  /** A desktop notification when a machine's memory reaches strained or critical. */
  memoryAlerts: boolean
}

export const DEFAULT_SETTINGS: FleetSettings = {
  fastIntervalMs: 5_000,
  slowIntervalMs: 60_000,
  health: DEFAULT_HEALTH,
  memoryRules: DEFAULT_MEMORY_RULES,
  cliPath: null,
  beacon: true,
  backgroundMonitoring: true,
  memoryAlerts: true
}

const LIMITS = {
  fastSec: { min: 2, max: 60 },
  slowSec: { min: 15, max: 3_600 }
}

function numberSetting(raw: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = raw[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

export function readSettings(raw: Record<string, unknown> | null | undefined): FleetSettings {
  const r = raw ?? {}
  const fastSec = numberSetting(r, 'fastIntervalSeconds', 5, LIMITS.fastSec.min, LIMITS.fastSec.max)
  const slowSec = numberSetting(r, 'slowIntervalSeconds', 60, LIMITS.slowSec.min, LIMITS.slowSec.max)
  const percent = (key: string, fallback: number): number => numberSetting(r, key, fallback, 1, 100)
  const cliPath = typeof r.cliPath === 'string' && r.cliPath.trim() ? r.cliPath.trim() : null
  return {
    fastIntervalMs: Math.round(fastSec * 1000),
    // Slow polling is never faster than fast polling.
    slowIntervalMs: Math.round(Math.max(slowSec, fastSec) * 1000),
    health: {
      cpu: orderedThresholds({
        busy: percent('cpuBusyPercent', DEFAULT_HEALTH.cpu.busy),
        strained: percent('cpuStrainedPercent', DEFAULT_HEALTH.cpu.strained),
        critical: percent('cpuCriticalPercent', DEFAULT_HEALTH.cpu.critical)
      }),
      memory: orderedThresholds({
        busy: percent('memoryBusyPercent', DEFAULT_HEALTH.memory.busy),
        strained: percent('memoryStrainedPercent', DEFAULT_HEALTH.memory.strained),
        critical: percent('memoryCriticalPercent', DEFAULT_HEALTH.memory.critical)
      })
    },
    memoryRules: { ramUsedBusyPercent: percent('ramUsedBusyPercent', DEFAULT_MEMORY_RULES.ramUsedBusyPercent) },
    cliPath,
    beacon: r.beacon !== false,
    backgroundMonitoring: r.backgroundMonitoring !== false,
    memoryAlerts: r.memoryAlerts !== false
  }
}
