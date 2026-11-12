// Runs the real worker wiring (src/monitor.ts with src/worker.ts's real sampler, system reader and
// process sampler) on this computer for a while, and prints what it wrote. The Orca CLI is stubbed
// out, so no machine is read or reached; only this computer's own sampling, beacon and process
// line run, which is what an unattended machine pays for.
//
//   ELECTRON_RUN_AS_NODE=1 /Applications/Orca.app/Contents/MacOS/Orca tools/measure-cost.ts \
//     --seconds 180 [--ask-every 3]
//
// --ask-every N asks for this computer's process list every N seconds, as an open panel would.
// Wrap it in something that counts the CPU of reaped children too (`/usr/bin/time -p`, or
// getrusage(RUSAGE_CHILDREN) in a parent) for the total: `top` and `ps` run as children, and the
// `top` streams are stopped (and reaped) before it exits.
import { execFileSync } from 'node:child_process'
import { startFleetMonitor, type WorkerOrca } from '../src/monitor.ts'
import { realDeps } from '../src/worker.ts'
import { BEACON_PREFIX } from '../src/beacon.ts'
import { PROCESS_PREFIX } from '../src/process-line.ts'

const arg = (name: string, fallback: number): number => {
  const at = process.argv.indexOf(name)
  const value = at > 0 ? Number(process.argv[at + 1]) : Number.NaN
  return Number.isFinite(value) && value > 0 ? value : fallback
}
const seconds = arg('--seconds', 180)
const askEvery = process.argv.includes('--ask-every') ? arg('--ask-every', 3) : 0

const lines = { beacon: [] as number[], process: [] as number[], other: 0 }
const handlers = new Map<string, (input: unknown) => unknown>()
const orca = {
  settings: { get: async () => ({ backgroundMonitoring: false }), onDidChange: () => ({ dispose() {} }) },
  panels: {
    handle: (name: string, fn: (input: unknown) => unknown) => {
      handlers.set(name, fn)
      return { dispose() {} }
    },
    post: () => {}
  },
  host: { call: async () => ({ ok: true }), has: () => true },
  log: (line: string) => {
    if (line.startsWith(BEACON_PREFIX)) lines.beacon.push(line.length)
    else if (line.startsWith(PROCESS_PREFIX)) lines.process.push(line.length)
    else lines.other += 1
  },
  commands: { register: () => ({ dispose() {} }) }
} as unknown as WorkerOrca

const deps = realDeps()
// No CLI: nothing is read from, or sent to, any machine.
deps.createRunner = () => ({
  run: async () => ({ code: null, stdout: '', stderr: '', timedOut: false, truncated: false, durationMs: 0, spawnError: 'stubbed for measurement' }),
  stop: () => {}
})
deps.declaredCommands = []

const cpu0 = process.cpuUsage()
const t0 = performance.now()
const monitor = await startFleetMonitor(orca, deps)
const answers: { rows: number; ms: number }[] = []
let asking: ReturnType<typeof setInterval> | null = null
if (askEvery > 0) {
  const ask = async (): Promise<void> => {
    const started = performance.now()
    const answer = (await handlers.get('fleet.processes')?.({ id: 'local' })) as { columns?: { pid: unknown[] } } | undefined
    answers.push({ rows: answer?.columns?.pid.length ?? 0, ms: performance.now() - started })
  }
  void ask()
  asking = setInterval(() => void ask(), askEvery * 1000)
}
await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
if (asking) clearInterval(asking)
// The `top` streams' own CPU so far (they are long-lived children, so `ps` can see it).
try {
  const listing = execFileSync('/bin/ps', ['-axo', 'ppid=,time=,args='], { env: { LC_ALL: 'C' }, maxBuffer: 1 << 24 }).toString()
  for (const line of listing.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(\/usr\/bin\/top -l 0 -s (\d+).*)$/.exec(line)
    if (m && Number(m[1]) === process.pid) console.log(`top every ${m[4]} s: ${m[2]} of CPU so far`)
  }
} catch {
  // Only a breakdown.
}
await monitor.stop()
// Let the killed `top` streams be reaped, so their CPU counts.
await new Promise((resolve) => setTimeout(resolve, 1500))
const cpu = process.cpuUsage(cpu0)
const elapsed = (performance.now() - t0) / 1000
const stats = (list: number[]): string => (list.length === 0 ? 'none' : `${list.length} lines, ${Math.min(...list)}-${Math.max(...list)} chars, mean ${Math.round(list.reduce((a, b) => a + b, 0) / list.length)}`)
console.log(`ran ${elapsed.toFixed(0)} s${askEvery > 0 ? `, asking for this computer's processes every ${askEvery} s` : ', nobody asking'}`)
console.log(`worker process itself: ${((cpu.user + cpu.system) / 1000).toFixed(0)} ms CPU = ${((cpu.user + cpu.system) / 1000 / elapsed / 10).toFixed(3)} % of one core (children not included)`)
console.log(`beacon lines: ${stats(lines.beacon)}`)
console.log(`process lines: ${stats(lines.process)}`)
if (answers.length > 0) {
  const ms = answers.map((a) => a.ms)
  console.log(`process answers: ${answers.length}, rows ${Math.min(...answers.map((a) => a.rows))}-${Math.max(...answers.map((a) => a.rows))}, first ${ms[0]!.toFixed(0)} ms, later median ${ms.slice(1).sort((a, b) => a - b)[Math.floor((ms.length - 1) / 2)]?.toFixed(0) ?? '-'} ms`)
}
process.exit(0)
