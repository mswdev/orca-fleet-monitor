// A Linux computer's network, disk, GPU and battery, from files the kernel serves, read without
// privileges and without a shell:
//
//   network   /proc/net/dev every reading (5 s), for the interface the default route goes out of
//             (/proc/net/route, or /proc/net/ipv6_route where there is no IPv4 default; about
//             once a minute): bytes in and out per second from the interface's cumulative
//             64-bit counters
//   disk      `statfs` of `/` about once a minute (no file read): the volume's size, and used =
//             size − available, as `df` counts available; /proc/diskstats about every 20 s:
//             bytes read and written per second, summed over every whole physical disk (the
//             devices listed in /sys/block, less those that only pass traffic on to another:
//             loop, device mapper, md and the like, so traffic through LVM, LUKS or RAID is
//             counted once)
//   GPU       about every 30 s, the busiest of /sys/class/drm/card<N>/device/gpu_busy_percent
//             (AMD's driver) and, only where NVIDIA's driver is loaded,
//             `nvidia-smi --query-gpu=utilization.gpu`. Intel's driver gives no figure without
//             privileges, so there is none for it. A GPU the kernel has put to sleep (a laptop's
//             second one) is not asked: asking would wake it.
//   battery   /sys/class/power_supply about once a minute: power source, charge, state, and
//             time remaining worked out from the battery's own energy and power figures
//
// What is read less often than every reading is carried until the next read, with its age; a
// read that fails carries the last value for a while longer, then the value is dropped. Every
// file is parsed defensively: a figure out of shape is left out, never guessed.
//
// Cost: file reads only. Each is a small text the kernel writes on the spot (nothing waits for a
// disk), read to its end and refused past 1 MiB. A reading is one read of /proc/net/dev; the
// other parts are a handful of reads each on their cadence. The one child process is
// `nvidia-smi`, with a 2 s timeout, and only on a computer that has NVIDIA's driver. In a Linux
// virtual machine on an Apple M1 Max (kernel 7.0, Node 24) a reading took about 1 ms of CPU, and
// about 4 ms when every part was due; no GPU or battery was there to be read.
import { open, readdir, type FileHandle } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { createRunBounded, type ExecFile } from './mac-memory.ts'
import { diskSpaceOf, due, isInterfaceName, realStatfs, SYSTEM_CADENCE, systemSnapshot, type Held, type StatFs } from './mac-system.ts'
import type { BatteryReading, MacSystem, NetReading } from './model.ts'

export const PROC_NET_ROUTE_PATH = '/proc/net/route'
export const PROC_NET_IPV6_ROUTE_PATH = '/proc/net/ipv6_route'
export const PROC_NET_DEV_PATH = '/proc/net/dev'
export const PROC_DISKSTATS_PATH = '/proc/diskstats'
export const SYS_BLOCK_PATH = '/sys/block'
export const SYS_DRM_PATH = '/sys/class/drm'
export const SYS_PCI_DEVICES_PATH = '/sys/bus/pci/devices'
export const SYS_POWER_SUPPLY_PATH = '/sys/class/power_supply'
export const NVIDIA_VERSION_PATH = '/proc/driver/nvidia/version'
export const NVIDIA_GPUS_PATH = '/proc/driver/nvidia/gpus'
export const NVIDIA_SMI_PATH = '/usr/bin/nvidia-smi'
export const NVIDIA_SMI_ARGS = ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'] as const
/** The main volume. */
export const LINUX_SPACE_PATH = '/'
const TIMEOUT_MS = 2_000
/** `nvidia-smi` prints one short line for each GPU. */
const NVIDIA_SMI_MAX_BYTES = 4 * 1024
/** This reader's own bounded runner, apart from the memory reads' (src/mac-memory.ts). */
export const linuxSystemRunBounded: ExecFile = createRunBounded()
/** The most a file read here may hold. The kernel's own are a few KB; /etc/passwd
 *  (src/linux-processes.ts) is the only one a person writes. */
export const MAX_FILE_BYTES = 1024 * 1024
const MAX_DISKS = 256
const MAX_GPUS = 16
const MAX_SUPPLIES = 32

// --- reading files ---------------------------------------------------------------------------

export type ReadFile = (path: string) => Promise<string | null>
export type ReadDir = (path: string) => Promise<string[] | null>

