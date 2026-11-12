import { assert, test } from 'orca/testing'
import type { MacMemory } from '../src/model.ts'
import { cpuDelta, LocalSampler, MAC_MEMORY_MAX_AGE_MS, type CpuInfo, type OsSource } from '../src/sampler.ts'
import { macMemory } from './helpers.ts'

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
  const source: OsSource = {
    cpus: () => [cpu(0, 0, 0)],
    totalmem: () => 16 * 2 ** 30,
    freemem: () => 2 ** 30,
    loadavg: () => [1, 1, 1],
    uptime: () => 1,
    hostname: () => 'h',
    platform: () => 'darwin',
    arch: () => 'arm64',
    release: () => 'r',
    now: () => clock
  }
  const sampler = new LocalSampler(source, reader, () => clock)
  assert.equal(sampler.sample().macMemory, undefined, 'nothing read yet')
  await sampler.prepare()
  assert.deepEqual(sampler.sample().macMemory, macMemory())
  assert.deepEqual(sampler.sample().memory, { total: 16 * 2 ** 30, free: 2 ** 30 }, 'os memory is still there for older readers')
  clock += MAC_MEMORY_MAX_AGE_MS + 1
  assert.equal(sampler.sample().macMemory, undefined, 'a reading older than two intervals is dropped')
  answer = null
  await sampler.prepare()
  assert.equal(sampler.sample().macMemory, undefined, 'a failed read leaves none')
  // Two prepares at once share one read.
  await Promise.all([sampler.prepare(), sampler.prepare()])
  assert.equal(reads, 3)
  const failing = new LocalSampler(source, { read: () => Promise.reject(new Error('boom')) }, () => clock)
  await failing.prepare()
  assert.equal(failing.sample().macMemory, undefined)
  await new LocalSampler(source).prepare() // no reader (not a Mac): resolves, reads nothing
})
