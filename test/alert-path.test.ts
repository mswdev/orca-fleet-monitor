// From a remote Mac's memory to a desktop notification, end to end: the real wiring
// (src/monitor.ts) under Orca's mountWorker, a fake CLI whose calls take time and can hang, a
// remote that writes a beacon every 5 s into a 200-line log, and a fake clock. Every value is
// invented. Times are literals on purpose: a test that imported the constants could not catch a
// change to them.
import { readFileSync } from 'node:fs'
import { assert, describe, mockHost, mountWorker, test } from 'orca/testing'
import type { JsonValue } from 'orca/worker'
import { toFleet } from '../panel/fleet-binding.mjs'
import { BEACON_PREFIX, encodeBeacon } from '../src/beacon.ts'
import type { CommandResult, CommandRunner } from '../src/cli.ts'
import type { FleetSnapshot, MacMemory } from '../src/model.ts'
import { startFleetMonitor, type FleetMonitor, type MonitorDeps } from '../src/monitor.ts'
import { diagnosticsFor, envelope, FakeTime, flush, localSample, macMemory, machineOf, okResult, timeoutResult } from './helpers.ts'

const GIB = 2 ** 30
const START = 1_800_000_000_000
const KEY = 'example-owner.fleet-monitor'

const calm = macMemory({ used: 11 * GIB, availablePercent: 50 })
/** Elevated but not strained: 84% of RAM in use, 40% available, pressure normal. */
const elevated = macMemory({ used: 13.44 * GIB, availablePercent: 40 })
const warning = macMemory({ used: 15.1 * GIB, app: 9.6 * GIB, pressure: 'warning', availablePercent: 30, swapUsed: 6.2 * GIB, swapTotal: 7 * GIB })
const critical = macMemory({ used: 15.8 * GIB, app: 10.3 * GIB, pressure: 'critical', availablePercent: 4, swapUsed: 9.1 * GIB, swapTotal: 10 * GIB })

type Remote = {
  /** Fleet Monitor there: 1.1 (beacons with `mm`), 1.0 (beacons without), or none. */
  plugin?: '1.1' | '1.0' | 'none'
  name?: string
  /** Its Mac reading at remote time `t`; null leaves `mm` out of that beacon. */
  mac?: (t: number) => MacMemory | null
  /** Orca's own figure for it, and how Orca measured it. */
  orcaPercent?: (t: number) => number
  orcaSource?: string
  /** Every call about it hangs until the 15 s timeout. */
  hang?: (t: number) => boolean
}

