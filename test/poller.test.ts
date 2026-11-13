import { assert, describe, test } from 'orca/testing'
import { FleetPoller, LOCAL_ID, type PollerDeps } from '../src/poller.ts'
import { readSettings } from '../src/settings.ts'
import {
  beaconLogs,
  diagnosticsFor,
  envelope,
  FakeCli,
  FakeTime,
  flush,
  isDiag,
  isEnvList,
  isLogs,
  localSample,
  machineOf,
  okResult,
  timeoutResult,
  type Reply
} from './helpers.ts'

type Env = { id: string; name: string; runtimeId: string }

/** Remote clocks run an hour ahead of ours, so anything judged on the wrong clock shows up. */
const SKEW = 3_600_000

function setup(options: {
  envs?: Env[]
  respond?: (args: string[], time: FakeTime, fallback: (args: string[]) => Reply) => Reply
  /** Left out, the poller uses its production limits. */
  maxConcurrent?: number
  maxProbes?: number
  idleWhenSlow?: () => boolean
  settings?: Record<string, unknown>
} = {}) {
  const time = new FakeTime()
  const state = { envs: options.envs ?? [], plugins: new Map<string, unknown[]>(), logs: new Map<string, () => string>() }
  const fallback = (args: string[]): Reply => {
    const machine = machineOf(args)
    if (isEnvList(args)) return okResult(envelope({ environments: state.envs }, { runtimeId: 'local' }))
    if (args[0] === 'diagnostics') {
      return okResult(
        machine === 'local'
          ? diagnosticsFor({ collectedAt: time.now(), runtimeId: 'rt-local' })
          : diagnosticsFor({ collectedAt: time.now() + SKEW, runtimeId: `rt-${machine}`, load1: 2, cores: 8 })
      )
    }
    if (args[0] === 'plugin' && args[1] === 'list') return okResult(envelope({ plugins: state.plugins.get(machine) ?? [] }))
    if (args[0] === 'plugin' && args[1] === 'logs') {
      const logs = state.logs.get(machine)
      return okResult(logs ? logs() : envelope({ pluginKey: args[2], lines: [], cursor: 'x:0' }))
    }
    return okResult(envelope(null))
  }
  const cli = new FakeCli(time, (args) => (options.respond ? options.respond(args, time, fallback) : fallback(args)))
  let sample = localSample({ t: time.now() })
  const changes = { count: 0 }
  const deps: PollerDeps = {
    run: cli.run,
    now: time.now,
    localSample: () => sample,
    localName: () => 'this-desktop',
    pluginId: 'fleet-monitor',
    maxConcurrent: options.maxConcurrent,
    maxProbes: options.maxProbes,
    idleWhenSlow: options.idleWhenSlow,
    onChange: () => {
      changes.count += 1
    }
  }
  const poller = new FleetPoller(deps, readSettings(options.settings ?? {}))
  return {
    time,
    cli,
    poller,
    state,
    changes,
    setSample: (next: ReturnType<typeof localSample>) => {
      sample = next
    },
    /** Lets every held or queued call finish, including the reads they chain into. */
    drain: async () => {
      for (let i = 0; i < 100; i += 1) {
        await flush()
        if (cli.held === 0 && poller.inFlight() === 0) return
        cli.release()
      }
      throw new Error('poller did not settle')
    },
    machine: (id: string) => poller.entries().find((e) => e.state.id === id)
  }
}

const runningPlugin = (key = 'local.fleet-monitor') => [{ pluginKey: key, status: 'running', isDev: true }]

