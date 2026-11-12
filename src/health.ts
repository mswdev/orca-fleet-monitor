// Health levels from CPU and memory thresholds.
import type { Health, HealthLevel, HealthThresholds, MachineState } from './model.ts'

export const HEALTH_ORDER: readonly HealthLevel[] = ['ok', 'busy', 'strained', 'critical']

export type HealthSettings = { cpu: HealthThresholds; memory: HealthThresholds }

export const DEFAULT_HEALTH: HealthSettings = {
  cpu: { busy: 70, strained: 85, critical: 95 },
  memory: { busy: 75, strained: 88, critical: 95 }
}

export function rank(level: HealthLevel | 'unknown'): number {
  return level === 'unknown' ? -1 : HEALTH_ORDER.indexOf(level)
}

/** Thresholds in rising order whatever order the person typed them in. */
export function orderedThresholds(raw: HealthThresholds): HealthThresholds {
  const [busy, strained, critical] = [raw.busy, raw.strained, raw.critical]
    .map((value) => Math.min(100, Math.max(0, value)))
    .sort((a, b) => a - b) as [number, number, number]
  return { busy, strained, critical }
}

export function levelFor(value: number, thresholds: HealthThresholds): HealthLevel {
  const t = orderedThresholds(thresholds)
  if (value >= t.critical) return 'critical'
  if (value >= t.strained) return 'strained'
  if (value >= t.busy) return 'busy'
  return 'ok'
}

function thresholdOf(level: HealthLevel, t: HealthThresholds): number {
  return level === 'critical' ? t.critical : level === 'strained' ? t.strained : t.busy
}

/** The worse of the CPU and memory levels, with the reasons that set it. */
export function assessHealth(
  input: {
    online: boolean
    cpu: { percent: number | null; source: string | null }
    memory: { percent: number; reliable: boolean } | null
  },
  settings: HealthSettings
): Health {
  if (!input.online) {
    return { level: 'unknown', reasons: ['offline'] }
  }
  const parts: { level: HealthLevel; reason: string }[] = []
  if (input.cpu.percent !== null) {
    const level = levelFor(input.cpu.percent, settings.cpu)
    const label = input.cpu.source === 'load' ? 'CPU load' : 'CPU'
    parts.push({
      level,
      reason:
        level === 'ok'
          ? ''
          : `${label} ${Math.round(input.cpu.percent)}% ≥ ${thresholdOf(level, orderedThresholds(settings.cpu))}%`
    })
  }
  if (input.memory && input.memory.reliable) {
    const level = levelFor(input.memory.percent, settings.memory)
    parts.push({
      level,
      reason:
        level === 'ok'
          ? ''
          : `memory ${Math.round(input.memory.percent)}% ≥ ${thresholdOf(level, orderedThresholds(settings.memory))}%`
    })
  }
  if (parts.length === 0) {
    return { level: 'unknown', reasons: ['no data yet'] }
  }
  const worst = parts.reduce((a, b) => (rank(b.level) > rank(a.level) ? b : a))
  return {
    level: worst.level,
    reasons: parts.filter((p) => p.level === worst.level && p.reason).map((p) => p.reason)
  }
}

/** The machine that most needs attention: highest level, then highest CPU. */
export function worstMachine(machines: readonly MachineState[]): MachineState | null {
  let worst: MachineState | null = null
  for (const machine of machines) {
    if (!machine.online) {
      continue
    }
    if (
      !worst ||
      rank(machine.health.level) > rank(worst.health.level) ||
      (rank(machine.health.level) === rank(worst.health.level) &&
        (machine.cpu.percent ?? 0) > (worst.cpu.percent ?? 0))
    ) {
      worst = machine
    }
  }
  return worst
}
