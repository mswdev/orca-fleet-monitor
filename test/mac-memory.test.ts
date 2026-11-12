// The Mac memory reader (src/mac-memory.ts): vm_stat and sysctl parsing, Activity Monitor's
// formula, swap rates, and the reader with a fake exec, so no command runs. Every value is invented.
import { assert, describe, test } from 'orca/testing'
import {
  createRunBounded,
  MacMemoryReader,
  MAX_LINGERING,
  macMemoryOf,
  runBounded,
  parseSysctl,
  parseVmStat,
  SUSTAINED_SWAP,
  swapRates,
  SYSCTL_NAMES,
  SYSCTL_PATH,
  VM_STAT_PATH,
  type ExecFile,
  type ExecResult
} from '../src/mac-memory.ts'
import { fixtureText } from './helpers.ts'

const GIB = 2 ** 30
const SYSCTL_16G = '17179869184\ntotal = 8192.00M  used = 6348.25M  free = 1843.75M  (encrypted)\n2\n18\n'
const SYSCTL_8G = '8589934592\ntotal = 2.00G  used = 512.00M  free = 1.50G  (encrypted)\n1\n71\n'

describe('vm_stat', () => {
  test('16K pages (Apple silicon): every count, the page size from the header', () => {
    const vm = parseVmStat(fixtureText('vm_stat-16k.txt'))
    assert.ok(vm)
    assert.deepEqual(vm, {
      pageSize: 16_384,
      free: 20_000,
      active: 330_000,
      inactive: 320_000,
      speculative: 5_000,
      throttled: 0,
      wired: 120_000,
      purgeable: 3_000,
      fileBacked: 200_000,
      anonymous: 455_000,
      compressor: 250_000,
      swapIns: 1_000,
      swapOuts: 5_000
    })
  })

  test('4K pages (Intel)', () => {
    const vm = parseVmStat(fixtureText('vm_stat-4k.txt'))
    assert.equal(vm?.pageSize, 4_096)
    assert.equal(vm?.anonymous, 900_000)
    assert.equal(vm?.compressor, 150_000, '"Pages occupied by compressor", not "Pages stored in compressor"')
    assert.equal(vm?.purgeable, 20_000, '"Pages purgeable", not the "Pages purged" counter')
  })

  test('refuses output without a usable page size or a count the formula needs', () => {
    const text = fixtureText('vm_stat-16k.txt')
    assert.equal(parseVmStat(text.replace('(page size of 16384 bytes)', '')), null, 'no header')
    assert.equal(parseVmStat(text.replace('16384', '12000')), null, 'not a power of two')
    assert.equal(parseVmStat(text.replace('16384', '512')), null, 'too small')
    assert.equal(parseVmStat(text.replace(/^Anonymous pages:.*$/m, '')), null, 'no anonymous pages')
    assert.equal(parseVmStat(text.replace(/^Pages occupied by compressor:.*$/m, '')), null, 'no compressor line')
    assert.equal(parseVmStat(''), null)
    assert.equal(parseVmStat(42), null)
    assert.equal(parseVmStat('x'.repeat(70_000)), null, 'far longer than vm_stat prints')
  })

  test('purgeable and the swap counters are optional; the first copy of a line wins', () => {
    const text = fixtureText('vm_stat-16k.txt')
      .replace(/^Pages purgeable:.*$/m, '')
      .replace(/^Swapins:.*$/m, '')
      .replace(/^Swapouts:.*$/m, '')
    const vm = parseVmStat(`${text}\nPages free:   99.\n`)
    assert.deepEqual([vm?.purgeable, vm?.swapIns, vm?.swapOuts, vm?.free], [0, null, null, 20_000])
  })

  test('copes with CRLF line ends and odd spacing', () => {
    const text = fixtureText('vm_stat-4k.txt').replace(/\n/g, '\r\n').replace('Pages free:', '  Pages free:  ')
    assert.equal(parseVmStat(text)?.free, 100_000)
  })
})

