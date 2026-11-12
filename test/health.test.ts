import { assert, describe, test } from 'orca/testing'
import { assessHealth, DEFAULT_HEALTH, DEFAULT_MEMORY_RULES, levelFor, memoryReasons, orderedThresholds, worstMachine } from '../src/health.ts'
import { mergeMachine } from '../src/merge.ts'
import { localSample, macMemory } from './helpers.ts'

const memory = (percent: number, reliable = true) => ({ percent, reliable })

test('levelFor crosses each threshold at its value', () => {
  const t = { busy: 70, strained: 85, critical: 95 }
  assert.equal(levelFor(0, t), 'ok')
  assert.equal(levelFor(69.9, t), 'ok')
  assert.equal(levelFor(70, t), 'busy')
  assert.equal(levelFor(85, t), 'strained')
  assert.equal(levelFor(95, t), 'critical')
  assert.equal(levelFor(100, t), 'critical')
})

test('thresholds typed out of order are put in order', () => {
  assert.deepEqual(orderedThresholds({ busy: 90, strained: 60, critical: 75 }), { busy: 60, strained: 75, critical: 90 })
  assert.equal(levelFor(80, { busy: 90, strained: 60, critical: 75 }), 'strained')
  assert.equal(levelFor(91, { busy: 90, strained: 60, critical: 75 }), 'critical')
})

test('the worse of CPU and memory wins, with its reason', () => {
  const h = assessHealth({ online: true, cpu: { percent: 72, source: 'sampler' }, memory: memory(96) }, DEFAULT_HEALTH)
  assert.equal(h.level, 'critical')
  assert.deepEqual(h.reasons, ['memory 96% ≥ 95%'])
  const both = assessHealth({ online: true, cpu: { percent: 90, source: 'beacon' }, memory: memory(90) }, DEFAULT_HEALTH)
  assert.equal(both.level, 'strained')
  assert.deepEqual(both.reasons, ['CPU 90% ≥ 85%', 'memory 90% ≥ 88%'])
})

test('a CPU estimate from the load average never sets a level', () => {
  const estimate = assessHealth({ online: true, cpu: { percent: 100, source: 'load' }, memory: memory(10) }, DEFAULT_HEALTH)
  assert.deepEqual([estimate.level, estimate.cpu, estimate.memory, estimate.reasons], ['ok', null, 'ok', []])
  const alone = assessHealth({ online: true, cpu: { percent: 100, source: 'load' }, memory: null }, DEFAULT_HEALTH)
  assert.equal(alone.level, 'unknown', 'with nothing else measured there is no level')
})

test('each metric keeps its own level, judged on its own thresholds', () => {
  const h = assessHealth({ online: true, cpu: { percent: 72, source: 'sampler' }, memory: memory(80) }, DEFAULT_HEALTH)
  assert.deepEqual([h.level, h.cpu, h.memory], ['busy', 'busy', 'busy'])
  const split = assessHealth({ online: true, cpu: { percent: 72, source: 'sampler' }, memory: memory(10) }, DEFAULT_HEALTH)
  assert.deepEqual([split.level, split.cpu, split.memory], ['busy', 'busy', 'ok'])
  const untrusted = assessHealth({ online: true, cpu: { percent: 5, source: 'sampler' }, memory: memory(99, false) }, DEFAULT_HEALTH)
  assert.equal(untrusted.memory, null, 'memory that cannot be trusted has no level')
})

test('memory that cannot be trusted does not count', () => {
  const h = assessHealth({ online: true, cpu: { percent: 10, source: 'sampler' }, memory: memory(97, false) }, DEFAULT_HEALTH)
  assert.equal(h.level, 'ok')
  assert.deepEqual(h.reasons, [])
})

test('offline and no-data machines are unknown', () => {
  assert.equal(assessHealth({ online: false, cpu: { percent: 99, source: 'beacon' }, memory: null }, DEFAULT_HEALTH).level, 'unknown')
  assert.deepEqual(assessHealth({ online: true, cpu: { percent: null, source: null }, memory: null }, DEFAULT_HEALTH), {
    level: 'unknown',
    reasons: ['no data yet'],
    cpu: null,
    memory: null
  })
})

