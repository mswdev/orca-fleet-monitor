// The poller as the worker runs it: production concurrency limits, a tick every second, a panel
// heartbeat every 5 s, and CLI calls that take time (350 ms, or 15 s for a machine that hangs
// until the timeout). The fake clock only moves when told to. Every value here is invented.
import { assert, describe, test } from 'orca/testing'
import { encodeBeacon } from '../src/beacon.ts'
import type { CommandResult, CommandRunner } from '../src/cli.ts'
import { FleetPoller, LOCAL_ID } from '../src/poller.ts'
import { readSettings } from '../src/settings.ts'
import { statusBarView } from '../src/status-bar.ts'
import { diagnosticsFor, envelope, errorResult, FakeTime, flush, localSample, machineOf, okResult, timeoutResult } from './helpers.ts'

/** Remote clocks run an hour ahead of ours, so anything judged on the wrong clock shows up. */
const SKEW = 3_600_000
const START = 1_800_000_000_000
const KEY = 'example-owner.fleet-monitor'

type Env = { id: string; name: string; runtimeId: string }
/** A custom answer, or the usual one (no `result`) after `ms`; null for the usual one at 350 ms. */
type Answer = { result?: CommandResult; ms: number } | null

function simulate(options: {
  envs: Env[]
  respond?: (args: string[]) => Answer
  settings?: Record<string, unknown>
  /** This computer's platform; Linux when not given. */
  localPlatform?: string
}) {
  const time = new FakeTime(START)
  const plugins = new Map<string, unknown[]>()
  const logs = new Map<string, () => string>()
  const calls: { args: string[]; at: number }[] = []
  const fallback = (args: string[]): CommandResult => {
    const machine = machineOf(args)
    if (args[0] === 'environment') return okResult(envelope({ environments: options.envs }, { runtimeId: 'rt-local' }))
    if (args[0] === 'host') return okResult(envelope({ hosts: [{ kind: 'local', id: 'local', machineName: 'Desk' }] }))
    if (args[0] === 'diagnostics') {
      return okResult(
        machine === 'local'
          ? diagnosticsFor({ collectedAt: time.now(), runtimeId: 'rt-local' })
          : diagnosticsFor({ collectedAt: time.now() + SKEW, runtimeId: `rt-${machine}`, memoryPercent: 40 })
      )
    }
    if (args[0] === 'plugin' && args[1] === 'list') return okResult(envelope({ plugins: plugins.get(machine) ?? [] }))
    if (args[0] === 'plugin' && args[1] === 'logs') {
      const answer = logs.get(machine)
      return okResult(answer ? answer() : envelope({ pluginKey: args[2], lines: [], cursor: 'x:0' }))
    }
    return okResult(envelope(null))
  }
  const run: CommandRunner = (args) =>
    new Promise((resolve) => {
      const list = [...args]
      calls.push({ args: list, at: time.now() })
      const custom = options.respond?.(list) ?? null
      const ms = custom?.ms ?? 350
      time.setTimeout(() => resolve({ ...(custom?.result ?? fallback(list)), durationMs: ms }), ms)
    })
  const platform = options.localPlatform ?? 'linux'
  let sample = localSample({ t: time.now(), platform })
  // Production limits: no maxConcurrent, maxProbes or timeout passed.
  const poller = new FleetPoller(
    { run, now: time.now, localSample: () => sample, localName: () => 'desk', pluginId: 'fleet-monitor', log: () => {} },
    readSettings(options.settings ?? {})
  )
  time.setInterval(() => poller.tick(), 1_000)
  time.setInterval(() => {
    sample = localSample({ t: time.now(), platform })
    poller.onLocalSample()
  }, 5_000)
  let panelOpen = false
  time.setInterval(() => {
    if (panelOpen) poller.heartbeat()
  }, 5_000)
  const advance = async (ms: number) => {
    for (let done = 0; done < ms; done += 50) {
      time.advance(50)
      await flush(2)
    }
  }
  return {
    time,
    plugins,
    logs,
    calls,
    poller,
    openPanel() {
      panelOpen = true
      poller.heartbeat()
    },
    /** Moves the clock in 50 ms steps, letting promise chains run in between. */
    advance,
    /** Each machine's tier at the end of every second for `seconds`. */
    async watch(ids: string[], seconds: number) {
      const seen = new Map<string, string[]>(ids.map((id) => [id, []]))
      for (let s = 0; s < seconds; s += 1) {
        await advance(1_000)
        for (const id of ids) seen.get(id)!.push(poller.entries().find((e) => e.state.id === id)?.state.tier ?? 'gone')
      }
      return seen
    },
    machine: (id: string) => poller.entries().find((e) => e.state.id === id)!,
    times: (predicate: (args: string[]) => boolean, from = 0) => calls.filter((c) => c.at >= from && predicate(c.args)).map((c) => c.at)
  }
}

