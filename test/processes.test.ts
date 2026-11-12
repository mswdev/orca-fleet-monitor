// This Mac's processes (src/processes.ts): ps and top parsers, the table, the top stream's life
// and the sampler, with invented output, a fake `top` child and a fake clock.
import { assert, describe, test } from 'orca/testing'
import type { ExecFile } from '../src/mac-memory.ts'
import {
  buildTable,
  FAST_TOP_LINGER_MS,
  largestProcess,
  parseCpuTime,
  parsePs,
  parseTopMem,
  parseTopSample,
  processName,
  ProcessSampler,
  selectTop,
  TopStream,
  type PsReading,
  type SpawnTop,
  type TopChild,
  type TopSample
} from '../src/processes.ts'
import { FakeTime, flush } from './helpers.ts'

const psLine = (pid: number, ppid: number, user: string, time: string, start: string, path: string) =>
  `${String(pid).padStart(5)} ${String(ppid).padStart(5)}   501 ${user.padEnd(16)} ${time.padStart(10)} ${start}     ${path}`

describe('ps', () => {
  test('cumulative CPU time in every shape ps prints', () => {
    assert.equal(parseCpuTime('0:00.52'), 52)
    assert.equal(parseCpuTime('2288:59.69'), (2288 * 60 + 59) * 100 + 69)
    assert.equal(parseCpuTime('01:02:03.4'), 3723 * 100 + 40)
    assert.equal(parseCpuTime('2-01:00:00.00'), 49 * 3600 * 100)
    assert.equal(parseCpuTime('5:07'), 307 * 100)
    assert.equal(parseCpuTime('1:75.00'), null)
    assert.equal(parseCpuTime('2-03.00'), null)
    assert.equal(parseCpuTime('abc'), null)
  })

  test('rows: the kernel short name (spaces kept, trailing padding gone) and a UTC start time', () => {
    const text = [
      psLine(1, 0, 'root', '115:04.93', 'Wed Nov  4 13:01:11 2026', 'launchd         '),
      psLine(4242, 1, 'example', '0:12.50', 'Thu Nov 12 09:30:05 2026', 'Example Helper ('),
      psLine(4242, 1, 'example', '0:12.50', 'Thu Nov 12 09:30:05 2026', 'duplicate'),
      'garbage line',
      psLine(77, 1, 'example', 'x:yy', 'Thu Nov 12 09:30:05 2026', 'bad-time'),
      psLine(78, 1, 'example', '0:01.00', 'Thu Foo 12 09:30:05 2026', 'bad-month')
    ].join('\n')
    const rows = parsePs(text)!
    assert.deepEqual(rows.map((r) => r.pid), [1, 4242])
    assert.equal(rows[1]!.name, 'Example Helper (')
    assert.equal(rows[1]!.user, 'example')
    assert.equal(rows[1]!.cpuCs, 1_250)
    assert.equal(rows[1]!.start, Date.UTC(2026, 10, 12, 9, 30, 5) / 1000, 'ps prints lstart in UTC (TZ=UTC)')
    assert.equal(rows[0]!.name, 'launchd')
    assert.equal('path' in rows[0]!, false, 'no path is kept')
  })

  test('names: bidirectional and control characters neutralised, length bounded, kept whole', () => {
    assert.equal(processName('evil\u202Eexe'), 'evil\uFFFDexe')
    assert.equal(processName('a\u0007b'), 'a b')
    assert.equal(processName('n'.repeat(500)).length, 128)
    assert.equal(processName('a/b'), 'a/b', 'a short name is not a path to cut')
    assert.equal(processName('café-tool'), 'café-tool')
    assert.equal(parsePs(7), null)
  })
})

