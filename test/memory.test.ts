// Memory in 1.1: alerts (src/alerts.ts) and their debounce, the poller's memory readings and the
// 15 s cadence for a machine in trouble with no panel open, back-filled RAM in use, and the
// notification the worker shows. A fake CLI and a fake clock; every value is invented.
import { assert, describe, mockHost, mountWorker, test } from 'orca/testing'
import type { JsonValue } from 'orca/worker'
import { MemoryAlerts, type LostEvent, type MemoryReading } from '../src/alerts.ts'
import { BEACON_PREFIX, decodeBeacon, encodeBeacon } from '../src/beacon.ts'
import type { CommandResult, CommandRunner } from '../src/cli.ts'
import { DEFAULT_HEALTH } from '../src/health.ts'
import { mergeMachine } from '../src/merge.ts'
import type { MacMemory, MachineState } from '../src/model.ts'
import { startFleetMonitor, type FleetMonitor, type MonitorDeps } from '../src/monitor.ts'
import { parseDiagnostics, parseEnvelope } from '../src/parse.ts'
import { ALERT_READ_MS, FleetPoller, LOCAL_ID } from '../src/poller.ts'
import { readSettings } from '../src/settings.ts'
import { diagnosticsFor, envelope, FakeTime, flush, localSample, macMemory, machineOf, okResult, timeoutResult, errorResult } from './helpers.ts'

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

/** A merged state as one reading: its memory level, or nothing while it is offline. */
function readingOf(state: MachineState, atMs: number): MemoryReading {
  return { id: state.id, name: state.name, level: state.online ? state.health.memory : null, at: atMs, memory: state.memory }
}

