// The one status bar item: the machine that most needs attention.
import { rank, worstMachine } from './health.ts'
import type { MachineState } from './model.ts'

export const STATUS_BAR_ID = 'fleet'

export type StatusBarView = {
  text: string
  icon: 'gauge'
  tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
  tooltip: string
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const pct = (value: number | null | undefined): string => (value === null || value === undefined ? '–' : `${Math.round(value)}%`)

export function statusBarView(machines: readonly MachineState[]): StatusBarView {
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
    if (!m.online) return `${m.name}: ${m.status}`
    const cpuLabel = m.cpu.source === 'load' ? 'load' : 'CPU'
    const mem = m.memory && m.memory.reliable ? pct(m.memory.percent) : '–'
    return `${m.name}: ${m.health.level} · ${cpuLabel} ${pct(m.cpu.percent)} · mem ${mem}`
  })
  return { text, icon: 'gauge', tone, tooltip: clip(['Fleet Monitor', ...lines].join('\n'), 1_000) }
}
