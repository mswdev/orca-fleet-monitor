// Memory in 1.1: alerts (src/alerts.ts) and their debounce, the poller's memory readings and the
// 15 s cadence for a machine in trouble with no panel open, back-filled RAM in use, and the
// notification the worker shows. A fake CLI and a fake clock; every value is invented.
import { assert, describe, mockHost, mountWorker, test } from 'orca/testing'
import type { JsonValue } from 'orca/worker'
import { ALERT_REARM_MS, MemoryAlerts } from '../src/alerts.ts'
import { BEACON_PREFIX, decodeBeacon, encodeBeacon } from '../src/beacon.ts'
import type { CommandResult, CommandRunner } from '../src/cli.ts'
import { DEFAULT_HEALTH } from '../src/health.ts'
import { mergeMachine } from '../src/merge.ts'
import type { MacMemory, MachineState } from '../src/model.ts'
import { startFleetMonitor, type FleetMonitor, type MonitorDeps } from '../src/monitor.ts'
import { parseDiagnostics, parseEnvelope } from '../src/parse.ts'
import { ALERT_READ_MS, FleetPoller, LOCAL_ID } from '../src/poller.ts'
import { readSettings } from '../src/settings.ts'
import { diagnosticsFor, envelope, FakeTime, flush, localSample, macMemory, machineOf, okResult } from './helpers.ts'

const GIB = 2 ** 30
const START = 1_800_000_000_000
const KEY = 'example-owner.fleet-monitor'

/** 12.5 of 16 GB in use, pressure normal; then warning (strained); then critical. */
const calm = macMemory()
const warning = macMemory({ used: 15.1 * GIB, app: 9.6 * GIB, pressure: 'warning', availablePercent: 12, swapUsed: 6.2 * GIB, swapTotal: 7 * GIB })
const critical = macMemory({ used: 15.6 * GIB, app: 10.1 * GIB, pressure: 'critical', availablePercent: 4, swapUsed: 7.5 * GIB, swapTotal: 8 * GIB })

/** A remote Mac with Fleet Monitor 1.1, as the poller merges it from a fresh beacon. */
function macState(mac: MacMemory, over: { id?: string; name?: string; online?: boolean } = {}): MachineState {
  const latest = decodeBeacon(encodeBeacon(localSample({ platform: 'darwin', macMemory: mac }), { run: 'r', seq: 1, intervalMs: 5_000 }))!
  const online = over.online !== false
  return mergeMachine({
    id: over.id ?? 'env-mini',
    name: over.name ?? 'Mac mini',
    kind: 'remote',
    now: 0,
    status: online ? 'online' : 'offline',
    lastSeenAt: 0,
    latencyMs: 1,
    error: null,
    beacon: { latest, fresh: online, ageMs: 0, pluginKey: KEY, remotePlugin: 'running' },
    health: DEFAULT_HEALTH
  })
}

/** A Mac without Fleet Monitor: Orca's diagnostics, whose figure there is memory pressure. */
function pressureState(percent: number, name = 'Build Box'): MachineState {
  const diag = parseDiagnostics(parseEnvelope(diagnosticsFor({ collectedAt: 1, memoryPercent: percent, memorySource: 'memory-pressure' })))!
  return mergeMachine({ id: 'env-b', name, kind: 'remote', now: 0, status: 'online', lastSeenAt: 0, latencyMs: 1, error: null, diag, health: DEFAULT_HEALTH })
}

function alerts(enabled: () => boolean = () => true) {
  let now = 0
  const a = new MemoryAlerts({ now: () => now, enabled, health: () => DEFAULT_HEALTH, memoryRules: () => undefined })
  /** A reading at `s` seconds. */
  const at = (s: number, state: MachineState) => {
    now = s * 1_000
    return a.observe(state)
  }
  return { a, at }
}

