// Runs this computer's real system and process readers for about 25 seconds, outside Orca, and
// prints what they read. CI runs it on Linux and Windows runners, where the unit tests (which feed
// the parsers recorded text) cannot tell whether the real files and counters look the way the
// parsers expect. It exits 1 when a reading every machine has is missing or out of shape.
//
//   node tools/smoke-system.ts
//
// A runner has no battery, and no GPU but a software display adapter, so those are printed but
// never required.
import os from 'node:os'
import { performance } from 'node:perf_hooks'
import { LinuxProcessSampler } from '../src/linux-processes.ts'
import { LinuxSystemReader } from '../src/linux-system.ts'
import { MacSystemReader } from '../src/mac-system.ts'
import type { MacSystem } from '../src/model.ts'
import type { ProcessSource } from '../src/monitor.ts'
import { ProcessSampler, type ProcessTable } from '../src/processes.ts'
import type { SystemReader } from '../src/sampler.ts'
import { PowerShellHost } from '../src/win-host.ts'
import { WindowsProcessSampler } from '../src/win-processes.ts'
import { WindowsSystemReader } from '../src/win-system.ts'

const platform = process.platform
const cores = (): number => os.cpus().length
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const failures: string[] = []
const check = (ok: boolean, what: string): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failures.push(what)
}
const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0

let host: PowerShellHost | null = null
let system: SystemReader
let processes: ProcessSource
if (platform === 'linux') {
  system = new LinuxSystemReader()
  processes = new LinuxProcessSampler({ cores })
} else if (platform === 'win32') {
  host = new PowerShellHost()
  system = new WindowsSystemReader({ host })
  processes = new WindowsProcessSampler({ host, cores })
} else if (platform === 'darwin') {
  system = new MacSystemReader()
  processes = new ProcessSampler({ cores })
} else {
  console.log(`nothing reads ${platform}`)
  process.exit(0)
}

/** Something for the readers to see: a core kept busy, and a file written and read back. */
function work(ms: number): void {
  const until = performance.now() + ms
  let x = 0
  while (performance.now() < until) x += Math.sqrt(x + 1)
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const started = performance.now()
  const cpu = process.cpuUsage()
  const value = await fn()
  const used = process.cpuUsage(cpu)
  console.log(`     ${label}: ${Math.round(performance.now() - started)} ms (this process: ${Math.round((used.user + used.system) / 1000)} ms of CPU)`)
  return value
}

