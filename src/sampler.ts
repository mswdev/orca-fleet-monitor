// Local machine sampler: node:os only, no child processes.
import os from 'node:os'
import type { LocalSample } from './model.ts'

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

function busyAndTotal(times: CpuTimes): { busy: number; total: number } {
  const idle = finite(times.idle)
  const total = finite(times.user) + finite(times.nice) + finite(times.sys) + finite(times.irq) + idle
  return { busy: total - idle, total }
}

/** Percent busy per core between two `os.cpus()` readings; null when they cannot be compared. */
export function cpuDelta(
  previous: readonly CpuInfo[],
  current: readonly CpuInfo[]
): { total: number; perCore: number[] } | null {
  if (previous.length === 0 || previous.length !== current.length) {
    return null
  }
  const perCore: number[] = []
  let busySum = 0
  let totalSum = 0
  for (let i = 0; i < current.length; i += 1) {
    const before = busyAndTotal(previous[i]!.times)
    const after = busyAndTotal(current[i]!.times)
    const total = after.total - before.total
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
  private previous: CpuInfo[] = []
  private last: LocalSample | null = null

  constructor(source: OsSource = realOs) {
    this.source = source
    this.previous = this.readCpus()
  }

  latest(): LocalSample | null {
    return this.last
  }

  sample(): LocalSample {
    const src = this.source
    const cpus = this.readCpus()
    const delta = cpuDelta(this.previous, cpus)
    this.previous = cpus
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
      load: [finite(load[0]), finite(load[1]), finite(load[2])]
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
