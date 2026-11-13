// This Windows computer's processes (src/win-processes.ts): the answer's parser, the table and
// the sampler, with invented answers from a fake PowerShell host and a fake clock.
import { assert, describe, test } from 'orca/testing'
import type { ProcessSource } from '../src/monitor.ts'
import { LIST_CACHE_MS, MAX_PROCESSES } from '../src/processes.ts'
import { buildWindowsTable, EMPTY_LIMIT, parseProcAnswer, RETRY_BLOCKED_MS, startSeconds, windowsProcessName, WindowsProcessSampler, type WindowsProcessReading } from '../src/win-processes.ts'
import { FakeTime, flush } from './helpers.ts'

/** A Windows file time (100 ns units since 1601) for a time in epoch seconds. */
const fileTime = (epochSeconds: number): number => (epochSeconds + 11_644_473_600) * 10_000_000
const NOV_12 = Date.UTC(2026, 10, 12, 9, 30, 5) / 1000
/** An answer as PowerShell writes it: JSON text, so numbers past 2^53 are rounded as they will be. */
const wire = (t: string, rows: string[]): unknown => JSON.parse(`{"t":${t},"p":[${rows.join(',')}]}`)

describe('the answer', () => {
  test('names: the instance number and the pid Windows may add come off, nothing else', () => {
    assert.equal(windowsProcessName('chrome#12', 4242), 'chrome')
    assert.equal(windowsProcessName('chrome', 4242), 'chrome')
    assert.equal(windowsProcessName('chrome:4242', 4242), 'chrome', 'the newer counter set')
    assert.equal(windowsProcessName('chrome_4242', 4242), 'chrome', 'ProcessNameFormat 2')
    assert.equal(windowsProcessName('worker_812', 4242), 'worker_812', 'not its own pid')
    assert.equal(windowsProcessName('report:2026', 7), 'report:2026')
    assert.equal(windowsProcessName('c#', 7), 'c#')
    assert.equal(windowsProcessName('Memory Compression', 2924), 'Memory Compression')
    assert.equal(windowsProcessName('_4242', 4242), '_4242', 'never down to nothing')
    assert.equal(windowsProcessName('evil‮exe', 7), 'evil�exe')
    assert.equal(windowsProcessName('a\u0007b', 7), 'a b')
    assert.equal(windowsProcessName('n'.repeat(500), 7).length, 128)
    assert.equal(windowsProcessName('café-tool#1', 7), 'café-tool')
  })

  test('rows: pid, parent, name, CPU time, memory and start; a row out of shape is skipped', () => {
    const started = String(fileTime(NOV_12))
    const answer = parseProcAnswer(
      wire('134389494050000000', [
        `[4,0,"System",9000000000,180224,${started}]`,
        `[4242,812,"example-tool#3",125000000,52428800,${started}]`,
        `[4242,812,"duplicate",1,1,${started}]`,
        `[0,0,"Idle",1,1,${started}]`,
        `[12.5,1,"half",1,1,${started}]`,
        `[5000000000,1,"too-large",1,1,${started}]`,
        `["77",1,"text-pid",1,1,${started}]`,
        `[78,1,null,1,1,${started}]`,
        `[79,1,"",1,1,${started}]`,
        `[80,1,"short"]`,
        `"not a row"`,
        `[81,-1,"odd-figures",1e300,1.5,0]`,
        `[82,1,"past-2-53",9007199254740993,12345678901234567890,-5]`
      ])
    )!
    assert.deepEqual(answer.rows.map((r) => r.pid), [4, 4242, 81, 82])
    assert.deepEqual(answer.rows[1], { pid: 4242, ppid: 812, name: 'example-tool', cpuTicks: 125_000_000, mem: 52_428_800, started: fileTime(NOV_12) })
    assert.deepEqual(answer.rows[2], { pid: 81, ppid: null, name: 'odd-figures', cpuTicks: null, mem: null, started: null }, 'a figure out of shape is left out, the row stays')
    assert.deepEqual([answer.rows[3]!.cpuTicks, answer.rows[3]!.mem, answer.rows[3]!.started], [null, null, null], 'not a number a double holds exactly')
    assert.equal(answer.t, 134_389_494_050_000_000)
    assert.equal('path' in answer.rows[0]!, false, 'no path is kept')
  })

  test('answers out of shape, a lone row, and more rows than are kept', () => {
    assert.equal(parseProcAnswer(null), null, 'the read failed')
    assert.equal(parseProcAnswer([]), null)
    assert.equal(parseProcAnswer('{}'), null)
    assert.equal(parseProcAnswer({ p: [] }), null, 'no time stamp')
    assert.equal(parseProcAnswer({ t: 0, p: [] }), null)
    assert.equal(parseProcAnswer({ t: '5', p: [] }), null)
    assert.equal(parseProcAnswer({ t: 5, p: { 0: [] } }), null)
    assert.deepEqual(parseProcAnswer({ t: 5, p: [] }), { t: 5, rows: [] })
    // PowerShell's own JSON writer would hand a list of one row back as the row.
    assert.deepEqual(parseProcAnswer({ t: 5, p: [812, 4, 'lone', 10, 20, 30] })?.rows, [{ pid: 812, ppid: 4, name: 'lone', cpuTicks: 10, mem: 20, started: 30 }])
    const many = Array.from({ length: MAX_PROCESSES + 5 }, (_, i) => [i + 1, 0, `p${i}`, 1, 1, 1])
    assert.equal(parseProcAnswer({ t: 5, p: many })?.rows.length, MAX_PROCESSES)
  })

  test('start times: a file time to epoch seconds, the same every reading, or none', () => {
    const now = fileTime(NOV_12 + 3_600)
    assert.equal(startSeconds(fileTime(NOV_12), now), NOV_12)
    // Past 2^53 a double steps by 16 (1.6 µs): the digits PowerShell writes come back rounded, to
    // the same number each time, and the second is the same.
    const written = JSON.parse('134389494051234567') as number
    assert.equal(Number.isSafeInteger(written), false)
    assert.equal(written, JSON.parse('134389494051234567'))
    assert.equal(startSeconds(written, now), NOV_12)
    assert.equal(startSeconds(null, now), null)
    assert.equal(startSeconds(5_000_000_000, now), null, 'before 1970: not a file time at all')
    assert.equal(startSeconds(now + 2 * 86_400 * 10_000_000, now), null, 'after the reading')
    assert.equal(startSeconds(now + 10_000_000, now), NOV_12 + 3_601, 'a clock set back a second in between is let through')
  })
})