/** Small enough to come out of Node's buffer pool: nearly every file read here fits in it. */
const FIRST_CHUNK_BYTES = 2_048
const NEXT_CHUNK_BYTES = 64 * 1024

/**
 * A file's bytes, read to its end, or null when it cannot be read or holds more than `maxBytes`.
 * It is read until a read gives nothing, because the kernel's files report no size and may hand
 * over a part at a time; no more than `maxBytes` and one chunk is ever held. Never throws.
 */
export async function readBytesBounded(path: string, maxBytes = MAX_FILE_BYTES): Promise<Buffer | null> {
  let handle: FileHandle | null = null
  try {
    handle = await open(path, 'r')
    const full: Buffer[] = []
    let chunk = Buffer.allocUnsafe(FIRST_CHUNK_BYTES)
    let used = 0
    let total = 0
    for (;;) {
      if (used === chunk.length) {
        full.push(chunk)
        chunk = Buffer.allocUnsafe(NEXT_CHUNK_BYTES)
        used = 0
      }
      const { bytesRead } = await handle.read(chunk, used, chunk.length - used, null)
      if (bytesRead === 0) break
      used += bytesRead
      total += bytesRead
      if (total > maxBytes) return null
    }
    full.push(chunk.subarray(0, used))
    return Buffer.concat(full, total)
  } catch {
    return null
  } finally {
    if (handle) await handle.close().catch(() => undefined)
  }
}

/** A file's text (UTF-8), or null: readBytesBounded. */
export async function readTextBounded(path: string, maxBytes = MAX_FILE_BYTES): Promise<string | null> {
  const bytes = await readBytesBounded(path, maxBytes)
  return bytes ? bytes.toString('utf8') : null
}

/** The names in a directory, or null when it cannot be listed. Never throws. */
export async function listDir(path: string): Promise<string[] | null> {
  try {
    return await readdir(path)
  } catch {
    return null
  }
}


// --- network ---------------------------------------------------------------------------------

const DIGITS = /^\d{1,20}$/
/** Route flags, as <linux/route.h> names them: the route is usable; it rejects what it matches. */
const RTF_UP = 0x0001
const RTF_REJECT = 0x0200

/**
 * The interface of the IPv4 default route in /proc/net/route: the row whose Destination and Mask
 * are both 00000000, is up, and has the lowest Metric (the one the kernel uses; the first of
 * equals). The columns are Iface, Destination, Gateway, Flags, RefCnt, Use, Metric, Mask, MTU,
 * Window and IRTT; addresses and flags are hexadecimal, the metric decimal. Only the main routing
 * table is listed here, so a VPN that routes by policy rule still shows the interface it runs over.
 */
export function parseProcNetRoute(text: unknown): string | null {
  if (typeof text !== 'string' || text.length > MAX_FILE_BYTES) return null
  let best: { name: string; metric: number } | null = null
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/)
    if (f.length < 8 || f[1] !== '00000000' || f[7] !== '00000000') continue
    if (!/^[0-9A-Fa-f]{1,8}$/.test(f[3]!) || !/^\d{1,10}$/.test(f[6]!)) continue
    const flags = Number.parseInt(f[3]!, 16)
    const name = f[0]
    // A route that rejects everything has no interface (`*`), and is not a way out.
    if ((flags & RTF_UP) === 0 || (flags & RTF_REJECT) !== 0 || !isInterfaceName(name)) continue
    const metric = Number(f[6])
    if (!best || metric < best.metric) best = { name, metric }
  }
  return best?.name ?? null
}

/**
 * The interface of the IPv6 default route in /proc/net/ipv6_route, for a computer with no IPv4
 * one. Each row is the destination and its prefix length, the source and its prefix length, the
 * next hop, the metric, a reference count, a use count, the flags and the device, all but the
 * device in hexadecimal. The default is the all-zero destination with prefix length 00; the
 * kernel also keeps one on `lo` that rejects everything, which is not a way out.
 */
export function parseProcNetIpv6Route(text: unknown): string | null {
  if (typeof text !== 'string' || text.length > MAX_FILE_BYTES) return null
  let best: { name: string; metric: number } | null = null
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/)
    if (f.length !== 10 || !/^0{32}$/.test(f[0]!) || f[1] !== '00') continue
    if (!/^[0-9a-f]{8}$/i.test(f[5]!) || !/^[0-9a-f]{8}$/i.test(f[8]!)) continue
    const flags = Number.parseInt(f[8]!, 16)
    const name = f[9]
    if ((flags & RTF_UP) === 0 || (flags & RTF_REJECT) !== 0 || name === 'lo' || !isInterfaceName(name)) continue
    const metric = Number.parseInt(f[5]!, 16)
    if (!best || metric < best.metric) best = { name, metric }
  }
  return best?.name ?? null
}

