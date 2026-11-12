import { assert, describe, test } from 'orca/testing'
import {
  assessBeacon,
  BEACON_MAX_CHARS,
  BEACON_PREFIX,
  decodeBeacon,
  emptyTracker,
  encodeBeacon,
  readBeacons
} from '../src/beacon.ts'
import * as released from './fixtures/beacon-1.0.0.ts'
import { localSample, macMemory } from './helpers.ts'

const meta = { run: 'run-a', seq: 7, intervalMs: 5_000 }

describe('encode and decode', () => {
  test('round-trips a sample', () => {
    const sample = localSample()
    const line = encodeBeacon(sample, meta)
    assert.ok(line)
    assert.ok(line.startsWith(BEACON_PREFIX))
    assert.ok(line.length < 1_000)
    assert.ok(!line.includes('\n'))
    const back = decodeBeacon(line, 1_800_000_000_123)
    assert.ok(back)
    assert.equal(back.run, 'run-a')
    assert.equal(back.seq, 7)
    assert.equal(back.t, sample.t)
    assert.equal(back.intervalMs, 5_000)
    assert.equal(back.hostname, 'test-host')
    assert.equal(back.cores, 4)
    assert.equal(back.cpu, 42.5)
    assert.deepEqual(back.perCore, [40, 45, 41, 44])
    assert.equal(back.memTotal, sample.memory.total)
    assert.equal(back.memFree, sample.memory.free)
    assert.deepEqual(back.load, [1.5, 1.25, 1])
    assert.equal(back.loggedAt, 1_800_000_000_123)
  })

  test('a first sample without CPU still encodes, with cpu null', () => {
    const back = decodeBeacon(encodeBeacon(localSample({ cpu: null }), meta))
    assert.ok(back)
    assert.equal(back.cpu, null)
    assert.equal(back.perCore, null)
  })

  test('drops per-core values first when a huge machine would not fit', () => {
    const perCore = Array.from({ length: 1_500 }, () => 99)
    const line = encodeBeacon(localSample({ cores: 1_500, cpu: { total: 99, perCore } }), meta)
    assert.ok(line)
    assert.ok(line.length <= BEACON_MAX_CHARS)
    const back = decodeBeacon(line)
    assert.ok(back)
    assert.equal(back.perCore, null)
    assert.equal(back.cpu, 99)
    assert.equal(back.cores, 1_500)
  })

  test('then trims long text fields', () => {
    const line = encodeBeacon(
      localSample({ hostname: 'h'.repeat(255), cpuModel: 'm'.repeat(300), release: 'r'.repeat(200) }),
      meta,
      600
    )
    assert.ok(line)
    assert.ok(line.length <= 600)
    assert.equal(decodeBeacon(line)?.hostname.length, 96)
  })

  test('gives up (null) rather than write a line over the cap', () => {
    assert.equal(encodeBeacon(localSample(), meta, 80), null)
  })

  test('refuses anything that is not a whole, valid beacon', () => {
    const good = encodeBeacon(localSample(), meta)!
    assert.equal(decodeBeacon('hello'), null)
    assert.equal(decodeBeacon(good.slice(BEACON_PREFIX.length)), null) // no prefix
    assert.equal(decodeBeacon(good.slice(0, good.length - 5)), null) // cut short, as Orca's 8192 cut would
    assert.equal(decodeBeacon(`${BEACON_PREFIX}[1,2,3]`), null)
    assert.equal(decodeBeacon(`${BEACON_PREFIX}${JSON.stringify({ v: 2, r: 'x', q: 1, t: 1, iv: 5000, n: 1, mt: 1, mf: 1 })}`), null)
    assert.equal(decodeBeacon(`${BEACON_PREFIX}${JSON.stringify({ v: 1, r: 'x', q: 1, t: 1, iv: 0, n: 1, mt: 1, mf: 1 })}`), null)
    assert.equal(decodeBeacon(`${BEACON_PREFIX}${JSON.stringify({ v: 1, q: 1, t: 1, iv: 5000, n: 1, mt: 1, mf: 1 })}`), null)
    assert.equal(decodeBeacon(42), null)
    assert.equal(decodeBeacon(BEACON_PREFIX + 'x'.repeat(9_000)), null)
  })

  test('bounds what a beacon may claim', () => {
    // 2,100 per-core values: more than a 4096-character beacon can hold, within Orca's 8192 cut.
    const raw = { v: 1, r: 'x', q: 1, t: 1, iv: 1e15, n: 1e9, u: 1e300, mt: 1e300, mf: 5, c: 5, pc: new Array(2_100).fill(1), l: [1e300, -4, 2, 9] }
    const back = decodeBeacon(`${BEACON_PREFIX}${JSON.stringify(raw)}`)
    assert.ok(back)
    assert.equal(back.intervalMs, 60_000, 'an interval long enough to stay fresh for hours is cut to a minute')
    assert.equal(back.cores, 4_096)
    assert.equal(back.uptimeSec, 100 * 365 * 86_400)
    assert.equal(back.memTotal, 2 ** 52)
    assert.equal(back.perCore, null, 'more per-core values than any beacon line can hold')
    assert.deepEqual(back.load, [1_000_000, 0, 2])
    assert.equal(decodeBeacon(`${BEACON_PREFIX}${JSON.stringify({ ...raw, q: -1 })}`), null, 'a negative sequence')
    assert.equal(decodeBeacon(`${BEACON_PREFIX}${JSON.stringify({ ...raw, q: 1.5 })}`), null, 'a fractional sequence')
    assert.equal(decodeBeacon(`${BEACON_PREFIX}${JSON.stringify({ ...raw, iv: 3_000 })}`)?.intervalMs, 3_000)
  })

  test('a beacon claiming a huge interval goes stale on the usual clock', () => {
    const far = decodeBeacon(`${BEACON_PREFIX}${JSON.stringify({ v: 1, r: 'x', q: 1, t: 0, iv: 1e15, n: 1, mt: 1, mf: 1 })}`)!
    const first = assessBeacon(far, emptyTracker(), { localNow: 0, remoteNow: 0 })
    assert.equal(assessBeacon(far, first.tracker, { localNow: 86_400_000, remoteNow: 86_400_000 }).fresh, false)
  })

  test('reads at most the last 400 log lines of an answer', () => {
    const line = (seq: number) => encodeBeacon(localSample({ t: seq }), { run: 'r', seq, intervalMs: 5_000 })
    const lines = Array.from({ length: 1_000 }, (_, i) => ({ ts: i, level: 'info', line: line(i + 1) }))
    const records = readBeacons(lines)
    assert.equal(records.length, 400)
    assert.equal(records[0]?.seq, 601)
  })

  test('clamps out-of-range values it does accept', () => {
    const raw = { v: 1, r: 'x', q: 1, t: 1, iv: 5000, n: 2, mt: 100, mf: 500, c: 250, pc: [-5, 300], l: [1] }
    const back = decodeBeacon(`${BEACON_PREFIX}${JSON.stringify(raw)}`)
    assert.ok(back)
    assert.equal(back.memFree, 100)
    assert.equal(back.cpu, 100)
    assert.deepEqual(back.perCore, [0, 100])
    assert.deepEqual(back.load, [1, 0, 0])
  })
})