/** A remote that has written a beacon every 5 s since `since` (on its clock, an hour ahead), with
 *  a real sequence, and keeps Orca's 200-line log ring. */
function beaconRing(time: FakeTime, platform = 'linux', since = START - 20 * 60_000, run = 'run-a') {
  return () => {
    const total = Math.floor((time.now() - since) / 5_000)
    const lines = []
    for (let q = Math.max(1, total - 199); q <= total; q += 1) {
      const t = since + q * 5_000 + SKEW
      const line = encodeBeacon(localSample({ t, platform, cpu: { total: 30, perCore: [30, 30, 30, 30] } }), { run, seq: q, intervalMs: 5_000 })
      lines.push({ ts: t + 2, level: 'info', line })
    }
    return envelope({ pluginKey: KEY, lines, cursor: 'c:1' })
  }
}

/** A remote's Fleet Monitor log: a beacon every 5 s (local time) from `since` until `stoppedAt()`
 *  (its worker stopped), each stamped with the remote's clock when it was written (`clock`), in
 *  the order written, in Orca's 200-line ring. */
function beaconWriter(
  time: FakeTime,
  options: { clock?: (local: number) => number; stoppedAt?: () => number; since?: number; cpu?: number } = {}
) {
  const since = options.since ?? START - 20 * 60_000
  const clock = options.clock ?? ((local: number) => local + SKEW)
  return () => {
    const end = Math.min(time.now(), options.stoppedAt?.() ?? Number.POSITIVE_INFINITY)
    const total = Math.floor((end - since) / 5_000)
    const lines = []
    for (let q = Math.max(1, total - 199); q <= total; q += 1) {
      const t = clock(since + q * 5_000)
      const cpu = options.cpu ?? 30
      const line = encodeBeacon(localSample({ t, platform: 'linux', cpu: { total: cpu, perCore: [cpu, cpu, cpu, cpu] } }), { run: 'run-a', seq: q, intervalMs: 5_000 })
      lines.push({ ts: t + 2, level: 'info', line })
    }
    return envelope({ pluginKey: KEY, lines, cursor: 'c:1' })
  }
}

const tally = (tiers: string[]) => {
  const out: Record<string, number> = {}
  for (const tier of tiers) out[tier] = (out[tier] ?? 0) + 1
  return out
}

const isLogs = (machine: string) => (args: string[]) => args[0] === 'plugin' && args[1] === 'logs' && machineOf(args) === machine
const isDiag = (machine: string) => (args: string[]) => args[0] === 'diagnostics' && machineOf(args) === machine
const isList = (machine: string) => (args: string[]) => args[0] === 'plugin' && args[1] === 'list' && machineOf(args) === machine
const gaps = (times: number[]) => times.slice(1).map((t, i) => t - times[i]!)
const running = [{ pluginKey: KEY, status: 'running', isDev: false }]