test('worstMachine picks the highest level, then the busiest CPU, and skips offline ones', () => {
  const make = (id: string, cpu: number, status: 'online' | 'offline' = 'online') =>
    mergeMachine({
      id,
      name: id,
      kind: 'remote',
      now: 0,
      status,
      lastSeenAt: 0,
      latencyMs: 1,
      error: null,
      beacon: {
        latest: { ...localSample(), run: 'r', seq: 1, intervalMs: 5000, cpu, perCore: null, coreGroups: null, memTotal: 10, memFree: 9, loggedAt: 0 },
        fresh: true,
        ageMs: 0,
        pluginKey: 'local.fleet-monitor',
        remotePlugin: 'running'
      },
      health: DEFAULT_HEALTH
    })
  const machines = [make('a', 20), make('b', 88), make('c', 99, 'offline'), make('d', 86)]
  assert.equal(worstMachine(machines)?.id, 'b')
  assert.equal(worstMachine([make('x', 1, 'offline')]), null)
})

test('worstMachine never ranks a machine by an estimate', () => {
  const memoryOnly = (id: string, load1: number) =>
    mergeMachine({
      id,
      name: id,
      kind: 'remote',
      now: 0,
      status: 'online',
      lastSeenAt: 0,
      latencyMs: 1,
      error: null,
      diag: {
        collectedAt: 1,
        runtimeId: null,
        host: { totalMemory: 100, availableMemory: 50, usedMemory: 50, memoryPercent: 50, availableMemorySource: 'proc-meminfo', cores: 4, load1 },
        app: { cpu: 0, memory: 0 },
        totalCpu: 0,
        totalMemory: 0,
        workspaces: []
      },
      health: DEFAULT_HEALTH
    })
  const measured = mergeMachine({
    id: 'measured',
    name: 'measured',
    kind: 'remote',
    now: 0,
    status: 'online',
    lastSeenAt: 0,
    latencyMs: 1,
    error: null,
    beacon: {
      latest: { ...localSample(), run: 'r', seq: 1, intervalMs: 5000, cpu: 30, perCore: null, coreGroups: null, memTotal: 10, memFree: 9, loggedAt: 0 },
      fresh: true,
      ageMs: 0,
      pluginKey: 'local.fleet-monitor',
      remotePlugin: 'running'
    },
    health: DEFAULT_HEALTH
  })
  assert.equal(worstMachine([memoryOnly('estimated', 16), measured])?.id, 'measured', 'a 100% estimate does not outrank 30% measured')
})