describe('memory alerts', () => {
  test('two readings in a row at strained alert once, naming the machine and the numbers', () => {
    const { at } = alerts()
    assert.equal(at(0, macState(calm)), null)
    assert.equal(at(5, macState(warning)), null, 'one reading is not enough')
    const notice = at(10, macState(warning))
    assert.deepEqual(notice, {
      id: 'env-mini',
      name: 'Mac mini',
      level: 'strained',
      title: 'Mac mini: memory pressure warning',
      body: '15.1 of 16 GB used, swap 6.2 GB. Memory strained: macOS memory pressure warning, 12% available; memory pressure 88% ≥ 88%.'
    })
    for (let s = 15; s <= 60; s += 5) assert.equal(at(s, macState(warning)), null, `no repeat at ${s} s`)
  })

  test('escalating to critical alerts once more, when critical too holds for two readings', () => {
    const { at } = alerts()
    at(0, macState(warning))
    assert.equal(at(5, macState(warning))?.level, 'strained')
    assert.equal(at(10, macState(critical)), null)
    const notice = at(15, macState(critical))
    assert.equal(notice?.level, 'critical')
    assert.equal(notice?.title, 'Mac mini: memory pressure critical')
    assert.equal(notice?.body, '15.6 of 16 GB used, swap 7.5 GB. Memory critical: macOS memory pressure critical, 4% available; memory pressure 96% ≥ 95%.')
    assert.equal(at(20, macState(critical)), null)
    assert.equal(at(25, macState(warning)), null, 'easing back to strained is not an alert')
  })

  test('straight to critical is one alert, at critical', () => {
    const { at } = alerts()
    assert.equal(at(0, macState(critical)), null)
    assert.equal(at(5, macState(critical))?.level, 'critical')
    assert.equal(at(10, macState(warning)), null)
    assert.equal(at(15, macState(warning)), null)
  })

  test('single strained readings between calm ones never alert', () => {
    const { at } = alerts()
    const seen = [warning, calm, warning, calm, critical, calm, warning].map((m, i) => at(i * 5, macState(m)))
    assert.deepEqual(seen, [null, null, null, null, null, null, null])
  })

  test('re-arms after two minutes below strained, and only then', () => {
    const { a, at } = alerts()
    at(0, macState(warning))
    assert.ok(at(5, macState(warning)))
    // Below strained for 1 min 55 s, then back: still the same episode.
    at(10, macState(calm))
    at(125, macState(calm))
    at(130, macState(warning))
    assert.equal(at(135, macState(warning)), null)
    assert.equal(a.trackOf('env-mini')?.alerted, 'strained')
    // The calm is interrupted: its two minutes start again.
    at(140, macState(calm))
    at(200, macState(warning))
    at(205, macState(calm))
    assert.equal(at(205 + ALERT_REARM_MS / 1_000 - 1, macState(calm)), null)
    assert.equal(a.trackOf('env-mini')?.alerted, 'strained', 'not yet: 1 min 59 s')
    at(205 + ALERT_REARM_MS / 1_000, macState(calm))
    assert.equal(a.trackOf('env-mini')?.alerted, null, 're-armed after two minutes')
    at(400, macState(warning))
    assert.equal(at(405, macState(warning))?.level, 'strained', 'and the next episode alerts again')
  })

  test('each machine has its own alerts', () => {
    const { at } = alerts()
    at(0, macState(warning))
    at(1, macState(warning, { id: 'env-air', name: 'MacBook Air' }))
    assert.equal(at(5, macState(warning))?.name, 'Mac mini')
    assert.equal(at(6, macState(warning, { id: 'env-air', name: 'MacBook Air' }))?.name, 'MacBook Air')
  })

  test('turned off: nothing is shown and nothing counts as alerted, so turning it on tells', () => {
    let enabled = false
    const { at } = alerts(() => enabled)
    assert.equal(at(0, macState(warning)), null)
    assert.equal(at(5, macState(warning)), null)
    enabled = true
    assert.equal(at(10, macState(warning))?.level, 'strained')
  })

  test('an offline machine is not a reading: it neither counts nor breaks a run', () => {
    const { at } = alerts()
    at(0, macState(warning))
    assert.equal(at(5, macState(warning, { online: false })), null)
    assert.equal(at(10, macState(warning))?.level, 'strained')
  })

  test("a Mac read only through Orca: memory pressure in the alert, and never 'used'", () => {
    const { at } = alerts()
    at(0, pressureState(90))
    const notice = at(5, pressureState(90))!
    assert.equal(notice.title, 'Build Box: memory pressure 90%')
    assert.equal(notice.body, 'Memory pressure 90%, 32 GB of RAM. Memory strained: memory pressure 90% ≥ 88%.')
    assert.ok(!/used/i.test(notice.title + notice.body))
  })

  test("the title and body fit Orca's limits whatever the machine is called", () => {
    const { at } = alerts()
    const name = 'A machine name far longer than any notification title has room for, repeated: '.repeat(4)
    at(0, macState(critical, { name }))
    const notice = at(5, macState(critical, { name }))!
    assert.ok(notice.title.length >= 1 && notice.title.length <= 120)
    assert.ok(notice.body.length <= 1_000)
    assert.match(notice.title, /…: memory pressure critical$/)
  })
})

