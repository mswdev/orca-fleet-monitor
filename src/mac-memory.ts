// A Mac's memory as Activity Monitor counts it, from one `vm_stat` and one `sysctl -n` per reading.
//
// Activity Monitor (macOS 26, Apple silicon; checked against its Memory tab, within 0.02 GB):
//   Memory Used   = Anonymous pages + Pages wired down + Pages occupied by compressor
//                   + (hw.memsize − (free + active + inactive + speculative + wired + compressor))
//                   (the last term is physical memory no page count accounts for; it is counted
//                   with wired here)
//   Cached Files  = File-backed pages + Pages purgeable
//   Swap Used     = the `used` figure of `vm.swapusage`
// Pages are `vm_stat`'s own page size (its header: 16384 on Apple silicon, 4096 on Intel).
//
// The kernel's own judgement of memory pressure, readable without privileges:
//   kern.memorystatus_vm_pressure_level  1 normal, 2 warning, 4 critical (Activity Monitor's
//                                        green, yellow and red)
//   kern.memorystatus_level              percent of memory still available
//
// Everything here is parsed defensively: a field that is missing or out of shape is left out
// (or the whole reading is, when the formula would need it), never guessed.
import { execFile } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import type { MacMemory, PressureLevel } from './model.ts'

export const VM_STAT_PATH = '/usr/bin/vm_stat'
export const SYSCTL_PATH = '/usr/sbin/sysctl'
export const SYSCTL_NAMES = ['hw.memsize', 'vm.swapusage', 'kern.memorystatus_vm_pressure_level', 'kern.memorystatus_level'] as const
const TIMEOUT_MS = 2_000
const MAX_OUTPUT_BYTES = 64 * 1024

/**
 * "Sustained" swap-out activity: swap-outs in every reading over at least `minSpanMs` of the last
 * `windowMs` (with the 5 s sampler, five or six readings in a row), averaging at least
 * `minBytesPerSec`. A single burst, or a trickle of a few pages now and then, is not sustained.
 */
export const SUSTAINED_SWAP = { windowMs: 30_000, minSpanMs: 25_000, minBytesPerSec: 1024 * 1024 } as const

/** `vm_stat` page counts; the optional ones are 0 (or null) when the line is missing. */
export type VmStat = {
  pageSize: number
  free: number
  active: number
  inactive: number
  speculative: number
  throttled: number
  wired: number
  purgeable: number
  fileBacked: number
  anonymous: number
  compressor: number
  swapIns: number | null
  swapOuts: number | null
}

/** `vm_stat` line labels, exactly (several others look alike: "Pages stored in compressor" is how
 *  much was compressed, not the memory it takes; "Pages purged" and "Pageouts" are counters). */
const VM_FIELDS: Record<string, keyof Omit<VmStat, 'pageSize'>> = {
  'Pages free': 'free',
  'Pages active': 'active',
  'Pages inactive': 'inactive',
  'Pages speculative': 'speculative',
  'Pages throttled': 'throttled',
  'Pages wired down': 'wired',
  'Pages purgeable': 'purgeable',
  'File-backed pages': 'fileBacked',
  'Anonymous pages': 'anonymous',
  'Pages occupied by compressor': 'compressor',
  Swapins: 'swapIns',
  Swapouts: 'swapOuts'
}
const VM_REQUIRED = ['free', 'active', 'inactive', 'speculative', 'wired', 'fileBacked', 'anonymous', 'compressor'] as const