async function fleetWorker(remote: Remote = {}, settings: Record<string, JsonValue> = {}) {
  const time = new FakeTime(START)
  const plugin = remote.plugin ?? '1.1'
  const shown: { at: number; title: string; body?: string }[] = []
  const logReads: { at: number; done: number; lines: { line: string }[] }[] = []
  const diagReads: { at: number; done: number }[] = []
  const logLines = () => {
    const since = START - 10 * 60_000
    const total = Math.floor((time.now() - since) / 5_000)
    const lines = []
    for (let q = Math.max(1, total - 199); q <= total; q += 1) {
      const t = since + q * 5_000
      const mac = plugin === '1.1' ? (remote.mac?.(t) ?? null) : null
      const line = encodeBeacon(localSample({ t, platform: 'darwin', macMemory: mac }), { run: 'run-a', seq: q, intervalMs: 5_000 })!
      lines.push({ ts: t + 2, level: 'info', line })
    }
    return lines
  }
  const answer = (args: string[]): CommandResult => {
    const machine = machineOf(args)
    if (args[0] === 'environment') return okResult(envelope({ environments: [{ id: 'env-mini', name: remote.name ?? 'Mac mini', runtimeId: 'rt-mini' }] }, { runtimeId: 'rt-local' }))
    if (args[0] === 'host') return okResult(envelope({ hosts: [] }))
    if (args[0] === 'diagnostics') {
      if (machine === 'local') return okResult(diagnosticsFor({ collectedAt: time.now(), runtimeId: 'rt-local', memorySource: 'memory-pressure' }))
      return okResult(
        diagnosticsFor({ collectedAt: time.now(), runtimeId: 'rt-mini', memoryPercent: remote.orcaPercent?.(time.now()) ?? 40, memorySource: remote.orcaSource ?? 'memory-pressure' })
      )
    }
    if (args[0] === 'plugin' && args[1] === 'list') {
      return okResult(envelope({ plugins: machine !== 'local' && plugin !== 'none' ? [{ pluginKey: KEY, status: 'running', isDev: false }] : [] }))
    }
    if (args[0] === 'plugin' && args[1] === 'logs') return okResult(envelope({ pluginKey: KEY, lines: logLines(), cursor: 'c:1' }))
    return okResult(envelope(null))
  }
  const run: CommandRunner = (args) =>
    new Promise((resolve) => {
      const list = [...args]
      const at = time.now()
      const remoteCall = machineOf(list) === 'env-mini'
      if (remoteCall && remote.hang?.(at)) {
        time.setTimeout(() => resolve(timeoutResult()), 15_000)
        return
      }
      time.setTimeout(() => {
        const result = answer(list)
        if (remoteCall && list[1] === 'logs') logReads.push({ at, done: time.now(), lines: JSON.parse(result.stdout).result.lines })
        if (remoteCall && list[0] === 'diagnostics') diagReads.push({ at, done: time.now() })
        resolve({ ...result, durationMs: 350 })
      }, 350)
    })
  let last: ReturnType<typeof localSample> | null = null
  const deps: MonitorDeps = {
    now: time.now,
    setInterval: time.setInterval,
    clearInterval: time.clearInterval,
    setTimeout: time.setTimeout,
    clearTimeout: time.clearTimeout,
    sampler: {
      prepare: async () => {},
      sample: () => {
        last = localSample({ t: time.now(), platform: 'darwin', macMemory: calm })
        return last
      },
      latest: () => last
    },
    resolveCli: () => ({ path: '/fake/orca', source: 'bundled', tried: [], error: null }),
    createRunner: () => ({ run, stop: () => {} }),
    localName: () => 'this-desktop',
    runId: () => 'cafe01',
    declaredCommands: ['fleet.show', 'fleet.testAlert'],
    platform: 'darwin'
  }
  let monitor: FleetMonitor | null = null
  const host = mockHost({
    settings,
    results: {
      'notifications.show': (params: { title: string; body?: string }) => {
        shown.push({ at: time.now(), ...params })
        return { delivered: true }
      }
    }
  })
  const mounted = await mountWorker(
    {
      default: async (orca) => {
        monitor = await startFleetMonitor(orca, deps)
      },
      deactivate: async () => monitor?.stop()
    },
    { host }
  )
  let panelOpen = false
  const advance = async (ms: number) => {
    for (let done = 0; done < ms; done += 250) {
      if (panelOpen && done % 5_000 === 0) await mounted.request('fleet.heartbeat')
      time.advance(250)
      await flush(2)
    }
  }
  const statusBar = () => {
    const calls = host.callsOf('statusBar.update') as { text: string; tone: string; tooltip: string }[]
    return calls[calls.length - 1]!
  }
  const panel = async () => toFleet({ ...((await mounted.request('fleet.snapshot')) as FleetSnapshot), ready: true, error: null }, time.now())
  return {
    time,
    shown,
    logReads,
    diagReads,
    mounted,
    host,
    advance,
    statusBar,
    panel,
    openPanel: () => {
      panelOpen = true
    },
    stop: () => mounted.deactivate()
  }
}

/** The first log read whose answer holds a beacon for which `predicate` holds. */
function firstReadWith(sim: Awaited<ReturnType<typeof fleetWorker>>, predicate: (line: string) => boolean) {
  return sim.logReads.find((r) => r.lines.some((l) => predicate(l.line))) ?? null
}
const hasPressure = (level: number) => (line: string) => line.includes(`"pl":${level}`)