describe('top', () => {
  test('MEM in every unit top prints', () => {
    assert.equal(parseTopMem('2768K'), 2768 * 1024)
    assert.equal(parseTopMem('473M'), 473 * 2 ** 20)
    assert.equal(parseTopMem('5204M+'), 5204 * 2 ** 20)
    assert.equal(parseTopMem('12G'), 12 * 2 ** 30)
    assert.equal(parseTopMem('900B'), 900)
    assert.equal(parseTopMem('N/A'), null)
  })

  test('one sample: rows after the header, lines out of shape skipped', () => {
    const rows = parseTopSample('Processes: 3 total\nLoad Avg: 1\n\nPID    MEM    POWER\n0      17M    0.0\n406    5204M  12.3\nxyz    1M     0.0\n77     bad    zz\n')!
    assert.deepEqual([...rows.keys()], [0, 406, 77])
    assert.deepEqual(rows.get(406), { mem: 5204 * 2 ** 20, power: 12.3 })
    assert.deepEqual(rows.get(77), { mem: null, power: null })
    assert.equal(parseTopSample('Processes: 1 total\nno header here'), null)
  })
})

const sample = (wallAt: number, index: number, rows: [number, number | null, number | null][]): TopSample => ({ at: wallAt, wallAt, index, intervalMs: 3_000, rows: new Map(rows.map(([pid, mem, power]) => [pid, { mem, power }])) })
const reading = (wallAt: number, rows: [number, number, number][]): PsReading => ({
  at: wallAt,
  wallAt,
  rows: rows.map(([pid, cpuCs, start]) => ({ pid, ppid: 1, uid: 501, user: 'example', cpuCs, start, name: `p${pid}` }))
})

describe('the table', () => {
  test('CPU % from two readings, footprint and energy from top', () => {
    const before = reading(100_000, [[10, 1_000, 50], [11, 500, 50]])
    const now = reading(103_000, [[10, 1_300, 50], [11, 500, 50], [12, 150, 101]])
    const table = buildTable(now, before, sample(102_000, 2, [[10, 1_000_000, 4.5], [11, 2_000, 0], [0, 17_000_000, 1]]), 8)
    const byPid = new Map(table.rows.map((r) => [r.pid, r]))
    assert.equal(byPid.get(10)!.cpu, 100, '3 s of CPU in 3 s')
    assert.equal(byPid.get(11)!.cpu, 0)
    assert.equal(byPid.get(12)!.cpu, 50, 'started a second into the window: 1.5 s of CPU over the 3 s window, as Activity Monitor counts it')
    assert.equal(byPid.get(10)!.mem, 1_000_000)
    assert.equal(byPid.get(12)!.mem, null, 'not in top yet')
    assert.equal(byPid.get(10)!.energy, 4.5)
    assert.equal(byPid.get(0)!.name, 'kernel_task', 'the kernel, which ps does not list')
    assert.deepEqual([table.cpuWindowMs, table.memAgeMs, table.energyWindowMs, table.total], [3_000, 1_000, 3_000, 4])
  })

  test('a reused pid: no CPU across it, and no footprint from before it started', () => {
    const before = reading(100_000, [[10, 90_000, 50]])
    const now = reading(103_000, [[10, 30, 102]])
    const table = buildTable(now, before, sample(101_000, 3, [[10, 9_000_000, 2]]))
    assert.equal(table.rows[0]!.cpu, 10, 'its own CPU time over the window, not over its life')
    assert.equal(table.rows[0]!.mem, null, 'top saw the old process')
  })

  test('the first top sample has no energy; no previous reading has no CPU; CPU is bounded', () => {
    const t = buildTable(reading(103_000, [[10, 9_999_999, 50]]), null, sample(102_000, 0, [[10, 5, 9]]))
    assert.deepEqual([t.rows[0]!.cpu, t.rows[0]!.mem, t.rows[0]!.energy, t.energyWindowMs], [null, 5, null, null])
    const capped = buildTable(reading(101_000, [[10, 9_000_000, 50]]), reading(100_000, [[10, 0, 50]]), null, 2)
    assert.equal(capped.rows[0]!.cpu, 200, 'never more than every core')
    const close = buildTable(reading(100_100, [[10, 5, 50]]), reading(100_000, [[10, 0, 50]]), null)
    assert.equal(close.cpuWindowMs, null, 'readings too close together give no CPU')
  })

  test('the top list: 40 by memory, then the busiest by CPU, and the largest', () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ pid: i + 2, name: `p${i}`, mem: i < 90 ? (i + 1) * 1_000 : null, cpu: i % 10 === 0 ? 50 + i : 0 }))
    const top = selectTop(rows, 40, 20)
    assert.equal(top.length, 40 + 6, 'the CPU-busy ones not already in')
    assert.equal(top[0]!.mem, 90_000)
    assert.ok(top.some((r) => r.pid === 2 && r.cpu === 50), 'small but busy')
    assert.deepEqual(largestProcess(rows), { pid: 91, name: 'p89', mem: 90_000 })
    assert.equal(largestProcess([{ pid: 1, name: 'x', mem: null }]), null)
  })
})

