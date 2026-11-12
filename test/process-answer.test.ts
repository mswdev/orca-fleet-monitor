// Answers to `fleet.processes` (src/process-answer.ts): columns, the 1 MiB answer cap, and a
// remote's states. Every value here is invented.
import { assert, test } from 'orca/testing'
import { estimateCloneBytes } from '../src/bridge.ts'
import type { MachineState, ProcessRow } from '../src/model.ts'
import { ANSWER_MAX_ROWS, localAnswer, remoteAnswer } from '../src/process-answer.ts'
import type { ProcessTable } from '../src/processes.ts'

const row = (pid: number, mem: number | null, name = `p${pid}`): ProcessRow => ({ pid, ppid: 1, name, user: 'example', cpu: pid % 5, mem, energy: null, start: 1_000 + pid })
const table = (rows: ProcessRow[]): ProcessTable => ({ takenAt: 9_000, rows, cpuWindowMs: 5_000, memAgeMs: 0, energyWindowMs: null, total: rows.length })

test('this computer: every process, in columns, with its age on the worker clock', () => {
  const a = localAnswer('local', table([row(1, 10), row(2, 20)]), 50_000, 10_000)
  assert.deepEqual([a.state, a.scope, a.ageMs, a.takenAt, a.total, a.truncated], ['ok', 'full', 1_000, 49_000, 2, undefined])
  assert.deepEqual(a.columns, { pid: [1, 2], ppid: [1, 1], name: ['p1', 'p2'], user: ['example', 'example'], cpu: [1, 2], mem: [10, 20], energy: [null, null], start: [1_001, 1_002] })
  assert.deepEqual([localAnswer('local', null, 1, 1).state, localAnswer('local', null, 1, 1).reason], ['unavailable', 'failed'])
})

test('an answer too large keeps the busiest processes, marked truncated, under the cap', () => {
  const rows = Array.from({ length: 3_000 }, (_, i) => row(i + 2, i, 'n'.repeat(120)))
  const a = localAnswer('local', table(rows), 1, 1, 200_000)
  assert.ok(estimateCloneBytes(a) <= 200_000)
  assert.equal(a.truncated, true)
  assert.equal(a.total, 3_000, 'total still counts every process')
  assert.ok(a.columns.pid.length < 3_000 && a.columns.pid.length > 100)
  assert.equal(a.columns.mem[0], 2_999, 'the largest kept first')
  const many = localAnswer('local', table(Array.from({ length: ANSWER_MAX_ROWS + 10 }, (_, i) => row(i + 2, i))), 1, 1)
  assert.equal(many.columns.pid.length, ANSWER_MAX_ROWS)
})

test('a paired Mac: unknown, unavailable with its reason, waiting, or its top list with age', () => {
  const state = (processes: MachineState['processes']) => ({ id: 'env-a', kind: 'remote', processes }) as MachineState
  assert.equal(remoteAnswer('env-a', null, null, 1).reason, 'unknown-machine')
  assert.equal(remoteAnswer('local', { ...state(undefined), kind: 'local' } as MachineState, null, 1).reason, 'unknown-machine')
  assert.equal(remoteAnswer('env-a', state({ state: 'unavailable', reason: 'outdated', takenAt: null }), null, 1).reason, 'outdated')
  assert.equal(remoteAnswer('env-a', state(undefined), null, 1).reason, 'not-read-yet')
  assert.equal(remoteAnswer('env-a', state({ state: 'waiting', reason: null, takenAt: null }), null, 1).state, 'waiting')
  const record = { run: 'r', seq: 1, t: 0, intervalMs: 30_000, total: 600, cpuWindowMs: 30_000, memAgeMs: 4_000, energyWindowMs: 120_000, rows: [row(5, 50)], loggedAt: 0 }
  const a = remoteAnswer('env-a', state({ state: 'top', reason: null, takenAt: 1_000 }), { record, takenAt: 1_000, readAt: 2_000, largest: null }, 31_000)
  assert.deepEqual([a.state, a.scope, a.ageMs, a.total, a.columns.pid], ['ok', 'top', 30_000, 600, [5]])
})
