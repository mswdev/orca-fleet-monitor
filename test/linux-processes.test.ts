// This Linux computer's processes (src/linux-processes.ts): the /proc parsers, the table and the
// sampler, with invented files (a map of paths stands in for /proc) and a fake clock. No test
// reads this computer's own /proc.
import { assert, describe, test } from 'orca/testing'
import {
  AUXV_PATH,
  buildProcessTable,
  commName,
  exeName,
  FALLBACK_PAGE_BYTES,
  isKernelThread,
  LinuxProcessSampler,
  parseAuxvPageSize,
  parseBootTime,
  parsePasswd,
  parseUptimeTicks,
  parseProcStat,
  pidsOf,
  READ_BATCH,
  READ_DEADLINE_MS,
  type ProcReading
} from '../src/linux-processes.ts'
import type { ProcessSource } from '../src/monitor.ts'
import { LIST_CACHE_MS, MAX_PROCESSES, NAME_MAX } from '../src/processes.ts'
import { FakeTime, fixtureText, flush } from './helpers.ts'

/** `exe` is where /proc/<pid>/exe points; without one the link cannot be read. */
type Proc = { pid: number; comm: string; state?: string; ppid: number; utime: number; stime?: number; start: number; vsize?: number; rss: number; uid?: number; exe?: string }

/** One /proc/<pid>/stat: 52 fields, the ones read here set and the rest plausible. */
const statLine = (p: Proc): string =>
  `${p.pid} (${p.comm}) ${p.state ?? 'S'} ${p.ppid} ${p.pid} ${p.pid} 0 -1 4194304 812 0 3 0 ${p.utime} ${p.stime ?? 0} 0 0 20 0 1 0 ${p.start} ${p.vsize ?? 104_857_600} ${p.rss} 18446744073709551615 ${Array(27).fill('0').join(' ')}\n`

/** An auxiliary vector: pairs of words, ending at AT_NULL. */
function auxv(pairs: [number, number][], wordBytes: 4 | 8 = 8, little = true): Uint8Array {
  const bytes = new Uint8Array((pairs.length + 1) * 2 * wordBytes)
  const view = new DataView(bytes.buffer)
  pairs.forEach(([key, value], i) => {
    for (const [at, word] of [[i * 2 * wordBytes, key], [(i * 2 + 1) * wordBytes, value]] as const) {
      if (wordBytes === 8) view.setBigUint64(at, BigInt(word), little)
      else view.setUint32(at, word, little)
    }
  })
  return bytes
}
/** AT_SYSINFO_EHDR, AT_HWCAP, AT_PAGESZ, AT_CLKTCK, AT_PHNUM, as a kernel lays them out. */
const auxvWith = (pageSize: number, wordBytes: 4 | 8 = 8, little = true): Uint8Array =>
  auxv([[33, 0x7ffd_1000], [16, 0xbfeb_fbff], [6, pageSize], [17, 100], [5, 13]], wordBytes, little)

describe('/proc/<pid>/stat', () => {
  test('the fields read: parent, CPU time, start, address space and resident pages', () => {
    assert.deepEqual(parseProcStat(fixtureText('linux-stat-systemd.txt')), {
      pid: 1,
      comm: 'systemd',
      state: 'S',
      ppid: 0,
      cpuTicks: 412 + 1_204,
      startTicks: 2,
      vsize: 172_412_928,
      rssPages: 3_204
    })
    assert.deepEqual(parseProcStat(statLine({ pid: 900, comm: 'bash', state: 'R', ppid: 899, utime: 7, stime: 5, start: 123_456, vsize: 9_000_000, rss: 1_250 })), {
      pid: 900,
      comm: 'bash',
      state: 'R',
      ppid: 899,
      cpuTicks: 12,
      startTicks: 123_456,
      vsize: 9_000_000,
      rssPages: 1_250
    })
  })

  test('a name with spaces and parentheses is what stands between the first ( and the last )', () => {
    const web = parseProcStat(fixtureText('linux-stat-web-content.txt'))!
    assert.equal(web.comm, '(Web Content) (x)')
    assert.deepEqual([web.pid, web.state, web.ppid, web.cpuTicks, web.startTicks, web.rssPages], [4_242, 'S', 4_100, 91_250 + 20_412, 8_126_040, 151_204])
    assert.equal(parseProcStat(statLine({ pid: 5, comm: '(sd-pam)', ppid: 4, utime: 0, start: 9, rss: 1 }))!.comm, '(sd-pam)')
    // A name written to look like the fields after it changes none of them.
    const forged = parseProcStat(statLine({ pid: 77, comm: 'x) R 1 77 77 0 -1 0 0 0 0 0 999999 999999 0 0 20 0 1 0 1 1 999999 (y', ppid: 4_100, utime: 3, start: 50, rss: 10 }))!
    assert.deepEqual([forged.ppid, forged.cpuTicks, forged.startTicks, forged.rssPages], [4_100, 3, 50, 10])
    assert.equal(forged.comm.startsWith('x) R 1'), true)
    assert.equal(parseProcStat(statLine({ pid: 78, comm: 'two\nlines', ppid: 1, utime: 0, start: 9, rss: 1 }))!.comm, 'two\nlines')
    assert.equal(parseProcStat(statLine({ pid: 79, comm: '', ppid: 1, utime: 0, start: 9, rss: 1 }))!.comm, '', 'a process may name itself nothing')
  })

  test('anything out of shape is no process', () => {
    const good = statLine({ pid: 900, comm: 'bash', ppid: 899, utime: 7, start: 123_456, rss: 1_250 })
    assert.notEqual(parseProcStat(good), null)
    assert.equal(parseProcStat(good.replace('900 (', 'x (')), null, 'no pid')
    assert.equal(parseProcStat(good.replace('900 (', '0 (')), null, 'pid 0')
    assert.equal(parseProcStat(good.replace('(bash)', 'bash')), null, 'no parentheses')
    assert.equal(parseProcStat(good.replace(') S ', ') 5 ')), null, 'no state letter')
    assert.equal(parseProcStat(good.replace(' 899 ', ' -1 ')), null, 'a parent that is not a number')
    assert.equal(parseProcStat(good.replace(' 123456 ', ' soon ')), null, 'a start that is not a number')
    assert.equal(parseProcStat(good.replace(' 1250 ', ' -4 ')), null, 'resident pages below zero')
    assert.equal(parseProcStat(good.replace(' 123456 ', ` ${'9'.repeat(20)} `)), null, 'past a safe integer')
    assert.equal(parseProcStat(good.split(' ').slice(0, 20).join(' ')), null, 'cut short: the process ended while it was read')
    assert.equal(parseProcStat(''), null)
    assert.equal(parseProcStat(null), null)
    assert.equal(parseProcStat(`1 (${'x'.repeat(5_000)}) S 0 0 0`), null, 'far too long')
  })

  test('kernel threads: kthreadd and its children, which have no address space', () => {
    const kworker = parseProcStat(fixtureText('linux-stat-kworker.txt'))!
    assert.equal(kworker.comm, 'kworker/3:0H-events_highpri')
    assert.equal(isKernelThread(kworker), true)
    assert.equal(isKernelThread(parseProcStat(statLine({ pid: 2, comm: 'kthreadd', ppid: 0, utime: 0, start: 2, vsize: 0, rss: 0 }))!), true)
    assert.equal(isKernelThread(parseProcStat(fixtureText('linux-stat-systemd.txt'))!), false)
    // In a container pid 2 is an ordinary process, and so are its children.
    assert.equal(isKernelThread(parseProcStat(statLine({ pid: 2, comm: 'node', ppid: 1, utime: 9, start: 400, rss: 9_000 }))!), false)
    assert.equal(isKernelThread(parseProcStat(statLine({ pid: 31, comm: 'sh', ppid: 2, utime: 1, start: 500, rss: 300 }))!), false)
    assert.equal(isKernelThread(parseProcStat(statLine({ pid: 40, comm: 'defunct', state: 'Z', ppid: 1, utime: 1, start: 500, vsize: 0, rss: 0 }))!), false, 'a zombie is not one')
  })

  test('the process ids in a listing of /proc', () => {
    assert.deepEqual(pidsOf(['cpuinfo', '42', '1', 'self', 'net', '007', '42', '0', '3x', '99999999999', '4194304', 'thread-self']), [1, 42, 4_194_304])
    assert.deepEqual(pidsOf(null), [])
    assert.deepEqual(pidsOf([7, null, '8']), [8])
  })
})