/**
 * Cumulative bytes in and out of `iface` from /proc/net/dev: its row is `iface:` and sixteen
 * numbers, eight received then eight sent, bytes first in each. Old kernels leave no space after
 * the colon when a count is wide, so the row is cut at the colon, not at a space.
 */
export function parseProcNetDev(text: unknown, iface: string): { rx: number; tx: number } | null {
  if (typeof text !== 'string' || text.length > MAX_FILE_BYTES) return null
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':')
    if (colon === -1 || line.slice(0, colon).trim() !== iface) continue
    const fields = line.slice(colon + 1).trim().split(/\s+/)
    const rx = fields[0]
    const tx = fields[8]
    if (rx === undefined || tx === undefined || !DIGITS.test(rx) || !DIGITS.test(tx)) return null
    const rxN = Number(rx)
    const txN = Number(tx)
    return Number.isSafeInteger(rxN) && Number.isSafeInteger(txN) ? { rx: rxN, tx: txN } : null
  }
  return null
}

// --- disk traffic ----------------------------------------------------------------------------

/** /proc/diskstats counts sectors of 512 bytes, whatever the disk's own sector size. */
const SECTOR_BYTES = 512
/**
 * Block devices that are not a physical disk of their own. Loop devices, device mapper (LVM,
 * LUKS), md (RAID), bcache, DRBD and ZFS volumes pass their traffic on to the disks under them,
 * and one path of a multipath NVMe disk (nvme0c0n1) repeats its disk's (nvme0n1): counting them
 * would count that traffic twice. RAM disks and compressed swap in RAM touch no disk; optical
 * and floppy drives are not what anyone means by disk traffic.
 */
const NOT_A_DISK = /^(?:loop|ram|zram|dm-|md|md_d|sr|fd|zd|bcache|drbd)\d|^nvme\d+c\d+n\d+$/

/** The whole physical disks in a listing of /sys/block, by the name /proc/diskstats gives them.
 *  Partitions are not listed there at all (they sit inside their disk's directory). */
export function physicalDisks(entries: unknown): Set<string> {
  const disks = new Set<string>()
  if (!Array.isArray(entries)) return disks
  for (const entry of entries) {
    if (disks.size >= MAX_DISKS) break
    if (typeof entry !== 'string' || !/^[A-Za-z][A-Za-z0-9!._-]{0,31}$/.test(entry) || NOT_A_DISK.test(entry)) continue
    // /sys/block writes the `/` of a name such as cciss/c0d0 as `!`.
    disks.add(entry.replace(/!/g, '/'))
  }
  return disks
}

/**
 * Cumulative bytes read and written by each of `disks`, from /proc/diskstats. A row is the
 * device's major and minor numbers, its name, then at least eleven figures (every kernel since
 * 2.6; later ones add more at the end): sectors read is the 3rd of them, sectors written the 7th.
 * A row out of shape is left out.
 */
export function parseDiskstats(text: unknown, disks: ReadonlySet<string>): Map<string, { read: number; write: number }> | null {
  if (typeof text !== 'string' || text.length > MAX_FILE_BYTES) return null
  const out = new Map<string, { read: number; write: number }>()
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/)
    const name = f[2]
    if (f.length < 14 || name === undefined || !disks.has(name) || out.has(name)) continue
    const read = f[5]!
    const write = f[9]!
    if (!DIGITS.test(read) || !DIGITS.test(write)) continue
    const r = Number(read) * SECTOR_BYTES
    const w = Number(write) * SECTOR_BYTES
    if (Number.isSafeInteger(r) && Number.isSafeInteger(w)) out.set(name, { read: r, write: w })
  }
  return out
}

// --- GPU -------------------------------------------------------------------------------------

/** A DRM card's `device/gpu_busy_percent`: one whole number, 0 to 100. */
export function parseGpuBusyPercent(text: unknown): number | null {
  if (typeof text !== 'string' || text.length > 16 || !/^\d{1,3}\s*$/.test(text)) return null
  const value = Number(text)
  return value <= 100 ? value : null
}

