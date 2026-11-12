// The worker's steady clock (src/worker.ts): it never goes back when the wall clock is set back,
// and follows the wall clock across a sleep. Polling and history run on it.
import { assert, test } from 'orca/testing'
import { FleetPoller } from '../src/poller.ts'
import { readSettings } from '../src/settings.ts'
import { steadyClock } from '../src/worker.ts'
import { diagnosticsFor, envelope, FakeCli, FakeTime, flush, localSample, machineOf, okResult } from './helpers.ts'

test('follows the monotonic clock through a wall clock set back, and the wall clock across a sleep', () => {
  let wall = 1_800_000_000_000
  let mono = 1_000
  const now = steadyClock(
    () => wall,
    () => mono
  )
  assert.equal(now(), 1_800_000_000_000)
  wall += 5_000
  mono += 5_000
  assert.equal(now(), 1_800_000_005_000)
  wall -= 3_600_000 // set back an hour
  mono += 1_000
  assert.equal(now(), 1_800_000_006_000, 'moves on by what really passed')
  wall += 2_000
  mono += 2_000
  assert.equal(now(), 1_800_000_008_000)
  wall += 8 * 3_600_000 // asleep for eight hours: the monotonic clock did not run
  mono += 50
  assert.equal(now(), 1_800_000_008_000 + 8 * 3_600_000, 'follows a real jump forward')
  // Small disagreements between the two clocks do not add up.
  for (let i = 0; i < 1_000; i += 1) {
    wall += i % 2 ? 6 : 4
    mono += 5
    now()
  }
  assert.ok(Math.abs(now() - (1_800_000_008_000 + 8 * 3_600_000 + 5_000)) <= 1)
})

test('a wall clock set back an hour neither stops polling nor folds new history into old', async () => {
  const time = new FakeTime() // stands in for the monotonic clock
  let shift = 0
  const now = steadyClock(
    () => time.now() + shift,
    () => time.now()
  )
  const cli = new FakeCli(time, (args) => {
    if (args[0] === 'environment') return okResult(envelope({ environments: [{ id: 'env-a', name: 'A', runtimeId: 'rt-a' }] }, { runtimeId: 'local' }))
    if (args[0] === 'diagnostics') return okResult(diagnosticsFor({ collectedAt: time.now() + shift + (machineOf(args) === 'local' ? 0 : 3_600_000), runtimeId: `rt-${machineOf(args)}` }))
    return okResult(envelope({ plugins: [] }))
  })
  let sample = localSample({ t: time.now() })
  const poller = new FleetPoller(
    { run: cli.run, now, localSample: () => sample, localName: () => 'desk', pluginId: 'fleet-monitor' },
    readSettings({})
  )
  const second = async () => {
    time.advance(1_000)
    if (time.now() % 5_000 === 0) {
      sample = localSample({ t: time.now() + shift })
      poller.onLocalSample()
    }
    poller.heartbeat()
    for (let i = 0; i < 5; i += 1) await flush()
  }
  for (let s = 0; s < 60; s += 1) await second()
  const before = cli.count((a) => a[0] === 'diagnostics' && machineOf(a) === 'env-a')
  shift = -3_600_000
  for (let s = 0; s < 120; s += 1) await second()
  const reads = cli.count((a) => a[0] === 'diagnostics' && machineOf(a) === 'env-a') - before
  assert.ok(reads >= 22, `${reads} reads in the two minutes after the clock was set back`)
  const remote = poller.entries().find((e) => e.state.id === 'env-a')!.history.all()
  const ordered = remote.every((p, i) => i === 0 || p.t > remote[i - 1]!.t)
  assert.ok(ordered, 'history stays in order')
  assert.ok(now() - remote[remote.length - 1]!.t <= 6_000, 'the newest point is current')
})