describe('core groups (added after the first release)', () => {
  const groups = [
    { kind: 'performance' as const, start: 1, count: 3 },
    { kind: 'efficiency' as const, start: 0, count: 1 }
  ]

  test('travel with the per-core values and come back the same', () => {
    const line = encodeBeacon(localSample({ coreGroups: groups }), meta)!
    assert.match(line, /"cg":\[\["P",1,3\],\["E",0,1\]\]/)
    const back = decodeBeacon(line)
    assert.deepEqual(back?.coreGroups, groups)
  })

  test('a beacon written by the first release (no cg) still decodes, with no groups', () => {
    // Written by encodeBeacon at commit c895441, which remotes may still run.
    const old =
      'FLEETMON1 {"v":1,"r":"run-a","q":7,"t":1800000000000,"iv":5000,"h":"test-host","p":"darwin","a":"arm64","rl":"25.0.0","m":"Example Chip","n":6,"u":3600,"c":33.3,"pc":[10,20,30,40,50,60],"mt":17179869184,"mf":4294967296,"l":[1.5,1.25,1]}'
    const back = decodeBeacon(old)
    assert.ok(back)
    assert.equal(back.cpu, 33.3)
    assert.deepEqual(back.perCore, [10, 20, 30, 40, 50, 60])
    assert.equal(back.coreGroups, null)
  })

  test('keeps version 1, so the first release still reads new beacons', () => {
    const line = encodeBeacon(localSample({ coreGroups: groups }), meta)!
    const wire = JSON.parse(line.slice(BEACON_PREFIX.length)) as Record<string, unknown>
    assert.equal(wire.v, 1)
    for (const key of ['r', 'q', 't', 'iv', 'h', 'p', 'a', 'rl', 'm', 'n', 'u', 'c', 'pc', 'mt', 'mf', 'l']) {
      assert.ok(key in wire, `first-release field ${key} is still written`)
    }
  })

  test('groups that do not cover the cores exactly once are dropped, not trusted', () => {
    const wire = (cg: unknown) =>
      decodeBeacon(
        `${BEACON_PREFIX}${JSON.stringify({ v: 1, r: 'r', q: 1, t: 1, iv: 5_000, n: 4, mt: 1, mf: 1, c: 5, pc: [1, 2, 3, 4], cg })}`
      )?.coreGroups
    assert.equal(wire([['P', 0, 3]]), null, 'a core left out')
    assert.equal(wire([['P', 0, 3], ['E', 2, 2]]), null, 'overlap')
    assert.equal(wire([['X', 0, 4]]), null, 'unknown kind')
    assert.equal(wire('P4'), null, 'not a list')
    assert.deepEqual(wire([['P', 0, 4]]), [{ kind: 'performance', start: 0, count: 4 }])
  })

  test('a beacon written by 85df480 (with cg) still decodes, groups and all', () => {
    // Written by encodeBeacon at commit 85df480, which paired servers run.
    const line =
      'FLEETMON1 {"v":1,"r":"run-b","q":12,"t":1800000000000,"iv":5000,"h":"example-mini","p":"darwin","a":"arm64","rl":"25.0.0","m":"Example Chip","n":6,"u":3600,"c":33.3,"pc":[10,20,30,40,50,60],"cg":[["P",2,4],["E",0,2]],"mt":17179869184,"mf":4294967296,"l":[1.5,1.25,1]}'
    const back = decodeBeacon(line)
    assert.ok(back)
    assert.deepEqual([back.run, back.seq, back.intervalMs, back.cores, back.uptimeSec, back.cpu], ['run-b', 12, 5_000, 6, 3_600, 33.3])
    assert.deepEqual(back.coreGroups, [
      { kind: 'performance', start: 2, count: 4 },
      { kind: 'efficiency', start: 0, count: 2 }
    ])
    assert.equal(assessBeacon(back, emptyTracker(), { localNow: 0, remoteNow: 1_800_000_002_000 }).fresh, true)
  })

  test('only the literal kinds P and E: nothing from Object.prototype gets through', () => {
    const wire = (kind: unknown) =>
      decodeBeacon(`${BEACON_PREFIX}${JSON.stringify({ v: 1, r: 'r', q: 1, t: 1, iv: 5_000, n: 4, mt: 1, mf: 1, c: 5, pc: [1, 2, 3, 4], cg: [[kind, 0, 4]] })}`)
    for (const kind of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 'isPrototypeOf', 'p', 'e', 1, null]) {
      const back = wire(kind)
      assert.ok(back, String(kind))
      assert.equal(back.coreGroups, null, String(kind))
    }
  })

  test('groups without per-core values are not written', () => {
    const line = encodeBeacon(localSample({ cpu: null, coreGroups: groups }), meta)!
    assert.ok(!line.includes('"cg"'))
  })
})

