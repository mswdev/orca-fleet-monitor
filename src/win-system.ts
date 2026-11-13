// A Windows computer's network, disk, GPU and battery, read without elevation. All but the disk's
// space are asked of the one resident PowerShell (src/win-host.ts), which reads them from .NET:
//
//   network   `net` every reading (5 s), for the adapter that is up and has a default gateway:
//             bytes in and out per second from the adapter's cumulative 64-bit counters
//   disk      `statfs` of the system drive about once a minute (no request): the volume's size,
//             and used = size − what is free to this user;
//             `disk` about every 20 s: bytes read and written per second over every physical
//             disk, from the PhysicalDisk counters' cumulative totals
//   GPU       `gpu` about every 30 s: the "GPU Engine" counters' utilisation between two
//             requests, the busiest GPU when there are several; none before Windows 10 1709
//   battery   `bat` about once a minute: power line, charge, charging or not, time remaining
//
// What is read less often than every reading is carried until the next read, with its age; a
// read that fails carries the last value for a while longer, then the value is dropped. Every
// answer is parsed defensively: a figure out of shape is left out, never guessed.
//
// Cost, on a 4-core CI machine (src/win-host.ts has the figures): once PowerShell is running, a
// refresh is answered in about 20 ms. Not measured on a desktop, nor with a real GPU, where `gpu`
// reads one counter for each process using each engine.
import { performance } from 'node:perf_hooks'
import { diskSpaceOf, due, interfaceLabel, realStatfs, SYSTEM_CADENCE, systemSnapshot, type Held, type StatFs } from './mac-system.ts'

export { interfaceLabel }
import type { BatteryReading, MacSystem, NetReading } from './model.ts'
import { PowerShellHost } from './win-host.ts'

/** How long PowerShell has to answer one request. Long, because a slow answer costs nothing
 *  (readings are never waited for) while giving up kills PowerShell, and its first use of the
 *  performance counters can take seconds. */
const REQUEST_TIMEOUT_MS = 10_000
/** Longest adapter name kept to tell one adapter from another; Windows allows 255 characters. */
const ADAPTER_NAME_MAX = 256

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** A count as JSON carries it: a whole number from 0 up that a double holds exactly. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** `net`'s answer, `{ n, rx, tx }`: the adapter's name as Windows has it and its cumulative
 *  bytes received and sent; null when out of shape. */
export function parseNetAnswer(answer: unknown): { name: string; rx: number; tx: number } | null {
  const a = record(answer)
  if (!a || typeof a.n !== 'string' || a.n === '' || !isCount(a.rx) || !isCount(a.tx)) return null
  return { name: a.n.slice(0, ADAPTER_NAME_MAX), rx: a.rx, tx: a.tx }
}


/** `disk`'s answer, `{ r, w }`: cumulative bytes read and written over every physical disk. */
export function parseDiskAnswer(answer: unknown): { read: number; write: number } | null {
  const a = record(answer)
  return a && isCount(a.r) && isCount(a.w) ? { read: a.r, write: a.w } : null
}

/** `gpu`'s answer, `{ p }`: the busiest GPU's utilisation, 0 to 100, as a whole number; null when
 *  there is none (no such counters, or the first request) or it is out of shape. */
export function parseGpuAnswer(answer: unknown): number | null {
  const p = record(answer)?.p
  return typeof p === 'number' && p >= 0 && p <= 100 ? Math.round(p) : null
}

/** BatteryChargeStatus: flags, except that 255 is "unknown" and not all of them at once. */
const BATTERY_FLAG = { charging: 8, noBattery: 128, unknown: 255 } as const
/** More minutes than this is no estimate (a beacon carries no more either). */
const MAX_MINUTES = 100_000

/**
 * `bat`'s answer, `{ line, flag, pct, secs }`, as .NET's PowerStatus has them: the power line
 * (0 offline, 1 online, 255 unknown), BatteryChargeStatus, the charge in percent and the seconds
 * the battery has left (−1 when Windows has no estimate). Null when out of shape, or when Windows
 * does not know the battery's status at all: .NET reports the charge as 100% then.
 */