describe('the name of the executable', () => {
  test('the file name of the link target, and nothing of its directory', () => {
    assert.equal(exeName('/usr/local/bin/node'), 'node')
    assert.equal(exeName('/usr/lib/firefox/firefox'), 'firefox')
    assert.equal(exeName('/home/example/secret-project-x/bin/tool'), 'tool')
    assert.equal(exeName('/opt/My App/bin/My Tool'), 'My Tool', 'spaces are part of a name')
    assert.equal(exeName('/sbin/init'), 'init')
    assert.equal(exeName('/toplevel'), 'toplevel')
    assert.equal(exeName('/usr/bin/café-tool'), 'café-tool')
  })

  test('a replaced executable loses its " (deleted)"', () => {
    assert.equal(exeName('/usr/lib/firefox/firefox (deleted)'), 'firefox')
    assert.equal(exeName('/opt/My App/My Tool (deleted)'), 'My Tool')
    assert.equal(exeName('/memfd:jit (deleted)'), 'memfd:jit', 'a program run from memory')
    assert.equal(exeName('/usr/bin/tool (deleted) '), 'tool (deleted)', 'only at the very end')
    assert.equal(exeName('/usr/bin/(deleted)'), '(deleted)', 'a file may be called that')
  })

  test('made fit for one line, and no longer than a name may be', () => {
    assert.equal(exeName(`/srv/${'n'.repeat(300)}`), 'n'.repeat(NAME_MAX))
    assert.equal(exeName(`/srv/${'d'.repeat(300)}/${'n'.repeat(200)} (deleted)`), 'n'.repeat(NAME_MAX))
    assert.equal(exeName('/tmp/evil\u202Eexe'), 'evil\uFFFDexe')
    assert.equal(exeName('/tmp/two\nlines'), 'two lines')
  })

  test('a target that names no file is none: the kernel short name stays', () => {
    assert.equal(exeName('/'), null)
    assert.equal(exeName('/usr/bin/'), null)
    assert.equal(exeName('/ (deleted)'), null)
    assert.equal(exeName('/tmp/\n'), null, 'nothing left of the name')
    assert.equal(exeName(''), null)
    assert.equal(exeName('node'), null, 'not an absolute path: not what the kernel gives')
    assert.equal(exeName(' (deleted)'), null)
    assert.equal(exeName(`/${'x/'.repeat(3_000)}tool`), null, 'longer than any path')
    assert.equal(exeName(null), null)
    assert.equal(exeName(42), null)
  })
})

