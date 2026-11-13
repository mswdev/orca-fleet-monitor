import { assert, test } from 'orca/testing'
import type { MacMemory } from '../src/model.ts'
import { cpuDelta, LocalSampler, type CpuInfo, type OsSource } from '../src/sampler.ts'
import { FakeTime, flush, macMemory } from './helpers.ts'

const cpu = (user: number, sys: number, idle: number): CpuInfo => ({
  model: '  Example CPU  ',
  times: { user, nice: 0, sys, idle, irq: 0 }
})

test('cpuDelta is busy time over total time, per core and overall', () => {
  const before = [cpu(100, 0, 900), cpu(0, 0, 1_000)]
  const after = [cpu(150, 50, 1_000), cpu(0, 0, 1_200)]
  const d = cpuDelta(before, after)
  assert.ok(d)
  assert.deepEqual(d.perCore, [50, 0])
  assert.equal(Math.round(d.total * 100) / 100, 25)
})

test('cpuDelta cannot compare readings with a different core count, or no baseline', () => {
  assert.equal(cpuDelta([cpu(1, 1, 1)], [cpu(1, 1, 1), cpu(1, 1, 1)]), null)
  assert.equal(cpuDelta([], [cpu(1, 1, 1)]), null)
})

test('cpuDelta treats a counter that went backwards as idle', () => {
  const d = cpuDelta([cpu(500, 0, 500)], [cpu(100, 0, 600)])
  assert.deepEqual(d, { total: 0, perCore: [0] })
})

// Node on Windows gives `sys` as kernel time less idle, which already holds interrupt time.
test('cpuDelta on Windows does not count interrupt time twice', () => {
  const at = (user: number, sys: number, idle: number, irq: number): CpuInfo => ({ model: 'x', times: { user, nice: 0, sys, idle, irq } })
  const before = [at(0, 0, 0, 0)]
  const after = [at(100, 100, 800, 80)] // 80 ms of interrupts, inside the 100 ms of sys
  assert.deepEqual(cpuDelta(before, after, { platform: 'win32' }), { total: 20, perCore: [20] })
  // Elsewhere `irq` is its own slice of the time.
  assert.equal(Math.round(cpuDelta(before, after, { platform: 'linux' })!.total * 10) / 10, 25.9)
  assert.equal(Math.round(cpuDelta(before, after)!.total * 10) / 10, 25.9)
})

// Node on Linux leaves out time waiting for disk (and soft interrupts, and time a hypervisor took).
test('cpuDelta on Linux does not read a core waiting for disk as busy', () => {
  const before = [cpu(0, 0, 0), cpu(0, 0, 0)]
  const after = [cpu(1_200, 300, 500), cpu(250, 0, 4_750)] // core 0: 3 s of its 5 s waited for disk
  const blind = cpuDelta(before, after, { platform: 'linux' })!
  assert.deepEqual(blind.perCore, [75, 5], 'without the time that passed, the wait is missing from the total')
  const timed = cpuDelta(before, after, { platform: 'linux', elapsedMs: 5_000 })!
  assert.deepEqual(timed.perCore, [30, 5])
  assert.equal(timed.total, 17.5)
  // A clock a little behind the counters never shrinks a core's total, and only Linux uses it.
  assert.deepEqual(cpuDelta(before, after, { platform: 'linux', elapsedMs: 1_000 })!.perCore, [75, 5])
  assert.deepEqual(cpuDelta(before, after, { platform: 'darwin', elapsedMs: 5_000 })!.perCore, [75, 5])
  assert.deepEqual(cpuDelta(before, after, { platform: 'linux', elapsedMs: Number.NaN })!.perCore, [75, 5])
})

test('LocalSampler times its own readings, for Linux', () => {
  const readings = [[cpu(0, 0, 0)], [cpu(1_500, 0, 500)]] // 3 s of the 5 s waited for disk
  let i = 0
  let clock = 0
  const source: OsSource = {
    cpus: () => readings[i]!,
    totalmem: () => 8_000,
    freemem: () => 2_000,
    loadavg: () => [0, 0, 0],
    uptime: () => 1,
    hostname: () => 'h',
    platform: () => 'linux',
    arch: () => 'x64',
    release: () => 'r',
    now: () => 1_000
  }
  const sampler = new LocalSampler(source, null, () => clock)
  i = 1
  clock = 5_000
  assert.deepEqual(sampler.sample().cpu, { total: 30, perCore: [30] })
})

test('LocalSampler reports CPU since its previous reading', () => {
  const readings = [
    [cpu(0, 0, 0), cpu(0, 0, 0)],
    [cpu(30, 10, 60), cpu(10, 0, 90)],
    [cpu(30, 10, 160), cpu(10, 0, 190)]
  ]
  let i = 0
  const source: OsSource = {
    cpus: () => readings[Math.min(i, readings.length - 1)]!,
    totalmem: () => 8_000,
    freemem: () => 9_000,
    loadavg: () => [0.5, 0.25],
    uptime: () => 12.6,
    hostname: () => 'test-host',
    platform: () => 'linux',
    arch: () => 'arm64',
    release: () => '6.1.0-test',
    now: () => 1_000 + i
  }
  const sampler = new LocalSampler(source)
  assert.equal(sampler.latest(), null)
  i = 1
  const first = sampler.sample()
  assert.deepEqual(first.cpu, { total: 25, perCore: [40, 10] })
  assert.equal(first.cpuModel, 'Example CPU')
  assert.equal(first.cores, 2)
  assert.deepEqual(first.memory, { total: 8_000, free: 8_000 }) // free is capped at total
  assert.deepEqual(first.load, [0.5, 0.25, 0])
  assert.equal(first.uptimeSec, 13)
  i = 2
  const second = sampler.sample()
  assert.deepEqual(second.cpu, { total: 0, perCore: [0, 0] })
  assert.equal(sampler.latest(), second)
  assert.equal(second.coreGroups, null, 'no split until one is handed in')
  sampler.setCoreGroups([
    { kind: 'performance', start: 1, count: 1 },
    { kind: 'efficiency', start: 0, count: 1 }
  ])
  assert.deepEqual(sampler.sample().coreGroups, [
    { kind: 'performance', start: 1, count: 1 },
    { kind: 'efficiency', start: 0, count: 1 }
  ])
  sampler.setCoreGroups([{ kind: 'performance', start: 0, count: 8 }])
  assert.equal(sampler.sample().coreGroups, null, 'a split that does not fit these cores is ignored')
})