function alerts(enabled: () => boolean = () => true) {
  let now = 0
  const logs: string[] = []
  const a = new MemoryAlerts({ now: () => now, enabled, health: () => DEFAULT_HEALTH, memoryRules: () => undefined, log: (line) => logs.push(line) })
  /** A reading at `s` seconds. */
  const at = (s: number, state: MachineState) => {
    now = s * 1_000
    return a.observe(readingOf(state, now))
  }
  /** A reading that says nothing (missing, or carried over a failed read) at `s` seconds. */
  const silent = (s: number, id = 'env-mini') => {
    now = s * 1_000
    return a.observe({ id, name: 'Mac mini', level: null, at: now, memory: null })
  }
  const setNow = (s: number) => {
    now = s * 1_000
  }
  return { a, at, silent, setNow, logs }
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
      kind: 'strained',
      title: 'Mac mini: memory pressure warning',
      body: '15.1 of 16 GB used, swap 6.2 GB. Memory strained: macOS memory pressure warning, 12% available; memory pressure 88% ≥ 88%.'
    })
    for (let s = 15; s <= 60; s += 5) assert.equal(at(s, macState(warning)), null, `no repeat at ${s} s`)
  })

  test('critical alerts on the first reading that shows it, and escalating from strained alerts once more', () => {
    const { at } = alerts()
    at(0, macState(warning))
    assert.equal(at(5, macState(warning))?.level, 'strained')
    const notice = at(10, macState(critical))
    assert.equal(notice?.level, 'critical')
    assert.equal(notice?.kind, 'critical')
    assert.equal(notice?.title, 'Mac mini: memory pressure critical')
    assert.equal(notice?.body, '15.6 of 16 GB used, swap 7.5 GB. Memory critical: macOS memory pressure critical, 4% available; memory pressure 96% ≥ 95%.')
    assert.equal(at(15, macState(critical)), null)
    assert.equal(at(20, macState(warning)), null, 'easing back to strained is not an alert')
  })

  test('straight to critical is one alert, at critical, on its first reading', () => {
    const { at } = alerts()
    assert.equal(at(0, macState(critical))?.level, 'critical')
    assert.equal(at(5, macState(critical)), null)
    assert.equal(at(10, macState(warning)), null)
    assert.equal(at(15, macState(warning)), null)
  })

  test('single strained readings between calm ones never alert', () => {
    const { at } = alerts()
    const seen = [warning, calm, warning, calm, warning, calm, warning].map((m, i) => at(i * 5, macState(m)))
    assert.deepEqual(seen, [null, null, null, null, null, null, null])
  })

  test('a reading that says nothing neither counts nor breaks a run, and never reads as calm', () => {
    const { a, at, silent } = alerts()
    at(0, macState(warning))
    assert.equal(silent(5), null)
    assert.equal(a.trackOf('env-mini')?.strainedRun, 1, 'the run stands')
    assert.equal(at(10, macState(warning))?.level, 'strained', 'two strained readings with a silent one between are in a row')
    // Alerted: silent readings do not start the two minutes that re-arm it either.
    for (let s = 15; s <= 400; s += 5) silent(s)
    assert.equal(a.trackOf('env-mini')?.alerted, 'strained')
    assert.equal(a.trackOf('env-mini')?.calmSince, null)
  })

  test('two strained readings more than two minutes apart are not in a row', () => {
    const { at, silent } = alerts()
    at(0, macState(warning))
    for (let s = 5; s < 125; s += 5) silent(s)
    assert.equal(at(125, macState(warning)), null, '2 min 5 s later: a new run')
    assert.equal(at(130, macState(warning))?.level, 'strained')
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
    assert.equal(at(205 + 119, macState(calm)), null)
    assert.equal(a.trackOf('env-mini')?.alerted, 'strained', 'not yet: 1 min 59 s')
    at(205 + 120, macState(calm))
    assert.equal(a.trackOf('env-mini')?.alerted, null, 're-armed after exactly two minutes')
    at(400, macState(warning))
    assert.equal(at(405, macState(warning))?.level, 'strained', 'and the next episode alerts again')
  })

  test('while it stays critical, a reminder every 10 minutes', () => {
    const { at } = alerts()
    const sent: { s: number; kind: string }[] = []
    for (let s = 0; s <= 25 * 60; s += 5) {
      const notice = at(s, macState(critical))
      if (notice) sent.push({ s, kind: notice.kind })
    }
    assert.deepEqual(sent, [
      { s: 0, kind: 'critical' },
      { s: 600, kind: 'reminder' },
      { s: 1_200, kind: 'reminder' }
    ])
    const { at: again } = alerts()
    again(0, macState(critical))
    const reminder = (() => {
      for (let s = 5; s <= 600; s += 5) {
        const n = again(s, macState(critical))
        if (n) return n
      }
      return null
    })()
    assert.match(reminder!.body, /^Still critical\. 15\.6 of 16 GB used/)
  })

  test('critical for two hours: reminded every 10 minutes, five notices an hour, one slot always left', () => {
    const { at } = alerts()
    const sent: number[] = []
    for (let s = 0; s <= 2 * 3_600; s += 5) if (at(s, macState(critical))) sent.push(s)
    assert.deepEqual(sent, [0, 600, 1_200, 1_800, 2_400, 3_600, 4_200, 4_800, 5_400, 6_000, 7_200])
  })

  test('at most 6 notifications an hour per machine: a machine that flaps cannot flood', () => {
    const { at, logs } = alerts()
    // 10 s warning, 10 s critical, 130 s calm (just past the re-arm), over and over for two hours.
    const sent: { s: number; kind: string }[] = []
    for (let s = 0; s < 2 * 3_600; s += 5) {
      const p = s % 150
      const notice = at(s, macState(p < 10 ? warning : p < 20 ? critical : calm))
      if (notice) sent.push({ s, kind: notice.kind })
    }
    for (let from = 0; from < 2 * 3_600; from += 60) {
      const inHour = sent.filter((x) => x.s >= from && x.s < from + 3_600)
      assert.ok(inHour.length <= 6, `${inHour.length} in the hour from ${from} s`)
      assert.ok(inHour.filter((x) => x.kind === 'strained').length <= 3, 'strained ones stop at 3')
    }
    assert.ok(sent.some((x) => x.kind === 'critical'), 'critical ones still get through')
    assert.ok(logs.some((line) => /held back/.test(line)), 'and holding one back is logged')
  })

  test('critical with reminders for 55 minutes, then it stops answering: that is still told', () => {
    const { a, at, setNow } = alerts()
    let sent = 0
    for (let s = 0; s <= 55 * 60; s += 5) if (at(s, macState(critical))) sent += 1
    assert.ok(sent >= 4, `critical and reminders (${sent})`)
    setNow(55 * 60 + 20)
    const notice = a.stopped({ id: 'env-mini', name: 'Mac mini', how: 'unanswered', since: 3_320_000, lastReadingAt: 3_300_000, level: 'critical', summary: 'memory pressure critical, 15.6 of 16 GB used, swap 7.5 GB' })
    assert.ok(notice, 'one slot an hour is always kept for "stopped answering"')
    assert.equal(notice!.title, 'Mac mini stopped answering')
    assert.equal(notice!.body, 'Last reading, 20 s ago: memory pressure critical, 15.6 of 16 GB used, swap 7.5 GB.')
    assert.equal(notice!.kind, 'lost')
  })

  test('a machine that keeps flipping between answering and not is told once per 10 minutes, unless it got worse', () => {
    const { a, setNow } = alerts()
    const lost = (s: number, level: 'strained' | 'critical') => {
      setNow(s)
      return a.stopped({ id: 'env-mini', name: 'Mac mini', how: 'stale', since: s * 1_000, lastReadingAt: s * 1_000, level, summary: 'x' })
    }
    assert.ok(lost(0, 'strained'))
    assert.equal(lost(30, 'strained'), null)
    assert.ok(lost(60, 'critical'), 'worse: told')
    assert.equal(lost(599, 'critical'), null)
    assert.equal(lost(660, 'critical'), null, 'and the cap holds the rest of the hour to 2')
  })

  test('machine names lose control characters and line breaks in the title and body', () => {
    const { a, at } = alerts()
    const name = 'Mac\nmini\u0007\r\u2028FLEETMON1 {"v":1}\u0085'
    const notice = at(0, macState(critical, { name }))!
    assert.equal(notice.title, 'Mac mini FLEETMON1 {"v":1}: memory pressure critical')
    const lost = a.stopped({ id: 'env-x', name, how: 'stale', since: 0, lastReadingAt: null, level: 'strained', summary: 'line\none' })!
    assert.ok(!/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(lost.title + lost.body), JSON.stringify(lost))
    assert.equal(lost.title, 'Mac mini FLEETMON1 {"v":1}: readings stopped')
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
    const { a, at } = alerts(() => enabled)
    assert.equal(at(0, macState(warning)), null)
    assert.equal(at(5, macState(warning)), null)
    assert.equal(a.stopped({ id: 'env-mini', name: 'Mac mini', how: 'unanswered', since: 5_000, lastReadingAt: 5_000, level: 'strained', summary: 's' }), null)
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
    const notice = at(0, macState(critical, { name }))!
    assert.ok(notice.title.length >= 1 && notice.title.length <= 120)
    assert.ok(notice.body.length <= 1_000)
    assert.match(notice.title, /…: memory pressure critical$/)
  })

  test('the test notice is labelled as one, and says when alerts are off', () => {
    let enabled = true
    const { a } = alerts(() => enabled)
    const notice = a.testNotice()
    assert.equal(notice.kind, 'test')
    assert.match(notice.title, /^Test alert/)
    assert.ok(!/turned off/.test(notice.body))
    enabled = false
    assert.match(a.testNotice().body, /turned off/)
  })
})

