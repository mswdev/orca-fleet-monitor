// Shared test doubles: a fake clock with timers, a scriptable fake Orca CLI and sample builders.
// Every value here is invented.
import { readFileSync } from 'node:fs'
import { encodeBeacon } from '../src/beacon.ts'
import type { CommandResult, CommandRunner } from '../src/cli.ts'
import type { LocalSample, MacMemory } from '../src/model.ts'

const GIB = 2 ** 30

/** An invented Mac's memory reading: 16 GB, 12.5 GB of it in use, 1 GB of swap, pressure normal. */
export function macMemory(overrides: Partial<MacMemory> = {}): MacMemory {
  return {
    total: 16 * GIB,
    used: 12.5 * GIB,
    app: 7 * GIB,
    wired: 2.5 * GIB,
    compressed: 3 * GIB,
    cached: 2 * GIB,
    swapUsed: GIB,
    swapTotal: 2 * GIB,
    pressure: 'normal',
    availablePercent: 55,
    pageSize: 16_384,
    swapInsPerSec: 0,
    swapOutsPerSec: 0,
    sustainedSwapOutsPerSec: null,
    ...overrides
  }
}

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))
}

export function fixtureText(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
}

/** A clock and timers that only move when told to. */
export class FakeTime {
  t: number
  private nextId = 1
  private timers = new Map<number, { at: number; fn: () => void; every: number | null }>()

  constructor(start = 1_800_000_000_000) {
    this.t = start
  }

  now = (): number => this.t

  setTimeout = (fn: () => void, ms: number): unknown => this.add(fn, ms, null)
  setInterval = (fn: () => void, ms: number): unknown => this.add(fn, ms, ms)
  clearTimeout = (handle: unknown): void => {
    this.timers.delete(handle as number)
  }
  clearInterval = (handle: unknown): void => {
    this.timers.delete(handle as number)
  }

  get pending(): number {
    return this.timers.size
  }

  /** Moves the clock forward, firing timers in time order. */
  advance(ms: number): void {
    const end = this.t + ms
    for (;;) {
      let nextId = -1
      let next: { at: number; fn: () => void; every: number | null } | null = null
      for (const [id, timer] of this.timers) {
        if (timer.at <= end && (!next || timer.at < next.at)) {
          next = timer
          nextId = id
        }
      }
      if (!next) break
      this.t = Math.max(this.t, next.at)
      if (next.every === null) this.timers.delete(nextId)
      else next.at += next.every
      next.fn()
    }
    this.t = end
  }

  private add(fn: () => void, ms: number, every: number | null): number {
    const id = this.nextId++
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn, every })
    return id
  }
}

export function okResult(stdout: string, durationMs = 300): CommandResult {
  return { code: 0, stdout, stderr: '', timedOut: false, truncated: false, durationMs, spawnError: null }
}

export function envelope(result: unknown, meta: Record<string, unknown> = {}): string {
  return JSON.stringify({ id: 'req', ok: true, result, _meta: meta })
}

export function errorResult(code: string, message: string): CommandResult {
  return {
    code: 1,
    stdout: JSON.stringify({ id: 'req', ok: false, error: { code, message } }),
    stderr: '',
    timedOut: false,
    truncated: false,
    durationMs: 300,
    spawnError: null
  }
}

export function timeoutResult(): CommandResult {
  return { code: null, stdout: '', stderr: '', timedOut: true, truncated: false, durationMs: 15_000, spawnError: null }
}

/** Which machine a CLI call is about: the `--environment` value, or `local`. The environment
 *  and host lists read this machine's pairing store and are about no machine in particular. */
export function machineOf(args: readonly string[]): string {
  if (args[0] === 'environment' || args[0] === 'host') return '(pairing store)'
  const index = args.indexOf('--environment')
  return index === -1 ? 'local' : (args[index + 1] ?? 'local')
}

export type Reply = CommandResult | Promise<CommandResult>

/**
 * A fake Orca CLI. `respond` decides each answer; with `hold` set, calls wait until `release()`,
 * so tests can see what runs at the same time.
 */
export class FakeCli {
  calls: { args: string[]; at: number }[] = []
  maxInFlight = 0
  maxPerMachine = 0
  hold = false
  private inFlight = 0
  private perMachine = new Map<string, number>()
  private waiting: (() => void)[] = []
  private readonly time: FakeTime
  respond: (args: string[]) => Reply

  constructor(time: FakeTime, respond: (args: string[]) => Reply) {
    this.time = time
    this.respond = respond
  }