describe('machines that hang', () => {
  test('two machines that time out do not slow the others (production limits)', async () => {
    const sim = simulate({
      envs: [
        { id: 'env-ok', name: 'Healthy', runtimeId: 'rt-ok' },
        { id: 'env-hang1', name: 'Asleep 1', runtimeId: 'rt-h1' },
        { id: 'env-hang2', name: 'Asleep 2', runtimeId: 'rt-h2' }
      ],
      respond: (args) => (machineOf(args).startsWith('env-hang') ? { result: timeoutResult(), ms: 15_000 } : null)
    })
    sim.plugins.set('env-ok', running)
    sim.logs.set('env-ok', beaconRing(sim.time))
    sim.openPanel()
    await sim.advance(20_000)
    const from = sim.time.now()
    await sim.advance(160_000)
    assert.equal(sim.machine('env-ok').state.tier, 'full')
    const beaconGaps = gaps(sim.times(isLogs('env-ok'), from))
    assert.ok(Math.max(...beaconGaps) <= 6_000, `healthy beacon reads every 5 s, not ${Math.max(...beaconGaps)} ms`)
    const localGaps = gaps(sim.times(isDiag('local'), from))
    assert.ok(Math.max(...localGaps) <= 16_000, `this computer's diagnostics every 15 s, not ${Math.max(...localGaps)} ms`)
    const points = sim.machine('env-ok').history.all().filter((p) => p.t > sim.time.now() - 160_000).length
    assert.ok(points >= 31, `${points} history points in 160 s at 5 s`)
    assert.equal(sim.machine('env-hang1').state.status, 'offline')
  })
})

describe('a beacon that stops arriving', () => {
  for (const [label, answer, minPoints] of [
    ['answers an error', { result: errorResult('runtime_error', 'boom'), ms: 350 }, 10],
    // Each hung read holds the machine for 15 s; failed reads back off, so diagnostics fit between.
    ['hangs until the timeout', { result: timeoutResult(), ms: 15_000 }, 5]
  ] as const) {
    test(`goes stale on time while the log ${label}, and diagnostics take over`, async () => {
      let failing = false
      const sim = simulate({ envs: [{ id: 'env-a', name: 'A', runtimeId: 'rt-a' }], respond: (args) => (failing && isLogs('env-a')(args) ? answer : null) })
      sim.plugins.set('env-a', running)
      sim.logs.set('env-a', beaconRing(sim.time))
      sim.openPanel()
      await sim.advance(60_000)
      assert.equal(sim.machine('env-a').state.tier, 'full')
      failing = true
      await sim.advance(25_000)
      const m = sim.machine('env-a').state
      assert.equal(m.tier, 'basic', 'demoted within 25 s')
      assert.equal(m.beacon.state, 'stale')
      assert.equal(m.cpu.source, 'load')
      const before = sim.machine('env-a').history.size
      await sim.advance(60_000)
      const added = sim.machine('env-a').history.size - before
      assert.ok(added >= minPoints, `diagnostics make history points again (${added} in 60 s)`)
      if (minPoints >= 10) assert.ok(Math.max(...gaps(sim.times(isDiag('env-a'), sim.time.now() - 50_000))) <= 6_000, 'at the basic cadence')
    })
  }
})