describe('concurrency', () => {
  test('one call per machine at a time, within the production limits of each lane', async () => {
    // The production limits (DEFAULT_MAX_CONCURRENT, DEFAULT_MAX_PROBES): two in each lane.
    const lanes = 2 + 2
    const envs = ['a', 'b', 'c', 'd'].map((x) => ({ id: `env-${x}`, name: `Box ${x}`, runtimeId: `rt-${x}` }))
    const t = setup({ envs }) // no limits passed: what the worker runs with
    t.cli.hold = true
    t.poller.heartbeat()
    assert.equal(t.cli.held, 2, 'this computer: the machine list and its own diagnostics')
    t.poller.tick()
    assert.equal(t.cli.held, 2, 'no more calls start while both are running')
    t.cli.release()
    await flush()
    // The list is in: four machines connecting, read two at a time in their own lane, while this
    // computer's lane carries on.
    const remote = () => t.cli.calls.filter((c) => machineOf(c.args).startsWith('env-')).length
    assert.equal(remote(), 2)
    assert.ok(t.cli.held <= lanes)
    await t.drain()
    assert.ok(t.cli.maxInFlight <= lanes, `${t.cli.maxInFlight} at once`)
    assert.equal(t.cli.maxPerMachine, 1)
    for (const env of envs) {
      assert.equal(t.cli.count(isDiag(env.id)), 1, `diagnostics for ${env.id}`)
      assert.equal(t.cli.count((a) => a[1] === 'list' && machineOf(a) === env.id), 1, `plugin list for ${env.id}`)
    }
    assert.equal(t.poller.entries().length, 5)
    assert.equal(t.machine('env-a')?.state.status, 'online')
  })

  test('the limits can be set lower, and are kept', async () => {
    const envs = ['a', 'b', 'c'].map((x) => ({ id: `env-${x}`, name: `Box ${x}`, runtimeId: `rt-${x}` }))
    const t = setup({ envs, maxConcurrent: 1, maxProbes: 1 })
    t.poller.heartbeat()
    await t.drain()
    assert.ok(t.cli.maxInFlight <= 2)
    assert.equal(t.poller.entries().length, 4)
  })

  test('a slow machine does not hold up the others', async () => {
    const envs = [{ id: 'env-slow', name: 'Slow', runtimeId: 'rt-s' }, { id: 'env-fast', name: 'Fast', runtimeId: 'rt-f' }]
    let releaseSlow: () => void = () => {}
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve
    })
    const t = setup({
      envs,
      maxConcurrent: 3,
      respond: (args, _time, fallback) => (machineOf(args) === 'env-slow' ? slow.then(() => fallback(args)) : fallback(args))
    })
    t.poller.heartbeat()
    await flush(20)
    assert.equal(t.machine('env-fast')?.state.status, 'online')
    assert.equal(t.machine('env-slow')?.state.status, 'connecting')
    releaseSlow()
    await t.drain()
    assert.equal(t.machine('env-slow')?.state.status, 'online')
  })
})