/** `vm_stat`'s output, or null when it lacks the page size or any count the formula needs. */
export function parseVmStat(text: unknown): VmStat | null {
  if (typeof text !== 'string' || text.length > MAX_OUTPUT_BYTES) return null
  const header = /page size of (\d+) bytes/.exec(text)
  const pageSize = header ? Number(header[1]) : Number.NaN
  // A power of two between 1 KiB and 1 MiB: 4096 (Intel) and 16384 (Apple silicon) in practice.
  if (!Number.isSafeInteger(pageSize) || pageSize < 1024 || pageSize > 1024 * 1024 || (pageSize & (pageSize - 1)) !== 0) return null
  const found: Partial<Record<keyof Omit<VmStat, 'pageSize'>, number>> = {}
  for (const line of text.split('\n')) {
    const match = /^\s*"?([A-Za-z][A-Za-z -]*?)"?:\s+(\d+)\.?\s*$/.exec(line)
    if (!match) continue
    const key = Object.hasOwn(VM_FIELDS, match[1]!) ? VM_FIELDS[match[1]!] : undefined
    const value = Number(match[2])
    if (key && found[key] === undefined && Number.isSafeInteger(value)) found[key] = value
  }
  if (VM_REQUIRED.some((key) => found[key] === undefined)) return null
  return {
    pageSize,
    free: found.free!,
    active: found.active!,
    inactive: found.inactive!,
    speculative: found.speculative!,
    throttled: found.throttled ?? 0,
    wired: found.wired!,
    purgeable: found.purgeable ?? 0,
    fileBacked: found.fileBacked!,
    anonymous: found.anonymous!,
    compressor: found.compressor!,
    swapIns: found.swapIns ?? null,
    swapOuts: found.swapOuts ?? null
  }
}

export type SysctlMemory = {
  memsize: number | null
  swapUsed: number | null
  swapTotal: number | null
  pressure: PressureLevel | null
  availablePercent: number | null
}

const UNIT: Record<string, number> = { '': 1, K: 2 ** 10, M: 2 ** 20, G: 2 ** 30, T: 2 ** 40, P: 2 ** 50 }
const SWAP_LINE = /^total = ([\d.]+)([KMGTP]?)\s+used = ([\d.]+)([KMGTP]?)\s+free = ([\d.]+)([KMGTP]?)/
const INTEGER = /^\d{1,20}$/

function swapUsage(line: string): { used: number; total: number } | null {
  const m = SWAP_LINE.exec(line)
  if (!m) return null
  const bytes = (value: string, unit: string): number => Number(value) * (UNIT[unit] ?? Number.NaN)
  const total = bytes(m[1]!, m[2]!)
  const used = bytes(m[3]!, m[4]!)
  if (!Number.isFinite(total) || !Number.isFinite(used) || total < 0 || used < 0 || used > total * 1.001 + 1) return null
  return { used: Math.round(Math.min(used, total)), total: Math.round(total) }
}

function pressureOf(value: number | null): PressureLevel | null {
  return value === 1 ? 'normal' : value === 2 ? 'warning' : value === 4 ? 'critical' : null
}

/**
 * `sysctl -n hw.memsize vm.swapusage kern.memorystatus_vm_pressure_level kern.memorystatus_level`.
 * With `-n` the lines carry no names, and a name this macOS does not know is skipped (sysctl then
 * exits 1 with the rest printed), so each line is placed by its shape around the swap line. What
 * cannot be placed for certain is left out. `osTotal` (os.totalmem(), the same figure) checks
 * `hw.memsize`.
 */
export function parseSysctl(text: unknown, osTotal = 0): SysctlMemory {
  const none: SysctlMemory = { memsize: null, swapUsed: null, swapTotal: null, pressure: null, availablePercent: null }
  if (typeof text !== 'string' || text.length > MAX_OUTPUT_BYTES) return none
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  const int = (line: string | undefined): number | null => (line !== undefined && INTEGER.test(line) ? Number(line) : null)
  const swapAt = lines.findIndex((line) => SWAP_LINE.test(line))
  let memsize: number | null = null
  let level: number | null = null
  let available: number | null = null
  let swap: { used: number; total: number } | null = null
  if (swapAt !== -1) {
    swap = swapUsage(lines[swapAt]!)
    const before = lines.slice(0, swapAt)
    const after = lines.slice(swapAt + 1)
    if (before.length === 1) memsize = int(before[0])
    // Both pressure lines, or neither: one alone could be either.
    if (after.length === 2) [level, available] = [int(after[0]), int(after[1])]
  } else if (lines.length === 3) {
    // No swap line: the three numbers are still in order.
    ;[memsize, level, available] = lines.map((line) => int(line)) as [number | null, number | null, number | null]
  }
  if (memsize !== null && (!Number.isSafeInteger(memsize) || memsize < 2 ** 26)) memsize = null
  if (memsize !== null && osTotal > 0 && Math.abs(memsize - osTotal) > osTotal * 0.01) memsize = null
  return {
    memsize,
    swapUsed: swap?.used ?? null,
    swapTotal: swap?.total ?? null,
    pressure: pressureOf(level),
    availablePercent: available !== null && available >= 0 && available <= 100 ? available : null
  }
}

