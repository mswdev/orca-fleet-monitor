// The process line (src/process-line.ts): round trip, the size cap, hostile lines, the newest one
// in a log, and the 200-line log ring it shares with the beacons. Every value here is invented.
import { assert, describe, test } from 'orca/testing'
import { encodeBeacon, readBeacons } from '../src/beacon.ts'
import { decodeProcessLine, encodeProcessLine, MAX_WIRE_ROWS, PROCESS_INTERVAL_MS, PROCESS_MAX_CHARS, PROCESS_PREFIX, readProcessLog } from '../src/process-line.ts'
import type { ProcessRow } from '../src/model.ts'
import type { ProcessTable } from '../src/processes.ts'
import * as v100 from './fixtures/beacon-1.0.0.ts'
import * as v110 from './fixtures/beacon-1.1.0.ts'
import { localSample, macMemory } from './helpers.ts'

const meta = { run: 'run-a', seq: 3, intervalMs: PROCESS_INTERVAL_MS }

function row(pid: number, over: Partial<ProcessRow> = {}): ProcessRow {
  return { pid, ppid: 1, name: `tool-${pid}`, user: pid % 2 ? 'example' : 'root', cpu: (pid % 7) * 1.5, mem: pid * 1_048_576, energy: pid % 3, start: 1_800_000_000 + pid, ...over }
}
function table(rows: ProcessRow[], over: Partial<ProcessTable> = {}): ProcessTable {
  return { takenAt: 1_800_000_100_000, rows, cpuWindowMs: 30_000, memAgeMs: 12_000, energyWindowMs: 60_000, total: rows.length, ...over }
}

describe('encode and decode', () => {
  test('a top list round-trips: 40 by memory and the busiest by CPU, figures kept', () => {
    const rows = Array.from({ length: 300 }, (_, i) => row(i + 2))
    const line = encodeProcessLine(table(rows), meta)!
    assert.ok(line.startsWith(PROCESS_PREFIX))
    assert.ok(line.length <= PROCESS_MAX_CHARS)
    const back = decodeProcessLine(line, 1_800_000_100_500)!
    assert.deepEqual([back.run, back.seq, back.total, back.cpuWindowMs, back.memAgeMs, back.energyWindowMs, back.loggedAt], ['run-a', 3, 300, 30_000, 12_000, 60_000, 1_800_000_100_500])
    assert.ok(back.rows.length >= 40 && back.rows.length <= 60)
    const first = back.rows[0]!
    const original = rows.find((r) => r.pid === first.pid)!
    assert.deepEqual(first, { ...original, cpu: Math.round(original.cpu! * 10) / 10, energy: original.energy })
    assert.equal(first.mem, 301 * 1_048_576, 'most memory first')
  })

  test('a line stays under the cap: names shortened first, then the least used rows go', () => {
    const wide = Array.from({ length: 300 }, (_, i) => row(i + 2, { name: '\u{1F600}'.repeat(40) + i, user: `user-${i % 30}` }))
    const line = encodeProcessLine(table(wide), meta)!
    assert.ok(line.length <= PROCESS_MAX_CHARS, `${line.length} characters`)
    const back = decodeProcessLine(line)!
    assert.ok(back.rows.length > 10)
    assert.ok(back.rows.every((r) => r.name.length <= 48))
    assert.equal(encodeProcessLine(table(wide), meta, 100), null, 'nothing rather than a line over the cap')
  })

  test('unknown figures travel as null', () => {
    const back = decodeProcessLine(encodeProcessLine(table([row(5, { cpu: null, mem: 9, energy: null, ppid: null, user: null, start: null })]), meta))!
    assert.deepEqual(back.rows[0], { pid: 5, ppid: null, name: 'tool-5', user: null, cpu: null, mem: 0, energy: null, start: null })
  })
})