test('readBeacons keeps beacons only, oldest first, across worker runs', () => {
  const line = (seq: number, t: number, run = 'run-a') => encodeBeacon(localSample({ t }), { run, seq, intervalMs: 5_000 })
  const lines = [
    { ts: 3_000, level: 'info', line: line(1, 2_990, 'run-b') },
    { ts: 1_000, level: 'info', line: line(9, 990) },
    { ts: 1_500, level: 'error', line: '[frame] panel/view.mjs:3 oops' },
    { ts: 2_000, level: 'info', line: line(10, 1_990) },
    { ts: 2_500, level: 'warn', line: 'worker reaped after idle period' },
    null,
    'not an object'
  ]
  const records = readBeacons(lines)
  assert.deepEqual(records.map((r) => [r.run, r.seq]), [['run-a', 9], ['run-a', 10], ['run-b', 1]])
  assert.deepEqual(records.map((r) => r.loggedAt), [1_000, 2_000, 3_000])
})

describe('assessBeacon', () => {
  const at = (seq: number, t: number, run = 'run-a') => decodeBeacon(encodeBeacon(localSample({ t }), { run, seq, intervalMs: 5_000 }))!

  test('fresh when the remote clock says it is recent', () => {
    const a = assessBeacon(at(1, 10_000), emptyTracker(), { localNow: 500, remoteNow: 12_000 })
    assert.equal(a.fresh, true)
    assert.equal(a.ageMs, 2_000)
    assert.equal(a.advanced, true)
  })

  test('stale when older than three intervals on the remote clock, whatever the local clock says', () => {
    const a = assessBeacon(at(1, 10_000), emptyTracker(), { localNow: 10_000, remoteNow: 26_000 })
    assert.equal(a.fresh, false)
    assert.equal(a.ageMs, 16_000)
  })

  test('cannot judge a first sighting without the remote clock', () => {
    assert.equal(assessBeacon(at(1, 10_000), emptyTracker(), { localNow: 10_000, remoteNow: null }).fresh, false)
  })

  test('without the remote clock, a sequence that keeps moving stays fresh and one that stops goes stale', () => {
    let tracker = assessBeacon(at(1, 0), emptyTracker(), { localNow: 0, remoteNow: 0 }).tracker
    const moved = assessBeacon(at(2, 5_000), tracker, { localNow: 5_000, remoteNow: null })
    assert.equal(moved.fresh, true)
    tracker = moved.tracker
    assert.equal(assessBeacon(at(2, 5_000), tracker, { localNow: 15_000, remoteNow: null }).fresh, true)
    assert.equal(assessBeacon(at(2, 5_000), tracker, { localNow: 21_000, remoteNow: null }).fresh, false)
  })

  test('a stuck sequence is stale even when a skewed remote clock looks recent', () => {
    const first = assessBeacon(at(5, 0), emptyTracker(), { localNow: 0, remoteNow: 1_000 })
    const later = assessBeacon(at(5, 0), first.tracker, { localNow: 30_000, remoteNow: 1_000 })
    assert.equal(later.fresh, false)
  })

  test('a new run id is a restart, not a sequence going backwards', () => {
    const before = assessBeacon(at(500, 0), emptyTracker(), { localNow: 0, remoteNow: 0 })
    const after = assessBeacon(at(1, 20_000, 'run-b'), before.tracker, { localNow: 20_000, remoteNow: 21_000 })
    assert.equal(after.restarted, true)
    assert.equal(after.advanced, true)
    assert.equal(after.fresh, true)
    assert.deepEqual(after.tracker, { run: 'run-b', seq: 1, advancedAt: 20_000 })
  })

  test('a sequence lower than the last one seen is a restart too, not a beacon that stopped', () => {
    const before = assessBeacon(at(500, 0), emptyTracker(), { localNow: 0, remoteNow: 0 })
    const after = assessBeacon(at(3, 20_000), before.tracker, { localNow: 20_000, remoteNow: 21_000 })
    assert.equal(after.restarted, true)
    assert.equal(after.advanced, true)
    assert.equal(after.fresh, true)
    assert.deepEqual(after.tracker, { run: 'run-a', seq: 3, advancedAt: 20_000 })
  })

  test('nothing to assess is not fresh', () => {
    assert.equal(assessBeacon(null, emptyTracker(), { localNow: 0, remoteNow: 0 }).fresh, false)
  })
})

