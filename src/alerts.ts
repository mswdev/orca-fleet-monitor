// Memory alerts: desktop notifications when a machine's memory runs short, judged on each new
// reading of it (src/poller.ts: each sample of this computer, each beacon in a remote's log, each
// diagnostics answer its memory comes from), never on how often this desktop happens to read it.
//
// - Critical alerts on the first reading that shows it; strained once two readings in a row do.
// - A reading that says nothing (none came, it was carried over a failed read, or it is Orca's
//   calm figure for a Mac that reports its own) neither counts nor breaks a run.
// - One alert per level and episode, and one more if it escalates. While it stays critical, a
//   reminder every 10 minutes. After two minutes back below strained, the next episode alerts again.
// - A machine that stops answering while its memory is elevated says so, with its last reading.
// - At most 6 notifications an hour per machine, with room always kept for a critical alert and for
//   "stopped answering".
import { neutralizeBidi } from './bounds.ts'
import { gbText, memoryReasons, rank, type HealthSettings, type MemoryRules } from './health.ts'
import type { HealthLevel, LostReading, MachineState } from './model.ts'

/** Readings in a row at strained before it alerts. */
export const ALERT_CONFIRM_READINGS = 2
/** Readings at critical before it alerts: the first one does. */
export const CRITICAL_CONFIRM_READINGS = 1
/** Below strained for this long (on the readings' own times) re-arms a machine's alerts. */
export const ALERT_REARM_MS = 2 * 60_000
/** While a machine stays critical, a reminder this often. */
export const CRITICAL_REMIND_MS = 10 * 60_000
/** Two strained readings further apart than this, with only silent ones between, are not "in a
 *  row": the second starts a new run. */
export const RUN_GAP_MS = 2 * 60_000
/**
 * Notifications per machine in any hour. A hostile or flapping machine cannot flood: strained
 * alerts stop at 3, and critical alerts and reminders at 5, of everything but "stopped
 * answering", which has up to 2 of its own; so one is always left for it, and a critical alert
 * always has room after strained ones. A machine that stays critical is reminded every 10 minutes,
 * five times an hour.
 */
export const ALERT_CAP = { windowMs: 60 * 60_000, total: 6, strained: 3, reminder: 5, critical: 5, lost: 2 } as const
/** A second "stopped answering" for one machine within this long is not shown unless its memory
 *  was worse. */
export const LOST_REPEAT_MS = 10 * 60_000
/** Orca takes a title of 1 to 120 characters (and puts the plugin's name before it), and a body of
 *  at most 1000. */
const TITLE_MAX = 120
const BODY_MAX = 1_000
const NAME_MAX = 60

export type AlertLevel = 'strained' | 'critical'
/** What a notification is: the first at a level, a reminder, "stopped answering", or a test. */
export type AlertKind = 'strained' | 'critical' | 'reminder' | 'lost' | 'test'

export type AlertNotice = { id: string; name: string; level: AlertLevel; kind: AlertKind; title: string; body: string }

/** One new reading of a machine's memory. */
export type MemoryReading = {
  id: string
  name: string
  /** The memory level it shows; null when it says nothing (see above). */
  level: HealthLevel | null
  /** When it was taken, on the worker's clock (a beacon's own time, moved onto it). */
  at: number
  /** What it read, for the notification's numbers. */
  memory: MachineState['memory']
}

/** A machine whose memory reading stopped arriving while it was elevated (src/poller.ts). */
export type LostEvent = LostReading & { id: string; name: string }

type Track = {
  /** Readings in a row at strained or worse, and at critical. */
  strainedRun: number
  criticalRun: number
  /** The time of the last reading at strained or worse in this run. */
  lastStrainedAt: number | null
  /** The highest level alerted since the last re-arm. */
  alerted: AlertLevel | null
  /** When memory last dropped below strained after an alert; null while it is not below. */
  calmSince: number | null
  /** The newest reading's time, so a reading out of order never moves time back. */
  lastAt: number | null
  /** When the last critical alert or reminder was sent. */
  lastCriticalAt: number | null
  /** What was sent in the last hour, for the cap. */
  sent: { at: number; kind: AlertKind }[]
  /** When the cap last held one back, so that is logged once an hour. */
  heldBackAt: number | null
  /** The last "stopped answering" notice: when, and at what level. */
  lastLost: { at: number; level: AlertLevel } | null
}

