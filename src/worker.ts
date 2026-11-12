// Fleet Monitor's worker. Orca runs it as a resident worker (the plugin has a status bar item),
// so it keeps sampling, beaconing and polling for as long as the plugin is enabled.
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import type { OrcaWorkerApi } from 'orca/worker'
import { createProcessRunner, resolveCli, workerCliEnvironment } from './cli.ts'
import { startFleetMonitor, type FleetMonitor, type MonitorDeps } from './monitor.ts'
import { LocalSampler } from './sampler.ts'

export function localMachineName(hostname = os.hostname()): string {
  return hostname.replace(/\.local$/i, '') || 'This machine'
}

/** The real clock, timers, sampler and CLI. Timers are unref'd so they never hold Node open. */
export function realDeps(): MonitorDeps {
  const unref = (handle: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> => {
    handle.unref?.()
    return handle
  }
  return {
    now: () => Date.now(),
    setInterval: (fn, ms) => unref(setInterval(fn, ms)),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    setTimeout: (fn, ms) => unref(setTimeout(fn, ms)),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    sampler: new LocalSampler(),
    resolveCli: (override) => resolveCli(workerCliEnvironment(override)),
    createRunner: (cliPath) => createProcessRunner(cliPath),
    localName: () => localMachineName(),
    runId: () => randomBytes(4).toString('hex')
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