describe('failures and back-off', () => {
  test('a machine that never answers is offline and retried after 1, 2, then 4 intervals', async () => {
    const t = setup({
      envs: [{ id: 'env-a', name: 'A', runtimeId: 'rt-a' }],
      respond: (args, _time, fallback) => (isDiag('env-a')(args) ? timeoutResult() : fallback(args))
    })
    t.poller.heartbeat()
    await t.drain()
    assert.equal(t.machine('env-a')?.state.status, 'offline')
    assert.equal(t.machine('env-a')?.state.health.level, 'unknown')
    assert.match(t.machine('env-a')?.state.error ?? '', /timed out/)
    const callTimes: number[] = [t.time.now()]
    for (let s = 1; s <= 40; s += 1) {
      t.time.advance(1_000)
      t.poller.heartbeat() // keep fast mode on, as an open panel does
      await t.drain()
      const n = t.cli.count(isDiag('env-a'))
      if (n > callTimes.length) callTimes.push(t.time.now())
    }
    const gaps = callTimes.slice(1).map((at, i) => (at - callTimes[i]!) / 1_000)
    assert.deepEqual(gaps.slice(0, 3), [5, 10, 20])
    assert.equal(t.cli.count((a) => machineOf(a) === 'env-a' && a[0] === 'plugin'), 0, 'no plugin calls while offline')
  })

  test('one missed read keeps an online machine online; a second makes it offline; it recovers', async () => {
    let failing = false
    const t = setup({
      envs: [{ id: 'env-a', name: 'A', runtimeId: 'rt-a' }],
      respond: (args, _time, fallback) => (failing && isDiag('env-a')(args) ? timeoutResult() : fallback(args))
    })
    t.poller.heartbeat()
    await t.drain()
    assert.equal(t.machine('env-a')?.state.status, 'online')
    failing = true
    t.time.advance(5_000)
    t.poller.heartbeat()
    await t.drain()
    assert.equal(t.machine('env-a')?.state.status, 'online')
    assert.ok(t.machine('env-a')?.state.error)
    t.time.advance(5_000)
    t.poller.heartbeat()
    await t.drain()
    assert.equal(t.machine('env-a')?.state.status, 'offline')
    failing = false
    for (let i = 0; i < 12 && t.machine('env-a')?.state.status !== 'online'; i += 1) {
      t.time.advance(1_000)
      t.poller.heartbeat()
      await t.drain()
    }
    assert.equal(t.machine('env-a')?.state.status, 'online')
    assert.equal(t.machine('env-a')?.state.error, null)
  })

  test('a failing local diagnostics read leaves the local machine online on its sampler', async () => {
    const t = setup({ respond: (args, _time, fallback) => (isDiag('local')(args) ? timeoutResult() : fallback(args)) })
    t.poller.heartbeat()
    await t.drain()
    const local = t.machine(LOCAL_ID)!.state
    assert.equal(local.online, true)
    assert.equal(local.cpu.source, 'sampler')
    assert.equal(local.memory?.source, 'os')
  })
})

describe('cadence', () => {
  test('slow without a panel, fast while one heartbeats, slow again 15 s after the last heartbeat', async () => {
    const t = setup({ envs: [{ id: 'env-a', name: 'A', runtimeId: 'rt-a' }] })
    const diagCalls = () => t.cli.count(isDiag('env-a'))
    const step = async (ms: number) => {
      t.time.advance(ms)
      t.poller.tick()
      await t.drain()
    }
    t.poller.tick()
    await t.drain()
    assert.equal(t.poller.mode(), 'slow')
    assert.equal(diagCalls(), 1)
    await step(30_000)
    assert.equal(diagCalls(), 1, 'nothing new 30 s into a 60 s interval')
    await step(30_000)
    assert.equal(diagCalls(), 2)

    t.poller.heartbeat()
    await t.drain()
    assert.equal(t.poller.mode(), 'fast')
    assert.equal(diagCalls(), 3, 'a heartbeat after a quiet spell reads at once')
    for (let i = 0; i < 2; i += 1) await step(5_000)
    assert.equal(diagCalls(), 5, 'every 5 s while fast')
    await step(5_000) // 15 s after the heartbeat: still fast
    assert.equal(t.poller.mode(), 'fast')
    assert.equal(diagCalls(), 6)
    await step(5_000) // 20 s: slow, but the read booked while fast still happens
    assert.equal(t.poller.mode(), 'slow')
    assert.equal(diagCalls(), 7)
    await step(55_000)
    assert.equal(diagCalls(), 7)
    await step(5_000)
    assert.equal(diagCalls(), 8, 'next read one slow interval after the last')
  })

  test('nothing runs while slow when nobody can see it (no status bar, no panel)', async () => {
    let idle = true
    const t = setup({ envs: [{ id: 'env-a', name: 'A', runtimeId: 'rt-a' }], idleWhenSlow: () => idle })
    t.poller.tick()
    await t.drain()
    assert.equal(t.cli.calls.length, 0)
    t.poller.heartbeat()
    await t.drain()
    assert.equal(t.cli.count(isDiag('env-a')), 1, 'a panel still reads')
    // The panel closes. Its 15 s linger still reads; after that polling is slow, and idle.
    const step = async () => {
      t.time.advance(1_000)
      t.poller.tick()
      await t.drain()
    }
    for (let s = 0; s < 20; s += 1) await step()
    assert.equal(t.poller.mode(), 'slow')
    const afterPanel = t.cli.calls.length
    for (let s = 0; s < 600; s += 1) await step()
    assert.equal(t.cli.calls.length, afterPanel, 'ten minutes, no calls')
    const whileIdle = t.cli.calls.length
    idle = false
    t.time.advance(60_000)
    t.poller.tick()
    await t.drain()
    assert.ok(t.cli.count(isDiag('env-a')) > 1 && t.cli.calls.length > whileIdle, 'slow polling resumes once someone can see it')
  })

  test('settings change the intervals', async () => {
    const t = setup({ envs: [{ id: 'env-a', name: 'A', runtimeId: 'rt-a' }], settings: { fastIntervalSeconds: 2 } })
    t.poller.heartbeat()
    await t.drain()
    t.time.advance(2_000)
    t.poller.heartbeat()
    await t.drain()
    assert.equal(t.cli.count(isDiag('env-a')), 2)
    assert.equal(t.poller.intervalMs(), 2_000)
  })
})