/** A fake `top`: records each start, lets a test write samples and end it. */
function fakeTop() {
  const children: { args: readonly string[]; killed: string | null; write(text: string): void; exit(): void }[] = []
  const spawnTop: SpawnTop = (_file, args) => {
    const listeners: Record<string, ((...a: unknown[]) => void)[]> = { data: [], exit: [], error: [] }
    const record = {
      args,
      killed: null as string | null,
      write: (text: string) => listeners.data!.forEach((fn) => fn(text)),
      exit: () => {
        record.killed = 'exited'
        listeners.exit!.forEach((fn) => fn(0, null))
      }
    }
    children.push(record)
    const child: TopChild = {
      pid: 1000 + children.length,
      stdout: { on: (_e, fn) => listeners.data!.push(fn as (...a: unknown[]) => void) },
      on: (event: string, fn: (...a: never[]) => void) => listeners[event]!.push(fn as (...a: unknown[]) => void),
      kill: (signal) => {
        record.killed = signal ?? 'SIGTERM'
        return true
      }
    } as TopChild
    return child
  }
  const running = () => children.filter((c) => c.killed === null)
  return { children, spawnTop, running }
}
const topText = (rows: string) => `Processes: 2 total\n\nPID    MEM    POWER\n${rows}\n`

describe('the top stream', () => {
  test('a sample counts once top goes quiet; stop kills the child', async () => {
    const time = new FakeTime()
    const top = fakeTop()
    const stream = new TopStream(3, { spawnTop: top.spawnTop, timers: time, mono: time.now, wall: time.now })
    stream.start()
    stream.start()
    assert.equal(top.children.length, 1, 'started once')
    assert.deepEqual(top.children[0]!.args, ['-l', '0', '-s', '3', '-stats', 'pid,mem,power'])
    const next = stream.nextSample(5_000)
    top.children[0]!.write(topText('10     5M     0.0'))
    assert.equal(stream.latest(), null, 'not until quiet')
    time.advance(200)
    const first = await next
    assert.equal(first?.index, 0)
    assert.equal(first?.rows.get(10)?.mem, 5 * 2 ** 20)
    top.children[0]!.write(topText('10     6M     1.5'))
    time.advance(200)
    assert.equal(stream.latest()?.index, 1)
    stream.stop()
    assert.equal(top.children[0]!.killed, 'SIGKILL')
    assert.equal(stream.active, false)
    assert.equal(await stream.nextSample(1_000), null, 'nothing comes once stopped')
  })

  test('it starts again, after a growing pause, when top ends or stalls; never once stopped', () => {
    const time = new FakeTime()
    const top = fakeTop()
    const stream = new TopStream(60, { spawnTop: top.spawnTop, timers: time, mono: time.now, wall: time.now })
    stream.start()
    top.children[0]!.exit()
    time.advance(4_999)
    assert.equal(top.children.length, 1)
    time.advance(1)
    assert.equal(top.children.length, 2, 'restarted after 5 s')
    top.children[1]!.exit()
    time.advance(9_999)
    assert.equal(top.children.length, 2)
    time.advance(1)
    assert.equal(top.children.length, 3, 'then after 10 s')
    // No sample for three intervals and 10 s: killed and started again.
    time.advance(3 * 60_000 + 10_000)
    assert.equal(top.children[2]!.killed, 'SIGKILL')
    stream.stop()
    time.advance(10 * 60_000)
    assert.equal(top.running().length, 0, 'no top left running')
  })

  test('output out of shape, or too much of it, ends the child', () => {
    const time = new FakeTime()
    const top = fakeTop()
    const stream = new TopStream(3, { spawnTop: top.spawnTop, timers: time, mono: time.now, wall: time.now })
    stream.start()
    top.children[0]!.write('Processes: 1 total\nthis is not top output\n')
    time.advance(200)
    assert.equal(top.children[0]!.killed, 'SIGKILL')
    time.advance(5_000)
    top.children[1]!.write('x'.repeat(5 * 1024 * 1024))
    assert.equal(top.children[1]!.killed, 'SIGKILL')
    stream.stop()
  })

  test('a spawn that throws is retried later', () => {
    const time = new FakeTime()
    let tries = 0
    const stream = new TopStream(3, { spawnTop: () => { tries += 1; throw new Error('EAGAIN') }, timers: time, mono: time.now, wall: time.now })
    stream.start()
    time.advance(5_000)
    assert.equal(tries, 2)
    stream.stop()
  })
})