/** The busiest GPU in `nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits`: one
 *  whole number a line. A GPU that reports none prints `[N/A]`, which is skipped. */
export function parseNvidiaSmi(text: unknown): number | null {
  if (typeof text !== 'string' || text.length > NVIDIA_SMI_MAX_BYTES) return null
  let best: number | null = null
  for (const line of text.split('\n')) {
    const value = /^\s*(\d{1,3})\s*$/.exec(line)
    if (value && Number(value[1]) <= 100) best = best === null ? Number(value[1]) : Math.max(best, Number(value[1]))
  }
  return best
}

/** A device's `power/runtime_status` when the kernel has put it to sleep, or is doing so. */
export function isRuntimeSuspended(text: unknown): boolean {
  return typeof text === 'string' && /^suspend(?:ed|ing)\s*$/.test(text)
}

/** A PCI address as /proc/driver/nvidia/gpus names each GPU: `0000:01:00.0`. */
function isPciAddress(name: string): boolean {
  return /^[0-9a-f]{4,8}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$/i.test(name)
}

// --- battery ---------------------------------------------------------------------------------

/** One entry of /sys/class/power_supply: the text of the attribute files read from it, by file
 *  name. A file that is not there, or was not read, is null or absent. */
export type PowerSupply = Readonly<Record<string, string | null | undefined>>

/** What is read of a battery that powers the computer. */
const BATTERY_FILES = ['present', 'status', 'capacity', 'energy_now', 'energy_full', 'power_now', 'charge_now', 'charge_full', 'current_now'] as const

const STATE_OF: Record<string, BatteryReading['state']> = {
  charging: 'charging',
  discharging: 'discharging',
  full: 'charged',
  'not charging': 'not-charging'
}
/** Supply types that bring power in from outside: the charger socket, a USB port in any of its
 *  roles, a charging pad. */
const EXTERNAL_POWER = /^(?:Mains|USB(?:_[A-Z_]{1,8})?|BrickID|Wireless)$/
/** A time remaining of 100 hours or more is no estimate (a power figure near zero). */
const MAX_MINUTES = 100 * 60

function attribute(supply: PowerSupply, file: string): string | null {
  const value = Object.hasOwn(supply, file) ? supply[file] : null
  return typeof value === 'string' && value.length <= 64 ? value.trim() : null
}

/** A figure from an attribute file, summed over every battery, or null when any battery lacks
 *  it. Some drivers sign the current and power drawn while discharging; with `signed`, a sign is
 *  taken and dropped, since only the size is wanted. */
function sumOf(batteries: readonly PowerSupply[], file: string, signed = false): number | null {
  let total = 0
  for (const battery of batteries) {
    const text = attribute(battery, file)
    if (text === null || !(signed ? /^-?\d{1,15}$/ : /^\d{1,15}$/).test(text)) return null
    total += Math.abs(Number(text))
  }
  return total
}

function stateOf(battery: PowerSupply): BatteryReading['state'] {
  const status = (attribute(battery, 'status') ?? '').toLowerCase()
  return Object.hasOwn(STATE_OF, status) ? STATE_OF[status]! : null
}

/** One battery's own `capacity`; several batteries' charge as one, by what they hold of what
 *  they can hold (energy where every battery gives it, else charge). */
function percentOf(batteries: readonly PowerSupply[]): number | null {
  const capacity = batteries.length === 1 ? attribute(batteries[0]!, 'capacity') : null
  if (capacity !== null) return /^\d{1,3}$/.test(capacity) && Number(capacity) <= 100 ? Number(capacity) : null
  for (const unit of ['energy', 'charge'] as const) {
    const now = sumOf(batteries, `${unit}_now`)
    const full = sumOf(batteries, `${unit}_full`)
    if (now === null || full === null) continue
    // A battery a little over its last full charge is full; far over it, the figures are wrong.
    return full > 0 && now <= full * 1.05 ? Math.min(100, Math.round((now / full) * 100)) : null
  }
  return null
}

/** Minutes until empty (discharging) or full (charging): what is left to go, over the rate it is
 *  going at. Energy in µWh over power in µW, or charge in µAh over current in µA, is hours. */