describe('tiers and the beacon', () => {
  const env = { id: 'env-a', name: 'A', runtimeId: 'rt-a' }

  test('a fresh beacon promotes the machine to full, backfills history, and relaxes diagnostics', async () => {
    const t = setup({ envs: [env] })
    t.state.plugins.set('env-a', runningPlugin())
    t.state.logs.set('env-a', () => beaconLogs({ key: 'local.fleet-monitor', lastT: t.time.now() + SKEW - 1_000, count: 10, cpu: 37, noise: true }))
    await t.poller.runOnce()
    const m = t.machine('env-a')!
    assert.equal(m.state.tier, 'full')
    assert.equal(m.state.cpu.source, 'beacon')
    assert.equal(m.state.cpu.percent, 37)
    assert.equal(m.state.cpu.perCore?.length, 4)
    assert.equal(m.state.beacon.state, 'fresh')
    assert.equal(m.state.beacon.pluginKey, 'local.fleet-monitor')
    assert.equal(m.state.beacon.remotePlugin, 'running')
    assert.equal(m.state.memory?.source, 'orca')
    const points = m.history.all()
    // The reading taken before it was promoted stays (with its memory); the back-fill adds only
    // where history had nothing.
    assert.equal(points.length, 11, 'nine back-filled, the basic reading before, and the newest')
    const newest = points[points.length - 1]!
    assert.ok(Math.abs(newest.t - t.time.now()) <= 1_000, 'history is on the local clock')
    assert.equal(points.filter((p) => p.cpu === 37).length, 10)
    assert.equal(points.filter((p) => p.mem !== null).length, 11)

    const diagBefore = t.cli.count(isDiag('env-a'))
    const logsBefore = t.cli.count(isLogs('env-a'))
    for (let s = 0; s < 10; s += 1) {
      t.time.advance(1_000)
      t.poller.heartbeat()
      await t.drain()
    }
    assert.equal(t.cli.count(isLogs('env-a')) - logsBefore, 2, 'beacon read every 5 s')
    assert.equal(t.cli.count(isDiag('env-a')) - diagBefore, 0, 'diagnostics wait 15 s on the full tier')
    for (let s = 0; s < 6; s += 1) {
      t.time.advance(1_000)
      t.poller.heartbeat()
      await t.drain()
    }
    assert.equal(t.cli.count(isDiag('env-a')) - diagBefore, 1)
  })

  test('a beacon older than three intervals on the remote clock is stale: basic tier', async () => {
    const t = setup({ envs: [env] })
    t.state.plugins.set('env-a', runningPlugin())
    t.state.logs.set('env-a', () => beaconLogs({ key: 'local.fleet-monitor', lastT: t.time.now() + SKEW - 60_000, count: 3 }))
    await t.poller.runOnce()
    const m = t.machine('env-a')!.state
    assert.equal(m.tier, 'basic')
    assert.equal(m.beacon.state, 'stale')
    assert.ok((m.beacon.ageMs ?? 0) >= 59_000)
    assert.equal(m.cpu.source, 'load')
    assert.equal(t.machine('env-a')!.history.size, 1, 'no backfill from a stale beacon')
  })

  test('a beacon that stops moving goes stale', async () => {
    const t = setup({ envs: [env] })
    t.state.plugins.set('env-a', runningPlugin())
    const frozenAt = t.time.now() + SKEW - 500
    t.state.logs.set('env-a', () => beaconLogs({ key: 'local.fleet-monitor', lastT: frozenAt, count: 2 }))
    await t.poller.runOnce()
    assert.equal(t.machine('env-a')!.state.tier, 'full')
    for (let s = 0; s < 25; s += 1) {
      t.time.advance(1_000)
      t.poller.heartbeat()
      await t.drain()
    }
    assert.equal(t.machine('env-a')!.state.tier, 'basic')
    assert.equal(t.machine('env-a')!.state.beacon.state, 'stale')
  })

  test('without Fleet Monitor on the remote there are no log reads', async () => {
    const t = setup({ envs: [env] })
    t.state.plugins.set('env-a', [{ pluginKey: 'someone.other-plugin', status: 'running' }])
    await t.poller.runOnce()
    assert.equal(t.cli.count(isLogs('env-a')), 0)
    assert.equal(t.machine('env-a')!.state.beacon.remotePlugin, 'absent')
    assert.equal(t.machine('env-a')!.state.tier, 'basic')
  })

  test('after three empty reads it tries the next installed copy', async () => {
    const t = setup({ envs: [env] })
    t.state.plugins.set('env-a', [
      { pluginKey: 'local.fleet-monitor', status: 'running', isDev: true },
      { pluginKey: 'example-owner.fleet-monitor', status: 'idle', isDev: false }
    ])
    t.state.logs.set('env-a', () => envelope({ pluginKey: 'x', lines: [], cursor: 'x:0' }))
    await t.poller.runOnce()
    for (let s = 0; s < 16; s += 1) {
      t.time.advance(1_000)
      t.poller.heartbeat()
      await t.drain()
    }
    const keys = t.cli.calls.filter((c) => isLogs('env-a')(c.args)).map((c) => c.args[2])
    assert.deepEqual(keys.slice(0, 4), ['local.fleet-monitor', 'local.fleet-monitor', 'local.fleet-monitor', 'example-owner.fleet-monitor'])
  })
})

