// Health levels from CPU and memory thresholds, and for a Mac from its own memory reading.
import type { Health, HealthLevel, HealthThresholds, MachineState, MacMemory } from './model.ts'

export const HEALTH_ORDER: readonly HealthLevel[] = ['ok', 'busy', 'strained', 'critical']

export type HealthSettings = { cpu: HealthThresholds; memory: HealthThresholds }

export const DEFAULT_HEALTH: HealthSettings = {
  cpu: { busy: 70, strained: 85, critical: 95 },
  memory: { busy: 75, strained: 88, critical: 95 }
}

/** RAM in use, as Activity Monitor counts it, at which a machine that reports it counts as busy. */
export const DEFAULT_RAM_USED_BUSY = 90

/** Rules that apply only to a machine that reports real RAM usage (a Mac with Fleet Monitor 1.1). */
export type MemoryRules = { ramUsedBusyPercent: number }
export const DEFAULT_MEMORY_RULES: MemoryRules = { ramUsedBusyPercent: DEFAULT_RAM_USED_BUSY }

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

/** Gigabytes as Activity Monitor and the panel write them (2^30 bytes, one decimal, no ".0"). */
export function gbText(bytes: number): string {
  return (bytes / 2 ** 30).toFixed(1).replace(/\.0$/, '')
}

/** Megabytes a second, for a rate in pages. */
function mbPerSec(pages: number, pageSize: number): string {
  const mb = (pages * pageSize) / 2 ** 20
  return mb >= 10 ? String(Math.round(mb)) : mb.toFixed(1).replace(/\.0$/, '')
}

/** What health is judged on for memory. `kind` and the rest come with 1.1 (src/merge.ts); without
 *  them `percent` is judged on the memory thresholds, as before. */
export type MemoryInput = {
  percent: number
  reliable: boolean
  kind?: 'used' | 'pressure'
  pressurePercent?: number | null
  total?: number
  used?: number
  mac?: MacMemory | null
}

type Part = { level: HealthLevel; reason: string }

/**
 * The memory level: the worst of
 * - macOS's own pressure level: critical is critical, warning is strained;
 * - memory pressure % (100 − available) on the memory thresholds, on every machine;
 * - RAM used % at `ramUsedBusyPercent` or more: busy (only where RAM in use is reported);
 * - swap-outs sustained over about 30 s while swap in use is at least a quarter of RAM: busy.
 * Each rule that fires says so, with its numbers.
 */
function memoryParts(memory: MemoryInput, thresholds: HealthThresholds, rules: MemoryRules): Part[] {
  const parts: Part[] = []
  const t = orderedThresholds(thresholds)
  const judged = (level: HealthLevel, reason: string): void => {
    parts.push({ level, reason: level === 'ok' ? '' : reason })
  }
  if (memory.kind !== 'used') {
    const level = levelFor(memory.percent, t)
    const what = memory.kind === 'pressure' ? 'memory pressure' : 'memory'
    judged(level, `${what} ${Math.round(memory.percent)}% ≥ ${thresholdOf(level, t)}%`)
    return parts
  }
  const mac = memory.mac ?? null
  if (mac?.pressure === 'critical' || mac?.pressure === 'warning') {
    const left = mac.availablePercent === null ? '' : `, ${Math.round(mac.availablePercent)}% available`
    judged(mac.pressure === 'critical' ? 'critical' : 'strained', `macOS memory pressure ${mac.pressure}${left}`)
  }
  const pressure = memory.pressurePercent
  if (typeof pressure === 'number' && Number.isFinite(pressure)) {
    const level = levelFor(pressure, t)
    judged(level, `memory pressure ${Math.round(pressure)}% ≥ ${thresholdOf(level, t)}%`)
  }
  const busyAt = Math.min(100, Math.max(1, rules.ramUsedBusyPercent))
  const used = memory.used ?? 0
  const total = memory.total ?? 0
  judged(
    memory.percent >= busyAt ? 'busy' : 'ok',
    `RAM ${Math.round(memory.percent)}% used (${gbText(used)} of ${gbText(total)} GB) ≥ ${busyAt}%`
  )
  if (mac && mac.sustainedSwapOutsPerSec !== null && mac.swapUsed !== null && total > 0) {
    const quarter = total / 4
    judged(
      mac.swapUsed >= quarter ? 'busy' : 'ok',
      `swapping out ${mbPerSec(mac.sustainedSwapOutsPerSec, mac.pageSize)} MB/s for 30 s with ${gbText(mac.swapUsed)} GB of swap in use (≥ ${gbText(quarter)} GB, a quarter of RAM)`
    )
  }
  return parts
}