function minutesOf(batteries: readonly PowerSupply[], state: BatteryReading['state']): number | null {
  if (state !== 'charging' && state !== 'discharging') return null
  for (const [unit, rateFile] of [['energy', 'power_now'], ['charge', 'current_now']] as const) {
    const now = sumOf(batteries, `${unit}_now`)
    const rate = sumOf(batteries, rateFile, true)
    const full = state === 'charging' ? sumOf(batteries, `${unit}_full`) : 0
    if (now === null || rate === null || full === null) continue
    const left = state === 'charging' ? full - now : now
    if (!(rate > 0) || !(left > 0)) return null
    const minutes = Math.round((left / rate) * 60)
    return minutes >= 1 && minutes < MAX_MINUTES ? minutes : null
  }
  return null
}

/**
 * The power source and the internal battery, from the entries of /sys/class/power_supply. A
 * supply of type `Battery` is the computer's own unless its `scope` is `Device` (a mouse's, a
 * keyboard's, a headset's) or its bay is empty (`present` 0). A laptop with two batteries is
 * given as one. On external power when a charger socket, USB port or charging pad says it is
 * `online`; on battery when a battery is discharging and none does; otherwise not known.
 */
export function parsePowerSupplies(supplies: readonly PowerSupply[]): BatteryReading {
  const batteries: PowerSupply[] = []
  let external = false
  for (const supply of supplies) {
    const type = attribute(supply, 'type')
    if (type === 'Battery') {
      if (attribute(supply, 'scope') !== 'Device' && attribute(supply, 'present') !== '0') batteries.push(supply)
    } else if (type !== null && EXTERNAL_POWER.test(type)) {
      // 1 is a fixed supply, 2 one whose voltage is negotiated (USB Power Delivery).
      const online = attribute(supply, 'online')
      if (online === '1' || online === '2') external = true
    }
  }
  const states = batteries.map(stateOf)
  const discharging = states.includes('discharging')
  const source: BatteryReading['source'] = external ? 'ac' : discharging ? 'battery' : null
  if (batteries.length === 0) return { present: false, percent: null, state: null, source, minutesRemaining: null }
  const state: BatteryReading['state'] = discharging
    ? 'discharging'
    : states.includes('charging')
      ? 'charging'
      : states.every((s) => s === 'charged')
        ? 'charged'
        : states.includes('not-charging')
          ? 'not-charging'
          : null
  return { present: true, percent: percentOf(batteries), state, source, minutesRemaining: minutesOf(batteries, state) }
}

/** A name that is one path segment, so a listing can never lead a read out of its directory. */
function isEntryName(name: string): boolean {
  return /^[^/\u0000-\u001f]{1,128}$/.test(name) && name !== '.' && name !== '..'
}

// --- the reader ------------------------------------------------------------------------------


export type LinuxSystemOptions = {
  readFile?: ReadFile
  readDir?: ReadDir
  exec?: ExecFile
  mono?: () => number
  statfs?: StatFs
  platform?: string
  heavyAllowed?: () => boolean
}

/**
 * Reads a Linux computer's network, disk, GPU and battery, each on its own cadence (the same as
 * a Mac's: src/mac-system.ts). `refresh()` reads what is due (with every reading), side by side;
 * `snapshot()` gives what is known now, with ages. Never throws; on any other platform it reads
 * nothing and `snapshot()` is null.
 */
export class LinuxSystemReader {
  private readonly readFile: ReadFile
  private readonly readDir: ReadDir
  private readonly exec: ExecFile
  private readonly mono: () => number
  private readonly statfs: StatFs
  private readonly platform: string
  /** False while optional work should wait: the GPU read (the only one that may start a child
   *  process) is skipped then, and what it last read is carried until it is too old. */
  private readonly heavyAllowed: () => boolean
  private iface: { name: string; at: number } | null = null
  private netCounters: { iface: string; rx: number; tx: number; at: number } | null = null
  private net: Held<NetReading> | null = null
  private diskCounters: { byName: Map<string, { read: number; write: number }>; at: number } | null = null
  private diskIo: Held<{ read: number; write: number }> | null = null
  private diskIoTriedAt = Number.NEGATIVE_INFINITY
  private gpu: Held<number> | null = null
  private gpuTriedAt = Number.NEGATIVE_INFINITY
  private battery: Held<BatteryReading> | null = null
  private batteryTriedAt = Number.NEGATIVE_INFINITY
  private space: Held<{ total: number; used: number }> | null = null
  private spaceTriedAt = Number.NEGATIVE_INFINITY
  private running: Promise<void> | null = null