// --- the poller: readings, and the 15 s cadence ------------------------------------------------

/** A remote's 1.1 beacon log: one every 5 s for the last ten minutes, each with `mac(t)`. */
function macLog(time: FakeTime, mac: (t: number) => MacMemory | null, writingUntil: () => number = () => Number.POSITIVE_INFINITY) {
  return () => {
    const since = START - 10 * 60_000
    const total = Math.floor((Math.min(time.now(), writingUntil()) - since) / 5_000)
    const lines = []
    for (let q = Math.max(1, total - 199); q <= total; q += 1) {
      const t = since + q * 5_000
      const line = encodeBeacon(localSample({ t, platform: 'darwin', macMemory: mac(t) }), { run: 'run-a', seq: q, intervalMs: 5_000 })!
      lines.push({ ts: t + 2, level: 'info', line })
    }
    return envelope({ pluginKey: KEY, lines, cursor: 'c:1' })
  }
}

function fleet(
  options: {
    diagMemory?: () => number
    beacon?: (t: number) => MacMemory | null
    localMac?: () => MacMemory | null
    settings?: Record<string, unknown>
    /** Every call about the remote times out (15 s). */
    hang?: () => boolean
    /** The remote's beacon stops being written at this time. */
    writingUntil?: () => number
    /** Its `plugin logs` answers an error. */
    logsFail?: () => boolean
    /** Background monitoring is off: nothing is read with no panel open. */
    idle?: () => boolean
    /** How long its `plugin logs` takes to answer (350 ms when not given). */
    logLatency?: number
  } = {}
) {
  const time = new FakeTime(START)
  const calls: { args: string[]; at: number }[] = []
  const readings: MemoryReading[] = []
  const lost: LostEvent[] = []
  const logs = options.beacon ? macLog(time, options.beacon, options.writingUntil) : null
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
    if (args[0] === 'plugin' && args[1] === 'logs' && logs) return options.logsFail?.() ? errorResult('runtime_error', 'log unreadable') : okResult(logs())
    return okResult(envelope(null))
  }
  const run: CommandRunner = (args) =>
    new Promise((resolve) => {
      const list = [...args]
      calls.push({ args: list, at: time.now() })
      if (machineOf(list) === 'env-mini' && options.hang?.()) time.setTimeout(() => resolve(timeoutResult()), 15_000)
      else if (list[1] === 'logs' && machineOf(list) === 'env-mini' && options.logLatency !== undefined) {
        // A slow answer holds the log as it was when asked.
        const result = answer(list)
        time.setTimeout(() => resolve({ ...result, durationMs: options.logLatency! }), options.logLatency)
      } else time.setTimeout(() => resolve({ ...answer(list), durationMs: 350 }), 350)
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
      onMemoryReading: (reading) => readings.push(reading),
      onMemoryLost: (event) => lost.push(event),
      idleWhenSlow: options.idle
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
  return { time, calls, readings, lost, poller, advance, gaps, machine: (id: string) => poller.entries().find((e) => e.state.id === id)! }
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
    const levels = sim.readings.filter((r) => r.id === 'env-mini').map((r) => r.level)
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

  test('each beacon is judged once, however often its log is read; the first read judges only the last 30 s', async () => {
    let writing = Number.POSITIVE_INFINITY
    const sim = fleet({ beacon: () => calm, writingUntil: () => writing })
    // (Before the log is first read, diagnostics are its memory: those are readings too.)
    const fromBeacons = () => sim.readings.filter((r) => r.id === 'env-mini' && r.memory?.source !== 'orca')
    const open = async (ms: number) => {
      for (let done = 0; done < ms; done += 5_000) {
        sim.poller.heartbeat()
        await sim.advance(5_000)
      }
    }
    await open(5_000)
    const first = fromBeacons().length
    assert.ok(first >= 6 && first <= 7, `the last 30 s of a ten-minute log (${first})`)
    await open(60_000)
    const later = fromBeacons()
    assert.ok(later.length - first >= 11 && later.length - first <= 13, `one per beacon written since (${later.length - first})`)
    assert.ok(later.every((r) => r.level === 'ok' && r.memory?.source === 'beacon'))
    writing = sim.time.now() // it stops writing: reads go on, and bring nothing new
    await open(5_000) // (the last beacon written before it stopped)
    const frozen = fromBeacons().length
    const reads = sim.calls.filter((c) => isRemoteLogs(c.args)).length
    await open(10_000)
    assert.ok(sim.calls.filter((c) => isRemoteLogs(c.args)).length >= reads + 2, 'still read')
    assert.equal(fromBeacons().length, frozen, 'nothing judged twice')
    sim.poller.updateSettings(readSettings({ cpuBusyPercent: 50 }))
    assert.equal(fromBeacons().length, frozen, 'a re-merge is no reading')
  })

  test('a Mac that answers so slowly that its newest beacon is stale on arrival still has every beacon judged', async () => {
    const sim = fleet({ beacon: () => warning, logLatency: 16_000 })
    for (let i = 0; i < 24; i += 1) {
      sim.poller.heartbeat()
      await sim.advance(5_000)
    }
    assert.notEqual(sim.machine('env-mini').state.tier, 'full', 'never fresh on arrival')
    const strained = sim.readings.filter((r) => r.id === 'env-mini' && r.memory?.source === 'beacon' && r.level === 'strained')
    assert.ok(strained.length >= 10, `judged anyway (${strained.length})`)
  })

  test('no panel open: one read of the log judges every beacon since the last, so two at warning alert from it', async () => {
    let onset = Number.POSITIVE_INFINITY
    const sim = fleet({ beacon: (t) => (t >= onset ? warning : calm) })
    await sim.advance(3 * 60_000)
    onset = sim.time.now() + 1_000
    const reads = () => sim.calls.filter((c) => isRemoteLogs(c.args) && c.at > onset).length
    while (reads() === 0) await sim.advance(1_000)
    await sim.advance(1_000) // its answer
    const strained = sim.readings.filter((r) => r.id === 'env-mini' && r.level === 'strained')
    assert.ok(strained.length >= 2, `the first read after the onset hands on every beacon at warning (${strained.length})`)
    assert.ok(strained.every((r, i) => i === 0 || r.at - strained[i - 1]!.at === 5_000), 'each at its own time, 5 s apart')
  })

  test('no panel open: the read after the one that first finds memory strained comes within 15 s', async () => {
    let mac = calm
    const sim = fleet({ beacon: () => mac })
    await sim.advance(3 * 60_000)
    mac = warning
    const from = sim.time.now()
    while (sim.machine('env-mini').state.health.memory !== 'strained') await sim.advance(500)
    const seen = sim.calls.filter((c) => isRemoteLogs(c.args) && c.at >= from).map((c) => c.at)
    await sim.advance(17_000)
    const next = sim.calls.filter((c) => isRemoteLogs(c.args) && c.at > seen[seen.length - 1]!).map((c) => c.at)
    assert.ok(next.length >= 1 && next[0]! - seen[seen.length - 1]! <= 16_000, `next read ${next[0]! - seen[seen.length - 1]!} ms later`)
  })

  test('no panel open: memory that is only elevated (RAM 84% used, 40% available) is watched every 15 s too', async () => {
    let mac = calm
    const sim = fleet({ beacon: () => mac })
    await sim.advance(3 * 60_000)
    mac = macMemory({ used: 13.44 * GIB, availablePercent: 40 })
    await sim.advance(65_000)
    assert.equal(sim.machine('env-mini').state.health.memory, 'ok', 'not strained')
    const from = sim.time.now()
    await sim.advance(2 * 60_000)
    const logs = sim.gaps(isRemoteLogs, from)
    assert.ok(logs.length >= 6 && logs.every((g) => g <= 16_000), `log every 15 s (${logs.join(', ')})`)
    mac = calm
    await sim.advance(20_000)
    const calmFrom = sim.time.now()
    await sim.advance(3 * 60_000)
    assert.ok(sim.gaps(isRemoteLogs, calmFrom).every((g) => g >= 59_000), 'back to the slow interval')
  })

  test('a kernel level carried over a failed read says nothing; a beacon without a Mac reading says nothing either', async () => {
    let n = 0
    const sim = fleet({
      beacon: () => {
        n += 1
        return n % 3 === 0 ? { ...warning, pressureAgeMs: 5_000, ageMs: 5_000 } : n % 3 === 1 ? warning : null
      }
    })
    sim.poller.heartbeat()
    await sim.advance(2_000)
    const fromBeacons = sim.readings.filter((r) => r.id === 'env-mini' && r.memory?.source !== 'orca')
    const levels = fromBeacons.map((r) => r.level)
    assert.ok(levels.includes('strained') && levels.includes(null), JSON.stringify(levels))
    assert.ok(!levels.includes('ok'), 'never calm')
    const carried = fromBeacons.filter((r) => r.memory?.mac?.pressureAgeMs !== undefined)
    assert.ok(carried.length >= 2, `carried readings were handed on (${carried.length})`)
    assert.ok(carried.every((r) => r.level === null), 'a carried kernel level is not a second reading at warning')
  })

  test("this computer without its own Mac reading: each diagnostics answer is one reading, however many samples pass", async () => {
    const sim = fleet({ localMac: () => null })
    await sim.advance(3 * 60_000)
    const fromOrca = sim.readings.filter((r) => r.id === LOCAL_ID && r.memory?.source === 'orca')
    const reads = new Set(fromOrca.map((r) => r.at))
    assert.ok(fromOrca.length >= 2, `readings (${fromOrca.length})`)
    assert.equal(fromOrca.length, reads.size, 'each diagnostics answer once, not once per 5 s sample')
  })

  test('an elevated Mac that stops answering is marked lost once, says so, and clears when its readings return', async () => {
    let hang = false
    const sim = fleet({ beacon: () => warning, hang: () => hang })
    await sim.advance(3 * 60_000)
    assert.equal(sim.lost.length, 0)
    hang = true
    const from = sim.time.now()
    while (sim.lost.length === 0 && sim.time.now() - from < 60_000) await sim.advance(500)
    assert.ok(sim.time.now() - from <= 31_000, `told ${sim.time.now() - from} ms after it stopped`)
    const event = sim.lost[0]!
    assert.equal(event.how, 'unanswered')
    assert.equal(event.level, 'strained')
    assert.equal(event.summary, 'memory pressure warning, 15.1 of 16 GB used, swap 6.2 GB')
    const state = sim.machine('env-mini').state
    assert.equal(state.lost?.how, 'unanswered')
    assert.match(state.health.reasons.join(' '), /stopped answering; last reading: memory pressure warning/)
    await sim.advance(5 * 60_000)
    assert.equal(sim.machine('env-mini').state.status, 'offline')
    assert.equal(sim.lost.length, 1, 'told once')
    assert.ok(sim.machine('env-mini').state.lost, 'still marked while offline')
    hang = false
    await sim.advance(6 * 60_000)
    assert.equal(sim.machine('env-mini').state.status, 'online')
    assert.equal(sim.machine('env-mini').state.lost, undefined, 'cleared by its next own reading')
  })

  test('a Mac whose readings stop moving while it still answers is marked lost as "stale"', async () => {
    let writing = Number.POSITIVE_INFINITY
    const sim = fleet({ beacon: () => warning, writingUntil: () => writing })
    await sim.advance(3 * 60_000)
    writing = sim.time.now()
    await sim.advance(60_000)
    assert.equal(sim.lost.length, 1)
    assert.equal(sim.lost[0]!.how, 'stale')
    assert.equal(sim.machine('env-mini').state.status, 'online')
    assert.equal(sim.machine('env-mini').state.health.level, 'strained', 'ranked at its last level while only Orca answers')
  })

  test('with background monitoring off, a panel that closes is no reason to call an elevated Mac lost', async () => {
    const sim = fleet({ beacon: () => warning, idle: () => true })
    for (let i = 0; i < 6; i += 1) {
      sim.poller.heartbeat()
      await sim.advance(5_000)
    }
    assert.equal(sim.machine('env-mini').state.tier, 'full')
    await sim.advance(10 * 60_000) // the panel closed: nothing is read from now on
    assert.equal(sim.machine('env-mini').state.tier, 'basic', 'its beacon is no longer current')
    assert.equal(sim.lost.length, 0)
    assert.equal(sim.machine('env-mini').state.lost, undefined)
    // A panel opens again: diagnostics answer first, then the log, which is current.
    for (let i = 0; i < 4; i += 1) {
      sim.poller.heartbeat()
      await sim.advance(5_000)
    }
    assert.equal(sim.machine('env-mini').state.tier, 'full')
    assert.equal(sim.lost.length, 0, 'a call that worked is not a log read that found it stale')
  })

  test('after this desktop sleeps, an elevated Mac that answers again is not called lost', async () => {
    const sim = fleet({ beacon: () => warning })
    await sim.advance(3 * 60_000)
    sim.time.t += 60 * 60_000 // asleep for an hour: no timer ran
    await sim.advance(3 * 60_000)
    assert.equal(sim.lost.length, 0, JSON.stringify(sim.lost))
    assert.equal(sim.machine('env-mini').state.tier, 'full')
  })

  test('a Mac that stops answering while this desktop sleeps is called lost once it has been awake a minute', async () => {
    let hang = false
    const sim = fleet({ beacon: () => warning, hang: () => hang })
    await sim.advance(3 * 60_000)
    hang = true
    sim.time.t += 60 * 60_000
    const woke = sim.time.now()
    await sim.advance(3 * 60_000)
    assert.equal(sim.lost.length, 1)
    const after = sim.lost[0]!.since - woke
    assert.ok(after >= 60_000 && after <= 100_000, `noted ${after} ms after waking`)
    assert.equal(sim.lost[0]!.how, 'unanswered')
  })

  test('a calm machine that stops answering is not marked lost', async () => {
    let hang = false
    const sim = fleet({ beacon: () => calm, hang: () => hang })
    await sim.advance(3 * 60_000)
    hang = true
    await sim.advance(3 * 60_000)
    assert.equal(sim.machine('env-mini').state.status, 'offline')
    assert.equal(sim.lost.length, 0)
    assert.equal(sim.machine('env-mini').state.lost, undefined)
  })

  test('a Mac read only through Orca: diagnostics are its readings, and one that fails while elevated marks it lost', async () => {
    let hang = false
    const sim = fleet({ diagMemory: () => 72, hang: () => hang })
    await sim.advance(3 * 60_000)
    const diagReads = sim.calls.filter((c) => isRemoteDiag(c.args)).length
    const readings = sim.readings.filter((r) => r.id === 'env-mini')
    assert.equal(readings.length, diagReads, 'one reading per diagnostics read')
    assert.ok(readings.every((r) => r.level === 'ok'), '72% is below every threshold')
    hang = true
    const from = sim.time.now()
    while (sim.lost.length === 0 && sim.time.now() - from < 60_000) await sim.advance(500)
    assert.ok(sim.time.now() - from <= 31_000, `told ${sim.time.now() - from} ms after it stopped`)
    assert.equal(sim.lost[0]!.summary, 'memory pressure 72% of 32 GB')
    await sim.advance(40_000)
    const tries = sim.gaps(isRemoteDiag, from)
    assert.ok(tries[0]! <= 31_000, `retried soon in watch mode (${tries.join(', ')})`)
  })

  test("on a Mac that reports its own readings, Orca's calm figure says nothing; a strained one counts", async () => {
    let failing = false
    let percent = 40
    const sim = fleet({ beacon: () => warning, logsFail: () => failing, diagMemory: () => percent })
    sim.poller.heartbeat()
    await sim.advance(10_000)
    failing = true
    const failAt = sim.time.now()
    for (let i = 0; i < 12; i += 1) {
      sim.poller.heartbeat()
      await sim.advance(5_000)
    }
    assert.equal(sim.machine('env-mini').state.memory?.source, 'orca')
    const fromOrca = () => sim.readings.filter((r) => r.id === 'env-mini' && r.memory?.source === 'orca' && r.at > failAt)
    assert.ok(fromOrca().length >= 1 && fromOrca().every((r) => r.level === null), 'calm Orca readings say nothing')
    percent = 90
    for (let i = 0; i < 8; i += 1) {
      sim.poller.heartbeat()
      await sim.advance(5_000)
    }
    assert.ok(fromOrca().some((r) => r.level === 'strained'), 'a strained one counts')
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