  run: CommandRunner = async (args) => {
    const list = [...args]
    this.calls.push({ args: list, at: this.time.now() })
    const machine = machineOf(list)
    this.inFlight += 1
    this.perMachine.set(machine, (this.perMachine.get(machine) ?? 0) + 1)
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    this.maxPerMachine = Math.max(this.maxPerMachine, this.perMachine.get(machine)!)
    try {
      if (this.hold) await new Promise<void>((resolve) => this.waiting.push(resolve))
      return await this.respond(list)
    } finally {
      this.inFlight -= 1
      this.perMachine.set(machine, this.perMachine.get(machine)! - 1)
    }
  }

  /** Lets every held call answer. */
  release(): void {
    const waiting = this.waiting
    this.waiting = []
    for (const resolve of waiting) resolve()
  }

  get held(): number {
    return this.waiting.length
  }

  count(predicate: (args: string[]) => boolean): number {
    return this.calls.filter((c) => predicate(c.args)).length
  }
}

export const isDiag = (machine: string) => (args: string[]) => args[0] === 'diagnostics' && machineOf(args) === machine
export const isLogs = (machine: string) => (args: string[]) => args[0] === 'plugin' && args[1] === 'logs' && machineOf(args) === machine
export const isEnvList = (args: string[]) => args[0] === 'environment'

/** Lets queued promise callbacks run. */
export async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

export function localSample(overrides: Partial<LocalSample> = {}): LocalSample {
  return {
    t: 1_800_000_000_000,
    hostname: 'test-host',
    platform: 'linux',
    arch: 'x64',
    release: '6.1.0-test',
    cpuModel: 'Example CPU 8-Core',
    cores: 4,
    uptimeSec: 3_600,
    cpu: { total: 42.5, perCore: [40, 45, 41.2, 43.8] },
    memory: { total: 16 * 2 ** 30, free: 4 * 2 ** 30 },
    load: [1.5, 1.25, 1],
    ...overrides
  }
}

export function diagnosticsFor(options: {
  collectedAt: number
  load1?: number
  cores?: number
  memoryPercent?: number
  runtimeId?: string
  workspaces?: { id: string; name: string; repo: string; cpu: number; memory: number }[]
  /** How Orca measured available memory: `memory-pressure` on a Mac. `proc-meminfo` when not given. */
  memorySource?: string
}): string {
  const total = 32 * 2 ** 30
  const percent = options.memoryPercent ?? 40
  const used = Math.round((total * percent) / 100)
  return envelope(
    {
      app: { cpu: 4, memory: 600_000_000, main: { cpu: 1, memory: 1 }, renderer: { cpu: 2, memory: 1 }, other: { cpu: 1, memory: 1 }, history: [] },
      worktrees: (options.workspaces ?? []).map((w) => ({
        worktreeId: w.id,
        worktreeName: w.name,
        repoId: 'repo',
        repoName: w.repo,
        cpu: w.cpu,
        memory: w.memory,
        sessions: [],
        history: []
      })),
      host: {
        totalMemory: total,
        freeMemory: 2 ** 30,
        availableMemory: total - used,
        availableMemorySource: options.memorySource ?? 'proc-meminfo',
        usedMemory: used,
        memoryUsagePercent: percent,
        cpuCoreCount: options.cores ?? 8,
        loadAverage1m: options.load1 ?? 2
      },
      processMemoryMetric: 'rss',
      totalCpu: 10,
      totalMemory: 1_000_000_000,
      collectedAt: options.collectedAt
    },
    { runtimeId: options.runtimeId ?? 'rt-remote' }
  )
}

/** A `plugin logs` answer holding beacons written every `intervalMs` up to `lastT`. */
export function beaconLogs(options: {
  key: string
  lastT: number
  count: number
  intervalMs?: number
  run?: string
  platform?: string
  cpu?: number
  noise?: boolean
}): string {
  const interval = options.intervalMs ?? 5_000
  const lines: { ts: number; level: string; line: string }[] = []
  if (options.noise) lines.push({ ts: options.lastT - 1, level: 'error', line: '[frame] panel/view.mjs:1 something went wrong' })
  for (let i = options.count - 1; i >= 0; i -= 1) {
    const t = options.lastT - i * interval
    const line = encodeBeacon(
      localSample({ t, platform: options.platform ?? 'linux', cpu: { total: options.cpu ?? 30, perCore: [30, 30, 30, 30] } }),
      { run: options.run ?? 'run-a', seq: options.count - i, intervalMs: interval }
    )!
    lines.push({ ts: t + 3, level: 'info', line })
  }
  return envelope({ pluginKey: options.key, lines, cursor: 'abc:1' })
}