describe('noticing Fleet Monitor installed on a basic machine', () => {
  const env = { id: 'env-a', name: 'A', runtimeId: 'rt-a' }
  const listCalls = (t: ReturnType<typeof setup>) =>
    t.cli.count((a) => a[0] === 'plugin' && a[1] === 'list' && machineOf(a) === 'env-a')
  /** One panel heartbeat a second for `seconds`. */
  const panelOpenFor = async (t: ReturnType<typeof setup>, seconds: number) => {
    for (let s = 0; s < seconds; s += 1) {
      t.time.advance(1_000)
      t.poller.heartbeat()
      await t.drain()
    }
  }

  test('while a panel is open, a basic machine has its plugin list re-read about every 30 s', async () => {
    const t = setup({ envs: [env] })
    await t.poller.runOnce()
    assert.equal(listCalls(t), 1)
    await panelOpenFor(t, 29)
    assert.equal(listCalls(t), 1)
    await panelOpenFor(t, 2)
    assert.equal(listCalls(t), 2, 're-read 30 s after the last one, not 5 minutes')
    await panelOpenFor(t, 60)
    assert.equal(listCalls(t), 4)
  })

  test('a machine that gains Fleet Monitor goes full within about 30 s', async () => {
    const t = setup({ envs: [env] })
    await t.poller.runOnce()
    assert.equal(t.machine('env-a')!.state.tier, 'basic')
    // Installed there now; its worker has started beaconing.
    t.state.plugins.set('env-a', runningPlugin('example-owner.fleet-monitor'))
    t.state.logs.set('env-a', () =>
      beaconLogs({ key: 'example-owner.fleet-monitor', lastT: t.time.now() + SKEW - 1_000, count: 2 })
    )
    await panelOpenFor(t, 32)
    assert.equal(t.machine('env-a')!.state.tier, 'full')
    assert.equal(t.machine('env-a')!.state.beacon.pluginKey, 'example-owner.fleet-monitor')
  })

  test('with no panel open the slow 5-minute schedule stands, and opening a panel re-checks at once', async () => {
    const t = setup({ envs: [env] })
    t.poller.tick()
    await t.drain()
    assert.equal(t.poller.mode(), 'slow')
    assert.equal(listCalls(t), 1)
    for (let s = 0; s < 120; s += 1) {
      t.time.advance(1_000)
      t.poller.tick()
      await t.drain()
    }
    assert.equal(listCalls(t), 1, 'no re-check every 30 s while nobody is looking')
    t.poller.heartbeat()
    await t.drain()
    assert.equal(listCalls(t), 2, 'a panel opening re-reads the list')
  })

  test('a full-tier machine keeps the 5-minute schedule while a panel is open', async () => {
    const t = setup({ envs: [env] })
    t.state.plugins.set('env-a', runningPlugin())
    let written = 2 // the remote keeps beaconing, so its sequence moves on
    t.state.logs.set('env-a', () =>
      beaconLogs({ key: 'local.fleet-monitor', lastT: t.time.now() + SKEW - 1_000, count: Math.min(150, written++) })
    )
    await t.poller.runOnce()
    assert.equal(t.machine('env-a')!.state.tier, 'full')
    await panelOpenFor(t, 90)
    assert.equal(t.machine('env-a')!.state.tier, 'full')
    assert.equal(listCalls(t), 1)
  })
})