describe('memory on a machine that reports RAM in use (a Mac with Fleet Monitor 1.1)', () => {
  const GIB = 2 ** 30
  /** What src/merge.ts makes of a Mac's own reading. */
  const mac = (over: Parameters<typeof macMemory>[0] = {}, pressurePercent: number | null = 100 - (over.availablePercent ?? 55)) => {
    const m = macMemory(over)
    return { percent: (m.used / m.total) * 100, reliable: true, kind: 'used' as const, pressurePercent, total: m.total, used: m.used, mac: m }
  }
  const judge = (memory: ReturnType<typeof mac>, rules = DEFAULT_MEMORY_RULES) =>
    assessHealth({ online: true, cpu: { percent: 10, source: 'sampler' }, memory }, DEFAULT_HEALTH, rules)

  test('macOS critical pressure is critical, warning is strained, each said with what is left', () => {
    const critical = judge(mac({ pressure: 'critical', availablePercent: 4 }, null))
    assert.deepEqual([critical.level, critical.memory, critical.reasons], ['critical', 'critical', ['macOS memory pressure critical, 4% available']])
    const warning = judge(mac({ pressure: 'warning', availablePercent: 30 }, null))
    assert.deepEqual([warning.level, warning.reasons], ['strained', ['macOS memory pressure warning, 30% available']])
    assert.equal(judge(mac({ pressure: 'normal' })).memory, 'ok')
  })

  test('the memory thresholds judge memory pressure (100 − available), as on every machine', () => {
    const h = judge(mac({ availablePercent: 10 }))
    assert.deepEqual([h.level, h.reasons], ['strained', ['memory pressure 90% ≥ 88%']])
    assert.equal(judge(mac({ availablePercent: 24 })).memory, 'busy')
    assert.equal(judge(mac({ availablePercent: 26 })).memory, 'ok', '74% pressure, and 78% RAM used, is fine')
  })

  test('RAM in use at 90% or more is busy, and the setting moves it', () => {
    const full = mac({ used: 14.5 * GIB, app: 9 * GIB })
    const h = judge(full)
    assert.deepEqual([h.level, h.reasons], ['busy', ['RAM 91% used (14.5 of 16 GB) ≥ 90%']])
    assert.equal(judge(full, { ramUsedBusyPercent: 95 }).memory, 'ok')
    assert.equal(judge(mac(), { ramUsedBusyPercent: 70 }).memory, 'busy', '78% used')
  })

  test('sustained swap-outs with a quarter of RAM in swap are busy; less swap, or no sustained activity, is not', () => {
    const swapping = mac({ swapUsed: 4.2 * GIB, swapTotal: 5 * GIB, sustainedSwapOutsPerSec: 320 })
    const h = judge(swapping)
    assert.deepEqual([h.level, h.reasons], ['busy', ['swapping out 5 MB/s for 30 s with 4.2 GB of swap in use (≥ 4 GB, a quarter of RAM)']])
    assert.equal(judge(mac({ swapUsed: 3.9 * GIB, sustainedSwapOutsPerSec: 320 })).memory, 'ok', 'under a quarter of RAM in swap')
    assert.equal(judge(mac({ swapUsed: 6 * GIB, swapTotal: 7 * GIB, sustainedSwapOutsPerSec: null, swapOutsPerSec: 900 })).memory, 'ok', 'one busy interval is not sustained')
  })

  test('the level is the worst rule, and the reasons are the rules at that level', () => {
    const many = judge(mac({ used: 15.1 * GIB, app: 9.6 * GIB, pressure: 'warning', availablePercent: 8, swapUsed: 6.2 * GIB, swapTotal: 7 * GIB, sustainedSwapOutsPerSec: 500 }))
    assert.equal(many.level, 'strained')
    assert.deepEqual(many.reasons, ['macOS memory pressure warning, 8% available', 'memory pressure 92% ≥ 88%'])
    const both = memoryReasons(mac({ used: 15.1 * GIB, app: 9.6 * GIB, swapUsed: 6.2 * GIB, swapTotal: 7 * GIB, sustainedSwapOutsPerSec: 500 }), DEFAULT_HEALTH)
    assert.deepEqual(both, {
      level: 'busy',
      reasons: ['RAM 94% used (15.1 of 16 GB) ≥ 90%', 'swapping out 7.8 MB/s for 30 s with 6.2 GB of swap in use (≥ 4 GB, a quarter of RAM)']
    })
    assert.deepEqual(memoryReasons(null, DEFAULT_HEALTH), { level: null, reasons: [] })
  })

  test("Orca's reading of a Mac is called memory pressure; elsewhere it is worded as before", () => {
    const pressure = assessHealth({ online: true, cpu: { percent: 10, source: 'sampler' }, memory: { percent: 90, reliable: true, kind: 'pressure' } }, DEFAULT_HEALTH)
    assert.deepEqual(pressure.reasons, ['memory pressure 90% ≥ 88%'])
    const linux = assessHealth({ online: true, cpu: { percent: 10, source: 'sampler' }, memory: { percent: 90, reliable: true } }, DEFAULT_HEALTH)
    assert.deepEqual(linux.reasons, ['memory 90% ≥ 88%'])
  })
})