  constructor(options: LinuxSystemOptions = {}) {
    this.readFile = options.readFile ?? ((path) => readTextBounded(path))
    this.readDir = options.readDir ?? listDir
    this.exec = options.exec ?? linuxSystemRunBounded
    this.mono = options.mono ?? (() => performance.now())
    this.statfs = options.statfs ?? realStatfs
    this.platform = options.platform ?? process.platform
    this.heavyAllowed = options.heavyAllowed ?? (() => true)
  }

  /** Reads what is due. A refresh still running is joined, not started again. */
  refresh(): Promise<void> {
    if (this.platform !== 'linux') return Promise.resolve()
    this.running ??= this.readDue().finally(() => {
      this.running = null
    })
    return this.running
  }

  /** What is known now: each part with its age, or null where there is nothing young enough. */
  snapshot(): MacSystem | null {
    if (this.platform !== 'linux') return null
    return systemSnapshot({ net: this.net, diskIo: this.diskIo, space: this.space, gpu: this.gpu, battery: this.battery }, this.mono())
  }

  private async readDue(): Promise<void> {
    const now = this.mono()
    const jobs: Promise<void>[] = []
    if (!this.iface || now - this.iface.at >= SYSTEM_CADENCE.routeMs || now < this.iface.at) {
      jobs.push(this.readRoute().then(() => this.readNet()))
    } else {
      jobs.push(this.readNet())
    }
    if (due(this.diskIoTriedAt, now, SYSTEM_CADENCE.diskIoMs)) jobs.push(this.readDiskIo(now))
    if (due(this.gpuTriedAt, now, SYSTEM_CADENCE.gpuMs) && this.heavy()) jobs.push(this.readGpu(now))
    if (due(this.batteryTriedAt, now, SYSTEM_CADENCE.batteryMs)) jobs.push(this.readBattery(now))
    if (due(this.spaceTriedAt, now, SYSTEM_CADENCE.spaceMs)) this.readSpace(now)
    await Promise.all(jobs)
  }

  private heavy(): boolean {
    try {
      return this.heavyAllowed()
    } catch {
      return false
    }
  }

  private async file(path: string): Promise<string | null> {
    try {
      const text = await this.readFile(path)
      return typeof text === 'string' ? text : null
    } catch {
      return null
    }
  }

  private async dir(path: string): Promise<string[] | null> {
    try {
      const names = await this.readDir(path)
      return Array.isArray(names) ? names.filter((name): name is string => typeof name === 'string' && isEntryName(name)) : null
    } catch {
      return null
    }
  }

  private async run(file: string, args: readonly string[], maxBuffer: number): Promise<string | null> {
    try {
      const out = await this.exec(file, args, { timeout: TIMEOUT_MS, maxBuffer })
      return out.error ? null : out.stdout
    } catch {
      return null
    }
  }

  private async readRoute(): Promise<void> {
    const name = parseProcNetRoute(await this.file(PROC_NET_ROUTE_PATH)) ?? parseProcNetIpv6Route(await this.file(PROC_NET_IPV6_ROUTE_PATH))
    // No default route (offline): nothing to read until there is one again.
    this.iface = name ? { name, at: this.mono() } : null
    if (!name) this.netCounters = null
  }

  private async readNet(): Promise<void> {
    const iface = this.iface?.name
    if (!iface) return
    const counters = parseProcNetDev(await this.file(PROC_NET_DEV_PATH), iface)
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
    // The listing is read each time, so a disk plugged in since is counted from its second read.
    const [listing, text] = await Promise.all([this.dir(SYS_BLOCK_PATH), this.file(PROC_DISKSTATS_PATH)])
    const stats = parseDiskstats(text, physicalDisks(listing))
    const at = this.mono()
    if (!stats || stats.size === 0) return
    const last = this.diskCounters
    this.diskCounters = { byName: stats, at }
    if (!last) return
    const seconds = (at - last.at) / 1000
    if (!(seconds >= 0.5)) return
    // Per disk, so a disk that appears, goes or resets its counters costs only its own share.
    let read = 0
    let write = 0
    for (const [name, now] of stats) {
      const before = last.byName.get(name)
      if (!before || now.read < before.read || now.write < before.write) continue
      read += now.read - before.read
      write += now.write - before.write
    }
    this.diskIo = { value: { read: Math.round(read / seconds), write: Math.round(write / seconds) }, at }
  }

