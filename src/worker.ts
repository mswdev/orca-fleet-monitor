// Fleet Monitor's worker. Orca runs it as a resident worker (the plugin has a status bar item),
// so it keeps sampling, beaconing and polling for as long as the plugin is enabled.
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import type { OrcaWorkerApi } from 'orca/worker'
import { createProcessRunner, resolveCli, workerCliEnvironment } from './cli.ts'
import { readCoreGroups } from './core-groups.ts'
import { startFleetMonitor, type FleetMonitor, type MonitorDeps } from './monitor.ts'
import { LocalSampler } from './sampler.ts'

/** What to call this computer until Orca's own name for it arrives (`orca host list`): the
 *  hostname up to its first dot (`build-box.local` and `desk.localdomain` lose their suffix). */
export function localMachineName(hostname = os.hostname()): string {
  const trimmed = hostname.trim()
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(trimmed) || trimmed.includes(':')) return trimmed || 'This machine'
  return trimmed.split('.')[0] || 'This machine'
}

/** The real clock, timers, sampler and CLI. Timers are unref'd so they never hold Node open. */
export function realDeps(): MonitorDeps {
  const unref = (handle: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> => {
    handle.unref?.()
    return handle
  }
  const sampler = new LocalSampler()
  // Once per worker start; until it answers (and wherever there is no split) cores are one group.
  void readCoreGroups(os.platform(), os.cpus().length).then((groups) => sampler.setCoreGroups(groups))
  return {
    now: () => Date.now(),
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
