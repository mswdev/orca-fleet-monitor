// Fleet Monitor's worker. Orca runs it as a resident worker (the plugin has a status bar item),
// so it keeps sampling, beaconing and polling for as long as the plugin is enabled.
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import type { OrcaWorkerApi } from 'orca/worker'
import { createProcessRunner, resolveCli, workerCliEnvironment } from './cli.ts'
import { readCoreGroups } from './core-groups.ts'
import { MacMemoryReader } from './mac-memory.ts'
import { startFleetMonitor, type FleetMonitor, type MonitorDeps } from './monitor.ts'
import { LocalSampler, realOs } from './sampler.ts'

/** What to call this computer until Orca's own name for it arrives (`orca host list`): the
 *  hostname up to its first dot (`build-box.local` and `desk.localdomain` lose their suffix). */
export function localMachineName(hostname = os.hostname()): string {
  const trimmed = hostname.trim()
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(trimmed) || trimmed.includes(':')) return trimmed || 'This machine'
  return trimmed.split('.')[0] || 'This machine'
}

/** How far the wall clock may run ahead of the monotonic one between two readings before it is
 *  taken for a real jump (the machine slept, or the clock was set forward) and followed. */
const WALL_JUMP_MS = 1_000

/**
 * The worker's clock: wall time when it starts, then moved on by the monotonic clock, so it never
 * goes back. Polling is scheduled on it and history is stamped with it, so a wall clock set back
 * (by NTP or by hand) neither stops polling until the old time comes round again nor folds new
 * readings in among old ones. When the wall clock runs ahead of the monotonic one by more than a
 * second (sleep pauses the monotonic clock; or the clock was set forward) it follows, so readings
 * from before a sleep age out of the 30 minutes as they should. Panels work out its offset from
 * their own clock from each answer's `generatedAt`.
 */
export function steadyClock(wall: () => number = Date.now, mono: () => number = () => performance.now()): () => number {
  let lastWall = wall()
  let lastMono = mono()
  let current = lastWall
  return () => {
    const w = wall()
    const m = mono()
    const dWall = w - lastWall
    const dMono = Math.max(0, m - lastMono)
    lastWall = w
    lastMono = m
    current += dWall - dMono > WALL_JUMP_MS ? dWall : dMono
    return Math.floor(current)
  }
}

/** The real clock, timers, sampler and CLI. Timers are unref'd so they never hold Node open. */
export function realDeps(): MonitorDeps {
  const unref = (handle: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> => {
    handle.unref?.()
    return handle
  }
  // On a Mac, each sample also reads memory as Activity Monitor counts it (one vm_stat, one sysctl).
  const memory = os.platform() === 'darwin' ? new MacMemoryReader({ osTotal: () => os.totalmem() }) : null
  const sampler = new LocalSampler(realOs, memory)
  // Once per worker start; until it answers (and wherever there is no split) cores are one group.
  void readCoreGroups(os.platform(), os.cpus().length).then((groups) => sampler.setCoreGroups(groups))
  return {
    now: steadyClock(),
    setInterval: (fn, ms) => unref(setInterval(fn, ms)),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    setTimeout: (fn, ms) => unref(setTimeout(fn, ms)),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    sampler,
    resolveCli: (override) => resolveCli(workerCliEnvironment(override)),
    createRunner: (cliPath) => createProcessRunner(cliPath),
    localName: () => localMachineName(),
    runId: () => randomBytes(4).toString('hex'),
    workerFile: workerFile(),
    declaredCommands: declaredCommands()
  }
}

function workerFile(): string | null {
  try {
    return fileURLToPath(import.meta.url)
  } catch {
    return null
  }
}

/** The worker commands this copy's manifest declares. Orca stops a worker that registers any
 *  other, so registering follows the manifest; anything unreadable means none. */
export function declaredCommands(read: () => string = () => readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8')): string[] {
  try {
    const manifest = JSON.parse(read()) as { contributes?: { commands?: unknown } }
    const list = manifest.contributes?.commands
    return Array.isArray(list)
      ? list
          .filter((c): c is { id: string } => !!c && typeof c === 'object' && typeof c.id === 'string' && !('action' in c))
          .map((c) => c.id)
      : []
  } catch {
    return []
  }
}

let monitor: FleetMonitor | null = null

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  await monitor?.stop()
  monitor = await startFleetMonitor(orca, realDeps())
}

export async function deactivate(): Promise<void> {
  const current = monitor
  monitor = null
  await current?.stop()
}