describe('sysctl', () => {
  test('the four values in order, swap in megabytes or gigabytes', () => {
    assert.deepEqual(parseSysctl(SYSCTL_16G), {
      memsize: 16 * GIB,
      swapUsed: Math.round(6348.25 * 2 ** 20),
      swapTotal: 8192 * 2 ** 20,
      pressure: 'warning',
      availablePercent: 18
    })
    const g = parseSysctl(SYSCTL_8G)
    assert.deepEqual([g.swapTotal, g.swapUsed, g.pressure, g.availablePercent], [2 * GIB, 512 * 2 ** 20, 'normal', 71])
    assert.equal(parseSysctl('17179869184\ntotal = 0.00M  used = 0.00M  free = 0.00M  \n4\n3\n').pressure, 'critical')
    assert.equal(parseSysctl('17179869184\ntotal = 1024.00K  used = 512.00K  free = 512.00K\n1\n50\n').swapUsed, 512 * 1024)
  })

  test('a name this macOS does not know is skipped by sysctl: nothing is guessed into its place', () => {
    // One pressure line missing: which one cannot be told, so neither is used.
    const one = parseSysctl('17179869184\ntotal = 8192.00M  used = 100.00M  free = 8092.00M\n2\n')
    assert.deepEqual([one.memsize, one.swapUsed, one.pressure, one.availablePercent], [16 * GIB, 100 * 2 ** 20, null, null])
    // No swap line: the three numbers are still in order.
    const noSwap = parseSysctl('17179869184\n4\n9\n')
    assert.deepEqual([noSwap.memsize, noSwap.swapUsed, noSwap.pressure, noSwap.availablePercent], [16 * GIB, null, 'critical', 9])
    // No memsize: only what follows the swap line.
    const noSize = parseSysctl('total = 8192.00M  used = 100.00M  free = 8092.00M\n1\n60\n')
    assert.deepEqual([noSize.memsize, noSize.pressure], [null, 'normal'])
    // Two numbers and no swap line: too ambiguous to use any.
    assert.deepEqual(parseSysctl('17179869184\n1\n'), { memsize: null, swapUsed: null, swapTotal: null, pressure: null, availablePercent: null })
  })

  test('values out of shape are left out', () => {
    const bad = parseSysctl('17179869184\ntotal = 100.00M  used = 900.00M  free = 0.00M\n3\n140\n')
    assert.deepEqual([bad.swapUsed, bad.pressure, bad.availablePercent], [null, null, null], 'more swap used than there is; level 3; 140%')
    assert.equal(parseSysctl('12\ntotal = 1.00M  used = 0.00M  free = 1.00M\n1\n50\n').memsize, null, 'a memory size too small to be one')
    assert.equal(parseSysctl(SYSCTL_16G, 8 * GIB).memsize, null, 'hw.memsize that disagrees with os.totalmem()')
    assert.equal(parseSysctl(SYSCTL_16G, 16 * GIB).memsize, 16 * GIB)
    assert.equal(parseSysctl('total = 8.00X  used = 1.00X  free = 7.00X\n').swapUsed, null)
    assert.equal(parseSysctl(undefined).memsize, null)
  })
})

describe("Activity Monitor's formula", () => {
  test('Memory Used is app + wired + compressed + what no count accounts for; Cached Files is file-backed + purgeable', () => {
    const vm = parseVmStat(fixtureText('vm_stat-16k.txt'))!
    const m = macMemoryOf(vm, parseSysctl(SYSCTL_16G))!
    const page = 16_384
    // 16 GiB = 1,048,576 pages; the counts listed add up to 1,045,000, so 3,576 are unaccounted.
    assert.equal(m.total, 1_048_576 * page)
    assert.equal(m.app, 455_000 * page)
    assert.equal(m.wired, (120_000 + 3_576) * page, 'wired includes the unaccounted pages')
    assert.equal(m.compressed, 250_000 * page)
    assert.equal(m.used, (455_000 + 120_000 + 250_000 + 3_576) * page)
    // The same figure as hw.memsize − free − file-backed, the other way to write it.
    assert.equal(m.used, (1_048_576 - 20_000 - 200_000) * page)
    assert.equal(m.cached, (200_000 + 3_000) * page)
    assert.deepEqual([m.swapUsed, m.swapTotal, m.pressure, m.availablePercent, m.pageSize], [Math.round(6348.25 * 2 ** 20), 8192 * 2 ** 20, 'warning', 18, page])
    assert.equal(Math.round((m.used / GIB) * 100) / 100, 12.64)
  })

  test('4K pages: the same formula', () => {
    const m = macMemoryOf(parseVmStat(fixtureText('vm_stat-4k.txt'))!, parseSysctl(SYSCTL_8G))!
    assert.equal(m.used, (2_097_152 - 100_000 - 500_000) * 4_096)
    assert.equal(m.wired, (400_000 + 47_152) * 4_096)
    assert.equal(m.cached, 520_000 * 4_096)
  })

  test('without hw.memsize, os.totalmem() stands in; without either, there is no reading', () => {
    const vm = parseVmStat(fixtureText('vm_stat-16k.txt'))!
    const sys = { ...parseSysctl(SYSCTL_16G), memsize: null }
    assert.equal(macMemoryOf(vm, sys, 16 * GIB)?.total, 16 * GIB)
    assert.equal(macMemoryOf(vm, sys, 0), null)
  })

  test('page counts that add up to more than the RAM there is (a wrong page size) are refused', () => {
    const vm = parseVmStat(fixtureText('vm_stat-16k.txt'))!
    assert.equal(macMemoryOf(vm, parseSysctl(SYSCTL_8G)), null)
    // Slightly more than RAM (counts read a moment apart): nothing is unaccounted, nothing negative.
    const tight = macMemoryOf({ ...vm, free: vm.free + 3_576 + 1_000 }, parseSysctl(SYSCTL_16G))!
    assert.equal(tight.wired, 120_000 * 16_384)
  })
})