describe('the local machine name', () => {
  test('is the name Orca shows for this computer, read from `orca host list`', async () => {
    const t = setup({
      respond: (args, _time, fallback) =>
        args[0] === 'host'
          ? okResult(envelope({ hosts: [{ kind: 'local', id: 'local', name: 'this machine', machineName: 'Example Workstation' }] }))
          : fallback(args)
    })
    assert.equal(t.machine(LOCAL_ID)!.state.name, 'this-desktop', 'the hostname until Orca answers')
    await t.poller.runOnce()
    assert.equal(t.machine(LOCAL_ID)!.state.name, 'Example Workstation')
    assert.equal(t.cli.count((a) => a[0] === 'host'), 1)
  })

  test('falls back to the hostname when Orca has no name for it, and asks again later', async () => {
    const t = setup({
      respond: (args, _time, fallback) => (args[0] === 'host' ? okResult(envelope({ hosts: [{ kind: 'local', id: 'local' }] })) : fallback(args))
    })
    await t.poller.runOnce()
    assert.equal(t.machine(LOCAL_ID)!.state.name, 'this-desktop')
    for (let s = 0; s < 301; s += 1) {
      t.time.advance(1_000)
      t.poller.heartbeat()
      await t.drain()
    }
    assert.equal(t.cli.count((a) => a[0] === 'host'), 2, 'retried after 5 minutes')
  })
})