// --- the poller: readings, and the 15 s cadence ------------------------------------------------

/** A remote's 1.1 beacon log: one every 5 s for the last ten minutes, each with `mac(t)`. */
function macLog(time: FakeTime, mac: (t: number) => MacMemory) {
  return () => {
    const since = START - 10 * 60_000
    const total = Math.floor((time.now() - since) / 5_000)
    const lines = []
    for (let q = Math.max(1, total - 199); q <= total; q += 1) {
      const t = since + q * 5_000
      const line = encodeBeacon(localSample({ t, platform: 'darwin', macMemory: mac(t) }), { run: 'run-a', seq: q, intervalMs: 5_000 })!
      lines.push({ ts: t + 2, level: 'info', line })
    }
    return envelope({ pluginKey: KEY, lines, cursor: 'c:1' })
  }
}

function fleet(options: { diagMemory?: () => number; beacon?: (t: number) => MacMemory; localMac?: () => MacMemory | null; settings?: Record<string, unknown> } = {}) {
  const time = new FakeTime(START)
  const calls: { args: string[]; at: number }[] = []
  const readings: MachineState[] = []
  const logs = options.beacon ? macLog(time, options.beacon) : null
  const answer = (args: string[]): CommandResult => {
    const machine = machineOf(args)
    if (args[0] === 'environment') return okResult(envelope({ environments: [{ id: 'env-mini', name: 'Mac mini', runtimeId: 'rt-mini' }] }, { runtimeId: 'rt-local' }))
    if (args[0] === 'host') return okResult(envelope({ hosts: [] }))
    if (args[0] === 'diagnostics') {
      return okResult(
        machine === 'local'
          ? diagnosticsFor({ collectedAt: time.now(), runtimeId: 'rt-local', memorySource: 'memory-pressure' })
          : diagnosticsFor({ collectedAt: time.now(), runtimeId: 'rt-mini', memoryPercent: options.diagMemory?.() ?? 40, memorySource: 'memory-pressure' })
      )
    }
    if (args[0] === 'plugin' && args[1] === 'list') {
      return okResult(envelope({ plugins: machine !== 'local' && logs ? [{ pluginKey: KEY, status: 'running', isDev: false }] : [] }))
    }
    if (args[0] === 'plugin' && args[1] === 'logs' && logs) return okResult(logs())
    return okResult(envelope(null))
  }
  const run: CommandRunner = (args) =>
    new Promise((resolve) => {
      const list = [...args]
      calls.push({ args: list, at: time.now() })
      time.setTimeout(() => resolve({ ...answer(list), durationMs: 350 }), 350)
    })
  const sampleNow = () => localSample({ t: time.now(), platform: 'darwin', macMemory: options.localMac?.() ?? null })
  let sample = sampleNow()
  const poller = new FleetPoller(
    {
      run,
      now: time.now,
      localSample: () => sample,
      localName: () => 'desk',
      localPlatform: 'darwin',
      pluginId: 'fleet-monitor',
      onMemoryReading: (state) => readings.push(state)
    },
    readSettings(options.settings ?? {})
  )
  time.setInterval(() => poller.tick(), 1_000)
  time.setInterval(() => {
    sample = sampleNow()
    poller.onLocalSample()
  }, 5_000)
  poller.tick()
  const advance = async (ms: number) => {
    for (let done = 0; done < ms; done += 50) {
      time.advance(50)
      await flush(2)
    }
  }
  const gaps = (predicate: (args: string[]) => boolean, from: number) => {
    const at = calls.filter((c) => c.at >= from && predicate(c.args)).map((c) => c.at)
    return at.slice(1).map((t, i) => t - at[i]!)
  }
  return { time, calls, readings, poller, advance, gaps, machine: (id: string) => poller.entries().find((e) => e.state.id === id)! }
}

