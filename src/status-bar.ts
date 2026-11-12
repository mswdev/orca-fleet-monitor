// The one status bar item: the machine that most needs attention. A machine that stopped answering
// while its memory was elevated (`lost`) comes first: it may have run out of memory.
import { gbText, isMeasuredCpu, rank, worstMachine } from './health.ts'
import { lostLevel } from './merge.ts'
import type { MachineState } from './model.ts'

export const STATUS_BAR_ID = 'fleet'

export type StatusBarView = {
  text: string
  icon: 'gauge'
  tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
  tooltip: string
}

export type StatusBarOptions = {
  /** Background monitoring is off and no panel is open: paired machines are not being read, so
   *  their last readings would be stale. Only this computer is summed up. */
  remotesPaused?: boolean
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const pct = (value: number | null | undefined): string => (value === null || value === undefined ? '–' : `${Math.round(value)}%`)

function cpuText(m: MachineState): string {
  if (isMeasuredCpu(m.cpu.source)) return `CPU ${pct(m.cpu.percent)}`
  if (m.cpu.source === 'load') return m.cpu.percent === null ? 'CPU –' : `CPU ~${pct(m.cpu.percent)} (estimate)`
  return 'CPU –'
}

/** Memory as the panel names it: RAM in use for a Mac's own reading, memory pressure for Orca's
 *  reading of a Mac (never "used"), and Orca's figure as before elsewhere. */
function memoryText(m: MachineState): string {
  if (m.memory?.kind === 'unavailable') return 'memory unavailable'
  const memory = m.memory && m.memory.reliable ? m.memory : null
  if (!memory) return 'mem –'
  if (memory.kind === 'used') {
    const mac = memory.mac ?? null
    let text = `RAM ${pct(memory.percent)} used (${gbText(memory.used)}/${gbText(memory.total)} GB)`
    if (mac?.swapUsed) text += ` · swap ${gbText(mac.swapUsed)} GB`
    if (mac?.pressure === 'warning' || mac?.pressure === 'critical') text += ` · memory pressure ${mac.pressure}`
    return text
  }
  if (memory.kind === 'pressure') return `memory pressure ${pct(memory.percent)}`
  return `mem ${pct(memory.percent)}`
}

/** "stopped answering" or "readings stopped", for a lost machine. */
function lostWords(m: MachineState): string {
  return m.lost?.how === 'stale' ? 'readings stopped' : 'stopped answering'
}

/** The lost machine to name, if any: the one whose last level was worst, then the latest. */
function worstLost(machines: readonly MachineState[]): MachineState | null {
  let worst: MachineState | null = null
  for (const m of machines) {
    if (!m.lost) continue
    if (!worst || rank(lostLevel(m.lost)) > rank(lostLevel(worst.lost!)) || (rank(lostLevel(m.lost)) === rank(lostLevel(worst.lost!)) && m.lost.since > worst.lost!.since)) worst = m
  }
  return worst
}

/** The level and, when it is not ok, why. */
function levelText(m: MachineState): string {
  const why = m.health.level !== 'ok' && m.health.level !== 'unknown' ? m.health.reasons.filter(Boolean) : []
  return why.length > 0 ? `${m.health.level} (${why.join('; ')})` : m.health.level
}

/** "memory " when memory alone sets the machine's level, so the status bar says what is wrong. */
function causeText(m: MachineState): string {
  const { level, cpu, memory } = m.health
  if (level === 'unknown' || memory !== level) return ''
  return cpu !== null && rank(cpu) >= rank(level) ? '' : 'memory '
}

export function statusBarView(all: readonly MachineState[], options: StatusBarOptions = {}): StatusBarView {
  const machines = options.remotesPaused ? all.filter((m) => m.kind === 'local') : all
  const online = machines.filter((m) => m.online)
  const offline = machines.filter((m) => m.kind === 'remote' && m.status === 'offline')
  const worst = worstMachine(machines)
  const level = worst?.health.level ?? 'unknown'
  const lost = worstLost(machines)
  let text: string
  let tone: StatusBarView['tone']
  let named: MachineState | null = null
  if (lost && (!worst || worst.lost || rank(lostLevel(lost.lost!)) >= rank(level))) {
    named = lost
    text = `${clip(lost.name, 24)} ${lostWords(lost)}`
    tone = 'danger'
  } else if (worst && rank(level) > rank('ok')) {
    text = `${clip(worst.name, 24)} ${causeText(worst)}${level}`
    tone = level === 'critical' ? 'danger' : level === 'strained' ? 'warning' : 'accent'
  } else {
    text = `${online.length} ${online.length === 1 ? 'machine' : 'machines'} ok`
    tone = 'neutral'
  }
  const otherOffline = offline.filter((m) => m !== named).length
  if (otherOffline > 0) {
    text += named ? ` · ${otherOffline} more offline` : ` · ${otherOffline} offline`
    if (tone === 'neutral' || tone === 'accent') tone = 'warning'
  }
  const lines = machines.map((m) => {
    const name = clip(m.name, 64)
    if (m.lost) {
      const now = m.online ? ` · now ${cpuText(m)} · ${memoryText(m)}` : ''
      return `${name}: ${lostWords(m)} · last reading: ${m.lost.summary}${now}`
    }
    if (!m.online) return `${name}: ${m.status}`
    return `${name}: ${levelText(m)} · ${cpuText(m)} · ${memoryText(m)}`
  })
  const paused = all.length > machines.length
  if (paused) lines.push('Paired machines are read only while Fleet Monitor is open (background monitoring is off).')
  return { text, icon: 'gauge', tone, tooltip: clip(['Fleet Monitor', ...lines].join('\n'), 1_000) }
}
