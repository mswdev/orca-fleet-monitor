// Local machine sampler: node:os, plus on a Mac its memory as Activity Monitor counts it
// (src/mac-memory.ts, one `vm_stat` and one `sysctl` per reading, read by `prepare()` just before
// each sample). The core split, which needs `sysctl`, is read once elsewhere
// (src/core-groups.ts) and handed in with `setCoreGroups`.
import os from 'node:os'
import { performance } from 'node:perf_hooks'
import { groupsFit } from './core-groups.ts'
import type { CoreGroup, LocalSample, MacMemory, MacSystem } from './model.ts'

/** A Mac memory reading older than this (two sample intervals and a bit) is not attached. Until
 *  then, a sample whose own read failed carries the last one, marked with its age, so one failed
 *  read neither drops the figures nor reads as a new reading. */
export const MAC_MEMORY_MAX_AGE_MS = 12_000
/** A read that has not answered after this long is given up on, so the next sample starts a fresh
 *  one (each command has a 2 s timeout of its own; src/monitor.ts waits at most 3 s). */
export const PREPARE_DEADLINE_MS = 2_750

/** Reads a Mac's memory; src/mac-memory.ts's MacMemoryReader. */
export type MemoryReader = { read(): Promise<MacMemory | null> }
/** Reads a Mac's network, disk, GPU and battery; src/mac-system.ts's MacSystemReader. `refresh`
 *  runs what is due, `snapshot` gives what is known now with its ages. */
export type SystemReader = { refresh(): Promise<void>; snapshot(): MacSystem | null }

export type CpuTimes = { user: number; nice: number; sys: number; idle: number; irq: number }
export type CpuInfo = { model: string; times: CpuTimes }

/** What the sampler reads, so tests can feed it fixed numbers. */
export type OsSource = {
  cpus(): CpuInfo[]
  totalmem(): number
  freemem(): number
  loadavg(): number[]
  uptime(): number
  hostname(): string
  platform(): string
  arch(): string
  release(): string
  availableParallelism?(): number
  now(): number
}