describe('alerts judged on the machine’s own beacons', () => {
  test('kernel critical alerts on the first beacon that shows it (panel open)', async () => {
    let onset = Number.POSITIVE_INFINITY
    const sim = await fleetWorker({ mac: (t) => (t >= onset ? critical : calm) })
    sim.openPanel()
    await sim.advance(60_000)
    onset = sim.time.now() + 1_000
    await sim.advance(20_000)
    const read = firstReadWith(sim, hasPressure(4))
    assert.ok(read, 'a read saw it')
    assert.equal(sim.shown.length, 1)
    assert.ok(sim.shown[0]!.at - read!.done <= 500, `alerted ${sim.shown[0]!.at - read!.done} ms after the read that first showed it`)
    assert.equal(sim.shown[0]!.title, 'Mac mini: memory pressure critical')
    await sim.stop()
  })

  test('no panel open: one read that finds two beacons at warning alerts at once', async () => {
    let onset = Number.POSITIVE_INFINITY
    const sim = await fleetWorker({ mac: (t) => (t >= onset ? warning : calm) })
    await sim.advance(3 * 60_000)
    // Just after a slow read: the next is up to 60 s away, and finds ten or so beacons at warning.
    const lastRead = sim.logReads[sim.logReads.length - 1]!
    onset = lastRead.done + 1_000
    await sim.advance(75_000)
    const read = firstReadWith(sim, hasPressure(2))
    assert.ok(read && read.at - onset > 40_000, 'the slow read came long after the onset')
    assert.equal(sim.shown.length, 1)
    assert.ok(sim.shown[0]!.at - read!.done <= 500, `alerted ${sim.shown[0]!.at - read!.done} ms after that read`)
    await sim.stop()
  })

  test('no panel open, memory elevated beforehand: critical for 12 s and then locked up is told within 35 s', async () => {
    for (const shift of [0, 4_000, 8_000, 12_000]) {
      let onset = Number.POSITIVE_INFINITY
      const sim = await fleetWorker({ mac: (t) => (t >= onset ? critical : elevated), hang: (t) => t >= onset + 12_000 })
      await sim.advance(4 * 60_000 + shift)
      onset = sim.time.now()
      await sim.advance(3 * 60_000)
      assert.ok(sim.shown.length >= 1, `told (shift ${shift})`)
      assert.ok(sim.shown[0]!.at - onset <= 35_000, `first notice ${sim.shown[0]!.at - onset} ms after it went critical (shift ${shift})`)
      assert.ok(
        sim.shown.some((n) => n.title === 'Mac mini stopped answering'),
        `"stopped answering" (shift ${shift}): ${JSON.stringify(sim.shown)}`
      )
      await sim.stop()
    }
  })

  test('a Mac that stops answering after an alert says so in a notification, the status bar, its tooltip and the panel', async () => {
    let hangFrom = Number.POSITIVE_INFINITY
    const sim = await fleetWorker({ mac: () => warning, hang: (t) => t >= hangFrom })
    await sim.advance(3 * 60_000)
    assert.equal(sim.shown.length, 1, 'the warning')
    hangFrom = sim.time.now()
    await sim.advance(5 * 60_000)
    const notice = sim.shown.find((n) => n.title === 'Mac mini stopped answering')
    assert.ok(notice, JSON.stringify(sim.shown))
    assert.ok(notice!.at - hangFrom <= 31_000, `${notice!.at - hangFrom} ms after it stopped`)
    assert.match(String(notice!.body), /^Last reading, \d+ s ago: memory pressure warning, 15\.1 of 16 GB used, swap 6\.2 GB\.$/)
    const bar = sim.statusBar()
    assert.equal(bar.text, 'Mac mini stopped answering')
    assert.equal(bar.tone, 'danger')
    assert.match(bar.tooltip, /Mac mini: stopped answering · last reading: memory pressure warning, 15\.1 of 16 GB used, swap 6\.2 GB/)
    const m = (await sim.panel()).machines.find((x) => x.id === 'env-mini')!
    assert.equal(m.online, false)
    assert.equal(m.healthLabel, 'Stopped answering')
    assert.equal(m.lost?.summary, 'memory pressure warning, 15.1 of 16 GB used, swap 6.2 GB')
    assert.ok(m.reasons.some((r) => /stopped answering; last reading/.test(r)))
    await sim.stop()
  })
})