async function main(): Promise<void> {
  console.log(`${platform} ${os.release()}, ${cores()} cores, node ${process.version}`)
  let snapshot: MacSystem | null = null
  let first: ProcessTable | null = null
  let table: ProcessTable | null = null
  // The slowest cadence a runner can show is disk traffic (every 20 s), so four readings 7 s apart.
  for (let round = 0; round < 4; round += 1) {
    if (round > 0) {
      work(1_500)
      await sleep(5_500)
    }
    await timed(`system refresh ${round + 1}`, () => system.refresh())
    snapshot = system.snapshot()
    const read = await timed(`process list ${round + 1}`, () => processes.localTable())
    if (round === 0) first = read
    table = read
  }
  console.log('system:', JSON.stringify(snapshot, null, 1))

  check(snapshot !== null, 'the system reader gives a snapshot')
  const net = snapshot?.net ?? null
  check(net !== null && typeof net.iface === 'string' && net.iface.length > 0, `network: an interface (${net?.iface ?? 'none'})`)
  check(isCount(net?.rxBytesPerSec) && isCount(net?.txBytesPerSec), 'network: bytes per second in and out')
  const disk = snapshot?.disk ?? null
  check(isCount(disk?.totalBytes) && isCount(disk?.usedBytes) && disk!.totalBytes! > 2 ** 30 && disk!.usedBytes! <= disk!.totalBytes!, 'disk: space used and total')
  check(isCount(disk?.readBytesPerSec) && isCount(disk?.writeBytesPerSec), 'disk: bytes per second read and written')
  console.log(`     gpu: ${snapshot?.gpu ? `${snapshot.gpu.percent}%` : 'none reported'}; battery: ${snapshot?.battery ? JSON.stringify(snapshot.battery) : 'none reported'}`)

  check(first !== null && table !== null, 'the process list could be read')
  if (table) {
    const rows = table.rows
    console.log(`     ${rows.length} processes, CPU over ${table.cpuWindowMs} ms`)
    const byCpu = [...rows].sort((a, b) => (b.cpu ?? -1) - (a.cpu ?? -1)).slice(0, 5)
    const byMem = [...rows].sort((a, b) => (b.mem ?? -1) - (a.mem ?? -1)).slice(0, 5)
    const show = (r: (typeof rows)[number]): string => `${r.name} pid ${r.pid} user ${r.user ?? '-'} cpu ${r.cpu ?? '-'} mem ${r.mem === null ? '-' : Math.round(r.mem / 2 ** 20) + ' MB'}`
    console.log('     busiest:', byCpu.map(show).join(' | '))
    console.log('     largest:', byMem.map(show).join(' | '))
    check(rows.length >= 5, 'processes: at least a handful')
    check(table.cpuWindowMs !== null && table.cpuWindowMs >= 3_000 && table.cpuWindowMs <= 15_000, 'processes: CPU measured over the time between two readings')
    check(rows.filter((r) => r.cpu !== null).length >= rows.length / 2, 'processes: most have a CPU figure')
    check(rows.filter((r) => isCount(r.mem) && r.mem! > 0).length >= rows.length / 2, 'processes: most have a memory figure')
    // macOS allows a `/` inside a process's short name; nowhere does a name hold a directory.
    const pathLike = (name: string): boolean => name.includes('\\') || name.startsWith('/') || (platform !== 'darwin' && name.includes('/'))
    check(rows.every((r) => r.name.length > 0 && !pathLike(r.name)), 'processes: every one has a name, and none is a path')
    const self = rows.find((r) => r.pid === process.pid) ?? null
    console.log(`     this process: ${self ? show(self) : 'not found'}; node says rss ${Math.round(process.memoryUsage().rss / 2 ** 20)} MB, started ${Math.round(process.uptime())} s ago`)
    check(self !== null, 'processes: this process is in the list')
    if (self) {
      const rss = process.memoryUsage().rss
      check(isCount(self.mem) && self.mem! > rss / 8 && self.mem! < rss * 4, 'processes: its memory is near what Node reports')
      // It worked a core for 1.5 s of each 7 s round: about 21% of one core.
      check(isCount(self.cpu) && self.cpu! >= 5 && self.cpu! <= 100, `processes: its CPU reflects the work it just did (${self.cpu}%)`)
      const age = self.start === null ? null : Date.now() / 1000 - self.start
      check(age !== null && Math.abs(age - process.uptime()) < 30, `processes: its start time is right (${age === null ? 'none' : Math.round(age) + ' s ago'})`)
      if (platform !== 'win32') check(self.user === os.userInfo().username, `processes: its owner is this user (${self.user})`)
    }
  }
}

// Awaited at the top, with a timer Node has to wait for: the readers' own timers do not keep Node
// running, and a run that ended while a read was still out would otherwise exit 0 having checked
// nothing. A run that hangs fails.
const watchdog = setTimeout(() => {
  console.log('\nthe run did not finish in 120 s')
  process.exit(1)
}, 120_000)
try {
  await main()
} catch (error) {
  console.log(error)
  failures.push('the script threw')
}
clearTimeout(watchdog)
processes.stop()
host?.stop()
console.log(failures.length === 0 ? '\nall checks passed' : `\n${failures.length} check(s) failed:\n- ${failures.join('\n- ')}`)
process.exit(failures.length === 0 ? 0 : 1)
