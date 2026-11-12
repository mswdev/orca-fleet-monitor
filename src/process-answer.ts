// Answers to `fleet.processes`: this computer's full list, or a remote's newest top list, in
// columns (one object per column, far inside Orca's 10,000-object limit) and within Orca's 1 MiB
// answer cap. Every answer goes through plainJson (src/bounds.ts) before it leaves.
import { plainJson } from './bounds.ts'
import { estimateCloneBytes } from './bridge.ts'
import type { MachineState, ProcessColumns, ProcessList, ProcessRow, ProcessUnavailable } from './model.ts'
import type { RemoteProcessLine } from './poller.ts'
import type { ProcessTable } from './processes.ts'

export type { ProcessTable } from './processes.ts'

export const ANSWER_MAX_BYTES = 960 * 1024
/** Most processes one answer carries; a Mac rarely runs more than 1,500. */
export const ANSWER_MAX_ROWS = 5_000

export function toProcessColumns(rows: readonly ProcessRow[]): ProcessColumns {
  return {
    pid: rows.map((r) => r.pid),
    ppid: rows.map((r) => r.ppid),
    name: rows.map((r) => r.name),
    user: rows.map((r) => r.user),
    cpu: rows.map((r) => r.cpu),
    mem: rows.map((r) => r.mem),
    energy: rows.map((r) => r.energy),
    start: rows.map((r) => r.start)
  }
}

const EMPTY: ProcessColumns = { pid: [], ppid: [], name: [], user: [], cpu: [], mem: [], energy: [], start: [] }

export function unavailableAnswer(machineId: string, reason: ProcessUnavailable, scope: ProcessList['scope']): ProcessList {
  return { machineId, state: 'unavailable', reason, scope, takenAt: null, ageMs: null, cpuWindowMs: null, memAgeMs: null, energyWindowMs: null, total: null, columns: EMPTY }
}

/** The busiest first, for an answer that must leave some out: by memory, then CPU. */
function busiestFirst(rows: readonly ProcessRow[]): ProcessRow[] {
  return [...rows].sort((a, b) => (b.mem ?? -1) - (a.mem ?? -1) || (b.cpu ?? -1) - (a.cpu ?? -1) || a.pid - b.pid)
}

/** Keeps halving the rows (the busiest kept) until the answer fits `maxBytes`. */
function fitted(answer: ProcessList, rows: readonly ProcessRow[], maxBytes: number): ProcessList {
  let keep = Math.min(rows.length, ANSWER_MAX_ROWS)
  // In the order given unless some must go; then the busiest are the ones kept.
  let ordered: readonly ProcessRow[] = keep < rows.length ? busiestFirst(rows) : rows
  for (;;) {
    const kept = ordered.slice(0, keep)
    const out = plainJson({ ...answer, columns: toProcessColumns(kept), ...(kept.length < rows.length ? { truncated: true } : {}) }) as unknown as ProcessList
    if (estimateCloneBytes(out) <= maxBytes || keep === 0) return out
    if (ordered === rows) ordered = busiestFirst(rows)
    keep = Math.floor(keep / 2)
  }
}

/** This computer's whole list. `now` is the worker's clock and `wallNow` the wall clock, since a
 *  table carries wall times. */
export function localAnswer(machineId: string, table: ProcessTable | null, now: number, wallNow: number, maxBytes = ANSWER_MAX_BYTES): ProcessList {
  if (!table) return unavailableAnswer(machineId, 'failed', 'full')
  const ageMs = Math.max(0, Math.round(wallNow - table.takenAt))
  const answer: ProcessList = {
    machineId,
    state: 'ok',
    reason: null,
    scope: 'full',
    takenAt: now - ageMs,
    ageMs,
    cpuWindowMs: table.cpuWindowMs,
    memAgeMs: table.memAgeMs,
    energyWindowMs: table.energyWindowMs,
    total: table.total,
    columns: EMPTY
  }
  return fitted(answer, table.rows, maxBytes)
}

/** A paired machine's newest top list, as its state says it can give one. */
export function remoteAnswer(machineId: string, state: MachineState | null, line: RemoteProcessLine | null, now: number, maxBytes = ANSWER_MAX_BYTES): ProcessList {
  if (!state || state.kind !== 'remote') return unavailableAnswer(machineId, 'unknown-machine', 'top')
  const availability = state.processes
  if (!availability || availability.state === 'unavailable') return unavailableAnswer(machineId, availability?.reason ?? 'not-read-yet', 'top')
  if (availability.state === 'waiting' || !line) return { ...unavailableAnswer(machineId, 'not-read-yet', 'top'), state: 'waiting', reason: null }
  const { record } = line
  const answer: ProcessList = {
    machineId,
    state: 'ok',
    reason: null,
    scope: 'top',
    takenAt: line.takenAt,
    ageMs: Math.max(0, Math.round(now - line.takenAt)),
    cpuWindowMs: record.cpuWindowMs,
    memAgeMs: record.memAgeMs,
    energyWindowMs: record.energyWindowMs,
    total: record.total,
    columns: EMPTY
  }
  return fitted(answer, record.rows, maxBytes)
}