describe('the process sampler', () => {
  const PS = [psLine(1, 0, 'root', '1:00.00', 'Wed Nov  4 13:01:11 2026', 'launchd'), psLine(4242, 1, 'example', '0:12.50', 'Thu Nov 12 09:30:05 2026', 'example-tool')].join('\n')

  function setup(platform = 'darwin') {
    const time = new FakeTime()
    const top = fakeTop()
    let psRuns = 0
    let psFails = false
    const exec: ExecFile = async () => {
      psRuns += 1
      return psFails ? { error: Object.assign(new Error('timed out'), { killed: true, code: null }), stdout: '' } : { error: null, stdout: PS }
    }
    const sampler = new ProcessSampler({ exec, spawnTop: top.spawnTop, timers: time, mono: time.now, wall: time.now, platform, cores: () => 4 })
    const streamArgs = (seconds: string) => top.children.filter((c) => c.args[3] === seconds)
    return { time, top, sampler, streamArgs, ps: () => psRuns, failPs: () => (psFails = true) }
  }

  test('a request starts the fast stream, waits for its first sample, and it stops 20 s after the last', async () => {
    const t = setup()
    const asked = t.sampler.localTable()
    assert.equal(t.streamArgs('5').length, 1, 'the fast stream started on the request')
    t.top.children[0]!.write(topText('4242   12M    0.0'))
    t.time.advance(200)
    const table = await asked
    assert.equal(table?.rows.find((r) => r.pid === 4242)?.mem, 12 * 2 ** 20)
    assert.equal(t.ps(), 1)
    // Within the cache, the same table; after it, a new ps.
    assert.equal(await t.sampler.localTable(), table)
    t.time.advance(2_000)
    await t.sampler.localTable()
    assert.equal(t.ps(), 2)
    assert.equal(t.sampler.latestTable()?.cpuWindowMs, 2_000)
    t.time.advance(FAST_TOP_LINGER_MS - 1)
    assert.equal(t.sampler.fast.active, true, 'still asked for recently')
    t.time.advance(1)
    assert.equal(t.sampler.fast.active, false, 'nobody asked for 20 s')
    t.time.advance(10 * 60_000)
    assert.equal(t.top.running().length, 0, 'and no top is left running')
  })

  test('the first request is answered without footprints if top never answers', async () => {
    const t = setup()
    const asked = t.sampler.localTable()
    t.time.advance(3_500)
    await flush()
    const table = await asked
    assert.equal(table?.rows[0]?.mem, null)
    t.sampler.stop()
  })

  test('publishing runs the slow stream; nothing at all runs off a Mac; stop ends every child', async () => {
    const t = setup()
    t.sampler.setPublishing(true)
    assert.equal(t.streamArgs('120').length, 1)
    t.sampler.setPublishing(false)
    assert.equal(t.streamArgs('120')[0]!.killed, 'SIGKILL')
    t.sampler.setPublishing(true)
    const fastAsked = t.sampler.localTable()
    t.time.advance(3_600)
    await fastAsked
    t.sampler.stop()
    assert.equal(t.top.running().length, 0, 'no top left running after stop')
    const off = setup('linux')
    off.sampler.setPublishing(true)
    assert.equal(await off.sampler.localTable(), null)
    assert.equal(await off.sampler.publishTable(), null)
    assert.deepEqual([off.top.children.length, off.ps()], [0, 0])
  })

  test('a ps that fails gives no table', async () => {
    const t = setup()
    t.failPs()
    assert.equal(await t.sampler.publishTable(), null)
    t.sampler.stop()
  })
})