describe('/etc/passwd, the auxiliary vector and the boot time', () => {
  test('account names by uid: the first line for a uid, and only its name', () => {
    const users = parsePasswd(fixtureText('linux-passwd.txt'))!
    assert.deepEqual([...users.entries()], [[0, 'root'], [1, 'daemon'], [33, 'www-data'], [101, 'messagebus'], [998, 'systemd-network'], [1000, 'example'], [65534, 'nobody']])
    assert.equal([...users.values()].some((name) => name.includes('Person') || name.includes('/')), false, 'no full name, no home')
    assert.equal(parsePasswd('evil‮name:x:5:5::/:/bin/sh\n' + `${'n'.repeat(80)}:x:6:6::/:/bin/sh\n`)!.get(5), 'evil�name')
    assert.equal(parsePasswd(`${'n'.repeat(80)}:x:6:6::/:/bin/sh\n`)!.get(6)!.length, 32)
    assert.equal(parsePasswd('big:x:4294967296:1::/:/bin/sh\n:x:7:7::/:/bin/sh\n')!.size, 0, 'a uid past 32 bits, and a line without a name')
    assert.equal(parsePasswd('')!.size, 0)
    assert.equal(parsePasswd(7), null)
    assert.equal(parsePasswd('root:x:0:0::/:/bin/sh\n', 5), null, 'larger than is accepted')
  })

  test('the page size: AT_PAGESZ, in either word size and byte order', () => {
    assert.equal(parseAuxvPageSize(auxvWith(4_096), 8, true), 4_096)
    assert.equal(parseAuxvPageSize(auxvWith(16_384), 8, true), 16_384, 'Apple silicon')
    assert.equal(parseAuxvPageSize(auxvWith(65_536, 8, false), 8, false), 65_536, 'a big-endian 64-bit kernel')
    assert.equal(parseAuxvPageSize(auxvWith(4_096, 4), 4, true), 4_096, 'a 32-bit program')
    assert.equal(parseAuxvPageSize(auxvWith(4_096, 4, false), 4, false), 4_096)
    // Node's Buffers often share one pool: the bytes may start anywhere in it.
    const pooled = new Uint8Array(200)
    pooled.set(auxvWith(16_384), 24)
    assert.equal(parseAuxvPageSize(pooled.subarray(24, 24 + 96), 8, true), 16_384)
    assert.equal(parseAuxvPageSize(Buffer.from(auxvWith(4_096)), 8, true), 4_096)
  })

  test('the page size: out of shape is none, never a guess', () => {
    assert.equal(parseAuxvPageSize(auxvWith(5_000), 8, true), null, 'not a power of two')
    assert.equal(parseAuxvPageSize(auxvWith(1_024), 8, true), null, 'smaller than any page')
    assert.equal(parseAuxvPageSize(auxvWith(2 ** 30), 8, true), null, 'larger than any page')
    assert.equal(parseAuxvPageSize(auxv([[33, 1], [17, 100]]), 8, true), null, 'no AT_PAGESZ')
    assert.equal(parseAuxvPageSize(auxv([[0, 0], [6, 4_096]]), 8, true), null, 'after the end of the vector')
    assert.equal(parseAuxvPageSize(auxvWith(4_096).subarray(0, 40), 8, true), null, 'cut short before its value')
    assert.equal(parseAuxvPageSize(auxvWith(4_096), 8, false), null, 'read in the wrong byte order')
    assert.equal(parseAuxvPageSize(new Uint8Array(0), 8, true), null)
    assert.equal(parseAuxvPageSize('6 4096', 8, true), null)
    assert.equal(parseAuxvPageSize(new Uint8Array(8_192), 8, true), null, 'far too long')
    // With this computer's own word size and byte order: the page size or none, and no throw.
    assert.ok([4_096, null].includes(parseAuxvPageSize(auxvWith(4_096))))
  })

  test('btime: when the computer started', () => {
    const text = 'cpu  412034 1204 91204 81204120 4120 0 912 0 0 0\ncpu0 51204 120 11204 10150412 512 0 112 0 0 0\nintr 9120412 0 9 0 0\nctxt 81204120\nbtime 1794412345\nprocesses 412034\nprocs_running 2\n'
    assert.equal(parseBootTime(text), 1_794_412_345)
    assert.equal(parseBootTime('cpu  1 2 3\nprocesses 4\n'), null)
    assert.equal(parseBootTime('btime soon\n'), null)
    assert.equal(parseBootTime('btime 0\n'), null)
    assert.equal(parseBootTime('xbtime 1794412345\n'), null)
    assert.equal(parseBootTime(null), null)
  })
})

/** A reading with `at` and `wallAt` the same; each row is [pid, CPU ticks, start ticks]. */
/** `sinceBootTicks`: how long the computer had been up when the reading began (ticks). */
const reading = (at: number, rows: [number, number, number][], wallAt = at, sinceBootTicks: number | null = null): ProcReading => ({
  at,
  wallAt,
  sinceBootTicks,
  rows: rows.map(([pid, cpuTicks, startTicks]) => ({ pid, ppid: 1, name: `p${pid}`, user: 'example', cpuTicks, startTicks, start: 1_794_412_345 + Math.floor(startTicks / 100), mem: pid * 4_096 }))
})