  private async readGpu(now: number): Promise<void> {
    this.gpuTriedAt = now
    const [drm, nvidia] = await Promise.all([this.readDrmBusy(), this.readNvidia()])
    const percent = drm === null ? nvidia : nvidia === null ? drm : Math.max(drm, nvidia)
    if (percent !== null) this.gpu = { value: percent, at: this.mono() }
  }

  /** The busiest card that gives a `gpu_busy_percent`. A card that is asleep is passed over:
   *  reading the figure wakes it on all but the newest kernels, and it would stay awake for as
   *  long as it keeps being asked. */
  private async readDrmBusy(): Promise<number | null> {
    const names = await this.dir(SYS_DRM_PATH)
    if (!names) return null
    // card0, card1: not their connectors (card0-DP-1) or render nodes (renderD128).
    const cards = names.filter((name) => /^card\d{1,3}$/.test(name)).slice(0, MAX_GPUS)
    const values = await Promise.all(
      cards.map(async (card) => {
        const device = `${SYS_DRM_PATH}/${card}/device`
        if (isRuntimeSuspended(await this.file(`${device}/power/runtime_status`))) return null
        return parseGpuBusyPercent(await this.file(`${device}/gpu_busy_percent`))
      })
    )
    let best: number | null = null
    for (const value of values) if (value !== null) best = best === null ? value : Math.max(best, value)
    return best
  }

  /** NVIDIA's own tool, only where its driver is loaded (the driver makes this /proc file), and
   *  not while every NVIDIA GPU is asleep: `nvidia-smi` wakes them. */
  private async readNvidia(): Promise<number | null> {
    if ((await this.file(NVIDIA_VERSION_PATH)) === null) return null
    const addresses = ((await this.dir(NVIDIA_GPUS_PATH)) ?? []).filter(isPciAddress).slice(0, MAX_GPUS)
    if (addresses.length > 0) {
      const statuses = await Promise.all(addresses.map((address) => this.file(`${SYS_PCI_DEVICES_PATH}/${address}/power/runtime_status`)))
      if (statuses.every(isRuntimeSuspended)) return null
    }
    return parseNvidiaSmi(await this.run(NVIDIA_SMI_PATH, NVIDIA_SMI_ARGS, NVIDIA_SMI_MAX_BYTES))
  }

  private async readBattery(now: number): Promise<void> {
    this.batteryTriedAt = now
    const names = await this.dir(SYS_POWER_SUPPLY_PATH)
    // No such directory: this kernel has no power supplies to ask about, which is not the same
    // as a computer without a battery.
    if (!names) return
    const supplies = await Promise.all(names.sort().slice(0, MAX_SUPPLIES).map((name) => this.readSupply(name)))
    // Entries, but not one whose type could be read: the read failed; it says nothing.
    if (supplies.length > 0 && supplies.every((supply) => attribute(supply, 'type') === null)) return
    this.battery = { value: parsePowerSupplies(supplies), at: this.mono() }
  }

  /** One supply's files, and no more of them than its kind needs. A mouse's or a headset's
   *  battery is asked only what it is (`type`, `scope`): asked for its charge, its driver may
   *  put the question to the device itself, over Bluetooth, and wait for the answer. */
  private async readSupply(name: string): Promise<PowerSupply> {
    const dir = `${SYS_POWER_SUPPLY_PATH}/${name}`
    const type = await this.file(`${dir}/type`)
    if (type === null) return {}
    if (type.trim() !== 'Battery') return { type, online: await this.file(`${dir}/online`) }
    const scope = await this.file(`${dir}/scope`)
    if (scope !== null && scope.trim() === 'Device') return { type, scope }
    const values = await Promise.all(BATTERY_FILES.map((file) => this.file(`${dir}/${file}`)))
    const supply: Record<string, string | null> = { type, scope }
    BATTERY_FILES.forEach((file, i) => {
      supply[file] = values[i] ?? null
    })
    return supply
  }

  private readSpace(now: number): void {
    this.spaceTriedAt = now
    let space: { total: number; used: number } | null = null
    try {
      space = diskSpaceOf(this.statfs(LINUX_SPACE_PATH))
    } catch {
      space = null
    }
    if (space) this.space = { value: space, at: now }
  }
}