const T0 = fileTime(NOV_12 + 3_600)
/** A reading `ms` after T0 by the counters' own time stamp; rows are [pid, cpu ms, started (epoch seconds, or null), mem]. */
const reading = (ms: number, rows: [number, number | null, number | null, number?][], wallAt = 1_800_000_000_000 + ms): WindowsProcessReading => ({
  at: ms,
  wallAt,
  t: T0 + ms * 10_000,
  rows: rows.map(([pid, cpuMs, started, mem]) => ({ pid, ppid: 4, name: `p${pid}`, cpuTicks: cpuMs === null ? null : cpuMs * 10_000, mem: mem ?? null, started: started === null ? null : fileTime(started) }))
})

describe('the table', () => {
  test('CPU % of one core from two readings, by the answers own time stamps', () => {
    const before = reading(0, [[10, 10_000, NOV_12], [11, 5_000, NOV_12]])
    const now = reading(3_000, [[10, 13_000, NOV_12, 1_000_000], [11, 5_000, NOV_12], [12, 1_500, NOV_12 + 3_601]])
    const table = buildWindowsTable(now, before, 8)
    const byPid = new Map(table.rows.map((r) => [r.pid, r]))
    assert.equal(byPid.get(10)!.cpu, 100, '3 s of CPU in 3 s')
    assert.equal(byPid.get(11)!.cpu, 0)
    assert.equal(byPid.get(12)!.cpu, 50, 'new: its 1.5 s of CPU over the 3 s window, not over its shorter life')
    assert.deepEqual(byPid.get(10), { pid: 10, ppid: 4, name: 'p10', user: null, cpu: 100, mem: 1_000_000, energy: null, start: NOV_12 })
    assert.equal(byPid.get(11)!.mem, null)
    assert.deepEqual([table.takenAt, table.cpuWindowMs, table.memAgeMs, table.energyWindowMs, table.total], [1_800_000_003_000, 3_000, 0, null, 3])
    // The window is the stamps', whatever Node's clocks say.
    const skewed = buildWindowsTable({ ...now, at: 999_999, wallAt: 5 }, { ...before, at: 999_998, wallAt: 4 }, 8)
    assert.deepEqual([skewed.cpuWindowMs, skewed.rows[0]!.cpu], [3_000, 100])
    const fine = buildWindowsTable(reading(7_000, [[10, 17_254, NOV_12]]), before, 8)
    assert.equal(fine.rows[0]!.cpu, 103.6, '7.254 s of CPU in 7 s, to one decimal')
  })

  test('a reused pid: its own CPU time over the window, nothing across the two processes', () => {
    const before = reading(0, [[10, 900_000, NOV_12]])
    const table = buildWindowsTable(reading(3_000, [[10, 300, NOV_12 + 3_602]]), before, 8)
    assert.equal(table.rows[0]!.cpu, 10)
    assert.equal(table.rows[0]!.start, NOV_12 + 3_602)
  })

  test('no figure where there cannot be one', () => {
    const before = reading(0, [[10, 5_000, NOV_12], [11, 5_000, null], [12, null, NOV_12], [13, 5_000, NOV_12], [14, 5_000, NOV_12]])
    const now = reading(3_000, [[10, 4_000, NOV_12], [11, 6_000, null], [12, 6_000, NOV_12], [13, null, NOV_12], [14, 6_000, null]])
    const cpu = new Map(buildWindowsTable(now, before, 8).rows.map((r) => [r.pid, r.cpu]))
    assert.equal(cpu.get(10), null, 'CPU time went back')
    assert.equal(cpu.get(11), null, 'no start time either side: the pid may have changed hands')
    assert.equal(cpu.get(12), null, 'no CPU time before')
    assert.equal(cpu.get(13), null, 'no CPU time now')
    assert.equal(cpu.get(14), null, 'a start time gone missing')
    const first = buildWindowsTable(now, null, 8)
    assert.deepEqual([first.cpuWindowMs, first.rows[0]!.cpu], [null, null], 'no reading before')
    const close = buildWindowsTable(reading(100, [[10, 5_050, NOV_12]]), before, 8)
    assert.deepEqual([close.cpuWindowMs, close.rows[0]!.cpu], [null, null], 'readings too close together')
    const back = buildWindowsTable(reading(-60_000, [[10, 5_050, NOV_12]]), before, 8)
    assert.deepEqual([back.cpuWindowMs, back.rows[0]!.cpu], [null, null], 'the clock was set back')
  })

  test('CPU is never more than every core, and start times out of shape are left out', () => {
    const before = reading(0, [[10, 0, NOV_12]])
    assert.equal(buildWindowsTable(reading(1_000, [[10, 9_000_000, NOV_12]]), before, 2).rows[0]!.cpu, 200)
    assert.equal(buildWindowsTable(reading(1_000, [[10, 9_000_000, NOV_12]]), before).rows[0]!.cpu, 100, 'cores unknown')
    const odd = buildWindowsTable(reading(0, [[10, 1, NOV_12 + 86_400 * 30], [11, 1, null]]), null)
    assert.deepEqual(odd.rows.map((r) => r.start), [null, null])
  })
})