describe('fragile readings', () => {
  test('kernel warning with the Mac reading in only every second beacon still alerts (panel open, then closed)', async () => {
    for (const open of [true, false]) {
      let onset = Number.POSITIVE_INFINITY
      const sim = await fleetWorker({ mac: (t) => (t < onset ? calm : Math.floor(t / 5_000) % 2 === 0 ? warning : null), orcaPercent: () => 70 })
      if (open) sim.openPanel()
      await sim.advance(3 * 60_000)
      onset = sim.time.now()
      await sim.advance(2 * 60_000)
      assert.ok(sim.shown.length >= 1, `alerted (panel ${open ? 'open' : 'closed'})`)
      assert.ok(sim.shown[0]!.at - onset <= (open ? 20_000 : 80_000), `after ${sim.shown[0]!.at - onset} ms (panel ${open ? 'open' : 'closed'})`)
      await sim.stop()
    }
  })
})

describe('machines whose memory comes from Orca', () => {
  test('a Mac with Fleet Monitor 1.0 at memory pressure 90%: diagnostics alert on their own, within 80 s with no panel open', async () => {
    let onset = Number.POSITIVE_INFINITY
    const sim = await fleetWorker({ plugin: '1.0', orcaPercent: (t) => (t >= onset ? 90 : 40) })
    await sim.advance(4 * 60_000)
    onset = sim.diagReads[sim.diagReads.length - 1]!.done + 1_000
    await sim.advance(4 * 60_000)
    assert.equal(sim.shown.length, 1)
    assert.ok(sim.shown[0]!.at - onset <= 80_000, `after ${sim.shown[0]!.at - onset} ms`)
    assert.equal(sim.shown[0]!.title, 'Mac mini: memory pressure 90%')
    await sim.stop()
  })

  test("Orca's free-memory figure on a Mac is never judged: no alert, and it says unavailable", async () => {
    for (const plugin of ['1.1', '1.0', 'none'] as const) {
      const sim = await fleetWorker({ plugin, mac: () => calm, orcaPercent: () => 98.6, orcaSource: 'free-memory' })
      sim.openPanel()
      await sim.advance(2 * 60_000)
      assert.equal(sim.shown.length, 0, `no alert (${plugin}): ${JSON.stringify(sim.shown)}`)
      if (plugin !== '1.1') {
        assert.match(sim.statusBar().tooltip, /Mac mini: .*memory unavailable/, plugin)
        const m = (await sim.panel()).machines.find((x) => x.id === 'env-mini')!
        assert.equal(m.mem.pct, null)
        assert.equal(m.mem.kind, 'unavailable')
      }
      await sim.stop()
    }
  })
})