describe('swap rates', () => {
  const at = (s: number, swapOuts: number, swapIns = 0) => ({ at: s * 1_000, swapIns, swapOuts })

  test('pages per second since the previous reading; none from one reading or a counter that went back', () => {
    assert.deepEqual(swapRates([at(0, 100)], 16_384), { swapInsPerSec: null, swapOutsPerSec: null, sustainedSwapOutsPerSec: null })
    assert.deepEqual(swapRates([at(0, 100, 10), at(5, 600, 35)], 16_384), { swapInsPerSec: 5, swapOutsPerSec: 100, sustainedSwapOutsPerSec: null })
    assert.equal(swapRates([at(0, 600), at(5, 100)], 16_384).swapOutsPerSec, null)
    assert.equal(swapRates([at(0, 100), at(0.2, 600)], 16_384).swapOutsPerSec, null, 'readings too close to make a rate')
  })

  test('sustained: swap-outs in every reading for 25 to 35 s, at 1 MiB/s or more', () => {
    // 16K pages: 64 pages/s is 1 MiB/s. Seven readings 5 s apart, 100 pages/s throughout.
    const steady = Array.from({ length: 7 }, (_, i) => at(i * 5, 1_000 + i * 500))
    assert.equal(swapRates(steady, 16_384).sustainedSwapOutsPerSec, 100)
    // 83 pages/s on average, but none between 10 s and 15 s.
    const withPause = [1_000, 1_500, 2_000, 2_000, 2_500, 3_000, 3_500].map((swapOuts, i) => at(i * 5, swapOuts))
    assert.equal(swapRates(withPause, 16_384).sustainedSwapOutsPerSec, null, 'one reading without swap-outs')
    assert.equal(swapRates(steady.slice(-5), 16_384).sustainedSwapOutsPerSec, null, 'only 20 s of readings')
    const trickle = Array.from({ length: 7 }, (_, i) => at(i * 5, 1_000 + i * 50))
    assert.equal(swapRates(trickle, 16_384).sustainedSwapOutsPerSec, null, '10 pages/s is 160 KiB/s, a trickle')
    assert.equal(swapRates(trickle, 4_096).sustainedSwapOutsPerSec, null)
    const fast4k = Array.from({ length: 7 }, (_, i) => at(i * 5, i * 2_000))
    assert.equal(swapRates(fast4k, 4_096).sustainedSwapOutsPerSec, 400, '400 pages/s of 4 KiB is 1.6 MiB/s')
    assert.equal(SUSTAINED_SWAP.windowMs, 30_000)
  })
})