describe('the machine list', () => {
  test('a failing `environment list` is reported until it works again', async () => {
    let failing = true
    const t = setup({
      envs: [{ id: 'env-a', name: 'A', runtimeId: 'rt-a' }],
      respond: (args, _time, fallback) => (failing && args[0] === 'environment' ? { ...okResult(''), spawnError: 'spawn EACCES' } : fallback(args))
    })
    await t.poller.runOnce()
    assert.equal(t.poller.environmentError(), 'spawn EACCES')
    assert.equal(t.poller.entries().length, 1)
    failing = false
    t.time.advance(6_000)
    t.poller.heartbeat()
    await t.drain()
    assert.equal(t.poller.environmentError(), null)
    assert.equal(t.poller.entries().length, 2)
  })
})

describe('retry', () => {
  test('reads an offline machine at once instead of waiting out its back-off', async () => {
    const t = setup({
      envs: [{ id: 'env-a', name: 'A', runtimeId: 'rt-a' }],
      respond: (args, _time, fallback) => (isDiag('env-a')(args) ? timeoutResult() : fallback(args))
    })
    await t.poller.runOnce()
    t.time.advance(5_000)
    t.poller.heartbeat()
    await t.drain()
    assert.equal(t.machine('env-a')!.state.status, 'offline')
    const before = t.cli.count(isDiag('env-a'))
    t.time.advance(1_000)
    t.poller.tick()
    await t.drain()
    assert.equal(t.cli.count(isDiag('env-a')), before, 'backing off')
    assert.ok(t.poller.retry('env-a'))
    await t.drain()
    assert.equal(t.cli.count(isDiag('env-a')), before + 1)
    assert.equal(t.poller.retry('local'), false)
    assert.equal(t.poller.retry('nope'), false)
  })
})

describe('discovery', () => {
  test('machines come and go with the environment list; a pairing to this runtime is dropped', async () => {
    const t = setup({
      envs: [
        { id: 'env-a', name: 'A', runtimeId: 'rt-a' },
        { id: 'env-b', name: 'B', runtimeId: 'rt-b' },
        { id: 'env-self', name: 'Me', runtimeId: 'rt-local' }
      ]
    })
    await t.poller.runOnce()
    assert.deepEqual(t.poller.entries().map((e) => e.state.id).sort(), ['env-a', 'env-b', 'local'])
    t.state.envs = [{ id: 'env-b', name: 'B renamed', runtimeId: 'rt-b' }]
    for (let s = 0; s < 31; s += 1) {
      t.time.advance(1_000)
      t.poller.heartbeat()
      await t.drain()
    }
    assert.deepEqual(t.poller.entries().map((e) => e.state.name), ['this-desktop', 'B renamed'])
    assert.ok(t.cli.count(isEnvList) >= 2)
  })

  test('the local machine adds a history point per sampler reading', async () => {
    const t = setup()
    await t.poller.runOnce()
    const before = t.machine(LOCAL_ID)!.history.size
    t.time.advance(5_000)
    t.setSample(localSample({ t: t.time.now(), cpu: { total: 12, perCore: [12, 12, 12, 12] } }))
    t.poller.onLocalSample()
    t.poller.onLocalSample() // the same reading again adds nothing
    const local = t.machine(LOCAL_ID)!
    assert.equal(local.history.size, before + 1)
    assert.equal(local.state.cpu.percent, 12)
    // Linux: its own reading, new with each sample, ahead of diagnostics an interval old.
    assert.equal(local.state.memory?.source, 'os')
  })
})

test('stop() ends polling and ignores answers that arrive later', async () => {
  const t = setup({ envs: [{ id: 'env-a', name: 'A', runtimeId: 'rt-a' }] })
  t.cli.hold = true
  t.poller.heartbeat()
  const callsAtStop = t.cli.calls.length
  t.poller.stop()
  t.cli.release()
  await flush(10)
  t.time.advance(60_000)
  t.poller.tick()
  assert.equal(t.cli.calls.length, callsAtStop)
  assert.equal(t.poller.entries().length, 1, 'the environment list answer was ignored')
})
