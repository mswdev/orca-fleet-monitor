// Memory alerts: one desktop notification when a machine's memory reaches strained or critical and
// holds there for two readings in a row, and one more if it then escalates to critical (held for
// two readings too). After two minutes back below strained, the next escalation alerts again.
//
// A reading is a new memory reading of that machine (src/poller.ts `onMemoryReading`: a sample,
// a beacon or a diagnostics answer that its memory came from), never a re-merge of an old one.
import { gbText, memoryReasons, rank, type HealthSettings, type MemoryRules } from './health.ts'
import type { MachineState } from './model.ts'

/** Readings in a row at the level before it alerts. */
export const ALERT_CONFIRM_READINGS = 2
/** Below strained for this long (steady clock) re-arms a machine's alerts. */
export const ALERT_REARM_MS = 2 * 60_000
/** Orca takes a title of 1 to 120 characters (and puts the plugin's name before it), and a body of
 *  at most 1000. */
const TITLE_MAX = 120
const BODY_MAX = 1_000
const NAME_MAX = 60

export type AlertLevel = 'strained' | 'critical'

export type AlertNotice = { id: string; name: string; level: AlertLevel; title: string; body: string }

type Track = {
  /** Readings in a row at strained or worse, and at critical. */
  strainedRun: number
  criticalRun: number
  /** The highest level alerted since the last re-arm. */
  alerted: AlertLevel | null
  /** When memory last dropped below strained after an alert; null while it is not below. */
  calmSince: number | null
}

export type AlertDeps = {
  /** The worker's steady clock. */
  now: () => number
  enabled: () => boolean
  health: () => HealthSettings
  memoryRules: () => MemoryRules | undefined
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

export class MemoryAlerts {
  private readonly deps: AlertDeps
  private readonly tracks = new Map<string, Track>()

  constructor(deps: AlertDeps) {
    this.deps = deps
  }

  /** A new memory reading of a machine. Returns the notification to show, if this reading calls
   *  for one. With alerts turned off nothing is shown, and nothing counts as alerted. */
  observe(state: MachineState): AlertNotice | null {
    const level = state.online ? state.health.memory : null
    if (level === null) return null
    const now = this.deps.now()
    const track = this.tracks.get(state.id) ?? { strainedRun: 0, criticalRun: 0, alerted: null, calmSince: null }
    this.tracks.set(state.id, track)
    if (level === 'strained' || level === 'critical') {
      track.strainedRun += 1
      track.criticalRun = level === 'critical' ? track.criticalRun + 1 : 0
      track.calmSince = null
    } else {
      track.strainedRun = 0
      track.criticalRun = 0
      if (track.alerted !== null) {
        track.calmSince ??= now
        if (now - track.calmSince >= ALERT_REARM_MS) {
          track.alerted = null
          track.calmSince = null
        }
      }
    }
    const held: AlertLevel | null =
      track.criticalRun >= ALERT_CONFIRM_READINGS ? 'critical' : track.strainedRun >= ALERT_CONFIRM_READINGS ? 'strained' : null
    if (held === null || (track.alerted !== null && rank(held) <= rank(track.alerted))) return null
    if (!this.deps.enabled()) return null
    track.alerted = held
    return this.notice(state, held)
  }

  /** What one machine's alerts stand at, for tests and logs. */
  trackOf(id: string): Readonly<Track> | null {
    return this.tracks.get(id) ?? null
  }

  private notice(state: MachineState, level: AlertLevel): AlertNotice {
    const memory = state.memory
    const mac = memory?.kind === 'used' ? (memory.mac ?? null) : null
    const name = clip(state.name, NAME_MAX)
    const pressure = memory?.kind === 'used' ? memory.pressurePercent : memory?.kind === 'pressure' ? memory.percent : null
    let headline: string
    if (mac?.pressure === 'warning' || mac?.pressure === 'critical') headline = `memory pressure ${mac.pressure}`
    else if (typeof pressure === 'number') headline = `memory pressure ${Math.round(pressure)}%`
    else headline = `memory ${level}`
    // Only a Mac's own reading is RAM in use; Orca's figure on a Mac is pressure, and is never
    // called "used".
    let numbers: string
    if (memory?.kind === 'used') {
      numbers = `${gbText(memory.used)} of ${gbText(memory.total)} GB used`
      if (mac?.swapUsed !== null && mac?.swapUsed !== undefined) numbers += `, swap ${gbText(mac.swapUsed)} GB`
    } else if (memory?.kind === 'pressure') {
      numbers = `Memory pressure ${Math.round(memory.percent)}%, ${gbText(memory.total)} GB of RAM`
    } else {
      numbers = memory ? `Memory ${Math.round(memory.percent)}% of ${gbText(memory.total)} GB` : ''
    }
    const why = memoryReasons(memory, this.deps.health(), this.deps.memoryRules()).reasons
    const body = [numbers ? `${numbers}.` : '', why.length > 0 ? `Memory ${level}: ${why.join('; ')}.` : ''].filter(Boolean).join(' ')
    return {
      id: state.id,
      name: state.name,
      level,
      title: clip(`${name}: ${headline}`, TITLE_MAX),
      body: clip(body, BODY_MAX)
    }
  }
}