describe('a Mac memory reading (added in 1.1)', () => {
  const GIB = 2 ** 30
  const reading = macMemory({
    pressure: 'warning',
    availablePercent: 12,
    swapUsed: Math.round(6.2 * GIB),
    swapTotal: 8 * GIB,
    swapOutsPerSec: 310.5,
    swapInsPerSec: 2,
    sustainedSwapOutsPerSec: 250
  })

  test('travels under one optional key and comes back the same', () => {
    const line = encodeBeacon(localSample({ platform: 'darwin', macMemory: reading }), meta)!
    const wire = JSON.parse(line.slice(BEACON_PREFIX.length)) as Record<string, unknown>
    assert.equal(wire.v, 1, 'still version 1')
    assert.deepEqual(Object.keys(wire.mm as object).sort(), ['a', 'c', 'k', 'pa', 'pl', 'ps', 'si', 'so', 'ss', 'st', 'su', 't', 'u', 'w'])
    assert.equal((wire.mm as { pl: number }).pl, 2, 'the kernel numbering: 2 is warning')
    assert.deepEqual(decodeBeacon(line)?.macMemory, reading)
  })

  test('a figure that could not be read is left out, and comes back as unknown', () => {
    const partial = macMemory({ swapUsed: null, swapTotal: null, pressure: null, availablePercent: null, swapInsPerSec: null, swapOutsPerSec: null })
    const line = encodeBeacon(localSample({ platform: 'darwin', macMemory: partial }), meta)!
    const wire = JSON.parse(line.slice(BEACON_PREFIX.length)) as { mm: Record<string, unknown> }
    assert.deepEqual(Object.keys(wire.mm).sort(), ['a', 'c', 'k', 'ps', 't', 'u', 'w'])
    assert.deepEqual(decodeBeacon(line)?.macMemory, partial)
  })

  test('elsewhere, or when the Mac reading failed, nothing is written', () => {
    assert.ok(!encodeBeacon(localSample(), meta)!.includes('"mm"'))
    assert.ok(!encodeBeacon(localSample({ platform: 'darwin', macMemory: null }), meta)!.includes('"mm"'))
    assert.equal(decodeBeacon(encodeBeacon(localSample(), meta))?.macMemory, null)
  })

  test('stays when per-core values are dropped to fit a huge machine', () => {
    const perCore = Array.from({ length: 1_500 }, () => 99)
    const line = encodeBeacon(localSample({ cores: 1_500, cpu: { total: 99, perCore }, macMemory: reading }), meta)!
    assert.ok(line.length <= BEACON_MAX_CHARS)
    const back = decodeBeacon(line)!
    assert.equal(back.perCore, null)
    assert.deepEqual(back.macMemory, reading)
  })

  test('every figure from another machine is bounded', () => {
    const wire = (mm: unknown) => decodeBeacon(`${BEACON_PREFIX}${JSON.stringify({ v: 1, r: 'r', q: 1, t: 1, iv: 5_000, n: 4, mt: 16 * GIB, mf: 1, mm })}`)?.macMemory
    const good = { t: 16 * GIB, u: 8 * GIB, a: 4 * GIB, w: 2 * GIB, c: 2 * GIB, k: GIB, su: GIB, st: 2 * GIB, pl: 1, pa: 50, ps: 16_384, si: 0, so: 0 }
    assert.equal(wire(good)?.used, 8 * GIB)
    assert.equal(wire({ ...good, u: 99 * GIB })?.used, 16 * GIB, 'no more in use than there is')
    assert.equal(wire({ ...good, su: 9 * GIB })?.swapUsed, 2 * GIB, 'no more swap used than there is swap')
    assert.equal(wire({ ...good, pl: 3 })?.pressure, null, 'only 1, 2 and 4 are levels')
    assert.equal(wire({ ...good, pl: 4 })?.pressure, 'critical')
    assert.equal(wire({ ...good, pa: 140 })?.availablePercent, null)
    assert.equal(wire({ ...good, so: -5 })?.swapOutsPerSec, null)
    assert.equal(wire({ ...good, so: 1e20 })?.swapOutsPerSec, 1e9)
    assert.equal(wire({ ...good, st: undefined })?.swapUsed, null, 'swap used without a swap total')
    for (const broken of [{ ...good, u: undefined }, { ...good, t: 5 }, { ...good, ps: 0 }, { ...good, a: 'x' }, { ...good, w: -1 }, 'mm', [1, 2], null]) {
      assert.equal(wire(broken), null, JSON.stringify(broken))
    }
    // JSON.parse makes "__proto__" an own key; only the known keys are ever read.
    const mm = JSON.stringify({ ...good, constructor: 'x' }).replace('{', '{"__proto__":{"polluted":1},')
    const hostile = decodeBeacon(`${BEACON_PREFIX}{"v":1,"r":"r","q":1,"t":1,"iv":5000,"n":4,"mt":1,"mf":1,"mm":${mm}}`)
    assert.ok(hostile?.macMemory)
    assert.equal((hostile.macMemory as unknown as Record<string, unknown>).polluted, undefined)
    assert.equal(Object.getPrototypeOf(hostile.macMemory), Object.prototype)
    assert.equal(({} as Record<string, unknown>).polluted, undefined)
  })

  test('the 1.0.0 reader reads what 1.1 writes, and 1.1 reads what 1.0.0 writes', () => {
    const sample = localSample({ platform: 'darwin', macMemory: reading, coreGroups: [{ kind: 'performance', start: 1, count: 3 }, { kind: 'efficiency', start: 0, count: 1 }] })
    const newLine = encodeBeacon(sample, meta)!
    const byOld = released.decodeBeacon(newLine, 1_800_000_000_123)
    const byNew = decodeBeacon(newLine, 1_800_000_000_123)
    assert.ok(byOld && byNew)
    const { macMemory: _mac, ...newWithoutMac } = byNew
    assert.deepEqual(byOld, newWithoutMac, 'every field 1.0.0 knows reads the same')
    assert.equal(released.assessBeacon(byOld, released.emptyTracker(), { localNow: 0, remoteNow: sample.t + 1_000 }).fresh, true)
    assert.equal(released.readBeacons([{ ts: 1, level: 'info', line: newLine }]).length, 1)
    // A remote still on 1.0.0 writes no memory reading: 1.1 reads it as before, with none.
    const oldLine = released.encodeBeacon(localSample({ platform: 'darwin' }), meta)!
    const fromOld = decodeBeacon(oldLine)
    assert.ok(fromOld)
    assert.equal(fromOld.macMemory, null)
    assert.deepEqual({ ...fromOld, macMemory: undefined }, { ...released.decodeBeacon(oldLine)!, macMemory: undefined })
  })
})