describe('identity', () => {
  test('a process keeps the same start across readings: an absolute time, not one from elapsed time', async () => {
    // Two readings 7 s apart: CPU time moved, the start (ps's lstart) did not.
    const at = (cpu: string) => [psLine(4242, 1, 'example', cpu, 'Thu Nov 12 09:30:05 2026', 'example-tool'), psLine(51, 1, 'example', '0:00.01', 'Sat Feb 29 23:59:59 2028', 'leap')].join('\n')
    const [first, second] = [parsePs(at('0:12.50'))!, parsePs(at('0:19.75'))!]
    assert.deepEqual(first.map((r) => r.start), second.map((r) => r.start))
    assert.notEqual(first[0]!.cpuCs, second[0]!.cpuCs)
    // And through the sampler, which is what a panel's rows (pid + start) come from.
    const time = new FakeTime()
    let text = at('0:12.50')
    const sampler = new ProcessSampler({ exec: async () => ({ error: null, stdout: text }), spawnTop: fakeTop().spawnTop, timers: time, mono: time.now, wall: time.now, platform: 'darwin', cores: () => 2 })
    const a = await sampler.publishTable()
    time.advance(7_000)
    text = at('0:19.75')
    const b = await sampler.publishTable()
    assert.deepEqual(a!.rows.map((r) => [r.pid, r.start]), b!.rows.map((r) => [r.pid, r.start]))
    assert.equal(b!.rows[0]!.cpu, 103.6, '7.25 s of CPU in 7 s')
    sampler.stop()
  })
})

describe('after a pause', () => {
  test('a list asked for later is read fresh: the old table and its footprints are not served', async () => {
    const time = new FakeTime()
    const top = fakeTop()
    const PS = psLine(4242, 1, 'example', '0:12.50', 'Thu Nov 12 09:30:05 2026', 'example-tool')
    let reads = 0
    const sampler = new ProcessSampler({ exec: async () => ({ error: null, stdout: (reads++, PS) }), spawnTop: top.spawnTop, timers: time, mono: time.now, wall: time.now, platform: 'darwin' })
    const first = sampler.localTable()
    top.children[0]!.write(topText('4242   12M    0.0'))
    time.advance(200)
    assert.equal((await first)!.rows[0]!.mem, 12 * 2 ** 20)
    // The pause: every stream stops (and forgets its sample).
    sampler.stop()
    time.advance(5 * 60_000)
    const later = sampler.localTable()
    time.advance(3_500)
    await flush()
    const table = (await later)!
    assert.equal(reads, 2, 'ps read again')
    assert.equal(table.rows[0]!.mem, null, 'no footprint from before the pause')
    assert.equal(table.memAgeMs, null)
    sampler.stop()
  })
})