test('LocalSampler survives os.cpus() returning nothing', () => {
  const source: OsSource = {
    cpus: () => [],
    totalmem: () => 1,
    freemem: () => 1,
    loadavg: () => [],
    uptime: () => 1,
    hostname: () => 'h',
    platform: () => 'linux',
    arch: () => 'x64',
    release: () => 'r',
    availableParallelism: () => 3,
    now: () => 1
  }
  const s = new LocalSampler(source).sample()
  assert.equal(s.cpu, null)
  assert.equal(s.cores, 3)
})

function macSource(now: () => number): OsSource {
  return {
    cpus: () => [cpu(0, 0, 0)],
    totalmem: () => 16 * 2 ** 30,
    freemem: () => 2 ** 30,
    loadavg: () => [1, 1, 1],
    uptime: () => 1,
    hostname: () => 'h',
    platform: () => 'darwin',
    arch: () => 'arm64',
    release: () => 'r',
    now
  }
}

test('on a Mac, prepare() reads memory for the next sample; a reading too old is not attached', async () => {
  let clock = 0
  let reads = 0
  let answer: MacMemory | null = macMemory()
  const reader = {
    read: async () => {
      reads += 1
      return answer
    }
  }
  const source = macSource(() => clock)
  const sampler = new LocalSampler(source, reader, () => clock)
  assert.equal(sampler.sample().macMemory, undefined, 'nothing read yet')
  await sampler.prepare()
  assert.deepEqual(sampler.sample().macMemory, macMemory())
  assert.deepEqual(sampler.sample().memory, { total: 16 * 2 ** 30, free: 2 ** 30 }, 'os memory is still there for older readers')
  clock += 12_001
  assert.equal(sampler.sample().macMemory, undefined, 'a reading older than two intervals is dropped')
  answer = null
  await sampler.prepare()
  assert.equal(sampler.sample().macMemory, undefined, 'a failed read with nothing to carry leaves none')
  // Two prepares at once share one read.
  await Promise.all([sampler.prepare(), sampler.prepare()])
  assert.equal(reads, 3)
  const failing = new LocalSampler(source, { read: () => Promise.reject(new Error('boom')) }, () => clock)
  await failing.prepare()
  assert.equal(failing.sample().macMemory, undefined)
  await new LocalSampler(source).prepare() // no reader (not a Mac): resolves, reads nothing
})

test('a failed read carries the last reading, marked with its age, for up to 12 s: never dropped by one failure', async () => {
  let clock = 0
  let answer: MacMemory | null = macMemory({ pressure: 'warning', availablePercent: 20 })
  const sampler = new LocalSampler(macSource(() => clock), { read: async () => answer }, () => clock)
  await sampler.prepare()
  const fresh = sampler.sample().macMemory!
  assert.equal(fresh.ageMs, undefined, 'read with this sample')
  assert.equal(fresh.pressureAgeMs, undefined)
  answer = null // every read from now on fails
  for (const at of [5_000, 10_000, 12_000]) {
    clock = at
    await sampler.prepare()
    const carried = sampler.sample().macMemory
    assert.equal(carried?.pressure, 'warning', `kept at ${at} ms`)
    assert.equal(carried?.ageMs, at, 'marked with its age')
    assert.equal(carried?.pressureAgeMs, at)
  }
  clock = 12_001
  await sampler.prepare()
  assert.equal(sampler.sample().macMemory, undefined, 'and dropped once older than 12 s')
  // A reading the reader itself carried part of keeps its own age, plus the time since.
  clock = 20_000
  answer = macMemory({ pressureAgeMs: 4_000 })
  await sampler.prepare()
  assert.equal(sampler.sample().macMemory?.pressureAgeMs, 4_000)
  answer = null
  clock = 25_000
  await sampler.prepare()
  assert.equal(sampler.sample().macMemory?.pressureAgeMs, 9_000)
})

test('a read that never answers is given up on after 2.75 s, and the next sample starts a fresh one', async () => {
  const time = new FakeTime(0)
  let hang = true
  let reads = 0
  const reader = {
    read: () => {
      reads += 1
      return hang ? new Promise<MacMemory | null>(() => {}) : Promise.resolve(macMemory({ used: 13 * 2 ** 30 }))
    }
  }
  const sampler = new LocalSampler(macSource(time.now), reader, time.now, { setTimeout: time.setTimeout, clearTimeout: time.clearTimeout })
  let settled = false
  void sampler.prepare().then(() => {
    settled = true
  })
  time.advance(2_749)
  await flush()
  assert.equal(settled, false, 'still waiting at 2.749 s')
  time.advance(1)
  await flush()
  assert.equal(settled, true, 'given up on at 2.75 s')
  hang = false
  const next = sampler.prepare()
  await flush()
  await next
  assert.equal(reads, 2, 'a fresh read, not the hung one joined')
  assert.equal(sampler.sample().macMemory?.used, 13 * 2 ** 30)
})