/** The figures without rates (those need the previous reading), or null when the page counts
 *  cannot be right for this much memory (more pages than RAM: a wrong page size, say). */
export function macMemoryOf(vm: VmStat, sys: SysctlMemory, osTotal = 0): Omit<MacMemory, 'swapInsPerSec' | 'swapOutsPerSec' | 'sustainedSwapOutsPerSec'> | null {
  const total = sys.memsize ?? (Number.isSafeInteger(osTotal) && osTotal >= 2 ** 26 ? osTotal : null)
  if (total === null) return null
  const ps = vm.pageSize
  const counted = (vm.free + vm.active + vm.inactive + vm.speculative + vm.wired + vm.compressor) * ps
  if (!Number.isFinite(counted) || counted > total * 1.02) return null
  const unaccounted = Math.max(0, total - counted)
  const app = vm.anonymous * ps
  const wired = vm.wired * ps + unaccounted
  const compressed = vm.compressor * ps
  return {
    total,
    used: Math.min(total, app + wired + compressed),
    app: Math.min(total, app),
    wired: Math.min(total, wired),
    compressed: Math.min(total, compressed),
    cached: Math.min(total, (vm.fileBacked + vm.purgeable) * ps),
    swapUsed: sys.swapUsed,
    swapTotal: sys.swapTotal,
    pressure: sys.pressure,
    availablePercent: sys.availablePercent,
    pageSize: ps
  }
}

type Counters = { at: number; swapIns: number; swapOuts: number }

/** Swap rates from cumulative counters, oldest first, the newest last (monotonic ms). */
export function swapRates(history: readonly Counters[], pageSize: number): Pick<MacMemory, 'swapInsPerSec' | 'swapOutsPerSec' | 'sustainedSwapOutsPerSec'> {
  const none = { swapInsPerSec: null, swapOutsPerSec: null, sustainedSwapOutsPerSec: null }
  const last = history[history.length - 1]
  const previous = history[history.length - 2]
  if (!last || !previous) return none
  const seconds = (last.at - previous.at) / 1000
  if (!(seconds >= 0.5) || last.swapIns < previous.swapIns || last.swapOuts < previous.swapOuts) return none
  let sustained: number | null = null
  let first = history.length - 1
  while (first > 0 && last.at - history[first - 1]!.at <= SUSTAINED_SWAP.windowMs + 5_000) first -= 1
  const span = last.at - history[first]!.at
  if (span >= SUSTAINED_SWAP.minSpanMs) {
    let every = true
    for (let i = first + 1; i < history.length; i += 1) {
      if (!(history[i]!.swapOuts > history[i - 1]!.swapOuts)) every = false
    }
    const average = (last.swapOuts - history[first]!.swapOuts) / (span / 1000)
    if (every && average * pageSize >= SUSTAINED_SWAP.minBytesPerSec) sustained = Math.round(average * 10) / 10
  }
  return {
    swapInsPerSec: Math.round(((last.swapIns - previous.swapIns) / seconds) * 10) / 10,
    swapOutsPerSec: Math.round(((last.swapOuts - previous.swapOuts) / seconds) * 10) / 10,
    sustainedSwapOutsPerSec: sustained
  }
}