describe('history', () => {
  test('after a brief outage, a Mac keeps every point it had; the back-fill only fills the gap', async () => {
    let offline = false
    const sim = simulate({
      envs: [{ id: 'env-a', name: 'A', runtimeId: 'rt-a' }],
      respond: (args) => (offline && machineOf(args) === 'env-a' ? { result: timeoutResult(), ms: 3_000 } : null)
    })
    sim.plugins.set('env-a', running)
    sim.logs.set('env-a', beaconRing(sim.time, 'darwin'))
    sim.openPanel()
    await sim.advance(25 * 60_000)
    assert.equal(sim.machine('env-a').state.tier, 'full')
    const before = sim.machine('env-a').history.all().filter((p) => p.mem !== null && p.t > sim.time.now() - 25 * 60_000)
    assert.ok(before.length > 250, `${before.length} points with memory`)
    offline = true
    await sim.advance(25_000)
    assert.equal(sim.machine('env-a').state.status, 'offline')
    offline = false
    await sim.advance(90_000)
    assert.equal(sim.machine('env-a').state.tier, 'full')
    const after = new Map(sim.machine('env-a').history.all().map((p) => [p.t, p]))
    const cutoff = sim.time.now() - 30 * 60_000
    const lost = before.filter((p) => p.t > cutoff && after.get(p.t)?.mem !== p.mem)
    assert.equal(lost.length, 0, `${lost.length} points lost their memory reading`)
  })

  test('a first promotion back-fills around the readings already taken: none is replaced', async () => {
    const sim = simulate({ envs: [{ id: 'env-a', name: 'A', runtimeId: 'rt-a' }] })
    sim.logs.set('env-a', beaconRing(sim.time, 'darwin'))
    sim.openPanel()
    // Fleet Monitor is not listed there yet: three minutes on the basic tier, from diagnostics.
    await sim.advance(180_000)
    assert.equal(sim.machine('env-a').state.tier, 'basic')
    const basic = sim.machine('env-a').history.all()
    assert.ok(basic.length >= 30 && basic.every((p) => p.mem !== null), 'diagnostics points carry memory')
    sim.plugins.set('env-a', running)
    await sim.advance(40_000)
    assert.equal(sim.machine('env-a').state.tier, 'full')
    const after = new Map(sim.machine('env-a').history.all().map((p) => [p.t, p]))
    const replaced = basic.filter((p) => after.get(p.t)?.mem !== p.mem || after.get(p.t)?.cpu !== p.cpu)
    assert.equal(replaced.length, 0, `${replaced.length} readings replaced by the back-fill`)
    assert.ok(after.size > basic.length + 100, 'the 16 minutes before were filled in')
  })

  test('a beacon written while a slow read was out still becomes a point', async () => {
    let reads = 0
    const sim = simulate({
      envs: [{ id: 'env-a', name: 'A', runtimeId: 'rt-a' }],
      // Every third log read is slow, so two beacons can land between reads.
      respond: (args) => (isLogs('env-a')(args) && ++reads % 3 === 0 ? { result: okResult(beaconRing(sim.time)()), ms: 6_000 } : null)
    })
    sim.plugins.set('env-a', running)
    sim.logs.set('env-a', beaconRing(sim.time))
    sim.openPanel()
    await sim.advance(60_000)
    const from = sim.time.now()
    await sim.advance(300_000)
    const points = sim.machine('env-a').history.all().filter((p) => p.t > from).length
    assert.ok(points >= 300_000 / 5_000 - 2, `${points} points for ${300_000 / 5_000} beacons`)
  })

  test('every beacon becomes a history point, and basic machines are read every 5 s', async () => {
    const sim = simulate({ envs: [{ id: 'env-full', name: 'F', runtimeId: 'rt-f' }, { id: 'env-basic', name: 'B', runtimeId: 'rt-b' }] })
    sim.plugins.set('env-full', running)
    sim.logs.set('env-full', beaconRing(sim.time))
    sim.openPanel()
    await sim.advance(60_000)
    const from = sim.time.now()
    await sim.advance(300_000)
    const written = 300_000 / 5_000
    const points = sim.machine('env-full').history.all().filter((p) => p.t > from).length
    assert.ok(points >= written - 1, `${points} history points for ${written} beacons`)
    const reads = sim.times(isDiag('env-basic'), from).length
    assert.ok(reads >= 59 && reads <= 61, `${reads} diagnostics reads of a basic machine in 5 minutes`)
  })
})

describe('remote plugin lists', () => {
  test('a plugin list that keeps failing is read less and less often', async () => {
    const sim = simulate({
      envs: [{ id: 'env-old', name: 'Old', runtimeId: 'rt-o' }],
      respond: (args) => (isList('env-old')(args) ? { result: errorResult('unknown_method', 'no plugins here'), ms: 350 } : null)
    })
    sim.openPanel()
    await sim.advance(5 * 60_000)
    const reads = sim.times(isList('env-old')).length
    assert.ok(reads <= 8, `${reads} plugin list reads in 5 minutes`)
    assert.equal(sim.machine('env-old').state.status, 'online')
  })

  test('with several copies, a stale one gives way to one that is beaconing', async () => {
    // The development copy has its beacon off: its log holds only beacons from ten minutes ago.
    const frozen = beaconRing(new FakeTime(START - 10 * 60_000), 'linux', START - 30 * 60_000, 'run-old')
    const sim = simulate({
      envs: [{ id: 'env-a', name: 'A', runtimeId: 'rt-a' }],
      respond: (args) => (isLogs('env-a')(args) && args[2] === 'local.fleet-monitor' ? { result: okResult(frozen()), ms: 350 } : null)
    })
    sim.plugins.set('env-a', [
      { pluginKey: 'local.fleet-monitor', status: 'running', isDev: true },
      { pluginKey: KEY, status: 'running', isDev: false }
    ])
    sim.logs.set('env-a', beaconRing(sim.time))
    sim.openPanel()
    await sim.advance(60_000)
    const m = sim.machine('env-a').state
    assert.equal(m.tier, 'full')
    assert.equal(m.beacon.pluginKey, KEY)
    assert.deepEqual(sim.calls.filter((c) => isLogs('env-a')(c.args)).slice(0, 4).map((c) => c.args[2]), ['local.fleet-monitor', 'local.fleet-monitor', 'local.fleet-monitor', KEY])
  })

  test('a malformed plugin key never reaches the CLI', async () => {
    const sim = simulate({ envs: [{ id: 'env-a', name: 'A', runtimeId: 'rt-a' }] })
    sim.plugins.set('env-a', [{ pluginKey: '--approve=x.fleet-monitor', status: 'running', isDev: false }])
    sim.openPanel()
    await sim.advance(30_000)
    assert.equal(sim.times(isLogs('env-a')).length, 0)
    assert.equal(sim.machine('env-a').state.beacon.remotePlugin, 'absent')
  })
})