const isRemoteDiag = (args: string[]) => args[0] === 'diagnostics' && machineOf(args) === 'env-mini'
const isRemoteLogs = (args: string[]) => args[1] === 'logs' && machineOf(args) === 'env-mini'

describe('memory readings in the poller', () => {
  test('each new reading is handed on once; re-merges with nothing new are not', async () => {
    const sim = fleet({ localMac: () => calm })
    await sim.advance(30_500)
    const local = () => sim.readings.filter((s) => s.id === LOCAL_ID).length
    const before = local()
    assert.ok(before >= 6, `one per sample (${before})`)
    sim.poller.updateSettings(readSettings({ cpuBusyPercent: 50 }))
    sim.poller.heartbeat()
    sim.poller.onLocalSample() // the same sample again
    assert.equal(local(), before)
    const mini = sim.readings.filter((s) => s.id === 'env-mini')
    assert.equal(mini.length, sim.calls.filter((c) => isRemoteDiag(c.args)).length, 'one per diagnostics read')
  })

  test('no panel open: a Mac read through Orca whose memory is strained is read every 15 s, then slowly again', async () => {
    let percent = 40
    const sim = fleet({ diagMemory: () => percent })
    await sim.advance(3 * 60_000)
    assert.ok(sim.gaps(isRemoteDiag, START).every((g) => g >= 59_000), 'the slow interval while it is fine')
    percent = 90
    await sim.advance(65_000) // the next slow read finds it strained
    assert.equal(sim.machine('env-mini').state.health.memory, 'strained')
    const from = sim.time.now()
    await sim.advance(2 * 60_000)
    const strained = sim.gaps(isRemoteDiag, from)
    assert.ok(strained.length >= 6 && strained.every((g) => g <= ALERT_READ_MS + 1_000), `every 15 s (${strained.join(', ')})`)
    percent = 40
    await sim.advance(20_000)
    const calmFrom = sim.time.now()
    await sim.advance(3 * 60_000)
    assert.ok(sim.gaps(isRemoteDiag, calmFrom).every((g) => g >= 59_000), 'back to the slow interval')
    const levels = sim.readings.filter((s) => s.id === 'env-mini').map((s) => s.health.memory)
    assert.ok(levels.filter((l) => l === 'strained').length >= 8, 'every one of those reads was a reading')
  })

  test('no panel open: a Mac with 1.1 carries its memory in its beacon, so its log is what comes every 15 s', async () => {
    let mac = calm
    const sim = fleet({ beacon: () => mac })
    await sim.advance(3 * 60_000)
    assert.equal(sim.machine('env-mini').state.tier, 'full')
    assert.equal(sim.machine('env-mini').state.memory?.source, 'beacon')
    mac = warning
    await sim.advance(65_000)
    assert.equal(sim.machine('env-mini').state.health.memory, 'strained')
    const from = sim.time.now()
    await sim.advance(2 * 60_000)
    const logs = sim.gaps(isRemoteLogs, from)
    assert.ok(logs.length >= 6 && logs.every((g) => g <= ALERT_READ_MS + 1_000), `log every 15 s (${logs.join(', ')})`)
    assert.ok(sim.gaps(isRemoteDiag, from).every((g) => g >= 59_000), 'diagnostics stay slow: they carry no memory here')
    assert.equal(sim.machine('env-mini').state.tier, 'full', 'and it stays on the full tier')
  })

  test('a panel open: RAM in use is back-filled from a remote Mac’s older beacons', async () => {
    // RAM in use climbs over the ten minutes of log; pressure stays at 45%.
    const sim = fleet({ beacon: (t) => macMemory({ used: (10 + (t - START + 10 * 60_000) / (10 * 60_000)) * GIB, availablePercent: 55 }) })
    sim.poller.heartbeat()
    await sim.advance(10_000)
    const points = sim.machine('env-mini').history.all()
    const withRam = points.filter((p) => typeof p.ram === 'number')
    assert.ok(withRam.length >= 100, `back-filled (${withRam.length} of ${points.length})`)
    assert.ok(withRam.every((p) => p.mem === 45), 'pressure, from each beacon, in mem')
    const first = withRam[0]!.ram!
    const last = withRam[withRam.length - 1]!.ram!
    assert.ok(first < last && first > 62 && last <= 69, `RAM in use as it was then (${first} → ${last})`)
  })
})

