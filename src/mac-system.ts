// A Mac's network, disk, GPU and battery, from tools macOS ships, read without privileges:
//
//   network   `netstat -ibn -I <iface>` every reading (5 s), for the interface the default route
//             goes out of (`route -n get default`, about once a minute): bytes in and out per
//             second from the interface's cumulative 64-bit counters
//   disk      `statfs` of the main volume about once a minute (no child process): the APFS
//             container's size, and used = size − available, as `df` counts available;
//             `ioreg -r -d 1 -c IOBlockStorageDriver` about every 20 s: bytes read and written
//             per second, summed over every disk, as Activity Monitor's Disk tab sums them
//   GPU       `ioreg -r -d 1 -c IOAccelerator` about every 30 s: "Device Utilization %", the
//             busiest GPU when there are several
//   battery   `pmset -g batt` about once a minute: power source, charge, state, time remaining
//
// What is read less often than every reading is carried until the next read, with its age; a
// read that fails carries the last value for a while longer, then the value is dropped. Every
// output is parsed defensively: a figure out of shape is left out, never guessed.
//
// Cost on an Apple M2 Max with about 1,000 processes (child CPU, user + system): netstat 1.5 ms,
// route 1.4 ms, ioreg 19 ms per class (it walks the whole I/O Kit registry), pmset 5 ms. See
// tools/measure-cost.ts for the whole sampler.
import { statfsSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { createRunBounded, type ExecFile } from './mac-memory.ts'
import type { BatteryReading, DiskReading, GpuReading, MacSystem, NetReading } from './model.ts'

export const NETSTAT_PATH = '/usr/sbin/netstat'
export const ROUTE_PATH = '/sbin/route'
export const IOREG_PATH = '/usr/sbin/ioreg'
export const PMSET_PATH = '/usr/bin/pmset'
const TIMEOUT_MS = 2_000
/** This reader's own bounded runner, apart from the memory reads' (src/mac-memory.ts). */
export const systemRunBounded: ExecFile = createRunBounded()
/** ioreg prints every property of each matching object: about 45 KB for one Apple GPU. */
const IOREG_MAX_BYTES = 1024 * 1024
const MAX_OUTPUT_BYTES = 64 * 1024

/** How often each part is read, and how long a value may be carried past a failed read. */
export const SYSTEM_CADENCE = {
  routeMs: 60_000,
  diskIoMs: 20_000,
  gpuMs: 30_000,
  batteryMs: 60_000,
  spaceMs: 60_000
} as const
export const SYSTEM_MAX_AGE = {
  netMs: 12_000,
  diskIoMs: 50_000,
  gpuMs: 70_000,
  batteryMs: 180_000,
  spaceMs: 180_000
} as const

/** A network interface name `netstat -I` may be given: letters, digits, `.`, `_`, `-`. */
export function isInterfaceName(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9._-]{0,15}$/.test(name)
}

/**
 * A network interface's name in the shape a beacon carries (isInterfaceName), for the platforms
 * whose own names need not fit it: Windows' adapter names ("Ethernet 3", "Wi-Fi"), and a Linux
 * name that starts with a digit. Anything else than a letter, digit, `.`, `_` or `-` becomes `-`;
 * what comes before the first letter is dropped; a name with nothing left is `net`.
 */
export function interfaceLabel(name: string): string {
  const label = name
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z]+/, '')
    .slice(0, 16)
    .replace(/-+$/, '')
  return isInterfaceName(label) ? label : 'net'
}

/** The interface of the default route, from `route -n get default`, or null. */
export function parseDefaultRoute(text: unknown): string | null {
  if (typeof text !== 'string' || text.length > MAX_OUTPUT_BYTES) return null
  const match = /^\s*interface:\s*(\S+)\s*$/m.exec(text)
  return match && isInterfaceName(match[1]) ? match[1] : null
}

const DIGITS = /^\d{1,20}$/

/**
 * Cumulative bytes in and out of `iface` from `netstat -ibn -I <iface>`: its `<Link#n>` row,
 * which carries the interface's own counters (the address rows repeat them). The columns are
 * found by the header, counted from the right, because a row without a hardware address (a VPN
 * tunnel) has one field fewer in the middle.
 */