export function parseBatteryAnswer(answer: unknown): BatteryReading | null {
  const a = record(answer)
  if (!a) return null
  const { line, flag, pct, secs } = a
  if (!isCount(flag) || flag >= BATTERY_FLAG.unknown) return null
  if (flag & BATTERY_FLAG.noBattery) return { present: false, percent: null, state: null, source: line === 1 ? 'ac' : null, minutesRemaining: null }
  const percent = typeof pct === 'number' && pct >= 0 && pct <= 100 ? Math.round(pct) : null
  // Windows has no "charged": on the power line and not charging is charged at 100%, and held
  // below it otherwise (a charge limit, or a charger too weak).
  let state: BatteryReading['state'] = null
  if (flag & BATTERY_FLAG.charging) state = 'charging'
  else if (line === 0) state = 'discharging'
  else if (line === 1) state = percent === 100 ? 'charged' : 'not-charging'
  const minutes = state === 'discharging' && typeof secs === 'number' && secs > 0 ? Math.round(secs / 60) : null
  return {
    present: true,
    percent,
    state,
    source: line === 1 ? 'ac' : line === 0 ? 'battery' : null,
    minutesRemaining: minutes !== null && minutes <= MAX_MINUTES ? minutes : null
  }
}

/** The root of the drive Windows is on (`SystemDrive`), `C:\` when the variable is not a drive. */
export function systemDriveRoot(env: NodeJS.ProcessEnv): string {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'SYSTEMDRIVE')
  const drive = key === undefined ? undefined : env[key]
  return `${drive !== undefined && /^[A-Za-z]:$/.test(drive) ? drive : 'C:'}\\`
}



/**
 * Reads a Windows computer's network, disk, GPU and battery, each on its own cadence. `refresh()`
 * asks PowerShell for what is due (with every reading); `snapshot()` gives what is known now,
 * with ages. Never throws; on any other platform it asks nothing and `snapshot()` is null. The
 * PowerShell host is shared with the process list (src/win-processes.ts), so it is handed in and
 * never stopped here.
 */
export class WindowsSystemReader {
  private readonly host: Pick<PowerShellHost, 'request'>
  private readonly mono: () => number
  private readonly statfs: StatFs
  private readonly platform: string
  private readonly spacePath: string
  /** False while optional work should wait: disk traffic and the GPU are not asked for then, and
   *  what they last read is carried until it is too old. */
  private readonly heavyAllowed: () => boolean
  private netCounters: { name: string; rx: number; tx: number; at: number } | null = null
  private net: Held<NetReading> | null = null
  private diskCounters: { read: number; write: number; at: number } | null = null
  private diskIo: Held<{ read: number | null; write: number | null }> | null = null
  private diskIoTriedAt = Number.NEGATIVE_INFINITY
  private gpu: Held<number> | null = null
  private gpuTriedAt = Number.NEGATIVE_INFINITY
  private gpuAsked = false
  private battery: Held<BatteryReading> | null = null
  private batteryTriedAt = Number.NEGATIVE_INFINITY
  private space: Held<{ total: number; used: number }> | null = null
  private spaceTriedAt = Number.NEGATIVE_INFINITY
  private running: Promise<void> | null = null

  constructor(
    options: {
      host?: Pick<PowerShellHost, 'request'>
      mono?: () => number
      statfs?: StatFs
      platform?: string
      env?: NodeJS.ProcessEnv
      heavyAllowed?: () => boolean
    } = {}
  ) {
    this.platform = options.platform ?? process.platform
    this.host = options.host ?? new PowerShellHost({ platform: this.platform })
    this.mono = options.mono ?? (() => performance.now())
    this.statfs = options.statfs ?? realStatfs
    this.spacePath = systemDriveRoot(options.env ?? process.env)
    this.heavyAllowed = options.heavyAllowed ?? (() => true)
  }

  /** Reads what is due. A refresh still running is joined, not started again. */
  refresh(): Promise<void> {
    if (this.platform !== 'win32') return Promise.resolve()
    this.running ??= this.readDue()
      .catch(() => undefined)
      .finally(() => {
        this.running = null
      })
    return this.running
  }