describe('MacMemoryReader', () => {
  function fakeExec(answers: { vm?: ExecResult; sys?: ExecResult }) {
    const calls: { file: string; args: readonly string[]; timeout: number }[] = []
    const exec: ExecFile = async (file, args, options) => {
      calls.push({ file, args, timeout: options.timeout })
      if (file === VM_STAT_PATH) return answers.vm ?? { error: null, stdout: fixtureText('vm_stat-16k.txt') }
      return answers.sys ?? { error: null, stdout: SYSCTL_16G }
    }
    return { exec, calls }
  }

  test('runs one vm_stat and one sysctl, by absolute path, with a timeout', async () => {
    const { exec, calls } = fakeExec({})
    const m = await new MacMemoryReader({ exec, platform: 'darwin', osTotal: () => 16 * GIB }).read()
    assert.equal(m?.used, (1_048_576 - 220_000) * 16_384)
    assert.deepEqual(calls.map((c) => [c.file, c.args]), [
      ['/usr/bin/vm_stat', []],
      ['/usr/sbin/sysctl', ['-n', ...SYSCTL_NAMES]]
    ])
    assert.equal(SYSCTL_PATH, '/usr/sbin/sysctl')
    assert.ok(calls.every((c) => c.timeout > 0 && c.timeout <= 5_000))
  })

  test('runs nothing anywhere but macOS', async () => {
    for (const platform of ['linux', 'win32', 'freebsd']) {
      const { exec, calls } = fakeExec({})
      assert.equal(await new MacMemoryReader({ exec, platform }).read(), null)
      assert.equal(calls.length, 0)
    }
  })

  test('vm_stat failing keeps the kernel level sysctl read, beside the last RAM figures marked with their age', async () => {
    let clock = 0
    let vmFails = false
    const exec: ExecFile = async (file) =>
      file === VM_STAT_PATH
        ? vmFails
          ? { error: Object.assign(new Error('timed out'), { killed: true, code: null }), stdout: '' }
          : { error: null, stdout: fixtureText('vm_stat-16k.txt') }
        : { error: null, stdout: vmFails ? SYSCTL_16G.replace(/\n2\n18\n$/, '\n4\n6\n') : SYSCTL_16G }
    const reader = new MacMemoryReader({ exec, platform: 'darwin', mono: () => clock })
    const first = (await reader.read())!
    assert.equal(first.pressure, 'warning')
    vmFails = true
    clock = 5_000
    const m = await reader.read()
    assert.equal(m?.pressure, 'critical', 'the kernel level sysctl did return is kept')
    assert.equal(m?.availablePercent, 6)
    assert.equal(m?.used, first.used, 'RAM figures from the last read')
    assert.equal(m?.ageMs, 5_000, 'marked with their age')
    assert.equal(m?.pressureAgeMs, undefined, 'the kernel figures are this read’s')
  })

  test('sysctl failing keeps the RAM figures, with the last kernel level standing in for up to 12 s', async () => {
    let clock = 0
    let sysFails = false
    const exec: ExecFile = async (file) =>
      file === VM_STAT_PATH
        ? { error: null, stdout: fixtureText('vm_stat-16k.txt') }
        : sysFails
          ? { error: Object.assign(new Error('timed out'), { killed: true, code: null }), stdout: SYSCTL_16G }
          : { error: null, stdout: SYSCTL_16G }
    const reader = new MacMemoryReader({ exec, platform: 'darwin', mono: () => clock, osTotal: () => 16 * GIB })
    await reader.read()
    sysFails = true
    clock = 12_000
    const carried = await reader.read()
    assert.deepEqual([carried?.pressure, carried?.pressureAgeMs, carried?.ageMs], ['warning', 12_000, undefined])
    clock = 12_001
    const late = await reader.read()
    assert.deepEqual([late?.pressure, late?.availablePercent, late?.pressureAgeMs], [null, null, undefined], 'unknown once older than 12 s')
  })

  test("a killed sysctl's output is never used, even when it printed everything", async () => {
    const { exec } = fakeExec({ sys: { error: Object.assign(new Error('killed'), { killed: true, code: null, signal: 'SIGKILL' }), stdout: SYSCTL_16G } })
    const m = await new MacMemoryReader({ exec, platform: 'darwin', osTotal: () => 16 * GIB }).read()
    assert.deepEqual([m?.pressure, m?.availablePercent, m?.swapUsed], [null, null, null])
  })

  test('vm_stat failing with nothing to carry is no reading; sysctl exiting 1 over an unknown name still counts', async () => {
    const failed = fakeExec({ vm: { error: Object.assign(new Error('boom'), { code: 1 }), stdout: '' } })
    assert.equal(await new MacMemoryReader({ exec: failed.exec, platform: 'darwin' }).read(), null)
    const partial = fakeExec({
      sys: { error: Object.assign(new Error('exit 1'), { code: 1 }), stdout: '17179869184\ntotal = 8192.00M  used = 1.00M  free = 8191.00M\n1\n40\n' }
    })
    const m = await new MacMemoryReader({ exec: partial.exec, platform: 'darwin' }).read()
    assert.deepEqual([m?.pressure, m?.availablePercent, m?.swapUsed], ['normal', 40, 2 ** 20])
  })

  test('sysctl timing out leaves swap and pressure unknown, and os.totalmem() as the total', async () => {
    const { exec } = fakeExec({ sys: { error: Object.assign(new Error('timeout'), { killed: true, code: null }), stdout: '17179869184\n' } })
    const m = await new MacMemoryReader({ exec, platform: 'darwin', osTotal: () => 16 * GIB }).read()
    assert.deepEqual([m?.total, m?.swapUsed, m?.pressure, m?.availablePercent], [16 * GIB, null, null, null])
  })

  test('swap rates come from one reading to the next, on the monotonic clock', async () => {
    let swapOuts = 5_000
    let clock = 0
    const exec: ExecFile = async (file) =>
      file === VM_STAT_PATH
        ? { error: null, stdout: fixtureText('vm_stat-16k.txt').replace(/Swapouts:\s+\d+/, `Swapouts: ${swapOuts}`) }
        : { error: null, stdout: SYSCTL_16G }
    const reader = new MacMemoryReader({ exec, platform: 'darwin', mono: () => clock })
    assert.equal((await reader.read())?.swapOutsPerSec, null, 'nothing to compare the first reading with')
    const rates: (number | null)[] = []
    for (let i = 1; i <= 7; i += 1) {
      clock += 5_000
      swapOuts += 1_000
      const m = await reader.read()
      rates.push(m?.swapOutsPerSec ?? null)
      if (i === 7) assert.equal(m?.sustainedSwapOutsPerSec, 200)
    }
    assert.deepEqual(rates, [200, 200, 200, 200, 200, 200, 200])
    swapOuts = 10 // the counter went back (it cannot, short of a restart): rates start over
    clock += 5_000
    assert.equal((await reader.read())?.swapOutsPerSec, null)
  })
})