const row = (pid: number, name: string, cpuMs: number, mem: number, started = NOV_12): string => `[${pid},4,"${name}",${cpuMs * 10_000},${mem},${fileTime(started)}]`

/** A scripted PowerShell host: what `proc` answers now, with a clock that only moves when told. */
function setup(platform = 'win32') {
  const time = new FakeTime()
  const state = { answer: null as unknown, hold: false, throws: false }
  const asked: { command: string; timeoutMs: number }[] = []
  let release: (() => void)[] = []
  const host = {
    request: async (command: string, timeoutMs: number): Promise<unknown> => {
      asked.push({ command, timeoutMs })
      if (state.throws) throw new Error('gone')
      const answer = state.answer
      if (state.hold) await new Promise<void>((resolve) => release.push(resolve))
      return answer
    }
  }
  const sampler = new WindowsProcessSampler({ host, mono: time.now, wall: time.now, platform, cores: () => 4 })
  /** PowerShell's stamp `ms` after T0, as it would be written. */
  const at = (ms: number, rows: string[]) => (state.answer = wire(String(T0 + ms * 10_000), rows))
  const letGo = () => {
    const waiting = release
    release = []
    for (const resolve of waiting) resolve()
  }
  return { time, state, asked, sampler, at, letGo }
}

describe('the Windows process sampler', () => {
  test('a list is one request; one asked for again soon is the same list', async () => {
    const t = setup()
    assert.equal(t.sampler.supported, true)
    assert.equal(t.sampler.latestTable(), null)
    t.at(0, [row(4, 'System', 60_000, 180_224), row(4242, 'example-tool#1', 12_500, 52_428_800)])
    const table = (await t.sampler.localTable())!
    assert.deepEqual(t.asked.map((a) => a.command), ['proc'])
    assert.deepEqual(table.rows[1], { pid: 4242, ppid: 4, name: 'example-tool', user: null, cpu: null, mem: 52_428_800, energy: null, start: NOV_12 })
    assert.deepEqual([table.takenAt, table.cpuWindowMs, table.memAgeMs, table.energyWindowMs, table.total], [t.time.now(), null, 0, null, 2])
    assert.equal(t.sampler.latestTable(), table)
    t.time.advance(LIST_CACHE_MS - 1)
    assert.equal(await t.sampler.localTable(), table)
    assert.equal(await t.sampler.publishTable(), table)
    assert.equal(t.asked.length, 1)
    // After the cache, a new reading, and CPU % over the time between PowerShell's two stamps:
    // 7 s here, though Node saw 2 s go by.
    t.time.advance(1)
    t.at(7_000, [row(4, 'System', 60_000, 180_224), row(4242, 'example-tool#1', 19_754, 52_428_800)])
    const second = (await t.sampler.publishTable())!
    assert.equal(t.asked.length, 2)
    assert.deepEqual([second.cpuWindowMs, second.rows[0]!.cpu, second.rows[1]!.cpu], [7_000, 0, 103.6])
    assert.deepEqual(table.rows.map((r) => [r.pid, r.start]), second.rows.map((r) => [r.pid, r.start]), 'a process keeps its start across readings')
  })

  test('callers at the same time share one reading and its table', async () => {
    const t = setup()
    t.state.hold = true
    t.at(0, [row(4242, 'example-tool', 12_500, 1)])
    const a = t.sampler.localTable()
    const b = t.sampler.publishTable()
    await flush()
    assert.equal(t.asked.length, 1)
    t.letGo()
    const [first, second] = [await a, await b]
    assert.ok(first)
    assert.equal(first, second)
  })

  test('no answer gives no table, and the last one read is still there', async () => {
    const t = setup()
    t.at(0, [row(4242, 'example-tool', 12_500, 1)])
    const table = await t.sampler.publishTable()
    t.time.advance(30_000)
    t.state.answer = null
    assert.equal(await t.sampler.publishTable(), null)
    t.state.answer = wire(String(T0), [])
    assert.equal(await t.sampler.publishTable(), null, 'a list of nothing is no list')
    t.state.throws = true
    assert.equal(await t.sampler.localTable(), null)
    assert.equal(t.sampler.latestTable(), table)
    // The next one that answers is worked out against the last that did.
    t.state.throws = false
    t.at(30_000, [row(4242, 'example-tool', 27_500, 1)])
    assert.deepEqual([(await t.sampler.publishTable())?.cpuWindowMs, t.sampler.latestTable()?.rows[0]?.cpu], [30_000, 50])
  })

  test('nothing is asked off Windows; publishing and stop have nothing to do', async () => {
    const off = setup('darwin')
    off.at(0, [row(4242, 'example-tool', 12_500, 1)])
    // What the monitor asks of a process source, checked by the compiler.
    const source: ProcessSource = off.sampler
    assert.equal(source.supported, false)
    off.sampler.setPublishing(true)
    assert.equal(await off.sampler.localTable(), null)
    assert.equal(await off.sampler.publishTable(), null)
    assert.equal(off.asked.length, 0)
    const t = setup()
    t.at(0, [row(4242, 'example-tool', 12_500, 1)])
    t.sampler.setPublishing(true)
    t.sampler.setPublishing(false)
    assert.equal(t.asked.length, 0, 'nothing runs until a list is asked for')
    t.sampler.stop()
    assert.ok(await t.sampler.localTable(), 'a list asked for after a stop is still read')
    assert.equal(t.time.pending, 0, 'no timer of its own')
  })

  test('a pid that changed hands between two readings is a new process', async () => {
    const t = setup()
    t.at(0, [row(4242, 'old-tool', 900_000, 1, NOV_12)])
    await t.sampler.publishTable()
    t.time.advance(3_000)
    t.at(3_000, [row(4242, 'new-tool', 300, 1, NOV_12 + 3_602)])
    const table = (await t.sampler.publishTable())!
    assert.deepEqual([table.rows[0]!.name, table.rows[0]!.cpu, table.rows[0]!.start], ['new-tool', 10, NOV_12 + 3_602])
  })
})

