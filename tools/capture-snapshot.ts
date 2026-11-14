// Runs the real worker on this computer against the real Orca CLI, as an open panel would see it
// (heartbeats keep it in fast mode), and writes what the panel would be given: the snapshot and
// every machine's process answer. tools/preview/shoot-capture.mjs renders a capture with the real panel,
// so this computer's view of every machine, and another computer's view of this one, can be
// looked at side by side. Only read-only CLI commands run; nothing is published (the log is
// discarded). The file holds real host names and process names: keep it under .orca/ (git ignores it).
//
//   ELECTRON_RUN_AS_NODE=1 /Applications/Orca.app/Contents/MacOS/Orca tools/capture-snapshot.ts \
//     --seconds 60 --out .orca/captures/here.json
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { startFleetMonitor, type WorkerOrca } from '../src/monitor.ts'
import { realDeps } from '../src/worker.ts'

const arg = (name: string, fallback: string): string => {
  const at = process.argv.indexOf(name)
  return at > 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback
}
const seconds = Number(arg('--seconds', '60'))
const out = arg('--out', '.orca/captures/capture.json')

const handlers = new Map<string, (input: unknown) => unknown>()
const orca = {
  settings: { get: async () => ({}), onDidChange: () => ({ dispose() {} }) },
  panels: {
    handle: (name: string, fn: (input: unknown) => unknown) => {
      handlers.set(name, fn)
      return { dispose() {} }
    },
    post: () => {}
  },
  host: { call: async () => ({ ok: true }), has: () => false },
  log: () => {},
  commands: { register: () => ({ dispose() {} }) }
} as unknown as WorkerOrca

const call = async (name: string, input?: unknown): Promise<unknown> => handlers.get(name)!(input)
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const monitor = await startFleetMonitor(orca, realDeps())
await call('fleet.snapshot')
const until = Date.now() + seconds * 1000
let ids: string[] = []
while (Date.now() < until) {
  const snap = (await call('fleet.snapshot')) as { machines: { id: string }[] }
  ids = snap.machines.map((m) => m.id)
  // As an Activity tab would: every machine's list, so each one's readers and lines are warm.
  await Promise.all(ids.map((id) => call('fleet.processes', { id }).catch(() => null)))
  await sleep(3_000)
}
const snapshot = await call('fleet.snapshot')
const processes: Record<string, unknown> = {}
for (const id of ids) processes[id] = await call('fleet.processes', { id }).catch((error) => ({ error: String(error) }))
mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
writeFileSync(out, JSON.stringify({ capturedAt: Date.now(), platform: process.platform, snapshot, processes }))
console.log(`wrote ${out}: ${ids.length} machines`)
await monitor.stop()
process.exit(0)
