import { assert, test } from 'orca/testing'
import { downsample, HistoryRing, toColumns } from '../src/history.ts'

const p = (t: number, cpu: number | null = 10, mem: number | null = 20) => ({ t, cpu, mem })

test('appends in order and replaces a point that comes too soon after the newest', () => {
  const ring = new HistoryRing(60_000)
  assert.equal(ring.add(p(1_000), 1_000), true)
  assert.equal(ring.add(p(6_000), 6_000), true)
  assert.equal(ring.add(p(6_400, 99), 6_400), true)
  assert.deepEqual(ring.all().map((x) => [x.t, x.cpu]), [[1_000, 10], [6_400, 99]])
})

test('keeps only the window, and never more than the cap', () => {
  const ring = new HistoryRing(10_000, 3)
  for (let t = 0; t <= 20_000; t += 2_000) ring.add(p(t), t)
  assert.deepEqual(ring.all().map((x) => x.t), [16_000, 18_000, 20_000])
  const wide = new HistoryRing(60_000)
  for (let t = 0; t <= 20_000; t += 2_000) wide.add(p(t), t)
  wide.trim(75_000)
  assert.deepEqual(wide.all().map((x) => x.t), [16_000, 18_000, 20_000])
})

test('backfill inserts older points in time order and skips ones that crowd a neighbour', () => {
  const ring = new HistoryRing(60_000)
  ring.add(p(30_000), 30_000)
  ring.add(p(35_000), 35_000)
  assert.equal(ring.add(p(10_000), 35_000), true)
  assert.equal(ring.add(p(20_000), 35_000), true)
  assert.equal(ring.add(p(20_500), 35_000), false)
  assert.equal(ring.add(p(29_800), 35_000), false)
  assert.equal(ring.add(p(-40_000), 35_000), false) // outside the window
  assert.deepEqual(ring.all().map((x) => x.t), [10_000, 20_000, 30_000, 35_000])
  assert.deepEqual(ring.since(20_000).map((x) => x.t), [30_000, 35_000])
})

test('refuses points far in the future or not a number', () => {
  const ring = new HistoryRing(60_000)
  assert.equal(ring.add(p(1_000_000), 0), false)
  assert.equal(ring.add(p(Number.NaN), 0), false)
})

test('columns round to one decimal and keep nulls', () => {
  assert.deepEqual(toColumns([p(1, 12.345, null), p(2, null, 50)]), { t: [1, 2], cpu: [12.3, null], mem: [null, 50] })
})

test('downsample keeps the newest point', () => {
  const cols = toColumns([p(1), p(2), p(3), p(4), p(5)])
  assert.deepEqual(downsample(cols, 2).t, [1, 3, 5])
  assert.deepEqual(downsample(cols, 4).t, [1, 5])
  assert.deepEqual(downsample(cols, 1), cols)
})

test('insertMissing fills gaps only: it never replaces or crowds a point already there', () => {
  const ring = new HistoryRing(60_000)
  ring.add(p(10_000, 10, 50), 30_000)
  ring.add(p(20_000, 20, 60), 30_000)
  assert.equal(ring.insertMissing(p(20_000, 99, null), 30_000, 2_500), false, 'same time')
  assert.equal(ring.insertMissing(p(21_000, 99, null), 30_000, 2_500), false, 'too close to the newest: not replaced')
  assert.equal(ring.insertMissing(p(9_000, 99, null), 30_000, 2_500), false, 'too close to the oldest')
  assert.equal(ring.insertMissing(p(15_000, 15, null), 30_000, 2_500), true)
  assert.equal(ring.insertMissing(p(25_000, 25, null), 30_000, 2_500), true, 'after the newest, as a new point')
  assert.equal(ring.insertMissing(p(-40_000), 30_000, 2_500), false, 'outside the window')
  assert.deepEqual(ring.all().map((x) => [x.t, x.cpu, x.mem]), [
    [10_000, 10, 50],
    [15_000, 15, null],
    [20_000, 20, 60],
    [25_000, 25, null]
  ])
})