export const realOs: OsSource = {
  cpus: () => os.cpus(),
  totalmem: () => os.totalmem(),
  freemem: () => os.freemem(),
  loadavg: () => os.loadavg(),
  uptime: () => os.uptime(),
  hostname: () => os.hostname(),
  platform: () => os.platform(),
  arch: () => os.arch(),
  release: () => os.release(),
  availableParallelism: () =>
    typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length,
  now: () => Date.now()
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function busyAndTotal(times: CpuTimes, platform: string): { busy: number; total: number } {
  const idle = finite(times.idle)
  // On Windows Node's `sys` is kernel time less idle time, which already holds interrupt time
  // (libuv: KernelTime - IdleTime), so adding `irq` would count it twice.
  const irq = platform === 'win32' ? 0 : finite(times.irq)
  const busy = finite(times.user) + finite(times.nice) + finite(times.sys) + irq
  return { busy, total: busy + idle }
}

/**
 * Percent busy per core between two `os.cpus()` readings; null when they cannot be compared.
 *
 * `elapsedMs` is the time between the two readings. Only Linux uses it: Node leaves a core's time
 * waiting for disk, serving soft interrupts and taken by a hypervisor out of `os.cpus()` there, so
 * the times it does give can add up to much less than the time that passed, and dividing by their
 * sum alone would read a core that mostly waited for disk as busy. A core's total is never taken
 * as less than the time that passed.
 */
export function cpuDelta(
  previous: readonly CpuInfo[],
  current: readonly CpuInfo[],
  options: { platform?: string; elapsedMs?: number | null } = {}
): { total: number; perCore: number[] } | null {
  const platform = options.platform ?? ''
  const elapsed = platform === 'linux' && typeof options.elapsedMs === 'number' && Number.isFinite(options.elapsedMs) ? options.elapsedMs : 0
  if (previous.length === 0 || previous.length !== current.length) {
    return null
  }
  const perCore: number[] = []
  let busySum = 0
  let totalSum = 0
  for (let i = 0; i < current.length; i += 1) {
    const before = busyAndTotal(previous[i]!.times, platform)
    const after = busyAndTotal(current[i]!.times, platform)
    const total = Math.max(after.total - before.total, elapsed)
    const busy = after.busy - before.busy
    if (total <= 0 || busy < 0) {
      perCore.push(0)
      continue
    }
    busySum += busy
    totalSum += total
    perCore.push(clampPercent((busy / total) * 100))
  }
  return { total: totalSum > 0 ? clampPercent((busySum / totalSum) * 100) : 0, perCore }
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.min(100, Math.max(0, value))
}

/** Keeps the previous `os.cpus()` reading so each `sample()` reports CPU since the last one. */
export class LocalSampler {
  private readonly source: OsSource
  private readonly memory: MemoryReader | null
  private readonly system: SystemReader | null
  private readonly mono: () => number
  private readonly later: (fn: () => void, ms: number) => unknown
  private readonly cancel: (handle: unknown) => void
  private previous: CpuInfo[] = []
  /** When `previous` was read, on the monotonic clock. */
  private previousAt = 0
  private last: LocalSample | null = null
  private coreGroups: CoreGroup[] | null = null
  /** The last good reading, and whether the next sample is the first to carry it. */
  private mac: { value: MacMemory; at: number; fresh: boolean } | null = null
  private reading: Promise<void> | null = null
  private readingSince = 0
  private generation = 0

  /** `memory` reads a Mac's memory (null elsewhere); `mono` is a monotonic clock in ms; `timers`
   *  are for the read's deadline (test seams); `system` reads a Mac's network, disk, GPU and
   *  battery (null elsewhere), started with each prepare() but never waited for. */
  constructor(
    source: OsSource = realOs,
    memory: MemoryReader | null = null,
    mono: () => number = () => performance.now(),
    timers: { setTimeout?: (fn: () => void, ms: number) => unknown; clearTimeout?: (handle: unknown) => void } = {},
    system: SystemReader | null = null
  ) {
    this.source = source
    this.memory = memory
    this.system = system
    this.mono = mono
    this.later = timers.setTimeout ?? ((fn, ms) => setTimeout(fn, ms).unref?.())
    this.cancel = timers.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    this.previous = this.readCpus()
    this.previousAt = this.mono()
  }

  latest(): LocalSample | null {
    return this.last
  }

  /** Reads the Mac's memory for the next `sample()`; resolves once it has (at once without a
   *  reader). A read still running is joined, not started again, until PREPARE_DEADLINE_MS: then
   *  it is given up on (what it answers later is dropped) and the next call starts a fresh one. A
   *  failed read keeps the last good reading for `sample()` to carry. Never rejects. */
  prepare(): Promise<void> {
    // The optional reads (network, disk, GPU, battery) run on their own: the memory reading, and
    // so the beacon and this computer's alerts, never wait for them. sample() takes what they
    // last read, with its age.
    if (this.system) void this.system.refresh().catch(() => undefined)
    if (!this.memory) return Promise.resolve()
    // A read older than the deadline on this sampler's own clock is given up on here too, should
    // its timer not have fired (a host that froze timers, say).
    if (this.reading && this.mono() - this.readingSince >= PREPARE_DEADLINE_MS) {
      this.generation += 1
      this.reading = null
    }
    if (this.reading) return this.reading
    const reader = this.memory
    const generation = ++this.generation
    this.readingSince = this.mono()
    this.reading = new Promise<void>((resolve) => {
      let handle: unknown = null
      const done = (): void => {
        if (generation !== this.generation || this.reading === null) return
        this.cancel(handle)
        this.reading = null
        resolve()
      }
      handle = this.later(() => {
        if (generation !== this.generation) return
        this.generation += 1 // what this read answers from now on is dropped
        this.reading = null
        resolve()
      }, PREPARE_DEADLINE_MS)
      void (async () => {
        try {
          const value = await reader.read()
          if (generation === this.generation && value) this.mac = { value, at: this.mono(), fresh: true }
        } catch {
          // A failed read: the last good one stays, to be carried while it is young enough.
        }
        done()
      })()
    })
    return this.reading
  }

  /** How the cores split by kind, once known. Ignored by any reading it does not fit. */
  setCoreGroups(groups: CoreGroup[] | null): void {
    this.coreGroups = groups
  }

  sample(): LocalSample {
    const src = this.source
    const cpus = this.readCpus()
    const readAt = this.mono()
    const delta = cpuDelta(this.previous, cpus, { platform: String(src.platform() ?? ''), elapsedMs: readAt - this.previousAt })
    this.previous = cpus
    this.previousAt = readAt
    const load = src.loadavg()
    const total = Math.max(0, finite(src.totalmem()))
    const cores = cpus.length > 0 ? cpus.length : Math.max(1, finite(src.availableParallelism?.(), 1))
    const sample: LocalSample = {
      t: src.now(),
      hostname: String(src.hostname() ?? ''),
      platform: String(src.platform() ?? ''),
      arch: String(src.arch() ?? ''),
      release: String(src.release() ?? ''),
      cpuModel: String(cpus[0]?.model ?? '').trim(),
      cores,
      uptimeSec: Math.max(0, Math.round(finite(src.uptime()))),
      cpu: delta,
      memory: { total, free: Math.min(total, Math.max(0, finite(src.freemem()))) },
      load: [finite(load[0]), finite(load[1]), finite(load[2])],
      coreGroups: delta && groupsFit(this.coreGroups, delta.perCore.length) ? this.coreGroups : null
    }
    const mac = this.mac
    if (mac) {
      const age = Math.max(0, this.mono() - mac.at)
      if (age > MAC_MEMORY_MAX_AGE_MS) {
        this.mac = null
      } else if (mac.fresh) {
        sample.macMemory = mac.value
        mac.fresh = false
      } else {
        // Carried: this sample's own read failed. Every figure is that much older than it was.
        const carried = Math.round(age)
        sample.macMemory = { ...mac.value, ageMs: (mac.value.ageMs ?? 0) + carried, pressureAgeMs: (mac.value.pressureAgeMs ?? 0) + carried }
      }
    }
    if (this.system) {
      let system: MacSystem | null = null
      try {
        system = this.system.snapshot()
      } catch {
        system = null
      }
      if (system) sample.system = system
    }
    this.last = sample
    return sample
  }

  private readCpus(): CpuInfo[] {
    try {
      const list = this.source.cpus()
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
  }
}
