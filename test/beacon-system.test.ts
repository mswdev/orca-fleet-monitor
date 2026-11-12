// The beacon's 1.2 keys (src/beacon.ts): network, disk, GPU, battery and the process-line flag,
// round trip, hostile values, how a line too long sheds them, and 1.0.0 / 1.1.0 both ways.
import { assert, describe, test } from 'orca/testing'
import { BEACON_PREFIX, decodeBeacon, encodeBeacon } from '../src/beacon.ts'
import type { MacSystem } from '../src/model.ts'
import * as v100 from './fixtures/beacon-1.0.0.ts'
import * as v110 from './fixtures/beacon-1.1.0.ts'
import { localSample, macMemory } from './helpers.ts'

const meta = { run: 'run-a', seq: 7, intervalMs: 5_000 }
const SYSTEM: MacSystem = {
  net: { iface: 'en0', rxBytesPerSec: 4_200_000, txBytesPerSec: 310_000 },
  disk: { totalBytes: 994_662_584_320, usedBytes: 412_000_000_000, spaceAgeMs: 35_000, readBytesPerSec: 2_100_000, writeBytesPerSec: 640_000, ioAgeMs: 5_000 },
  gpu: { percent: 12, ageMs: 10_000 },
  battery: { present: true, percent: 82, state: 'charging', source: 'ac', minutesRemaining: 38, ageMs: 20_000 }
}
const mac = () => localSample({ platform: 'darwin', macMemory: macMemory(), system: SYSTEM })

describe('the 1.2 keys', () => {
  test('round-trip, with ages and the process-line flag', () => {
    const line = encodeBeacon(mac(), { ...meta, processes: true })!
    assert.ok(line.length < 1_200, `${line.length} characters`)
    const back = decodeBeacon(line)!
    assert.deepEqual(back.system, SYSTEM)
    assert.equal(back.publishesProcesses, true)
    assert.equal(decodeBeacon(encodeBeacon(mac(), meta))!.publishesProcesses, undefined, 'absent unless set')
  })

  test('a Mac without a battery, and figures not read yet', () => {
    const system: MacSystem = { net: { iface: 'utun3', rxBytesPerSec: null, txBytesPerSec: null }, disk: { totalBytes: null, usedBytes: null, readBytesPerSec: 5, writeBytesPerSec: null }, gpu: null, battery: { present: false, percent: null, state: null, source: 'ac', minutesRemaining: null } }
    const back = decodeBeacon(encodeBeacon(localSample({ system }), meta))!
    assert.deepEqual(back.system, system)
  })

  test('a beacon without them decodes as before, without the keys', () => {
    const back = decodeBeacon(encodeBeacon(localSample(), meta))!
    assert.equal('system' in back, false)
    assert.equal('publishesProcesses' in back, false)
  })

  test('hostile values are bounded or dropped, never trusted', () => {
    const wire = (extra: Record<string, unknown>) => {
      const base = JSON.parse(encodeBeacon(localSample(), meta)!.slice(BEACON_PREFIX.length)) as Record<string, unknown>
      return decodeBeacon(BEACON_PREFIX + JSON.stringify({ ...base, ...extra }))!
    }
    assert.equal(wire({ nw: { i: 'en0;rm', r: 1 } }).system, undefined, 'an interface that is not plain')
    assert.deepEqual(wire({ nw: { i: 'en0', r: -5, t: 1e20, a: 'x' } }).system?.net, { iface: 'en0', rxBytesPerSec: null, txBytesPerSec: null, ageMs: 3_600_000 })
    assert.deepEqual(wire({ dk: { s: 100, u: 5_000, r: 'fast' } }).system, undefined, 'used past the size, and no rate: nothing')
    assert.deepEqual(wire({ dk: { s: 1_000, u: 400, sa: -9 } }).system?.disk, { totalBytes: 1_000, usedBytes: 400, spaceAgeMs: 0, readBytesPerSec: null, writeBytesPerSec: null })
    assert.equal(wire({ gp: { u: 101 } }).system, undefined)
    assert.equal(wire({ gp: [12] }).system, undefined)
    assert.deepEqual(wire({ bt: { b: 1, p: 250, st: 'toString', ps: 'constructor', m: -1 } }).system?.battery, { present: true, percent: null, state: null, source: null, minutesRemaining: null })
    assert.equal(wire({ bt: { b: 'yes' } }).system, undefined)
    assert.deepEqual(wire({ bt: { b: 0, p: 50, st: 'c', m: 10 } }).system?.battery, { present: false, percent: null, state: null, source: null, minutesRemaining: null }, 'no battery: no charge either')
    assert.equal(wire({ pl: true }).publishesProcesses, undefined, 'only the literal 1')
  })

  test('a line too long sheds per-core values, then these keys, before any text', () => {
    const big = localSample({ cores: 1_500, cpu: { total: 50, perCore: Array.from({ length: 1_500 }, () => 50) }, system: SYSTEM })
    const shed = decodeBeacon(encodeBeacon(big, meta)!)!
    assert.equal(shed.perCore, null)
    assert.deepEqual(shed.system, SYSTEM, 'per-core values went first')
    const tight = encodeBeacon(localSample({ hostname: 'h'.repeat(200), system: SYSTEM, macMemory: macMemory() }), meta, 700)!
    const back = decodeBeacon(tight)!
    assert.equal(back.system, undefined)
    assert.ok(back.macMemory, 'the memory figures stay')
  })
})

describe('compatibility', () => {
  test('1.0.0 and 1.1.0 read a 1.2 beacon as they always read beacons', () => {
    const line = encodeBeacon(mac(), { ...meta, processes: true })!
    const sample = mac()
    for (const old of [v100, v110]) {
      const back = old.decodeBeacon(line, 1_800_000_000_123)!
      assert.deepEqual([back.run, back.seq, back.cpu, back.memTotal, back.cores], ['run-a', 7, sample.cpu!.total, sample.memory.total, sample.cores])
      assert.equal(old.readBeacons([{ ts: 1, level: 'info', line }]).length, 1)
    }
    assert.deepEqual(v110.decodeBeacon(line)!.macMemory, decodeBeacon(line)!.macMemory, '1.1.0 still reads the Mac memory')
  })

  test('this version reads 1.0.0 and 1.1.0 beacons exactly as they did, with nothing of 1.2', () => {
    for (const old of [v100, v110]) {
      const line = old.encodeBeacon(localSample({ platform: 'darwin' }), meta)!
      const back = decodeBeacon(line)!
      assert.equal(back.system, undefined)
      assert.equal(back.publishesProcesses, undefined)
      assert.deepEqual({ ...back, macMemory: undefined }, { ...old.decodeBeacon(line)!, macMemory: undefined })
    }
    const withMemory = v110.encodeBeacon(localSample({ platform: 'darwin', macMemory: macMemory() }), meta)!
    assert.deepEqual(decodeBeacon(withMemory)!.macMemory, v110.decodeBeacon(withMemory)!.macMemory)
  })
})