  /** What is known now: each part with its age, or null where there is nothing young enough. */
  snapshot(): MacSystem | null {
    if (this.platform !== 'win32') return null
    return systemSnapshot({ net: this.net, diskIo: this.diskIo, space: this.space, gpu: this.gpu, battery: this.battery }, this.mono())
  }

  private async readDue(): Promise<void> {
    const now = this.mono()
    const heavy = this.heavyAllowed()
    // PowerShell answers one request at a time, in the order asked: the network first.
    const jobs: Promise<void>[] = [this.readNet()]
    if (heavy && due(this.diskIoTriedAt, now, SYSTEM_CADENCE.diskIoMs)) jobs.push(this.readDiskIo(now))
    if (heavy && due(this.gpuTriedAt, now, SYSTEM_CADENCE.gpuMs)) jobs.push(this.readGpu(now))
    if (due(this.batteryTriedAt, now, SYSTEM_CADENCE.batteryMs)) jobs.push(this.readBattery(now))
    if (due(this.spaceTriedAt, now, SYSTEM_CADENCE.spaceMs)) this.readSpace(now)
    await Promise.all(jobs)
  }

  private async ask(command: string): Promise<unknown> {
    try {
      return await this.host.request(command, REQUEST_TIMEOUT_MS)
    } catch {
      return null
    }
  }

  private async readNet(): Promise<void> {
    // No answer is a failed read or no adapter with a default gateway (offline): either way
    // there is nothing to show, and what was shown grows old.
    const counters = parseNetAnswer(await this.ask('net'))
    const at = this.mono()
    if (!counters) return
    const last = this.netCounters
    let rates: { rx: number; tx: number } | null = null
    // By the name Windows has, not the label made of it: two adapters can share a label.
    if (last && last.name === counters.name && counters.rx >= last.rx && counters.tx >= last.tx) {
      const seconds = (at - last.at) / 1000
      if (seconds >= 0.5) rates = { rx: Math.round((counters.rx - last.rx) / seconds), tx: Math.round((counters.tx - last.tx) / seconds) }
    }
    this.netCounters = { ...counters, at }
    this.net = { value: { iface: interfaceLabel(counters.name), rxBytesPerSec: rates?.rx ?? null, txBytesPerSec: rates?.tx ?? null }, at }
  }

  private async readDiskIo(now: number): Promise<void> {
    this.diskIoTriedAt = now
    const counters = parseDiskAnswer(await this.ask('disk'))
    const at = this.mono()
    if (!counters) return
    const last = this.diskCounters
    this.diskCounters = { ...counters, at }
    if (!last) return
    const seconds = (at - last.at) / 1000
    if (!(seconds >= 0.5)) return
    // The totals are over the disks there are now, so one falls when a disk is taken out: no
    // rate from a total that went back.
    const rate = (before: number, after: number): number | null => (after >= before ? Math.round((after - before) / seconds) : null)
    const read = rate(last.read, counters.read)
    const write = rate(last.write, counters.write)
    this.diskIo = read === null && write === null ? null : { value: { read, write }, at }
  }

  private async readGpu(now: number): Promise<void> {
    this.gpuTriedAt = now
    const percent = parseGpuAnswer(await this.ask('gpu'))
    if (percent !== null) this.gpu = { value: percent, at: this.mono() }
    // PowerShell's first answer is always null: it has only then taken the samples the next is
    // worked out from. So the second is asked for with the next reading, not half a minute on.
    // Once only: a computer without these counters answers null every time.
    else if (!this.gpuAsked) this.gpuTriedAt = Number.NEGATIVE_INFINITY
    this.gpuAsked = true
  }

  private async readBattery(now: number): Promise<void> {
    this.batteryTriedAt = now
    const battery = parseBatteryAnswer(await this.ask('bat'))
    if (battery) this.battery = { value: battery, at: this.mono() }
  }

  private readSpace(now: number): void {
    this.spaceTriedAt = now
    let space: { total: number; used: number } | null = null
    try {
      space = diskSpaceOf(this.statfs(this.spacePath))
    } catch {
      space = null
    }
    if (space) this.space = { value: space, at: now }
  }
}

