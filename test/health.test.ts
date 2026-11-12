import { assert, test } from 'orca/testing'
import { assessHealth, DEFAULT_HEALTH, levelFor, orderedThresholds, worstMachine } from '../src/health.ts'
import { mergeMachine } from '../src/merge.ts'
import { localSample } from './helpers.ts'

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
  const both = assessHealth({ online: true, cpu: { percent: 90, source: 'load' }, memory: memory(90) }, DEFAULT_HEALTH)
  assert.equal(both.level, 'strained')
  assert.deepEqual(both.reasons, ['CPU load 90% ≥ 85%', 'memory 90% ≥ 88%'])
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