describe('runBounded', () => {
  test('a child that never exits is answered for at its timeout, killed, and at most 4 are left waiting', async () => {
    const children: { kills: string[]; exitListeners: (() => void)[] }[] = []
    let spawned = 0
    const run = createRunBounded((() => {
      spawned += 1
      const child = { kills: [] as string[], exitListeners: [] as (() => void)[] }
      children.push(child)
      return {
        exitCode: null,
        signalCode: null,
        kill: (signal?: string) => {
          child.kills.push(String(signal))
          return true
        },
        once: (_event: 'exit', listener: () => void) => child.exitListeners.push(listener)
      }
    }) as never)
    const started = Date.now()
    const results = await Promise.all(Array.from({ length: MAX_LINGERING }, () => run('/usr/bin/vm_stat', [], { timeout: 50, maxBuffer: 1024 })))
    const took = Date.now() - started
    assert.ok(took >= 290 && took < 1_500, `answered after ${took} ms (timeout + 250 ms)`)
    assert.ok(results.every((r) => r.error?.killed === true), 'as timed out')
    assert.deepEqual(children.map((c) => c.kills), [['SIGKILL'], ['SIGKILL'], ['SIGKILL'], ['SIGKILL']])
    const busy = await run('/usr/bin/vm_stat', [], { timeout: 50, maxBuffer: 1024 })
    assert.equal(spawned, 4, 'no fifth child while four have not exited')
    assert.equal((busy.error as { code?: unknown } | null)?.code, 'EBUSY')
    children[0]!.exitListeners.forEach((l) => l())
    await run('/usr/bin/vm_stat', [], { timeout: 50, maxBuffer: 1024 })
    assert.equal(spawned, 5, 'one exited: room for one more')
  })

  test('a real command that answers in time is read as usual, and one that does not is killed on time', async () => {
    if (process.platform === 'win32') return
    const ok = await runBounded('/bin/echo', ['ok'], { timeout: 2_000, maxBuffer: 1024 })
    assert.equal(ok.error, null)
    assert.equal(ok.stdout, 'ok\n')
    const started = Date.now()
    const slow = await runBounded('/bin/sleep', ['5'], { timeout: 200, maxBuffer: 1024 })
    assert.ok(Date.now() - started < 1_500)
    assert.equal(slow.error?.killed, true)
  })
})