describe('a full-tier machine read less often than its beacon is written', () => {
  const env = { id: 'env-a', name: 'A', runtimeId: 'rt-a' }

  test('with no panel open (slow interval, 60 s) it stays full between reads', async () => {
    const sim = simulate({ envs: [env] })
    sim.plugins.set('env-a', running)
    sim.logs.set('env-a', beaconRing(sim.time))
    await sim.advance(3 * 60_000)
    const from = sim.time.now()
    const tiers = (await sim.watch(['env-a'], 5 * 60)).get('env-a')!
    assert.deepEqual(tally(tiers), { full: 300 })
    const reads = gaps(sim.times(isLogs('env-a'), from))
    assert.ok(reads.length >= 4 && Math.min(...reads) >= 55_000, `its log is read once a minute (${reads.join(', ')} ms)`)
    assert.equal(sim.machine('env-a').state.cpu.source, 'beacon', 'judged on its measured CPU, not memory alone')
  })

  for (const fast of [15, 60]) {
    test(`with a panel open and the fast interval at ${fast} s it stays full`, async () => {
      const sim = simulate({ envs: [env], settings: { fastIntervalSeconds: fast } })
      sim.plugins.set('env-a', running)
      sim.logs.set('env-a', beaconRing(sim.time))
      sim.openPanel()
      await sim.advance(3 * 60_000)
      const from = sim.time.now()
      const tiers = (await sim.watch(['env-a'], 5 * 60)).get('env-a')!
      assert.deepEqual(tally(tiers), { full: 300 })
      const reads = gaps(sim.times(isLogs('env-a'), from))
      assert.ok(Math.min(...reads) >= fast * 1_000 - 1_000, `read every ${fast} s (${reads.join(', ')} ms)`)
    })
  }

  test('a round of reads longer than 15 s (many machines, slow answers) keeps every one full from its first reading', async () => {
    const envs = Array.from({ length: 12 }, (_, i) => ({ id: `env-${i}`, name: `Box ${i}`, runtimeId: `rt-${i}` }))
    const sim = simulate({ envs, respond: (args) => (machineOf(args).startsWith('env-') ? { ms: 2_500 } : null) })
    for (const e of envs) {
      sim.plugins.set(e.id, running)
      sim.logs.set(e.id, beaconRing(sim.time))
    }
    sim.openPanel()
    const seen = await sim.watch(envs.map((e) => e.id), 4 * 60)
    for (const [id, tiers] of seen) {
      const first = tiers.indexOf('full')
      assert.ok(first !== -1 && first < 90, `${id} reaches the full tier (after ${first} s)`)
      assert.deepEqual(tally(tiers.slice(first)), { full: tiers.length - first }, `${id} stays full from then on`)
    }
    const reads = gaps(sim.times(isLogs('env-0'), START + 90_000))
    assert.ok(Math.max(...reads) > 15_000, `the round takes longer than 15 s (gaps up to ${Math.max(...reads)} ms)`)
  })

  for (const [label, answer] of [
    ['answers an error', { result: errorResult('runtime_error', 'boom'), ms: 350 }],
    ['hangs until the timeout', { result: timeoutResult(), ms: 15_000 }]
  ] as const) {
    test(`a log that ${label} is still demoted within 20 s with the panel open`, async () => {
      let failing = false
      const sim = simulate({ envs: [env], respond: (args) => (failing && isLogs('env-a')(args) ? answer : null) })
      sim.plugins.set('env-a', running)
      sim.logs.set('env-a', beaconRing(sim.time))
      sim.openPanel()
      await sim.advance(60_000)
      assert.equal(sim.machine('env-a').state.tier, 'full')
      failing = true // the last good read starts before this moment
      const tiers = (await sim.watch(['env-a'], 30)).get('env-a')!
      const demotedAfter = tiers.indexOf('basic') + 1
      assert.ok(demotedAfter > 0 && demotedAfter <= 21, `demoted ${demotedAfter} s after the log stopped answering`)
      assert.deepEqual(tally(tiers.slice(demotedAfter)), { basic: tiers.length - demotedAfter })
    })
  }

  test('a beacon that stops moving is demoted within about 20 s with the panel open, and by the next read without one', async () => {
    for (const panel of [true, false]) {
      let stoppedAt = Number.POSITIVE_INFINITY
      const sim = simulate({ envs: [env] })
      sim.plugins.set('env-a', running)
      sim.logs.set('env-a', beaconWriter(sim.time, { stoppedAt: () => stoppedAt }))
      if (panel) sim.openPanel()
      await sim.advance(3 * 60_000)
      assert.equal(sim.machine('env-a').state.tier, 'full')
      // Its worker stops; the log still answers, with the last beacon it wrote.
      stoppedAt = sim.time.now()
      const tiers = (await sim.watch(['env-a'], 90)).get('env-a')!
      const demotedAfter = tiers.indexOf('basic') + 1
      // Without a panel: the next read, 60 s on, which may wait behind that machine's
      // diagnostics and plugin list (one call per machine at a time).
      const limit = panel ? 21 : 65
      assert.ok(demotedAfter > 0 && demotedAfter <= limit, `${panel ? 'panel open' : 'no panel'}: demoted ${demotedAfter} s after the last beacon`)
      assert.deepEqual(tally(tiers.slice(demotedAfter)), { basic: tiers.length - demotedAfter })
    }
  })
})