describe('the table', () => {
  test('CPU % of one core from two readings; memory, start and owner from the newer', () => {
    const before = reading(100_000, [[10, 1_000, 50], [11, 500, 60]], 100_000, 10_000)
    const now = reading(103_000, [[10, 1_300, 50], [11, 500, 60], [12, 150, 10_250]])
    const table = buildProcessTable(now, before, 8)
    const byPid = new Map(table.rows.map((r) => [r.pid, r]))
    assert.equal(byPid.get(10)!.cpu, 100, '300 ticks are 3 s of CPU, in 3 s')
    assert.equal(byPid.get(11)!.cpu, 0)
    assert.equal(byPid.get(12)!.cpu, 50, 'started since the last reading: 1.5 s of CPU over the 3 s window')
    assert.deepEqual(byPid.get(12), { pid: 12, ppid: 1, name: 'p12', user: 'example', cpu: 50, mem: 12 * 4_096, energy: null, start: 1_794_412_345 + 102 })
    assert.deepEqual([table.takenAt, table.cpuWindowMs, table.memAgeMs, table.energyWindowMs, table.total], [103_000, 3_000, 0, null, 3])
  })

  test('a reused pid is another process: its own CPU time, not the difference', () => {
    const table = buildProcessTable(reading(103_000, [[10, 30, 10_250]]), reading(100_000, [[10, 90_000, 50]], 100_000, 10_000))
    assert.equal(table.rows[0]!.cpu, 10, '0.3 s of CPU over the 3 s window')
  })

  test('a process the last reading missed gets no CPU %, not its whole life in one window', () => {
    // The last reading began 95 s after boot. Pids 11 and 13 were running by then and their reads
    // failed; pid 13 is even the newest process the computer had. Only pid 14 started since.
    const before = reading(100_000, [[10, 1_000, 50], [12, 40, 9_000]], 100_000, 9_500)
    const now = reading(103_000, [[10, 1_000, 50], [11, 500_000, 60], [12, 40, 9_000], [13, 240_000, 9_400], [14, 30, 9_600]])
    const byPid = new Map(buildProcessTable(now, before, 8).rows.map((r) => [r.pid, r.cpu]))
    assert.deepEqual([byPid.get(10), byPid.get(11), byPid.get(12), byPid.get(13), byPid.get(14)], [0, null, 0, null, 10])
  })

  test('a process that started in the very tick the last reading began is new', () => {
    const before = reading(100_000, [[10, 1_000, 50]], 100_000, 10_250)
    const now = reading(103_000, [[10, 1_000, 50], [12, 150, 10_250]])
    assert.equal(buildProcessTable(now, before, 8).rows.find((r) => r.pid === 12)!.cpu, 50)
  })

  test('new means later than the newest process the last reading saw, too', () => {
    // The last reading began at 95 s and went on to list a process that started at 97 s. One that
    // started at 96 s and is missing from it (its read failed) is not new.
    const before = reading(100_000, [[10, 1_000, 50], [12, 40, 9_700]], 100_000, 9_500)
    const now = reading(103_000, [[10, 1_000, 50], [12, 40, 9_700], [13, 600, 9_600], [14, 30, 9_800]])
    const byPid = new Map(buildProcessTable(now, before, 8).rows.map((r) => [r.pid, r.cpu]))
    assert.deepEqual([byPid.get(13), byPid.get(14)], [null, 10])
  })

  test('without the uptime of the last reading, no unmatched process is taken for a new one', () => {
    const before = reading(100_000, [[10, 1_000, 50]])
    const now = reading(103_000, [[10, 1_300, 50], [12, 150, 10_250]])
    const byPid = new Map(buildProcessTable(now, before, 8).rows.map((r) => [r.pid, r.cpu]))
    assert.deepEqual([byPid.get(10), byPid.get(12)], [100, null])
  })

  test('the uptime in clock ticks, and a kernel name without any directory', () => {
    assert.equal(parseUptimeTicks('81500.25 1040000.11\n'), 8_150_025)
    assert.equal(parseUptimeTicks('7 3\n'), 700)
    for (const bad of ['', 'up 3 days', '-5.00 1.00\n', null, 12, 'x'.repeat(300)]) assert.equal(parseUptimeTicks(bad), null)
    assert.equal(commName('postgres'), 'postgres')
    assert.equal(commName('/tmp/secret'), 'secret', 'a process that named itself with a path')
    assert.equal(commName('a/b/c'), 'c')
    assert.equal(commName('/tmp/dir/'), '', 'nothing after the last slash: the pid stands in')
  })

  test('no reading before, readings too close, a counter that went back, and the cap', () => {
    assert.deepEqual([buildProcessTable(reading(103_000, [[10, 9_999, 50]]), null).rows[0]!.cpu, buildProcessTable(reading(103_000, [[10, 9_999, 50]]), null).cpuWindowMs], [null, null])
    const close = buildProcessTable(reading(100_499, [[10, 5, 50]]), reading(100_000, [[10, 0, 50]]))
    assert.deepEqual([close.cpuWindowMs, close.rows[0]!.cpu], [null, null], 'readings too close together give no CPU')
    assert.equal(buildProcessTable(reading(100_500, [[10, 5, 50]]), reading(100_000, [[10, 0, 50]])).rows[0]!.cpu, 10)
    assert.equal(buildProcessTable(reading(103_000, [[10, 5, 50]]), reading(100_000, [[10, 9, 50]])).rows[0]!.cpu, null, 'the counter went back')
    const busy: [ProcReading, ProcReading] = [reading(101_000, [[10, 90_000, 50]]), reading(100_000, [[10, 0, 50]])]
    assert.equal(buildProcessTable(...busy, 2).rows[0]!.cpu, 200, 'never more than every core')
    assert.equal(buildProcessTable(...busy).rows[0]!.cpu, 100, 'one core when the number of cores is not known')
    assert.equal(buildProcessTable(reading(107_000, [[10, 725, 50]]), reading(100_000, [[10, 0, 50]]), 4).rows[0]!.cpu, 103.6, 'one decimal')
  })

  test('the window is measured on the monotonic clock, whatever the wall clock does', () => {
    // The wall clock was set back an hour between the two readings.
    const table = buildProcessTable(reading(103_000, [[10, 1_300, 50]], 1_800_000_000_000 - 3_600_000), reading(100_000, [[10, 1_000, 50]], 1_800_000_000_000), 8)
    assert.deepEqual([table.cpuWindowMs, table.rows[0]!.cpu, table.takenAt], [3_000, 100, 1_800_000_000_000 - 3_600_000])
  })
})

const BOOT = 1_794_412_345

/** A scripted /proc: the processes there now, their owners, and a clock that only moves when told. */
function fakeProc(platform = 'linux') {
  const time = new FakeTime()
  const procs = new Map<number, Proc>()
  const state = {
    passwd: fixtureText('linux-passwd.txt') as string | null,
    procStat: `cpu  412034 1204 91204 81204120 4120 0 912 0 0 0\nbtime ${BOOT}\nprocesses 412034\n` as string | null,
    /** /proc/uptime: up for 81,500 s, after every process below started. */
    uptime: '81500.00 1040000.00\n' as string | null,
    auxv: auxvWith(4_096) as Uint8Array | null,
    /** Pids the listing still shows although the process has ended. */
    ghosts: [] as number[],
    listable: true,
    reads: [] as string[],
    owners: [] as string[],
    links: [] as string[],
    lists: 0,
    inFlight: 0,
    maxInFlight: 0,
    linksInFlight: 0,
    maxLinksInFlight: 0,
    /** While set, a listing of /proc waits for it. */
    gate: null as Promise<void> | null
  }
  const put = (...list: Proc[]): void => {
    for (const p of list) procs.set(p.pid, p)
  }
  const readFile = async (path: string): Promise<string | null> => {
    state.reads.push(path)
    state.inFlight += 1
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight)
    await Promise.resolve()
    state.inFlight -= 1
    if (path === '/etc/passwd') return state.passwd
    if (path === '/proc/stat') return state.procStat
    if (path === '/proc/uptime') return state.uptime
    const match = /^\/proc\/(\d+)\/stat$/.exec(path)
    const proc = match ? procs.get(Number(match[1])) : undefined
    return proc ? statLine(proc) : null
  }
  const readDir = async (path: string): Promise<string[] | null> => {
    state.lists += 1
    if (state.gate) await state.gate
    if (path !== '/proc' || !state.listable) return null
    return ['cpuinfo', 'net', 'self', 'stat', 'thread-self', ...[...procs.keys(), ...state.ghosts].map(String)]
  }
  const statUid = async (path: string): Promise<number | null> => {
    state.owners.push(path)
    const proc = procs.get(Number(path.slice('/proc/'.length)))
    return proc ? (proc.uid ?? 1000) : null
  }
  const readBytes = async (path: string): Promise<Uint8Array | null> => {
    state.reads.push(path)
    return path === AUXV_PATH ? state.auxv : null
  }
  const readLink = async (path: string): Promise<string | null> => {
    state.links.push(path)
    state.linksInFlight += 1
    state.maxLinksInFlight = Math.max(state.maxLinksInFlight, state.linksInFlight)
    await Promise.resolve()
    state.linksInFlight -= 1
    const match = /^\/proc\/(\d+)\/exe$/.exec(path)
    return (match ? procs.get(Number(match[1]))?.exe : undefined) ?? null
  }
  const sampler = new LinuxProcessSampler({ readFile, readBytes, readDir, statUid, readLink, timers: time, mono: time.now, wall: time.now, platform, cores: () => 4 })
  const readsOf = (path: string): number => state.reads.filter((p) => p === path).length
  return { time, procs, state, put, sampler, readsOf }
}