export type ExecResult = { error: (Error & { code?: unknown; killed?: boolean }) | null; stdout: string }
export type ExecFile = (file: string, args: readonly string[], options: { timeout: number; maxBuffer: number }) => Promise<ExecResult>

/** A command's answer is waited for this much past its timeout, then given up on. */
const KILL_GRACE_MS = 250
/** Children of timed-out reads that have not exited yet. While this many linger, no new one
 *  starts: on a Mac short of memory, processes stuck in the kernel must not pile up. */
export const MAX_LINGERING = 4

/** What runBounded needs of `child_process.execFile` (a test seam). */
type Spawn = (
  file: string,
  args: string[],
  options: { timeout: number; killSignal: 'SIGKILL'; maxBuffer: number; encoding: 'utf8'; windowsHide: boolean; env: Record<string, string> },
  callback: (error: Error | null, stdout: string) => void
) => { exitCode: number | null; signalCode: string | null; kill(signal?: string): boolean; once(event: 'exit', listener: () => void): unknown }

/**
 * Runs a command with a timeout, and always answers by `timeout` + 250 ms. Node's own timeout
 * kills the child (SIGKILL here) and closes its pipes, but its callback still waits for the child
 * to exit, which a process stuck in the kernel (a Mac thrashing) may not do for a long time. So
 * this answers on its own timer as well, as timed out, and the next read starts fresh; at most
 * MAX_LINGERING such children are left waiting to exit before it starts no more. Never rejects.
 */
export function createRunBounded(spawn: Spawn = execFile as unknown as Spawn): ExecFile {
  let lingering = 0
  return (file, args, options) =>
    new Promise((resolve) => {
      if (lingering >= MAX_LINGERING) {
        resolve({ error: Object.assign(new Error('earlier reads have not exited'), { code: 'EBUSY' }), stdout: '' })
        return
      }
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      const finish = (result: ExecResult): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve(result)
      }
      let child: ReturnType<Spawn>
      try {
        child = spawn(
          file,
          [...args],
          { timeout: options.timeout, killSignal: 'SIGKILL', maxBuffer: options.maxBuffer, encoding: 'utf8', windowsHide: true, env: {} },
          (error, stdout) => finish({ error: error as ExecResult['error'], stdout: String(stdout ?? '') })
        )
      } catch (error) {
        finish({ error: error instanceof Error ? error : new Error(String(error)), stdout: '' })
        return
      }
      timer = setTimeout(() => {
        if (settled) return
        if (child.exitCode === null && child.signalCode === null) {
          lingering += 1
          child.once('exit', () => {
            lingering -= 1
          })
        }
        try {
          child.kill('SIGKILL')
        } catch {
          // Already gone.
        }
        finish({ error: Object.assign(new Error(`${file} did not answer`), { killed: true, code: null }), stdout: '' })
      }, Math.max(0, options.timeout) + KILL_GRACE_MS)
      timer.unref?.()
    })
}

/** The runner every MacMemoryReader uses unless given another. */
export const runBounded: ExecFile = createRunBounded()

/** When one command fails, what the other read is kept, with an earlier reading of the failed
 *  one standing in for it, marked with its age:
 *  - `sysctl`'s figures (the kernel's pressure level, percent available, swap) for up to this long,
 *    about two 5 s readings; */
export const SYSCTL_CARRY_MS = 12_000
/**  - `vm_stat`'s figures (RAM in use and its parts) for up to this long while `sysctl` still
 *    reads, because the kernel's level is what warns of a lock-up. A desktop judges RAM figures
 *    older than MAC_FIGURES_MAX_AGE_MS (src/health.ts) as unknown. */
export const VM_STAT_CARRY_MS = 5 * 60_000

type VmFigures = { vm: VmStat; at: number; rates: Pick<MacMemory, 'swapInsPerSec' | 'swapOutsPerSec' | 'sustainedSwapOutsPerSec'> }