describe('a reading carried over a failed read (1.1.0, this round)', () => {
  const lineWith = (mm: Record<string, unknown>) => {
    const line = encodeBeacon(localSample({ platform: 'darwin', macMemory: macMemory() }), meta)!
    const wire = JSON.parse(line.slice(BEACON_PREFIX.length))
    return BEACON_PREFIX + JSON.stringify({ ...wire, mm: { ...wire.mm, ...mm } })
  }

  test('travels with the ages of its vm_stat and kernel figures, and comes back the same', () => {
    const carried = macMemory({ pressure: 'warning', ageMs: 5_000, pressureAgeMs: 10_000 })
    const line = encodeBeacon(localSample({ platform: 'darwin', macMemory: carried }), meta)!
    assert.match(line, /"va":5000,"ka":10000/)
    assert.deepEqual(decodeBeacon(line)?.macMemory, carried)
    const fresh = encodeBeacon(localSample({ platform: 'darwin', macMemory: macMemory() }), meta)!
    assert.ok(!/"va"|"ka"/.test(fresh), 'a fresh reading carries no ages')
    assert.equal(decodeBeacon(fresh)?.macMemory?.pressureAgeMs, undefined)
  })

  test('an age out of shape still says "carried", at the longest; the rest of the reading is kept', () => {
    const at = (value: unknown) => decodeBeacon(lineWith({ ka: value }))?.macMemory?.pressureAgeMs
    assert.equal(at(-5), 0)
    assert.equal(at(1e12), 3_600_000)
    assert.equal(at('5000'), 3_600_000)
    assert.equal(at(null), 3_600_000)
    assert.equal(decodeBeacon(lineWith({ va: 2_500.4 }))?.macMemory?.ageMs, 2_500)
    assert.equal(decodeBeacon(lineWith({ ka: 'x' }))?.macMemory?.used, macMemory().used)
  })
})