/** A small desktop: init, kthreadd and a kernel worker, a shell, a browser tab, and a service
 *  whose account /etc/passwd does not name. */
function desktop(platform = 'linux') {
  const proc = fakeProc(platform)
  proc.put(
    { pid: 1, comm: 'systemd', ppid: 0, utime: 412, stime: 1_204, start: 2, rss: 3_204, uid: 0 },
    { pid: 2, comm: 'kthreadd', ppid: 0, utime: 0, stime: 12, start: 2, vsize: 0, rss: 0, uid: 0 },
    { pid: 37, comm: 'kworker/3:0H-events_highpri', state: 'I', ppid: 2, utime: 0, stime: 4, start: 14, vsize: 0, rss: 0, uid: 0 },
    { pid: 900, comm: 'postgres', ppid: 1, utime: 100, stime: 50, start: 4_000, rss: 20_000, uid: 4_999 },
    { pid: 4100, comm: 'bash', ppid: 1, utime: 20, stime: 10, start: 8_000_000, rss: 1_250 },
    { pid: 4242, comm: '(Web Content) (x)', ppid: 4_100, utime: 91_250, stime: 20_412, start: 8_126_040, rss: 151_204 }
  )
  return proc
}

describe('the process sampler', () => {
  test('every process, its owner, memory and start; kernel threads left out; nothing but stat and the exe link read', async () => {
    const pc = desktop()
    const table = (await pc.sampler.localTable())!
    assert.deepEqual(table.rows, [
      { pid: 1, ppid: 0, name: 'systemd', user: 'root', cpu: null, mem: 3_204 * 4_096, energy: null, start: BOOT },
      { pid: 900, ppid: 1, name: 'postgres', user: '4999', cpu: null, mem: 20_000 * 4_096, energy: null, start: BOOT + 40 },
      { pid: 4100, ppid: 1, name: 'bash', user: 'example', cpu: null, mem: 1_250 * 4_096, energy: null, start: BOOT + 80_000 },
      { pid: 4242, ppid: 4_100, name: '(Web Content) (x)', user: 'example', cpu: null, mem: 151_204 * 4_096, energy: null, start: BOOT + 81_260 }
    ])
    assert.deepEqual([table.takenAt, table.cpuWindowMs, table.memAgeMs, table.energyWindowMs, table.total], [pc.time.now(), null, 0, null, 4])
    assert.equal(pc.sampler.latestTable(), table)
    // The privacy rule: of a process, its stat file, its directory's owner and where its exe
    // link points, and nothing else. No link could be read here, so each has its kernel name.
    const allowed = /^(?:\/proc\/\d+\/stat|\/proc\/stat|\/proc\/uptime|\/proc\/self\/auxv|\/etc\/passwd)$/
    assert.deepEqual(pc.state.reads.filter((path) => !allowed.test(path)), [])
    assert.equal(pc.state.reads.some((path) => /cmdline|environ|exe|cwd|status|comm/.test(path)), false)
    assert.deepEqual(pc.state.owners.sort(), ['/proc/1', '/proc/4100', '/proc/4242', '/proc/900'], 'no owner is asked of a kernel thread')
    assert.deepEqual(pc.state.links.sort(), ['/proc/1/exe', '/proc/4100/exe', '/proc/4242/exe', '/proc/900/exe'], 'nor its executable; and no other link is read')
    assert.equal(pc.time.pending, 0, 'the deadline of a finished reading is cleared')
  })

  test('CPU % between two readings, 2 s apart at the least; a reused pid starts again', async () => {
    const pc = desktop()
    const first = await pc.sampler.localTable()
    pc.time.advance(LIST_CACHE_MS - 1)
    assert.equal(await pc.sampler.publishTable(), first, 'within the cache, the same table')
    assert.equal(pc.state.lists, 1)
    pc.time.advance(7_000 - (LIST_CACHE_MS - 1))
    pc.procs.get(4242)!.utime += 725
    const second = (await pc.sampler.publishTable())!
    assert.equal(pc.state.lists, 2)
    assert.equal(second.cpuWindowMs, 7_000)
    assert.deepEqual(second.rows.map((r) => r.cpu), [0, 0, 0, 103.6], '7.25 s of CPU in 7 s')
    assert.deepEqual(first!.rows.map((r) => [r.pid, r.start]), second.rows.map((r) => [r.pid, r.start]), 'the same processes keep the same start')
    // Pid 900 ends and a new process gets its number.
    pc.put({ pid: 900, comm: 'sleep', ppid: 4_100, utime: 20, stime: 10, start: 8_200_000, rss: 200 })
    pc.state.uptime = '82010.00 1040500.00\n' // the computer has been up a little longer than that
    pc.time.advance(3_000)
    const third = (await pc.sampler.localTable())!
    const reused = third.rows.find((r) => r.pid === 900)!
    assert.deepEqual([reused.name, reused.user, reused.cpu, reused.start], ['sleep', 'example', 10, BOOT + 82_000])
    assert.equal(pc.sampler.latestTable(), third)
  })

  test('once the uptime is seen to be on another clock, it is not believed again', async () => {
    const pc = desktop()
    // A container five minutes old: its processes seem to have started far in the future.
    pc.state.uptime = '300.00 280.00\n'
    await pc.sampler.localTable()
    // Weeks later the container is older than its processes' starts, and nothing shows the
    // mismatch any more. It is the same wrong clock.
    pc.state.uptime = '90000.00 80000.00\n'
    pc.time.advance(5_000)
    await pc.sampler.localTable()
    pc.time.advance(5_000)
    pc.put({ pid: 5000, comm: 'old-and-busy', ppid: 1, utime: 400_000, stime: 0, start: 8_100_000, rss: 100 })
    const table = (await pc.sampler.localTable())!
    assert.equal(table.rows.find((r) => r.pid === 5000)!.cpu, null)
  })

  test('the reading that finds the other clock out does not use the last one’s uptime either', async () => {
    const pc = desktop()
    // The first reading sees nothing odd: every process it lists started before this uptime.
    pc.state.uptime = '82000.00 80000.00\n'
    await pc.sampler.localTable()
    pc.time.advance(5_000)
    // Now a process whose start is beyond the uptime shows the mismatch, and with it comes an
    // old process the first reading missed.
    pc.put({ pid: 5000, comm: 'old-and-busy', ppid: 1, utime: 400_000, stime: 0, start: 8_210_000, rss: 100 })
    pc.put({ pid: 5001, comm: 'tell-tale', ppid: 1, utime: 1, stime: 0, start: 9_000_000, rss: 10 })
    const table = (await pc.sampler.localTable())!
    assert.deepEqual([table.rows.find((r) => r.pid === 5000)!.cpu, table.rows.find((r) => r.pid === 5001)!.cpu], [null, null])
  })

  test('a computer that slept during a reading is not taken for a container', async () => {
    const pc = desktop()
    // The uptime is read before the pass and again after it; here a minute's sleep fell between,
    // and a process started on waking. Against the second reading its start is not in the future.
    let reads = 0
    const before = '81500.00 1040000.00\n'
    const after = '81561.00 1040000.00\n'
    Object.defineProperty(pc.state, 'uptime', { get: () => ((reads += 1) % 2 === 1 ? before : after) })
    pc.put({ pid: 6000, comm: 'woke', ppid: 1, utime: 5, stime: 0, start: 8_156_050, rss: 10 })
    await pc.sampler.localTable()
    pc.time.advance(5_000)
    pc.put({ pid: 6001, comm: 'new', ppid: 1, utime: 100, stime: 0, start: 8_156_150, rss: 10 })
    const table = (await pc.sampler.localTable())!
    assert.equal(table.rows.find((r) => r.pid === 6001)!.cpu, 20, 'the uptime is still believed: a new process has its first figure')
  })

  test('an uptime on another clock than the start times (a container under LXCFS) is not used', async () => {
    const pc = desktop()
    // The container is 5 minutes old; its processes' starts are counted from the host's boot.
    pc.state.uptime = '300.00 280.00\n'
    await pc.sampler.localTable()
    pc.time.advance(5_000)
    // A process the first reading did not hold, long-lived and busy over its life.
    pc.put({ pid: 5000, comm: 'old-and-busy', ppid: 1, utime: 400_000, stime: 0, start: 8_100_000, rss: 100 })
    const table = (await pc.sampler.localTable())!
    assert.equal(table.rows.find((r) => r.pid === 5000)!.cpu, null, 'not its whole life in one window')
    assert.deepEqual(table.rows.filter((r) => r.pid !== 5000).map((r) => r.cpu), [0, 0, 0, 0], 'the others are measured as ever')
  })

  test('a process is named by its executable where the link can be read, by its kernel name where not', async () => {
    const pc = fakeProc()
    pc.put(
      // This user's own: Node 24 calls its main thread MainThread.
      { pid: 100, comm: 'MainThread', ppid: 1, utime: 5, start: 100, rss: 20_000, exe: '/home/example/.nvm/versions/node/v24.1.0/bin/node' },
      { pid: 101, comm: 'Web Content', ppid: 1, utime: 5, start: 101, rss: 90_000, exe: '/usr/lib/firefox/firefox (deleted)' },
      { pid: 102, comm: 'My Tool', ppid: 1, utime: 5, start: 102, rss: 300, exe: '/opt/My App/bin/My Tool' },
      { pid: 103, comm: 'gnome-settings-', ppid: 1, utime: 5, start: 103, rss: 300, exe: '/usr/libexec/gnome-settings-daemon' },
      { pid: 104, comm: 'wrapper', ppid: 1, utime: 5, start: 104, rss: 300, exe: `/home/example/secret-project-x/${'n'.repeat(300)}` },
      // Another user's, a zombie, and targets that name no file: the link says nothing.
      { pid: 200, comm: 'sshd', ppid: 1, utime: 5, start: 200, rss: 300, uid: 0 },
      { pid: 201, comm: 'defunct', state: 'Z', ppid: 100, utime: 5, start: 201, vsize: 0, rss: 0 },
      { pid: 202, comm: 'rootless', ppid: 1, utime: 5, start: 202, rss: 300, exe: '/' },
      { pid: 203, comm: 'relative', ppid: 1, utime: 5, start: 203, rss: 300, exe: 'bin/tool' },
      { pid: 204, comm: '', ppid: 1, utime: 5, start: 204, rss: 300 },
      // Kernel threads have no executable, and are never asked for one.
      { pid: 2, comm: 'kthreadd', ppid: 0, utime: 0, start: 2, vsize: 0, rss: 0, uid: 0, exe: '/must/not/be/read' },
      { pid: 37, comm: 'kworker/3:0H', ppid: 2, utime: 0, start: 14, vsize: 0, rss: 0, uid: 0, exe: '/must/not/be/read' }
    )
    const table = (await pc.sampler.localTable())!
    assert.deepEqual(
      table.rows.map((r) => [r.pid, r.name]),
      [[100, 'node'], [101, 'firefox'], [102, 'My Tool'], [103, 'gnome-settings-daemon'], [104, 'n'.repeat(NAME_MAX)], [200, 'sshd'], [201, 'defunct'], [202, 'rootless'], [203, 'relative'], [204, '204']]
    )
    assert.deepEqual(pc.state.links.sort(), [100, 101, 102, 103, 104, 200, 201, 202, 203, 204].map((pid) => `/proc/${pid}/exe`))
    // No directory anywhere: not in a row, not in the table, not in what the sampler keeps.
    for (const kept of [JSON.stringify(table), JSON.stringify(pc.sampler.latestTable()), JSON.stringify(pc.sampler)]) {
      assert.equal(/secret-project-x|\.nvm|\/usr|\/opt|\/home|My App|libexec|deleted/.test(kept), false)
    }
    assert.equal(table.rows.some((r) => Object.values(r).some((value) => typeof value === 'string' && value.includes('/'))), false)
    // The name follows the executable from one reading to the next: an update replaced the file.
    pc.procs.get(100)!.exe = '/home/example/.nvm/versions/node/v24.1.0/bin/node (deleted)'
    pc.procs.get(200)!.exe = '/usr/sbin/sshd'
    pc.time.advance(5_000)
    const later = (await pc.sampler.localTable())!
    assert.deepEqual([later.rows.find((r) => r.pid === 100)!.name, later.rows.find((r) => r.pid === 200)!.name], ['node', 'sshd'])
    assert.equal(later.rows.find((r) => r.pid === 100)!.cpu, 0, 'and it is still the same process')
  })

  test('a link read that throws, or gives something that is not text, leaves the kernel name', async () => {
    const time = new FakeTime()
    const stat = async (path: string): Promise<string | null> => (path === '/proc/7/stat' ? statLine({ pid: 7, comm: 'lonely', ppid: 1, utime: 5, start: 100, rss: 10 }) : null)
    const deps = { readFile: stat, readBytes: async () => null, readDir: async () => ['7'], statUid: async () => 1000, timers: time, mono: time.now, wall: time.now, platform: 'linux' }
    const thrower = new LinuxProcessSampler({ ...deps, readLink: async () => { throw new Error('EACCES') } })
    assert.equal((await thrower.localTable())!.rows[0]!.name, 'lonely')
    const odd = new LinuxProcessSampler({ ...deps, readLink: (async () => 42) as unknown as (path: string) => Promise<string | null> })
    assert.equal((await odd.localTable())!.rows[0]!.name, 'lonely')
    const named = new LinuxProcessSampler({ ...deps, readLink: async (path) => (path === '/proc/7/exe' ? '/usr/bin/only-child' : null) })
    assert.equal((await named.localTable())!.rows[0]!.name, 'only-child')
  })

  test('a process that ends while the list is read is simply not in it', async () => {
    const pc = desktop()
    pc.state.ghosts = [4250, 4251]
    const table = (await pc.sampler.localTable())!
    assert.deepEqual(table.rows.map((r) => r.pid), [1, 900, 4100, 4242])
    assert.equal(pc.readsOf('/proc/4250/stat'), 1, 'it was listed, so it was tried')
    // One that ends between its stat and the look at its owner is kept, without an owner.
    const racing = desktop()
    racing.put({ pid: 5000, comm: 'gone', ppid: 1, utime: 1, start: 9_000_000, rss: 10, uid: -1 })
    assert.equal((await racing.sampler.localTable())!.rows.find((r) => r.pid === 5000)!.user, null)
  })

  test('names are made fit for one line; a pid that does not match its file is not trusted', async () => {
    const pc = fakeProc()
    pc.put(
      { pid: 10, comm: 'evil‮exe', ppid: 1, utime: 0, start: 100, rss: 1 },
      { pid: 11, comm: 'two\nlines', ppid: 1, utime: 0, start: 100, rss: 1 },
      { pid: 12, comm: '', ppid: 1, utime: 0, start: 100, rss: 1 },
      { pid: 13, comm: 'café-tool', ppid: 1, utime: 0, start: 100, rss: 1 }
    )
    // /proc/14/stat that says it is pid 99.
    pc.procs.set(14, { pid: 99, comm: 'liar', ppid: 1, utime: 0, start: 100, rss: 1 })
    const table = (await pc.sampler.localTable())!
    assert.deepEqual(table.rows.map((r) => [r.pid, r.name]), [[10, 'evil�exe'], [11, 'two lines'], [12, '12'], [13, 'café-tool']])
  })

  test('the page size comes from the auxiliary vector, read once; 4 KiB stands in until it can be', async () => {
    const big = desktop()
    big.state.auxv = auxvWith(16_384)
    assert.equal((await big.sampler.localTable())!.rows[0]!.mem, 3_204 * 16_384)
    big.time.advance(5_000)
    await big.sampler.localTable()
    assert.equal(big.readsOf(AUXV_PATH), 1, 'it does not change while the computer runs')
    const blind = desktop()
    blind.state.auxv = null
    assert.equal((await blind.sampler.localTable())!.rows[0]!.mem, 3_204 * FALLBACK_PAGE_BYTES)
    blind.state.auxv = auxvWith(65_536)
    blind.time.advance(5_000)
    assert.equal((await blind.sampler.localTable())!.rows[0]!.mem, 3_204 * 65_536, 'read as soon as it can be')
  })

  test('/etc/passwd is read once, and again at most once a minute for a uid it does not name', async () => {
    const pc = desktop()
    await pc.sampler.localTable()
    pc.time.advance(5_000)
    await pc.sampler.localTable()
    assert.equal(pc.readsOf('/etc/passwd'), 1, 'uid 4999 is not named, but it was just read')
    pc.state.passwd = `${fixtureText('linux-passwd.txt')}postgres:x:4999:4999:Database:/var/lib/postgres:/bin/sh\n`
    pc.time.advance(55_000)
    const table = (await pc.sampler.localTable())!
    assert.equal(pc.readsOf('/etc/passwd'), 2)
    assert.equal(table.rows.find((r) => r.pid === 900)!.user, 'postgres')
    pc.time.advance(10 * 60_000)
    await pc.sampler.localTable()
    assert.equal(pc.readsOf('/etc/passwd'), 2, 'every uid is named: no reason to read it again')
    // A read that fails keeps the names already known.
    pc.put({ pid: 6000, comm: 'newcomer', ppid: 1, utime: 0, start: 9_500_000, rss: 5, uid: 7_777 })
    pc.state.passwd = null
    pc.time.advance(10 * 60_000)
    const later = (await pc.sampler.localTable())!
    assert.deepEqual([later.rows.find((r) => r.pid === 6000)!.user, later.rows.find((r) => r.pid === 1)!.user], ['7777', 'root'])
    // And with no /etc/passwd at all, every owner is a number.
    const bare = desktop()
    bare.state.passwd = null
    assert.deepEqual((await bare.sampler.localTable())!.rows.map((r) => r.user), ['0', '4999', '1000', '1000'])
  })

  test('the boot time is read about once a minute; without it there are no start times', async () => {
    const pc = desktop()
    await pc.sampler.localTable()
    pc.time.advance(30_000)
    await pc.sampler.localTable()
    assert.equal(pc.readsOf('/proc/stat'), 1)
    // The clock is set forward two hours (the network time arrived): btime moves with it.
    pc.state.procStat = `btime ${BOOT + 7_200}\n`
    pc.time.advance(30_000)
    const moved = (await pc.sampler.localTable())!
    assert.equal(pc.readsOf('/proc/stat'), 2)
    assert.equal(moved.rows[0]!.start, BOOT + 7_200)
    assert.deepEqual(moved.rows.map((r) => r.cpu), [0, 0, 0, 0], 'and each is still the process it was: no CPU time counted twice')
    pc.state.procStat = null
    pc.time.advance(60_000)
    assert.equal((await pc.sampler.localTable())!.rows[0]!.start, BOOT + 7_200, 'a failed read keeps the last one')
    const blind = desktop()
    blind.state.procStat = 'cpu  1 2 3\n'
    const table = (await blind.sampler.localTable())!
    assert.deepEqual(table.rows.map((r) => r.start), [null, null, null, null])
    assert.equal(table.rows[0]!.mem, 3_204 * 4_096, 'the rest is still read')
  })

  test('one reading is shared by everyone who asks while it runs', async () => {
    const pc = desktop()
    let open: () => void = () => undefined
    pc.state.gate = new Promise<void>((resolve) => {
      open = resolve
    })
    const a = pc.sampler.localTable()
    const b = pc.sampler.publishTable()
    const c = pc.sampler.localTable()
    await flush()
    assert.equal(pc.state.lists, 1)
    open()
    const [ta, tb, tc] = await Promise.all([a, b, c])
    assert.ok(ta)
    assert.equal(ta, tb)
    assert.equal(ta, tc)
    assert.equal(pc.state.lists, 1)
    assert.equal(pc.time.pending, 0)
  })

  test('thousands of processes are read 64 at a time, and no more than the cap are kept', async () => {
    const pc = fakeProc()
    for (let pid = 100; pid < 100 + MAX_PROCESSES + 300; pid += 1) pc.put({ pid, comm: `worker-${pid}`, ppid: 1, utime: pid, start: pid, rss: 100 })
    // Kernel threads among them do not count towards the cap.
    for (let pid = 3; pid < 60; pid += 1) pc.put({ pid, comm: `kworker/${pid}`, ppid: 2, utime: 0, start: 3, vsize: 0, rss: 0 })
    const table = (await pc.sampler.localTable())!
    assert.equal(table.total, MAX_PROCESSES)
    assert.equal(table.rows.length, MAX_PROCESSES)
    assert.equal(table.rows[0]!.pid, 100)
    assert.equal(pc.state.maxInFlight, READ_BATCH)
    assert.ok(pc.state.maxLinksInFlight <= READ_BATCH, 'the link reads take no place of their own')
    assert.equal(pc.state.links.length, pc.state.owners.length, 'one link and one owner for each process kept or tried')
    assert.ok(pc.state.reads.length < MAX_PROCESSES + 300, 'it stops reading once it has enough')
  })

  test('a reading that does not finish is answered as failed, and no second one starts beside it', async () => {
    const pc = desktop()
    let open: () => void = () => undefined
    pc.state.gate = new Promise<void>((resolve) => {
      open = resolve
    })
    let first: unknown = 'waiting'
    void pc.sampler.localTable().then((table) => {
      first = table
    })
    pc.time.advance(READ_DEADLINE_MS - 1)
    await flush()
    assert.equal(first, 'waiting')
    pc.time.advance(1)
    await flush()
    assert.equal(first, null)
    let second: unknown = 'waiting'
    void pc.sampler.publishTable().then((table) => {
      second = table
    })
    await flush()
    assert.equal(pc.state.lists, 1, 'the one under way is joined')
    pc.state.gate = null
    open()
    await flush()
    assert.notEqual(second, null)
    assert.equal(second, pc.sampler.latestTable())
    assert.equal(pc.time.pending, 0)
  })

  test('/proc that cannot be read, or holds no process, gives no table', async () => {
    const pc = desktop()
    pc.state.listable = false
    assert.equal(await pc.sampler.localTable(), null)
    assert.equal(pc.sampler.latestTable(), null)
    const empty = fakeProc()
    assert.equal(await empty.sampler.publishTable(), null)
    const onlyKernel = fakeProc()
    onlyKernel.put({ pid: 2, comm: 'kthreadd', ppid: 0, utime: 0, start: 2, vsize: 0, rss: 0 })
    assert.equal(await onlyKernel.sampler.localTable(), null)
  })

  test('reads that throw give no table, or a table without what they would have told', async () => {
    const boom = async (): Promise<never> => {
      throw new Error('EACCES')
    }
    const time = new FakeTime()
    const dead = new LinuxProcessSampler({ readFile: boom, readBytes: boom, readDir: boom, statUid: boom, readLink: boom, timers: time, mono: time.now, wall: time.now, platform: 'linux' })
    assert.equal(await dead.localTable(), null)
    assert.equal(time.pending, 0)
    const text = statLine({ pid: 7, comm: 'lonely', ppid: 1, utime: 5, start: 100, rss: 10 })
    const partly = new LinuxProcessSampler({
      readFile: async (path) => {
        if (path === '/proc/7/stat') return text
        throw new Error('EACCES')
      },
      readBytes: boom,
      readDir: async () => ['7'],
      statUid: boom,
      readLink: boom,
      timers: time,
      mono: time.now,
      wall: time.now,
      platform: 'linux',
      cores: () => {
        throw new Error('no')
      }
    })
    assert.deepEqual((await partly.localTable())!.rows, [{ pid: 7, ppid: 1, name: 'lonely', user: null, cpu: null, mem: 10 * FALLBACK_PAGE_BYTES, energy: null, start: null }])
  })

  test('nothing at all is read off Linux; setPublishing and stop have nothing to do', async () => {
    const mac = desktop('darwin')
    assert.equal(mac.sampler.supported, false)
    mac.sampler.setPublishing(true)
    assert.equal(await mac.sampler.localTable(), null)
    assert.equal(await mac.sampler.publishTable(), null)
    assert.equal(mac.sampler.latestTable(), null)
    mac.sampler.stop()
    assert.deepEqual([mac.state.reads.length, mac.state.lists, mac.state.owners.length, mac.state.links.length, mac.time.pending], [0, 0, 0, 0, 0])
    const pc = desktop()
    // The monitor takes it as it takes a Mac's sampler.
    const source: ProcessSource = pc.sampler
    assert.equal(source.supported, true)
    pc.sampler.setPublishing(true)
    pc.sampler.setPublishing(false)
    assert.deepEqual([pc.state.reads.length, pc.state.lists, pc.time.pending], [0, 0, 0], 'publishing starts nothing')
    const table = await pc.sampler.publishTable()
    pc.sampler.stop()
    assert.equal(pc.sampler.latestTable(), table)
    // After a pause the list is read fresh, not served from before it.
    pc.time.advance(5 * 60_000)
    assert.notEqual(await pc.sampler.localTable(), table)
    assert.equal(pc.state.lists, 2)
  })
})