/**
 * Reads a Mac's memory: one `vm_stat` and one `sysctl -n` each time, run side by side with a
 * timeout. Keeps the swap counters of the last minute or so for the rates. When only one command
 * fails, the other's figures are kept and the failed one's last figures stand in, marked with their
 * age (`ageMs`, `pressureAgeMs`). Never throws; resolves null when neither can give a reading
 * (src/sampler.ts then carries the last whole reading briefly), and on any other platform it runs
 * nothing.
 */
export class MacMemoryReader {
  private readonly exec: ExecFile
  private readonly mono: () => number
  private readonly osTotal: () => number
  private readonly platform: string
  private counters: Counters[] = []
  private lastVm: VmFigures | null = null
  private lastSys: { sys: SysctlMemory; at: number } | null = null

  constructor(options: { exec?: ExecFile; mono?: () => number; osTotal?: () => number; platform?: string } = {}) {
    this.exec = options.exec ?? runBounded
    this.mono = options.mono ?? (() => performance.now())
    this.osTotal = options.osTotal ?? (() => 0)
    this.platform = options.platform ?? process.platform
  }

  async read(): Promise<MacMemory | null> {
    if (this.platform !== 'darwin') return null
    const limits = { timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES }
    const [vmOut, sysOut] = await Promise.all([this.exec(VM_STAT_PATH, [], limits), this.exec(SYSCTL_PATH, ['-n', ...SYSCTL_NAMES], limits)])
    const at = this.mono()
    let total = 0
    try {
      total = this.osTotal()
    } catch {
      total = 0
    }
    // sysctl exits 1 when it skips a name it does not know and still prints the rest; a timeout,
    // a kill or a failure to start leaves nothing to read.
    const sysUsable = !sysOut.error || (typeof sysOut.error.code === 'number' && !sysOut.error.killed)
    const parsedSys = sysUsable ? parseSysctl(sysOut.stdout, total) : null
    const freshSys = parsedSys && Object.values(parsedSys).some((value) => value !== null) ? parsedSys : null
    if (freshSys) this.lastSys = { sys: freshSys, at }
    const carriedSys = !freshSys && this.lastSys && at - this.lastSys.at >= 0 && at - this.lastSys.at <= SYSCTL_CARRY_MS ? this.lastSys : null
    const sys = freshSys ?? carriedSys?.sys ?? parseSysctl('', total)

    const parsedVm = vmOut.error ? null : parseVmStat(vmOut.stdout)
    const freshFigures = parsedVm ? macMemoryOf(parsedVm, sys, total) : null
    if (parsedVm && freshFigures) {
      this.lastVm = { vm: parsedVm, at, rates: this.rates(parsedVm, at) }
      return { ...freshFigures, ...this.lastVm.rates, ...(carriedSys ? { pressureAgeMs: Math.round(at - carriedSys.at) } : {}) }
    }
    // vm_stat gave nothing usable: its last figures stand in, but only beside a fresh kernel level.
    const last = this.lastVm
    if (!freshSys || !last || at - last.at < 0 || at - last.at > VM_STAT_CARRY_MS) return null
    const carried = macMemoryOf(last.vm, sys, total)
    return carried ? { ...carried, ...last.rates, ageMs: Math.round(at - last.at) } : null
  }

  /** Swap rates from this reading's counters and the last minute or so of earlier ones. */
  private rates(vm: VmStat, at: number): VmFigures['rates'] {
    if (vm.swapIns !== null && vm.swapOuts !== null) {
      const last = this.counters[this.counters.length - 1]
      // Counters that went back (or time that did) start the history again.
      if (last && (vm.swapIns < last.swapIns || vm.swapOuts < last.swapOuts || at < last.at)) this.counters = []
      this.counters.push({ at, swapIns: vm.swapIns, swapOuts: vm.swapOuts })
      const keepFrom = at - 2 * SUSTAINED_SWAP.windowMs
      while (this.counters.length > 2 && this.counters[0]!.at < keepFrom) this.counters.shift()
    } else {
      this.counters = []
    }
    return swapRates(this.counters, vm.pageSize)
  }
}