describe('a hostile or broken line', () => {
  const wire = (over: Record<string, unknown>) => PROCESS_PREFIX + JSON.stringify({ v: 1, r: 'run-x', q: 1, t: 1, iv: 30_000, n: 2, u: ['example'], p: [], ...over })

  test('anything that is not a whole, valid line is refused', () => {
    for (const bad of [null, 7, 'FLEETPS1 {', 'FLEETPS1 []', 'FLEETMON1 {}', wire({ v: 2 }), wire({ q: -1 }), wire({ q: 1.5 }), wire({ t: 'now' }), wire({ iv: 0 }), wire({ r: 5 }), wire({ p: 'x' }), PROCESS_PREFIX + '{"v":1}' + ' '.repeat(8200)]) {
      assert.equal(decodeProcessLine(bad), null, String(bad).slice(0, 40))
    }
  })

  test('rows are bounded: count, pids, names, numbers; duplicates and junk dropped', () => {
    const rows: unknown[] = [
      [1, 0, 0, 'launchd', 5, 100, 1, 1_000],
      [1, 0, 0, 'duplicate', 5, 100, 1, 1_000],
      ['2', 0, 0, 'string pid'],
      [3, -4, 99, 'evil‮name\u0007', -50, -10, -1, -5],
      [4, 0, 0, 7, 1, 1, 1, 1],
      [5, 0, 0, '', 1e12, 1e30, 1e30, 1e30, 'extra', 'entries'],
      { pid: 6 },
      [2 ** 40, 0, 0, 'huge pid', 0, 0, 0, 0]
    ]
    const back = decodeProcessLine(wire({ p: [...rows, ...Array.from({ length: 150 }, (_, i) => [100 + i, 1, 0, `n${i}`, 0, 0, 0, 0])] }))!
    assert.equal(back.rows.length, MAX_WIRE_ROWS - 5, 'at most 100 entries read, junk among them skipped')
    const byPid = new Map(back.rows.map((r) => [r.pid, r]))
    assert.equal(byPid.get(1)!.name, 'launchd')
    const evil = byPid.get(3)!
    assert.deepEqual([evil.name, evil.ppid, evil.user, evil.cpu, evil.mem, evil.energy, evil.start], ['evil�name', null, null, null, null, null, null])
    const big = byPid.get(5)!
    assert.deepEqual([big.name, big.cpu, big.mem, big.energy, big.start], ['5', 100_000, 2 ** 42 * 1024, 1_000_000, null])
    assert.equal(byPid.has(4), false, 'a name that is not text')
  })

  test('the header is bounded too', () => {
    const back = decodeProcessLine(wire({ r: 'r'.repeat(99), iv: 1e12, n: -3, cw: -1, ma: 1e15, ew: 'x', u: Array.from({ length: 40 }, () => 'u‮'.repeat(40)) }))!
    assert.deepEqual([back.run.length, back.intervalMs, back.total, back.cpuWindowMs, back.memAgeMs, back.energyWindowMs], [16, 600_000, null, null, 3_600_000, null])
  })
})

describe('in a log', () => {
  const entry = (line: string, ts: number) => ({ ts, level: 'info', line })

  test('the newest line: last in log order, then the highest sequence of its run', () => {
    const at = (seq: number, run = 'run-a') => encodeProcessLine(table([row(9)]), { ...meta, seq, run })!
    const lines = [entry(at(4), 10), entry(at(9), 20), entry(at(7), 30), entry('fleet-monitor: noise', 31), entry(at(1, 'run-b'), 5)]
    assert.equal(readProcessLog(lines)?.run, 'run-b', 'a later line from a new run wins')
    assert.equal(readProcessLog(lines.slice(0, 4))?.seq, 9, 'within a run, the highest sequence')
    assert.equal(readProcessLog([]), null)
    assert.equal(readProcessLog([null, 5, { line: 7 }]), null)
  })

  test('beacon readers of 1.0.0, 1.1.0 and this version skip process lines', () => {
    const lines = [entry(encodeBeacon(localSample({ t: 1 }), { run: 'run-a', seq: 1, intervalMs: 5_000 })!, 1), entry(encodeProcessLine(table([row(9)]), meta)!, 2)]
    assert.equal(v100.readBeacons(lines).length, 1)
    assert.equal(v110.readBeacons(lines).length, 1)
    assert.equal(readBeacons(lines).length, 1)
    assert.equal(v110.decodeBeacon(lines[1]!.line), null)
  })

  test('the 200-line log still holds more than 10 minutes of beacons', () => {
    // Orca keeps a plugin's newest 200 lines. A Mac with everything on writes a beacon every
    // 5 s and a process line every 30 s; add an alert line every 2 minutes for good measure.
    const all: { ts: number; level: string; line: string }[] = []
    const rows = Array.from({ length: 300 }, (_, i) => row(i + 2))
    for (let t = 0, seq = 0; t <= 60 * 60_000; t += 5_000) {
      seq += 1
      const sample = localSample({ t, platform: 'darwin', macMemory: macMemory(), system: { net: { iface: 'en0', rxBytesPerSec: 1_000, txBytesPerSec: 2_000 }, disk: null, gpu: { percent: 3 }, battery: null } })
      all.push(entry(encodeBeacon(sample, { run: 'run-a', seq, intervalMs: 5_000, processes: true })!, t))
      if (t % PROCESS_INTERVAL_MS === 0) all.push(entry(encodeProcessLine(table(rows, { takenAt: t }), { ...meta, seq })!, t))
      if (t % 120_000 === 0) all.push(entry('fleet-monitor: strained alert "Example" sent; Orca answered delivered: true', t))
    }
    const kept = all.slice(-200)
    for (const reader of [readBeacons, v110.readBeacons, v100.readBeacons]) {
      const beacons = reader(kept)
      const spanMs = beacons[beacons.length - 1]!.t - beacons[0]!.t
      assert.ok(spanMs >= 10 * 60_000, `${Math.round(spanMs / 60_000)} minutes`)
    }
    assert.ok(readProcessLog(kept), 'and the newest process line')
    assert.ok(kept.every((e) => e.line.length < 8_192), 'no line Orca would cut')
  })
})
