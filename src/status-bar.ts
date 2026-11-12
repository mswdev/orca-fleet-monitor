// The one status bar item: the machine that most needs attention.
import { isMeasuredCpu, rank, worstMachine } from './health.ts'
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

export function statusBarView(all: readonly MachineState[], options: StatusBarOptions = {}): StatusBarView {
  const machines = options.remotesPaused ? all.filter((m) => m.kind === 'local') : all
  const online = machines.filter((m) => m.online)
  const offline = machines.filter((m) => m.kind === 'remote' && m.status === 'offline')
  const worst = worstMachine(machines)
  const level = worst?.health.level ?? 'unknown'
  let text: string
  let tone: StatusBarView['tone']
  if (worst && rank(level) > rank('ok')) {
    text = `${clip(worst.name, 24)} ${level}`
    tone = level === 'critical' ? 'danger' : level === 'strained' ? 'warning' : 'accent'
  } else {
    text = `${online.length} ${online.length === 1 ? 'machine' : 'machines'} ok`
    tone = 'neutral'
  }
  if (offline.length > 0) {
    text += ` · ${offline.length} offline`
    if (tone === 'neutral' || tone === 'accent') tone = 'warning'
  }
  const lines = machines.map((m) => {
    if (!m.online) return `${clip(m.name, 64)}: ${m.status}`
    const mem = m.memory && m.memory.reliable ? pct(m.memory.percent) : '–'
    return `${clip(m.name, 64)}: ${m.health.level} · ${cpuText(m)} · mem ${mem}`
  })
  const paused = all.length > machines.length
  if (paused) lines.push('Paired machines are read only while Fleet Monitor is open (background monitoring is off).')
  return { text, icon: 'gauge', tone, tooltip: clip(['Fleet Monitor', ...lines].join('\n'), 1_000) }
}