export type AlertDeps = {
  /** The worker's steady clock. */
  now: () => number
  enabled: () => boolean
  health: () => HealthSettings
  memoryRules: () => MemoryRules | undefined
  /** A line for the plugin log (the cap holding a notification back). */
  log?: (line: string) => void
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** Control characters (C0, DEL, C1) and the Unicode line and paragraph separators. */
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g

/** Text from another machine made fit for one line of a notification or the log: controls and
 *  line breaks become spaces, runs of space one, bidirectional controls U+FFFD. */
export function oneLine(text: string): string {
  return neutralizeBidi(text.replace(CONTROLS, ' ')).replace(/\s+/g, ' ').trim()
}

const plainName = (name: string, id: string): string => clip(oneLine(name) || oneLine(id) || 'A paired machine', NAME_MAX)

export class MemoryAlerts {
  private readonly deps: AlertDeps
  private readonly tracks = new Map<string, Track>()

  constructor(deps: AlertDeps) {
    this.deps = deps
  }

  /** A new reading of a machine's memory. Returns the notification to show, if this reading calls
   *  for one. With alerts turned off nothing is shown, and nothing counts as alerted. */
  observe(reading: MemoryReading): AlertNotice | null {
    const level = reading.level
    if (level === null) return null
    const track = this.track(reading.id)
    const at = Math.max(track.lastAt ?? Number.NEGATIVE_INFINITY, reading.at)
    track.lastAt = at
    if (level === 'strained' || level === 'critical') {
      if (track.lastStrainedAt !== null && at - track.lastStrainedAt > RUN_GAP_MS) {
        track.strainedRun = 0
        track.criticalRun = 0
      }
      track.strainedRun += 1
      track.criticalRun = level === 'critical' ? track.criticalRun + 1 : 0
      track.lastStrainedAt = at
      track.calmSince = null
    } else {
      track.strainedRun = 0
      track.criticalRun = 0
      track.lastStrainedAt = null
      if (track.alerted !== null) {
        track.calmSince ??= at
        if (at - track.calmSince >= ALERT_REARM_MS) {
          track.alerted = null
          track.calmSince = null
        }
      }
    }
    const held: AlertLevel | null =
      track.criticalRun >= CRITICAL_CONFIRM_READINGS ? 'critical' : track.strainedRun >= ALERT_CONFIRM_READINGS ? 'strained' : null
    if (held === null) return null
    const now = this.deps.now()
    let kind: AlertKind
    if (track.alerted === null || rank(held) > rank(track.alerted)) kind = held
    else if (held === 'critical' && track.lastCriticalAt !== null && now - track.lastCriticalAt >= CRITICAL_REMIND_MS) kind = 'reminder'
    else return null
    if (!this.deps.enabled()) return null
    if (!this.allowed(track, kind, now, reading.name, reading.id)) return null
    track.alerted = held
    if (held === 'critical') track.lastCriticalAt = now
    track.sent.push({ at: now, kind })
    return this.notice(reading, held, kind, now)
  }

  /** A machine stopped answering (or its readings stopped) while its memory was elevated: one
   *  notification with its last reading, within the cap. */
  stopped(event: LostEvent): AlertNotice | null {
    if (!this.deps.enabled()) return null
    const track = this.track(event.id)
    const now = this.deps.now()
    // A machine that answers slowly flips between answering and not: one notice per 10 minutes,
    // unless its memory was worse this time.
    const level: AlertLevel = rank(event.level) >= rank('critical') ? 'critical' : 'strained'
    if (track.lastLost && now - track.lastLost.at < LOST_REPEAT_MS && rank(level) <= rank(track.lastLost.level)) return null
    if (!this.allowed(track, 'lost', now, event.name, event.id)) return null
    track.sent.push({ at: now, kind: 'lost' })
    track.lastLost = { at: now, level }
    const name = plainName(event.name, event.id)
    const title = event.how === 'stale' ? `${name}: readings stopped` : `${name} stopped answering`
    const ago = event.lastReadingAt === null ? '' : `, ${agoText(Math.max(0, now - event.lastReadingAt))} ago`
    const why = event.how === 'stale' ? ' Orca still reaches it, but its Fleet Monitor readings stopped arriving.' : ''
    const body = `Last reading${ago}: ${oneLine(event.summary)}.${why}`
    return {
      id: event.id,
      name: event.name,
      level,
      kind: 'lost',
      title: clip(title, TITLE_MAX),
      body: clip(body, BODY_MAX)
    }
  }

  /** The notification "Fleet Monitor: Send a test alert" shows, through the same path. Not
   *  counted against any machine. */
  testNotice(): AlertNotice {
    const off = this.deps.enabled() ? '' : ' Memory alerts are turned off in Fleet Monitor’s settings, so real ones are not shown.'
    return {
      id: 'test',
      name: 'test',
      level: 'strained',
      kind: 'test',
      title: 'Test alert: nothing is wrong',
      body: `You ran “Fleet Monitor: Send a test alert”. If you can read this, Fleet Monitor’s memory alerts reach you on this computer.${off}`
    }
  }

  /** What one machine's alerts stand at, for tests and logs. */
  trackOf(id: string): Readonly<Track> | null {
    return this.tracks.get(id) ?? null
  }

  private track(id: string): Track {
    let track = this.tracks.get(id)
    if (!track) {
      track = { strainedRun: 0, criticalRun: 0, lastStrainedAt: null, alerted: null, calmSince: null, lastAt: null, lastCriticalAt: null, sent: [], heldBackAt: null, lastLost: null }
      this.tracks.set(id, track)
    }
    return track
  }

  /** Whether the cap leaves room for one more of this kind; logs, once an hour, when it does not. */
  private allowed(track: Track, kind: AlertKind, now: number, name: string, id: string): boolean {
    track.sent = track.sent.filter((s) => now - s.at < ALERT_CAP.windowMs)
    const all = track.sent.length
    const lost = track.sent.filter((s) => s.kind === 'lost').length
    const others = all - lost
    const room =
      all < ALERT_CAP.total &&
      (kind === 'lost'
        ? lost < ALERT_CAP.lost
        : kind === 'strained'
          ? others < ALERT_CAP.strained
          : kind === 'reminder'
            ? others < ALERT_CAP.reminder
            : others < ALERT_CAP.critical)
    if (!room && (track.heldBackAt === null || now - track.heldBackAt >= ALERT_CAP.windowMs)) {
      track.heldBackAt = now
      this.deps.log?.(`memory alert for ${plainName(name, id)} held back: ${all} sent in the last hour`)
    }
    return room
  }

  private notice(reading: MemoryReading, level: AlertLevel, kind: AlertKind, now: number): AlertNotice {
    const memory = reading.memory
    const mac = memory?.kind === 'used' ? (memory.mac ?? null) : null
    const name = plainName(reading.name, reading.id)
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
    const still = kind === 'reminder' ? `Still critical. ` : ''
    const late = now - reading.at > 30_000 ? ` (read ${agoText(now - reading.at)} ago)` : ''
    const body = [still, numbers ? `${numbers}${late}.` : '', why.length > 0 ? `Memory ${level}: ${why.join('; ')}.` : ''].filter(Boolean).join(' ')
    return {
      id: reading.id,
      name: reading.name,
      level,
      kind,
      title: clip(`${name}: ${headline}`, TITLE_MAX),
      body: clip(oneLine(body), BODY_MAX)
    }
  }
}

/** "20 s", "3 min", "2 h". */
function agoText(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 90) return `${s} s`
  const min = Math.round(s / 60)
  return min < 90 ? `${min} min` : `${Math.round(min / 60)} h`
}