export function parseNetstat(text: unknown, iface: string): { rx: number; tx: number } | null {
  if (typeof text !== 'string' || text.length > MAX_OUTPUT_BYTES) return null
  const lines = text.split('\n')
  const header = (lines[0] ?? '').trim().split(/\s+/)
  const rxAt = header.indexOf('Ibytes')
  const txAt = header.indexOf('Obytes')
  if (header[0] !== 'Name' || rxAt === -1 || txAt === -1) return null
  const rxFromEnd = header.length - 1 - rxAt
  const txFromEnd = header.length - 1 - txAt
  for (const line of lines.slice(1)) {
    const fields = line.trim().split(/\s+/)
    // `en1*` is an interface that is down.
    if (fields[0]?.replace(/\*$/, '') !== iface || !/^<Link#\d+>$/.test(fields[2] ?? '')) continue
    const rx = fields[fields.length - 1 - rxFromEnd]
    const tx = fields[fields.length - 1 - txFromEnd]
    if (rx === undefined || tx === undefined || !DIGITS.test(rx) || !DIGITS.test(tx)) return null
    const rxN = Number(rx)
    const txN = Number(tx)
    return Number.isSafeInteger(rxN) && Number.isSafeInteger(txN) ? { rx: rxN, tx: txN } : null
  }
  return null
}

/** Cumulative bytes read and written per block storage driver, keyed by its registry id, from
 *  `ioreg -r -d 1 -c IOBlockStorageDriver`. A driver without readable statistics is left out. */
export function parseDiskStats(text: unknown): Map<string, { read: number; write: number }> | null {
  if (typeof text !== 'string' || text.length > IOREG_MAX_BYTES) return null
  const out = new Map<string, { read: number; write: number }>()
  let id: string | null = null
  for (const line of text.split('\n')) {
    const object = /\+-o .*<class [A-Za-z0-9_]+, id (0x[0-9a-f]{1,16})\b/.exec(line)
    if (object) {
      id = object[1]!
      continue
    }
    if (id === null || !/^\s*"Statistics" = \{/.test(line)) continue
    const read = /"Bytes \(Read\)"=(\d{1,20})\b/.exec(line)
    const write = /"Bytes \(Write\)"=(\d{1,20})\b/.exec(line)
    const r = read ? Number(read[1]) : Number.NaN
    const w = write ? Number(write[1]) : Number.NaN
    if (Number.isSafeInteger(r) && Number.isSafeInteger(w) && !out.has(id)) out.set(id, { read: r, write: w })
    id = null
  }
  return out
}

/** The busiest GPU's "Device Utilization %" from `ioreg -r -d 1 -c IOAccelerator`, or null when
 *  no accelerator reports one (some Intel GPUs, virtual machines). */
export function parseGpu(text: unknown): number | null {
  if (typeof text !== 'string' || text.length > IOREG_MAX_BYTES) return null
  let best: number | null = null
  for (const line of text.split('\n')) {
    if (!/^\s*"PerformanceStatistics" = \{/.test(line)) continue
    const match = /"Device Utilization %"=(\d{1,3})\b/.exec(line)
    const value = match ? Number(match[1]) : Number.NaN
    if (value >= 0 && value <= 100) best = best === null ? value : Math.max(best, value)
  }
  return best
}

const STATE_OF: Record<string, BatteryReading['state']> = {
  charging: 'charging',
  'finishing charge': 'charging',
  discharging: 'discharging',
  charged: 'charged',
  'ac attached': 'not-charging',
  'not charging': 'not-charging'
}

/**
 * `pmset -g batt`:
 *   Now drawing from 'AC Power'
 *    -InternalBattery-0 (id=1234567)	81%; charging; 1:05 remaining present: true
 * A Mac without a battery has the first line only. Time remaining is "(no estimate)" while
 * macOS works it out, and "0:00" once charged; neither is an estimate.
 */
export function parsePmset(text: unknown): BatteryReading | null {
  if (typeof text !== 'string' || text.length > MAX_OUTPUT_BYTES) return null
  const from = /Now drawing from '([^']{1,40})'/.exec(text)
  if (!from) return null
  const sourceText = from[1]!.toLowerCase()
  const source: BatteryReading['source'] = sourceText.startsWith('ac') ? 'ac' : sourceText.startsWith('battery') ? 'battery' : sourceText.startsWith('ups') ? 'ups' : null
  const line = text.split('\n').find((l) => /^\s*-InternalBattery-\d+/.test(l))
  const none: BatteryReading = { present: false, percent: null, state: null, source, minutesRemaining: null }
  if (!line || /present:\s*false/.test(line)) return none
  const match = /\t\s*(\d{1,3})%;\s*([^;]*?)\s*;\s*(.*)$/.exec(line) ?? /\s(\d{1,3})%;\s*([^;]*?)\s*;\s*(.*)$/.exec(line)
  if (!match) return { ...none, present: true }
  const percent = Number(match[1])
  let state = Object.hasOwn(STATE_OF, match[2]!.toLowerCase()) ? STATE_OF[match[2]!.toLowerCase()]! : null
  const rest = match[3]!
  if (/not charging/i.test(rest)) state = 'not-charging'
  const time = /\b(\d{1,3}):(\d{2}) remaining/.exec(rest)
  let minutes = time ? Number(time[1]) * 60 + Number(time[2]) : null
  if (minutes !== null && (Number(time![2]) > 59 || (minutes === 0 && state !== 'discharging') || (state !== 'charging' && state !== 'discharging'))) minutes = null
  return { present: true, percent: percent <= 100 ? percent : null, state, source, minutesRemaining: minutes }
}

/** What `fs.statfs` gives, or null when it cannot read the volume. */
export type StatFs = (path: string) => { bsize: number; blocks: number; bavail: number } | null

export const realStatfs: StatFs = (path) => {
  try {
    const s = statfsSync(path)
    return { bsize: Number(s.bsize), blocks: Number(s.blocks), bavail: Number(s.bavail) }
  } catch {
    return null
  }
}

/** The main volume: on macOS 10.15 and later the Data volume, which shares its APFS container's
 *  size and free space with the system volume; `/` before that, or should it not be there. */
export const SPACE_PATHS = ['/System/Volumes/Data', '/'] as const

/** The container's size and what is used of it, or null for figures out of shape. */
export function diskSpaceOf(s: { bsize: number; blocks: number; bavail: number } | null): { total: number; used: number } | null {
  if (!s) return null
  const { bsize, blocks, bavail } = s
  if (![bsize, blocks, bavail].every((n) => Number.isSafeInteger(n) && n >= 0) || bsize === 0 || blocks === 0 || bavail > blocks) return null
  const total = bsize * blocks
  const used = bsize * (blocks - bavail)
  return Number.isSafeInteger(total) ? { total, used } : null
}

/** A value and when it was read, on the reader's monotonic clock. */
export type Held<T> = { value: T; at: number }

/** What a system reader holds between reads, on any platform. Disk traffic may know only one of
 *  read and write (a counter that went back gives none for that reading). */
export type HeldSystem = {
  net: Held<NetReading> | null
  diskIo: Held<{ read: number | null; write: number | null }> | null
  space: Held<{ total: number; used: number }> | null
  gpu: Held<number> | null
  battery: Held<BatteryReading> | null
}

/** What is known at `now`: each part with its age (from a second on), or null where there is
 *  nothing young enough (SYSTEM_MAX_AGE). The same for every platform's reader. */
export function systemSnapshot(held: HeldSystem, now: number): MacSystem {
  const age = (part: { at: number } | null, max: number): number | null => {
    if (!part) return null
    const a = Math.max(0, Math.round(now - part.at))
    return a <= max ? a : null
  }
  const withAge = <T extends object>(value: T, a: number, key: string): T => (a >= 1_000 ? { ...value, [key]: a } : value)
  const netAge = age(held.net, SYSTEM_MAX_AGE.netMs)
  const net = held.net && netAge !== null ? withAge(held.net.value, netAge, 'ageMs') : null
  const ioAge = age(held.diskIo, SYSTEM_MAX_AGE.diskIoMs)
  const spaceAge = age(held.space, SYSTEM_MAX_AGE.spaceMs)
  let disk: DiskReading | null = null
  if (ioAge !== null || spaceAge !== null) {
    const io = ioAge !== null && held.diskIo ? held.diskIo.value : null
    const space = spaceAge !== null && held.space ? held.space.value : null
    disk = {
      totalBytes: space?.total ?? null,
      usedBytes: space?.used ?? null,
      ...(space && spaceAge! >= 1_000 ? { spaceAgeMs: spaceAge! } : {}),
      readBytesPerSec: io?.read ?? null,
      writeBytesPerSec: io?.write ?? null,
      ...(io && ioAge! >= 1_000 ? { ioAgeMs: ioAge! } : {})
    }
  }
  const gpuAge = age(held.gpu, SYSTEM_MAX_AGE.gpuMs)
  const gpu: GpuReading | null = held.gpu && gpuAge !== null ? withAge({ percent: held.gpu.value }, gpuAge, 'ageMs') : null
  const batteryAge = age(held.battery, SYSTEM_MAX_AGE.batteryMs)
  const battery = held.battery && batteryAge !== null ? withAge(held.battery.value, batteryAge, 'ageMs') : null
  return { net, disk, gpu, battery }
}

/** Whether a part last tried at `triedAt` is due again (also when the clock went back). */
export function due(triedAt: number, now: number, interval: number): boolean {
  return now - triedAt >= interval || now < triedAt
}

/**
 * Reads a Mac's network, disk, GPU and battery, each on its own cadence. `refresh()` runs the
 * commands that are due (with every reading), side by side, each with a timeout; `snapshot()`
 * gives what is known now, with ages. Never throws; on any other platform it runs nothing and
 * `snapshot()` is null.
 */
export class MacSystemReader {
  private readonly exec: ExecFile
  private readonly mono: () => number
  private readonly statfs: StatFs
  private readonly platform: string
  /** False while optional work should wait (macOS memory pressure critical): the I/O Kit reads
   *  are skipped then, and what they last read is carried until it is too old. */
  private readonly heavyAllowed: () => boolean
  private iface: { name: string; at: number } | null = null
  private netCounters: { iface: string; rx: number; tx: number; at: number } | null = null
  private net: Held<NetReading> | null = null
  private diskCounters: { byId: Map<string, { read: number; write: number }>; at: number } | null = null
  private diskIo: Held<{ read: number; write: number }> | null = null
  private diskIoTriedAt = Number.NEGATIVE_INFINITY
  private gpu: Held<number> | null = null
  private gpuTriedAt = Number.NEGATIVE_INFINITY
  private battery: Held<BatteryReading> | null = null
  private batteryTriedAt = Number.NEGATIVE_INFINITY
  private space: Held<{ total: number; used: number }> | null = null
  private spaceTriedAt = Number.NEGATIVE_INFINITY
  private running: Promise<void> | null = null

  constructor(options: { exec?: ExecFile; mono?: () => number; statfs?: StatFs; platform?: string; heavyAllowed?: () => boolean } = {}) {
    this.exec = options.exec ?? systemRunBounded
    this.mono = options.mono ?? (() => performance.now())
    this.statfs = options.statfs ?? realStatfs
    this.platform = options.platform ?? process.platform
    this.heavyAllowed = options.heavyAllowed ?? (() => true)
  }

  /** Reads what is due. A refresh still running is joined, not started again. */
  refresh(): Promise<void> {
    if (this.platform !== 'darwin') return Promise.resolve()
    this.running ??= this.readDue().finally(() => {
      this.running = null
    })
    return this.running
  }

  /** What is known now: each part with its age, or null where there is nothing young enough. */
  snapshot(): MacSystem | null {
    if (this.platform !== 'darwin') return null
    return systemSnapshot({ net: this.net, diskIo: this.diskIo, space: this.space, gpu: this.gpu, battery: this.battery }, this.mono())
  }

  private async readDue(): Promise<void> {
    const now = this.mono()
    const heavy = this.heavyAllowed()
    const jobs: Promise<void>[] = []
    if (!this.iface || now - this.iface.at >= SYSTEM_CADENCE.routeMs || now < this.iface.at) {
      jobs.push(this.readRoute().then(() => this.readNet()))
    } else {
      jobs.push(this.readNet())
    }
    if (heavy && due(this.diskIoTriedAt, now, SYSTEM_CADENCE.diskIoMs)) jobs.push(this.readDiskIo(now))
    if (heavy && due(this.gpuTriedAt, now, SYSTEM_CADENCE.gpuMs)) jobs.push(this.readGpu(now))
    if (due(this.batteryTriedAt, now, SYSTEM_CADENCE.batteryMs)) jobs.push(this.readBattery(now))
    if (due(this.spaceTriedAt, now, SYSTEM_CADENCE.spaceMs)) this.readSpace(now)
    await Promise.all(jobs)
  }

  private async run(file: string, args: readonly string[], maxBuffer = MAX_OUTPUT_BYTES): Promise<string | null> {
    try {
      const out = await this.exec(file, args, { timeout: TIMEOUT_MS, maxBuffer })
      return out.error ? null : out.stdout
    } catch {
      return null
    }
  }

  private async readRoute(): Promise<void> {
    const name = parseDefaultRoute(await this.run(ROUTE_PATH, ['-n', 'get', 'default']))
    // No default route (offline): nothing to read until there is one again.
    this.iface = name ? { name, at: this.mono() } : null
    if (!name) this.netCounters = null
  }

  private async readNet(): Promise<void> {
    const iface = this.iface?.name
    if (!iface) return
    const counters = parseNetstat(await this.run(NETSTAT_PATH, ['-ibn', '-I', iface]), iface)
    const at = this.mono()
    if (!counters) {
      // The interface went away: find the default route again with the next reading.
      this.iface = null
      return
    }
    const last = this.netCounters
    let rates: { rx: number; tx: number } | null = null
    if (last && last.iface === iface && counters.rx >= last.rx && counters.tx >= last.tx) {
      const seconds = (at - last.at) / 1000
      if (seconds >= 0.5) rates = { rx: Math.round((counters.rx - last.rx) / seconds), tx: Math.round((counters.tx - last.tx) / seconds) }
    }
    this.netCounters = { iface, ...counters, at }
    this.net = { value: { iface, rxBytesPerSec: rates?.rx ?? null, txBytesPerSec: rates?.tx ?? null }, at }
  }

  private async readDiskIo(now: number): Promise<void> {
    this.diskIoTriedAt = now
    const stats = parseDiskStats(await this.run(IOREG_PATH, ['-r', '-d', '1', '-w', '0', '-c', 'IOBlockStorageDriver'], IOREG_MAX_BYTES))
    const at = this.mono()
    if (!stats || stats.size === 0) return
    const last = this.diskCounters
    this.diskCounters = { byId: stats, at }
    if (!last) return
    const seconds = (at - last.at) / 1000
    if (!(seconds >= 0.5)) return
    // Per disk, so a disk that appears, goes or resets its counters costs only its own share.
    let read = 0
    let write = 0
    for (const [id, now] of stats) {
      const before = last.byId.get(id)
      if (!before || now.read < before.read || now.write < before.write) continue
      read += now.read - before.read
      write += now.write - before.write
    }
    this.diskIo = { value: { read: Math.round(read / seconds), write: Math.round(write / seconds) }, at }
  }

  private async readGpu(now: number): Promise<void> {
    this.gpuTriedAt = now
    const percent = parseGpu(await this.run(IOREG_PATH, ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'], IOREG_MAX_BYTES))
    if (percent !== null) this.gpu = { value: percent, at: this.mono() }
  }

  private async readBattery(now: number): Promise<void> {
    this.batteryTriedAt = now
    const battery = parsePmset(await this.run(PMSET_PATH, ['-g', 'batt']))
    if (battery) this.battery = { value: battery, at: this.mono() }
  }

  private readSpace(now: number): void {
    this.spaceTriedAt = now
    for (const path of SPACE_PATHS) {
      const space = diskSpaceOf(this.statfs(path))
      if (space) {
        this.space = { value: space, at: now }
        return
      }
    }
  }
}