describe('machines that stop answering together', () => {
  const full = (id: string) => ({ id, name: id, runtimeId: `rt-${id}` })

  test('cost the others one timeout at most, and a full-tier machine stays full', async () => {
    let dropped = false
    const lost = new Set(['env-x', 'env-y'])
    const sim = simulate({
      envs: [full('env-h'), full('env-x'), full('env-y')],
      respond: (args) => (dropped && lost.has(machineOf(args)) ? { result: timeoutResult(), ms: 15_000 } : null)
    })
    for (const id of ['env-h', 'env-x', 'env-y']) {
      sim.plugins.set(id, running)
      sim.logs.set(id, beaconRing(sim.time))
    }
    sim.openPanel()
    await sim.advance(60_000)
    assert.equal(sim.machine('env-x').state.tier, 'full')
    dropped = true // a VPN drops: both stop answering at once
    const from = sim.time.now()
    const tiers = (await sim.watch(['env-h'], 120)).get('env-h')!
    assert.deepEqual(tally(tiers), { full: 120 }, 'the machine that still answers stays full')
    const healthy = gaps(sim.times(isLogs('env-h'), from - 5_000))
    assert.ok(Math.max(...healthy) <= 16_000, `its log waits one timeout at most (${Math.max(...healthy)} ms)`)
    const later = gaps(sim.times(isLogs('env-h'), from + 20_000))
    assert.ok(Math.max(...later) <= 6_000, `then it is read every 5 s again (${Math.max(...later)} ms)`)
    const local = gaps(sim.times(isDiag('local'), from - 15_000))
    assert.ok(Math.max(...local) <= 31_000, `this computer's diagnostics wait one timeout at most (${Math.max(...local)} ms)`)
    assert.equal(sim.machine('env-x').state.status, 'offline')
  })

  test('a log read that hangs while diagnostics work is retried in the probe lane, not the shared one', async () => {
    const hung = new Set(['env-l1', 'env-l2'])
    const sim = simulate({
      envs: [full('env-h'), full('env-l1'), full('env-l2')],
      respond: (args) => (args[1] === 'logs' && hung.has(machineOf(args)) ? { result: timeoutResult(), ms: 15_000 } : null)
    })
    for (const id of ['env-h', 'env-l1', 'env-l2']) {
      sim.plugins.set(id, running)
      sim.logs.set(id, beaconRing(sim.time))
    }
    sim.openPanel()
    await sim.advance(20_000)
    const from = sim.time.now()
    const tiers = (await sim.watch(['env-h'], 4 * 60)).get('env-h')!
    assert.deepEqual(tally(tiers), { full: 240 })
    const healthy = gaps(sim.times(isLogs('env-h'), from))
    assert.ok(Math.max(...healthy) <= 6_000, `the healthy machine's log is read every 5 s (${Math.max(...healthy)} ms)`)
    assert.ok(sim.times(isLogs('env-l1'), from).length >= 3, 'the hung log is still retried')
    assert.equal(sim.machine('env-l1').state.status, 'online', 'its diagnostics still come')
  })
})