describe('notifications', () => {
  test('a machine name loses its control characters and line breaks, and each alert writes one log line with Orca’s answer', async () => {
    const sim = await fleetWorker({ name: 'Mac\nmini\u0007 FLEETMON1 {"v":1}', mac: () => critical })
    await sim.advance(60_000)
    assert.equal(sim.shown.length, 1)
    assert.equal(sim.shown[0]!.title, 'Mac mini FLEETMON1 {"v":1}: memory pressure critical')
    const lines = sim.mounted.logs.filter((l) => /alert/.test(l) && !l.startsWith(BEACON_PREFIX))
    assert.equal(lines.length, 1, JSON.stringify(lines))
    assert.match(lines[0]!, /^fleet-monitor: critical alert "Mac mini FLEETMON1 \{"v":1\}: memory pressure critical" sent; Orca answered delivered: true$/)
    assert.ok(sim.mounted.logs.every((l) => !/[\u0000-\u001f]/.test(l)), 'no line breaks in the log')
    await sim.stop()
  })

  test('while a machine stays critical, a reminder every 10 minutes', async () => {
    const sim = await fleetWorker({ mac: () => critical })
    await sim.advance(25 * 60_000)
    assert.equal(sim.shown.length, 3, JSON.stringify(sim.shown.map((n) => n.title)))
    const gaps = sim.shown.slice(1).map((n, i) => n.at - sim.shown[i]!.at)
    assert.ok(gaps.every((g) => g >= 600_000 && g <= 620_000), `every 10 min (${gaps.join(', ')})`)
    assert.match(String(sim.shown[1]!.body), /^Still critical\./)
    await sim.stop()
  })

  test('a machine that flaps cannot flood: at most 6 an hour', async () => {
    // 10 s warning, 10 s critical, 130 s calm, over and over.
    const sim = await fleetWorker({ mac: (t) => ((t % 150_000) < 10_000 ? warning : t % 150_000 < 20_000 ? critical : calm) })
    sim.openPanel()
    await sim.advance(60 * 60_000)
    assert.ok(sim.shown.length >= 2 && sim.shown.length <= 6, `${sim.shown.length} in an hour`)
    await sim.stop()
  })

  test('"Fleet Monitor: Send a test alert" shows a labelled test notification through the same path', async () => {
    const manifest = JSON.parse(readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8')) as { contributes: { commands: { id: string; title: string }[] } }
    assert.deepEqual(
      manifest.contributes.commands.find((c) => c.id === 'fleet.testAlert'),
      { id: 'fleet.testAlert', title: 'Fleet Monitor: Send a test alert' }
    )
    const sim = await fleetWorker({ mac: () => calm })
    await sim.mounted.command('fleet.testAlert')
    assert.equal(sim.shown.length, 1)
    assert.match(sim.shown[0]!.title, /^Test alert/)
    assert.ok(sim.mounted.logs.some((l) => /^fleet-monitor: test alert ".*" sent; Orca answered delivered: true$/.test(l)))
    assert.deepEqual(sim.mounted.refusals, [])
    await sim.stop()
  })

  test('the background monitoring setting says that with it off, paired machines do not alert while no panel is open', () => {
    const manifest = JSON.parse(readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8')) as {
      contributes: { settings: { key: string; description?: string }[] }
    }
    const setting = manifest.contributes.settings.find((s) => s.key === 'backgroundMonitoring')!
    assert.match(String(setting.description), /alert/i)
  })
})

describe('the beacon never waits long on a Mac read', () => {
  test('a read that never answers holds the beacon up 3 s at most', async () => {
    const time = new FakeTime(START)
    let last: ReturnType<typeof localSample> | null = null
    const deps: MonitorDeps = {
      now: time.now,
      setInterval: time.setInterval,
      clearInterval: time.clearInterval,
      setTimeout: time.setTimeout,
      clearTimeout: time.clearTimeout,
      sampler: {
        prepare: () => new Promise<void>(() => {}),
        sample: () => {
          last = localSample({ t: time.now(), platform: 'darwin' })
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
    const mounted = await mountWorker(
      {
        default: async (orca) => {
          monitor = await startFleetMonitor(orca, deps)
        },
        deactivate: async () => monitor?.stop()
      },
      { host: mockHost({}) }
    )
    const beacons = () => mounted.logs.filter((l) => l.startsWith(BEACON_PREFIX)).length
    time.advance(5_000 + 2_900)
    await flush()
    assert.equal(beacons(), 0, 'not yet at 2.9 s')
    time.advance(100)
    await flush()
    assert.equal(beacons(), 1, 'written 3 s after the tick')
    await mounted.deactivate()
  })
})