test('the sampler says when PowerShell cannot run the reader, as the host does', () => {
  const answering = new WindowsProcessSampler({ host: { request: async () => null, unavailable: false }, platform: 'win32' })
  assert.equal(answering.unavailable(), false)
  const blocked = new WindowsProcessSampler({ host: { request: async () => null, unavailable: true }, platform: 'win32' })
  assert.equal(blocked.unavailable(), true)
  // A host given without that word (a test's fake) is taken to work.
  assert.equal(new WindowsProcessSampler({ host: { request: async () => null }, platform: 'win32' }).unavailable(), false)
})

test('five readings in a row without a list: the counters cannot be read here, said as that and tried again in an hour', async () => {
  const time = new FakeTime()
  let answer: unknown = null
  let asked = 0
  const sampler = new WindowsProcessSampler({
    host: {
      request: async () => {
        asked += 1
        return answer
      },
      unavailable: false
    },
    mono: time.now,
    wall: time.now,
    platform: 'win32'
  })
  for (let i = 0; i < EMPTY_LIMIT; i += 1) {
    assert.equal(sampler.unavailable(), false)
    assert.equal(await sampler.localTable(), null)
    time.advance(LIST_CACHE_MS)
  }
  assert.equal(sampler.unavailable(), true)
  time.advance(RETRY_BLOCKED_MS - LIST_CACHE_MS - 1)
  assert.equal(sampler.unavailable(), true)
  time.advance(1)
  assert.equal(sampler.unavailable(), false, 'its hour is up')
  // Still nothing: back for another hour after one try.
  const before = asked
  assert.equal(await sampler.localTable(), null)
  assert.equal(asked, before + 1)
  assert.equal(sampler.unavailable(), true)
  // The day the counters answer, it is a list again.
  time.advance(RETRY_BLOCKED_MS)
  answer = { t: 133_000_000_000_000_000, p: [[4, 0, 'System', 10, 2_000_000, 132_999_000_000_000_000]] }
  assert.equal((await sampler.localTable())?.rows.length, 1)
  assert.equal(sampler.unavailable(), false)
})