test("this computer's memory stays measured between slow reads, whatever the slow interval", async () => {
  // A Mac, whose own os.freemem() cannot be trusted: without Orca's diagnostics, memory is unknown.
  const sim = simulate({ envs: [], settings: { slowIntervalSeconds: 600 }, localPlatform: 'darwin' })
  await sim.advance(30_000)
  const misses: number[] = []
  for (let s = 0; s < 30 * 6; s += 1) {
    await sim.advance(10_000)
    const m = sim.machine(LOCAL_ID).state
    if (m.memory?.source !== 'orca' || m.health.memory === null) misses.push(s * 10)
  }
  assert.equal(misses.length, 0, `memory unknown at ${misses.slice(0, 5).join(', ')} s …`)
  const reads = gaps(sim.times(isDiag('local')))
  assert.ok(Math.min(...reads) >= 590_000, 'diagnostics are read every 10 minutes')
  assert.match(statusBarView(sim.poller.entries().map((e) => e.state)).tooltip, /mem 40%/)
})

describe('a remote clock set back', () => {
  for (const panel of [true, false]) {
    test(`an hour does not demote it until its old beacons leave the log (${panel ? 'panel open' : 'no panel'})`, async () => {
      let stepAt = Number.POSITIVE_INFINITY
      const clock = (local: number) => local + SKEW - (local >= stepAt ? 3_600_000 : 0)
      const sim: ReturnType<typeof simulate> = simulate({
        envs: [{ id: 'env-a', name: 'A', runtimeId: 'rt-a' }],
        respond: (args) =>
          isDiag('env-a')(args)
            ? { result: okResult(diagnosticsFor({ collectedAt: clock(sim.time.now()), runtimeId: 'rt-env-a', memoryPercent: 40 })), ms: 350 }
            : null
      })
      sim.plugins.set('env-a', running)
      sim.logs.set('env-a', beaconWriter(sim.time, { clock }))
      if (panel) sim.openPanel()
      await sim.advance(3 * 60_000)
      assert.equal(sim.machine('env-a').state.tier, 'full')
      stepAt = sim.time.now() + 2_500
      const tiers = (await sim.watch(['env-a'], 5 * 60)).get('env-a')!
      assert.ok((tally(tiers).basic ?? 0) <= 2, `basic for ${tally(tiers).basic} s of the 5 minutes after`)
      assert.equal(tiers[tiers.length - 1], 'full')
      const now = sim.time.now()
      assert.ok(sim.machine('env-a').history.all().every((p) => p.t <= now), 'no history point lands in the future')
    })
  }
})

test('this computer keeps its history on the poller clock', async () => {
  const sim = simulate({ envs: [] })
  sim.openPanel()
  await sim.advance(60_000)
  const local = sim.machine(LOCAL_ID)
  assert.ok(local.history.size >= 11)
  assert.ok(Math.abs(local.history.last()!.t - sim.time.now()) <= 5_000)
})