// --- the worker: the notification it shows ------------------------------------------------------

async function worker(settings: Record<string, JsonValue> = {}, mac: () => MacMemory = () => warning) {
  const time = new FakeTime(START)
  let last: ReturnType<typeof localSample> | null = null
  let prepared = 0
  const deps: MonitorDeps = {
    now: time.now,
    setInterval: time.setInterval,
    clearInterval: time.clearInterval,
    setTimeout: time.setTimeout,
    clearTimeout: time.clearTimeout,
    sampler: {
      prepare: async () => {
        prepared += 1
      },
      sample: () => {
        last = localSample({ t: time.now(), platform: 'darwin', macMemory: mac() })
        return last
      },
      latest: () => last
    },
    resolveCli: () => ({ path: '/fake/orca', source: 'bundled', tried: [], error: null }),
    createRunner: () => ({ run: async () => okResult(envelope({ environments: [] }, { runtimeId: 'rt-local' })), stop: () => {} }),
    localName: () => 'this-desktop',
    runId: () => 'cafe01',
    declaredCommands: [],
    platform: 'darwin'
  }
  let monitor: FleetMonitor | null = null
  const host = mockHost({ settings, results: { 'notifications.show': { delivered: true } } })
  const mounted = await mountWorker(
    {
      default: async (orca) => {
        monitor = await startFleetMonitor(orca, deps)
      },
      deactivate: async () => monitor?.stop()
    },
    { host }
  )
  const run = async (ms: number) => {
    for (let done = 0; done < ms; done += 1_000) {
      time.advance(1_000)
      await flush()
    }
  }
  return { time, host, mounted, run, prepared: () => prepared }
}

describe('the worker', () => {
  test('shows one desktop notification for this Mac, with only the fields Orca takes', async () => {
    const t = await worker()
    await t.run(30_000)
    const shown = t.host.callsOf('notifications.show') as Record<string, unknown>[]
    assert.equal(shown.length, 1)
    assert.deepEqual(Object.keys(shown[0]!).sort(), ['body', 'title'])
    assert.equal(shown[0]!.title, 'this-desktop: memory pressure warning')
    assert.match(String(shown[0]!.body), /^15\.1 of 16 GB used, swap 6\.2 GB\./)
    assert.deepEqual(t.mounted.refusals, [], 'the manifest declares notifications:show')
    await t.mounted.deactivate()
  })

  test('not with alerts turned off in settings', async () => {
    const t = await worker({ memoryAlerts: false })
    await t.run(30_000)
    assert.equal(t.host.callsOf('notifications.show').length, 0)
    await t.mounted.deactivate()
  })

  test('reads the Mac memory before each sample, and the beacon carries it', async () => {
    const t = await worker({}, () => calm)
    await t.run(15_000)
    assert.equal(t.prepared(), 3)
    const beacons = t.mounted.logs.filter((line) => line.startsWith(BEACON_PREFIX))
    assert.equal(beacons.length, 3)
    assert.deepEqual(decodeBeacon(beacons[2])?.macMemory, calm)
    assert.equal(t.host.callsOf('notifications.show').length, 0, 'nothing to alert')
    await t.mounted.deactivate()
  })
})