test('a request PowerShell never answered is not a reading without a list', async () => {
  const time = new FakeTime()
  let asked = 0
  let result: { answered: boolean; value: unknown } = { answered: false, value: null }
  const sampler = new WindowsProcessSampler({
    host: {
      request: async () => null,
      ask: async () => {
        asked += 1
        return result
      },
      unavailable: false
    },
    mono: time.now,
    wall: time.now,
    platform: 'win32'
  })
  // PowerShell pausing before a restart, or killed for another command's stall: nothing was asked.
  for (let i = 0; i < EMPTY_LIMIT * 3; i += 1) {
    assert.equal(await sampler.localTable(), null)
    time.advance(LIST_CACHE_MS)
  }
  assert.equal(sampler.unavailable(), false, 'none of those says the counters cannot be read')
  // Answered, and no list: those count.
  result = { answered: true, value: null }
  for (let i = 0; i < EMPTY_LIMIT; i += 1) {
    await sampler.localTable()
    time.advance(LIST_CACHE_MS)
  }
  assert.equal(sampler.unavailable(), true)
  // While it is taken to be unreadable, nothing is asked, by the panel or the 30 s beat.
  const before = asked
  for (let i = 0; i < 20; i += 1) {
    assert.equal(await sampler.publishTable(), null)
    assert.equal(await sampler.localTable(), null)
    time.advance(30_000)
  }
  assert.equal(asked, before)
  assert.equal(sampler.unavailable(), true, 'and its hour is not pushed back by those')
  time.advance(RETRY_BLOCKED_MS)
  await sampler.localTable()
  assert.equal(asked, before + 1, 'one try once the hour is up')
})
