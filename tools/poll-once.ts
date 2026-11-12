// Reads every machine once through the real Orca CLI, outside Orca, and prints a summary.
// Run it the way Orca runs the worker (Orca's binary as Node, a cut-down environment), so the
// CLI is found the same way:
//
//   env -i PATH=/usr/bin:/bin HOME="$HOME" TMPDIR="$TMPDIR" ELECTRON_RUN_AS_NODE=1 \
//     /Applications/Orca.app/Contents/MacOS/Orca tools/poll-once.ts
//
// Names, ids, hostnames and workspace names are replaced with placeholders unless --show-names
// is given. Only read-only CLI commands run: environment list, diagnostics memory, plugin list,
// plugin logs.
import os from 'node:os'
import { createProcessRunner, resolveCli, workerCliEnvironment, type CommandRunner } from '../src/cli.ts'
import { FleetPoller } from '../src/poller.ts'
import { LocalSampler } from '../src/sampler.ts'
import { readSettings } from '../src/settings.ts'

const showNames = process.argv.includes('--show-names')
const overrideIndex = process.argv.indexOf('--cli')
const override = overrideIndex > 0 ? (process.argv[overrideIndex + 1] ?? null) : null

const secrets = new Map<string, string>()
const redact = (text: string): string => {
  if (showNames) return text
  let out = text
  for (const [secret, placeholder] of [...secrets].sort((a, b) => b[0].length - a[0].length)) {
    if (secret) out = out.split(secret).join(placeholder)
  }
  return out
}
const remember = (secret: string | null | undefined, placeholder: string): void => {
  if (secret && secret.length >= 3 && !secrets.has(secret)) secrets.set(secret, placeholder)
}
remember(os.homedir(), '~')
remember(os.userInfo().username, '<user>')
remember(os.hostname(), '<local-hostname>')
remember(os.hostname().replace(/\.local$/i, ''), '<local-hostname>')

const cli = resolveCli(workerCliEnvironment(override))
const runner = createProcessRunner(() => cli.path)
const calls: { args: string; ms: number; ok: boolean }[] = []
const run: CommandRunner = async (args, options) => {
  const result = await runner.run(args, options)
  calls.push({ args: args.slice(0, 2).join(' '), ms: result.durationMs, ok: result.code === 0 })
  return result
}

const sampler = new LocalSampler()
await new Promise((resolve) => setTimeout(resolve, 1_000))
sampler.sample()

const started = Date.now()
const poller = new FleetPoller(
  {
    run,
    now: () => Date.now(),
    localSample: () => sampler.latest(),
    localName: () => os.hostname(),
    pluginId: 'fleet-monitor',
    maxConcurrent: 2
  },
  readSettings({})
)
const entries = await poller.runOnce()
const wallMs = Date.now() - started
runner.stop()

let n = 0
for (const { state } of entries) {
  const placeholder = state.kind === 'local' ? 'machine-0 (this computer)' : `machine-${++n}`
  remember(state.name, placeholder)
  remember(state.id === 'local' ? null : state.id, `<env-id-${n}>`)
  remember(state.host.hostname, `<hostname-${state.kind === 'local' ? 0 : n}>`)
  for (const w of [...state.workspaces.byCpu, ...state.workspaces.byMemory]) {
    remember(w.name, '<workspace>')
    remember(w.repo, '<repo>')
    remember(w.id, '<workspace-id>')
  }
}

const pct = (v: number | null | undefined): string => (typeof v === 'number' ? `${v.toFixed(1)}%` : '–')
const gib = (v: number | null | undefined): string => (typeof v === 'number' ? `${(v / 2 ** 30).toFixed(1)} GiB` : '–')
console.log(redact(`CLI: ${cli.path ?? '(none)'} via ${cli.source ?? '–'}${cli.error ? ` (${cli.error})` : ''}`))
console.log(`Polled ${entries.length} machine(s) in ${wallMs} ms with ${calls.length} CLI calls:`)
for (const c of calls) console.log(`  ${c.args.padEnd(20)} ${String(c.ms).padStart(5)} ms ${c.ok ? 'ok' : 'FAILED'}`)
n = 0
for (const { state, history } of entries) {
  const label = state.kind === 'local' ? 'machine-0 (this computer)' : `machine-${++n}`
  console.log(`\n${label}`)
  console.log(`  kind=${state.kind} tier=${state.tier} status=${state.status} health=${state.health.level}${state.health.reasons.length ? ` (${state.health.reasons.join('; ')})` : ''}`)
  console.log(`  platform=${state.host.platform ?? '–'} arch=${state.host.arch ?? '–'} cores=${state.host.cores ?? '–'} latency=${state.latencyMs ?? '–'} ms`)
  console.log(`  cpu=${pct(state.cpu.percent)} [${state.cpu.source ?? '–'}] perCore=${state.cpu.perCore ? state.cpu.perCore.length : 'none'}`)
  console.log(`  memory=${state.memory ? `${pct(state.memory.percent)} of ${gib(state.memory.total)} [${state.memory.source}${state.memory.reliable ? '' : ', unreliable'}]` : '–'}`)
  console.log(`  load=${state.load ? [state.load.one, state.load.five, state.load.fifteen].map((v) => (v === null ? '–' : v.toFixed(2))).join(' ') : '–'}`)
  console.log(`  orca app cpu=${state.orca ? pct(state.orca.cpu) : '–'} (of one core) memory=${state.orca ? gib(state.orca.memory) : '–'}`)
  console.log(`  workspaces: top-by-cpu=${state.workspaces.byCpu.length} top-by-memory=${state.workspaces.byMemory.length}`)
  console.log(`  beacon=${state.beacon.state} remotePlugin=${state.beacon.remotePlugin} history points=${history.size}`)
  if (state.error) console.log(redact(`  error: ${state.error}`))
}