/** The worse of the CPU and memory levels, with the reasons that set it. Only measured CPU is
 *  judged: an estimate from the load average (`source: 'load'`, the basic tier) never sets a
 *  level, so a basic machine is judged on its memory alone. */
export function assessHealth(
  input: {
    online: boolean
    cpu: { percent: number | null; source: string | null }
    memory: MemoryInput | null
  },
  settings: HealthSettings,
  rules: MemoryRules = DEFAULT_MEMORY_RULES
): Health {
  if (!input.online) {
    return { level: 'unknown', reasons: ['offline'], cpu: null, memory: null }
  }
  const parts: Part[] = []
  let cpu: HealthLevel | null = null
  let memory: HealthLevel | null = null
  if (input.cpu.percent !== null && isMeasuredCpu(input.cpu.source)) {
    cpu = levelFor(input.cpu.percent, settings.cpu)
    parts.push({
      level: cpu,
      reason: cpu === 'ok' ? '' : `CPU ${Math.round(input.cpu.percent)}% ≥ ${thresholdOf(cpu, orderedThresholds(settings.cpu))}%`
    })
  }
  if (input.memory && input.memory.reliable) {
    const memoryRules = memoryParts(input.memory, settings.memory, rules)
    if (memoryRules.length > 0) {
      memory = memoryRules.reduce((a, b) => (rank(b.level) > rank(a.level) ? b : a)).level
      parts.push(...memoryRules)
    }
  }
  if (parts.length === 0) {
    return { level: 'unknown', reasons: ['no data yet'], cpu, memory }
  }
  const worst = parts.reduce((a, b) => (rank(b.level) > rank(a.level) ? b : a))
  return {
    level: worst.level,
    reasons: parts.filter((p) => p.level === worst.level && p.reason).map((p) => p.reason),
    cpu,
    memory
  }
}

/** The reasons for a machine's memory level alone (for alerts): every memory rule at that level. */
export function memoryReasons(
  memory: MemoryInput | null,
  settings: HealthSettings,
  rules: MemoryRules = DEFAULT_MEMORY_RULES
): { level: HealthLevel | null; reasons: string[] } {
  if (!memory || !memory.reliable) return { level: null, reasons: [] }
  const parts = memoryParts(memory, settings.memory, rules)
  if (parts.length === 0) return { level: null, reasons: [] }
  const level = parts.reduce((a, b) => (rank(b.level) > rank(a.level) ? b : a)).level
  return { level, reasons: parts.filter((p) => p.level === level && p.reason).map((p) => p.reason) }
}

/** CPU read by a sampler (here or in a remote's beacon), as opposed to estimated from load. */
export function isMeasuredCpu(source: string | null): boolean {
  return source === 'sampler' || source === 'beacon'
}

/** Measured CPU, or 0 where there is only an estimate (which never ranks a machine). */
function measuredCpu(machine: MachineState): number {
  return isMeasuredCpu(machine.cpu.source) ? (machine.cpu.percent ?? 0) : 0
}

/** The machine that most needs attention: highest level, then highest measured CPU. */
export function worstMachine(machines: readonly MachineState[]): MachineState | null {
  let worst: MachineState | null = null
  for (const machine of machines) {
    if (!machine.online) {
      continue
    }
    if (
      !worst ||
      rank(machine.health.level) > rank(worst.health.level) ||
      (rank(machine.health.level) === rank(worst.health.level) && measuredCpu(machine) > measuredCpu(worst))
    ) {
      worst = machine
    }
  }
  return worst
}
