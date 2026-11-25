// A Mac's network, disk, GPU and battery (src/mac-system.ts), with invented command output.
import { assert, describe, test } from 'orca/testing'
import type { ExecFile, ExecResult } from '../src/mac-memory.ts'
import {
  diskSpaceOf,
  isInterfaceName,
  MAC_TEMP_SCRIPT,
  MacSystemReader,
  OSASCRIPT_PATH,
  parseDefaultRoute,
  parseMacTemps,
  parseDiskStats,
  parseGpu,
  parseNetstat,
  parsePmset,
  SMC_KEYS,
  smcKeyList,
  smcKeysFor,
  SYSTEM_CADENCE,
  SYSTEM_MAX_AGE,
  TEMP_TRIES
} from '../src/mac-system.ts'

const NETSTAT_HEAD = 'Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll'
const netstat = (iface: string, rx: number, tx: number, address = '02:00:00:00:00:01'): string =>
  [
    NETSTAT_HEAD,
    `${iface}        1500  <Link#7>    ${address} 1000     0 ${rx}    900     0 ${tx}     0`,
    `${iface}        1500  192.0.2     192.0.2.10         1000     - ${rx}    900     - ${tx}     -`
  ].join('\n')

const disks = (entries: { id: string; read: number; write: number }[]): string =>
  entries
    .map(
      (e) =>
        `+-o IOBlockStorageDriver  <class IOBlockStorageDriver, id ${e.id}, registered, matched, active, busy 0 (1 ms), retain 6>\n` +
        `      "Statistics" = {"Operations (Write)"=5,"Bytes (Read)"=${e.read},"Errors (Write)"=0,"Bytes (Write)"=${e.write},"Operations (Read)"=9}`
    )
    .join('\n')

const gpus = (...percents: (number | string)[]): string =>
  percents
    .map((p, i) => `+-o AGXAcceleratorExample  <class AGXAcceleratorExample, id 0x1000${i}, registered>\n      "PerformanceStatistics" = {"Tiler Utilization %"=3,"Device Utilization %"=${p},"Renderer Utilization %"=2}`)
    .join('\n')

describe('parsers', () => {
  test('the default route names its interface, and only a plain one', () => {
    assert.equal(parseDefaultRoute('   route to: default\ndestination: default\n  interface: en0\n      flags: <UP,GATEWAY,DONE>'), 'en0')
    assert.equal(parseDefaultRoute('  interface: utun3\n'), 'utun3')
    assert.equal(parseDefaultRoute('route: writing to routing socket: not in table'), null)
    assert.equal(parseDefaultRoute('  interface: -rf\n'), null)
    assert.equal(parseDefaultRoute('  interface: en0;ls\n'), null)
    assert.equal(parseDefaultRoute(42), null)
    assert.equal(isInterfaceName('bridge100'), true)
    assert.equal(isInterfaceName('a'.repeat(17)), false)
  })

  test('netstat: the Link row, columns counted from the right', () => {
    assert.deepEqual(parseNetstat(netstat('en0', 802_678_695_260, 40_040_855_250), 'en0'), { rx: 802_678_695_260, tx: 40_040_855_250 })
    // A tunnel has no hardware address: one field fewer in the middle.
    const tunnel = [NETSTAT_HEAD, 'utun3      1380  <Link#20>                       500     0     123456      400     0      65432     0'].join('\n')
    assert.deepEqual(parseNetstat(tunnel, 'utun3'), { rx: 123456, tx: 65432 })
    // An interface that is down is still read.
    assert.deepEqual(parseNetstat(netstat('en1*', 5, 6), 'en1'), { rx: 5, tx: 6 })
    assert.equal(parseNetstat(netstat('en0', 5, 6), 'en9'), null, 'another interface')
    assert.equal(parseNetstat('Name Mtu\nen0 1500 <Link#7> 1 2', 'en0'), null, 'no byte columns')
    assert.equal(parseNetstat(netstat('en0', 5, 6).replace(' 5 ', ' 5x '), 'en0'), null, 'not digits')
    assert.equal(parseNetstat(netstat('en0', 9e20, 6), 'en0'), null, 'past a safe integer')
    assert.equal(parseNetstat('x'.repeat(70_000), 'en0'), null)
  })

  test('ioreg block storage: bytes per driver, by registry id', () => {
    const map = parseDiskStats(disks([{ id: '0x100000ba2', read: 2_000, write: 1_000 }, { id: '0x100062f8a', read: 0, write: 0 }]))
    assert.deepEqual([...map!.entries()], [['0x100000ba2', { read: 2_000, write: 1_000 }], ['0x100062f8a', { read: 0, write: 0 }]])
    const broken = '+-o IOBlockStorageDriver  <class IOBlockStorageDriver, id 0x1, registered>\n      "Statistics" = {"Bytes (Read)"=abc}'
    assert.equal(parseDiskStats(broken)!.size, 0)
    assert.equal(parseDiskStats('      "Statistics" = {"Bytes (Read)"=1,"Bytes (Write)"=2}')!.size, 0, 'statistics without an object line')
    assert.equal(parseDiskStats(null), null)
  })

  test('ioreg GPU: the busiest one, 0 to 100 only', () => {
    assert.equal(parseGpu(gpus(12)), 12)
    assert.equal(parseGpu(gpus(4, 37)), 37)
    assert.equal(parseGpu(gpus(250)), null)
    assert.equal(parseGpu('+-o IntelAccelerator <class IntelAccelerator, id 0x2>\n      "PerformanceStatistics" = {"GPU Core Utilization"=5}'), null)
    assert.equal(parseGpu(''), null)
  })

  test('pmset: each state, and a Mac without a battery', () => {
    const line = (rest: string) => `Now drawing from 'AC Power'\n -InternalBattery-0 (id=1234567)\t${rest} present: true`
    assert.deepEqual(parsePmset(line('81%; charging; 1:05 remaining')), { present: true, percent: 81, state: 'charging', source: 'ac', minutesRemaining: 65 })
    assert.deepEqual(parsePmset(line('100%; charged; 0:00 remaining')), { present: true, percent: 100, state: 'charged', source: 'ac', minutesRemaining: null })
    assert.deepEqual(parsePmset(line('80%; AC attached; not charging')), { present: true, percent: 80, state: 'not-charging', source: 'ac', minutesRemaining: null })
    assert.deepEqual(parsePmset(line('99%; finishing charge; 0:04 remaining')), { present: true, percent: 99, state: 'charging', source: 'ac', minutesRemaining: 4 })
    const onBattery = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1234567)\t55%; discharging; (no estimate) present: true"
    assert.deepEqual(parsePmset(onBattery), { present: true, percent: 55, state: 'discharging', source: 'battery', minutesRemaining: null })
    const draining = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t9%; discharging; 0:21 remaining present: true"
    assert.equal(parsePmset(draining)?.minutesRemaining, 21)
    assert.deepEqual(parsePmset("Now drawing from 'AC Power'\n"), { present: false, percent: null, state: null, source: 'ac', minutesRemaining: null })
    assert.equal(parsePmset("Now drawing from 'UPS Power'\n -InternalBattery-0 (id=1)\t50%; charging; 0:10 remaining present: false")?.present, false)
    assert.equal(parsePmset("Now drawing from 'UPS Power'\n")?.source, 'ups')
    assert.equal(parsePmset(line('81%; levitating; 1:05 remaining'))?.state, null, 'an unknown state')
    assert.equal(parsePmset(line('81%; charging; 1:75 remaining'))?.minutesRemaining, null, 'minutes out of shape')
    assert.equal(parsePmset(line('181%; charging; 1:00 remaining'))?.percent, null)
    assert.equal(parsePmset(line('constructor%; toString; x'))?.present, true, 'a line out of shape keeps only that there is a battery')
    assert.equal(parsePmset('no power line here'), null)
  })

  test('disk space: the container size, and used = size − available', () => {
    assert.deepEqual(diskSpaceOf({ bsize: 4096, blocks: 1_000, bavail: 400 }), { total: 4_096_000, used: 2_457_600 })
    assert.equal(diskSpaceOf({ bsize: 4096, blocks: 1_000, bavail: 2_000 }), null)
    assert.equal(diskSpaceOf({ bsize: 0, blocks: 1_000, bavail: 1 }), null)
    assert.equal(diskSpaceOf({ bsize: 4096, blocks: -1, bavail: 0 }), null)
    assert.equal(diskSpaceOf({ bsize: 2 ** 30, blocks: 2 ** 40, bavail: 0 }), null, 'past a safe integer')
    assert.equal(diskSpaceOf(null), null)
  })
})

/** A scripted Mac: what each command prints now, and a clock that only moves when told. */
function fakeMac() {
  const state = { t: 0, iface: 'en0', rx: 1_000_000, tx: 50_000, disks: [{ id: '0xa', read: 10_000_000, write: 5_000_000 }], gpu: 20 as number | null, battery: "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t70%; charging; 0:40 remaining present: true", fail: new Set<string>() }
  const calls: string[] = []
  const exec: ExecFile = async (file, args) => {
    calls.push(file.split('/').pop()!)
    const ok = (stdout: string): ExecResult => ({ error: null, stdout })
    const name = file.split('/').pop()!
    if (state.fail.has(name)) return { error: Object.assign(new Error('failed'), { code: 1 }), stdout: '' }
    if (name === 'route') return ok(`  interface: ${state.iface}\n`)
    if (name === 'netstat') return ok(args.includes(state.iface) ? netstat(state.iface, state.rx, state.tx) : NETSTAT_HEAD)
    if (name === 'ioreg' && args.includes('IOBlockStorageDriver')) return ok(disks(state.disks))
    if (name === 'ioreg') return ok(state.gpu === null ? '' : gpus(state.gpu))
    if (name === 'pmset') return ok(state.battery)
    return ok('')
  }
  const statfs = () => ({ bsize: 4096, blocks: 250_000_000, bavail: 100_000_000 })
  const reader = new MacSystemReader({ exec, mono: () => state.t, statfs, platform: 'darwin', cpuModel: '' })
  return { state, calls, reader }
}

describe('MacSystemReader', () => {
  test('rates from counters between readings; the first reading has none', async () => {
    const mac = fakeMac()
    await mac.reader.refresh()
    const first = mac.reader.snapshot()!
    assert.deepEqual(first.net, { iface: 'en0', rxBytesPerSec: null, txBytesPerSec: null })
    assert.equal(first.disk?.readBytesPerSec, null)
    assert.equal(first.disk?.totalBytes, 1_024_000_000_000)
    assert.equal(first.disk?.usedBytes, 614_400_000_000)
    assert.equal(first.gpu?.percent, 20)
    assert.equal(first.battery?.percent, 70)
    mac.state.t = 5_000
    mac.state.rx += 2_500_000
    mac.state.tx += 500_000
    await mac.reader.refresh()
    const second = mac.reader.snapshot()!
    assert.deepEqual([second.net?.rxBytesPerSec, second.net?.txBytesPerSec], [500_000, 100_000])
    // The slow parts were not read again: they are carried, with their age.
    assert.equal(second.gpu?.ageMs, 5_000)
    assert.equal(second.battery?.ageMs, 5_000)
    assert.equal(second.disk?.spaceAgeMs, 5_000)
    assert.equal(mac.calls.filter((c) => c === 'ioreg').length, 2, 'ioreg once per class so far')
    mac.state.t = SYSTEM_CADENCE.diskIoMs
    const seconds = SYSTEM_CADENCE.diskIoMs / 1000
    mac.state.disks = [{ id: '0xa', read: 10_000_000 + seconds * 1_000_000, write: 5_000_000 + seconds * 100_000 }]
    await mac.reader.refresh()
    const third = mac.reader.snapshot()!
    assert.deepEqual([third.disk?.readBytesPerSec, third.disk?.writeBytesPerSec], [1_000_000, 100_000])
    assert.equal(third.disk?.ioAgeMs, undefined, 'just read')
  })

  test('a disk that appears, goes or resets costs only its own share', async () => {
    const mac = fakeMac()
    mac.state.disks = [{ id: '0xa', read: 1_000, write: 1_000 }, { id: '0xb', read: 9_000_000, write: 9_000_000 }]
    await mac.reader.refresh()
    mac.state.t = SYSTEM_CADENCE.diskIoMs
    mac.state.disks = [{ id: '0xa', read: 1_000 + (SYSTEM_CADENCE.diskIoMs / 1000) * 2_000, write: 1_000 }, { id: '0xc', read: 5, write: 5 }]
    await mac.reader.refresh()
    assert.deepEqual([mac.reader.snapshot()!.disk?.readBytesPerSec, mac.reader.snapshot()!.disk?.writeBytesPerSec], [2_000, 0])
  })

  test('counters that go back, or a new default interface, start the rates again', async () => {
    const mac = fakeMac()
    await mac.reader.refresh()
    mac.state.t = 5_000
    mac.state.rx = 10
    await mac.reader.refresh()
    assert.equal(mac.reader.snapshot()!.net?.rxBytesPerSec, null, 'the counter went back')
    mac.state.t = 10_000
    mac.state.rx = 1_010
    await mac.reader.refresh()
    assert.equal(mac.reader.snapshot()!.net?.rxBytesPerSec, 200)
    // The default route moves to another interface; netstat for the old one finds nothing.
    mac.state.iface = 'en7'
    mac.state.t = 15_000
    await mac.reader.refresh()
    mac.state.t = 20_000
    await mac.reader.refresh()
    const net = mac.reader.snapshot()!.net
    assert.equal(net?.iface, 'en7')
    assert.equal(net?.rxBytesPerSec, null)
  })

  test('a failed read carries the last value until it is too old', async () => {
    const mac = fakeMac()
    await mac.reader.refresh()
    mac.state.fail.add('pmset')
    mac.state.fail.add('ioreg')
    mac.state.t = SYSTEM_CADENCE.batteryMs
    await mac.reader.refresh()
    assert.equal(mac.reader.snapshot()!.battery?.ageMs, SYSTEM_CADENCE.batteryMs)
    mac.state.t = SYSTEM_MAX_AGE.batteryMs + 1
    assert.equal(mac.reader.snapshot()!.battery, null)
    assert.equal(mac.reader.snapshot()!.gpu, null)
  })

  test('the I/O Kit reads wait while memory is critical', async () => {
    const mac = fakeMac()
    let heavy = false
    const reader = new MacSystemReader({ exec: async (f, a) => { mac.calls.push(f); return { error: null, stdout: f.endsWith('route') ? '  interface: en0\n' : '' } }, mono: () => 0, statfs: () => null, platform: 'darwin', heavyAllowed: () => heavy })
    await reader.refresh()
    assert.equal(mac.calls.filter((c) => c.endsWith('ioreg')).length, 0)
    heavy = true
    await reader.refresh()
    assert.equal(mac.calls.filter((c) => c.endsWith('ioreg')).length, 2)
    assert.equal(reader.snapshot()!.disk, null, 'no space either: statfs read nothing')
  })

  test('a refresh still running is joined; anything but a Mac reads nothing', async () => {
    const mac = fakeMac()
    const a = mac.reader.refresh()
    const b = mac.reader.refresh()
    assert.equal(a, b)
    await a
    const linux = new MacSystemReader({ exec: async () => { throw new Error('must not run') }, platform: 'linux' })
    await linux.refresh()
    assert.equal(linux.snapshot(), null)
  })

  test('a command that throws, or no default route, gives nothing rather than a guess', async () => {
    const reader = new MacSystemReader({ exec: async () => { throw new Error('spawn EAGAIN') }, mono: () => 0, statfs: () => null, platform: 'darwin' })
    await reader.refresh()
    assert.deepEqual(reader.snapshot(), { net: null, disk: null, gpu: null, battery: null })
  })
})

describe('temperatures (the SMC)', () => {
  const M2 = SMC_KEYS.m2!
  // Figures as an M2 Pro gave them: P-cores off at rest (under 10), E-cores warm, the GPU off.
  const M2_REST = { Tp01: 6.7, Tp05: 4.6, Tp1h: 51.1, Tp1t: 53.4, Tg0f: 5.7, Tg0j: 5.7 }
  const M2_GPU = { Tp01: 67.8, Tp05: 66.3, Tp1h: 67, Tg0f: 73.8, Tg0j: 75.1 }

  test("each kind of Mac's keys, from the CPU's name; none for a chip that is not known", () => {
    assert.equal(smcKeysFor('Apple M1 Max'), SMC_KEYS.m1)
    assert.equal(smcKeysFor('Apple M2 Pro'), SMC_KEYS.m2)
    assert.equal(smcKeysFor('Apple M3'), SMC_KEYS.m3)
    assert.equal(smcKeysFor('Apple M4'), SMC_KEYS.m4)
    assert.equal(smcKeysFor('Apple M4 Max'), SMC_KEYS.m4Pro, "an M4 Pro's and Max's GPU keys are their own")
    assert.equal(smcKeysFor('Apple M5 Ultra'), SMC_KEYS.m5)
    assert.equal(smcKeysFor('Apple M6 Pro'), SMC_KEYS.m6)
    assert.equal(smcKeysFor('Apple A18 Pro'), SMC_KEYS.a18Pro)
    assert.equal(smcKeysFor('Intel(R) Core(TM) i9-9980HK CPU @ 2.40GHz'), SMC_KEYS.intel)
    for (const unknown of ['Apple M10', 'Apple M7', 'Apple M1 (Virtual)', 'VirtualApple @ 2.50GHz', '', null, 7]) {
      assert.equal(smcKeysFor(unknown), null, String(unknown))
    }
    assert.equal(SMC_KEYS.intel!.cpu.includes('Tp0P'), false, "an Intel Mac's Tp0P is its power board")
    for (const [kind, keys] of Object.entries(SMC_KEYS)) {
      const list = smcKeyList(keys)
      assert.ok(list.length <= 64, `${kind}: the script reads at most 64`)
      assert.ok(list.every((k) => /^[A-Za-z0-9]{4}$/.test(k)), kind)
    }
  })

  test('the hottest CPU core and GPU sensor; a GPU whose sensors are all off is at rest', () => {
    assert.deepEqual(parseMacTemps(JSON.stringify(M2_REST), M2), { cpuC: 53, gpuC: null, gpuOff: true })
    assert.deepEqual(parseMacTemps(JSON.stringify(M2_GPU), M2), { cpuC: 68, gpuC: 75 })
    assert.deepEqual(parseMacTemps(JSON.stringify({ Tp01: 50 }), M2), { cpuC: 50, gpuC: null }, 'no GPU key answered: not at rest, unknown')
  })

  test("only the chip's own keys count: an M1 Max's Tp0I is not one of its cores", () => {
    // As this M1 Max gave them, at rest, with every key the SMC lists that starts Tp or Tg.
    const m1Max = { Tp01: 41.6, Tp02: 50.9, Tp05: 42.4, Tp06: 52.1, Tp09: 40.7, Tp0D: 39.9, Tp0H: 40.8, Tp0I: 50.4, Tp0T: 40, Tp0b: 37.5, Tg04: 27.8, Tg05: 35.6, Tg0D: 34.2, Tg0L: 36, Tg0T: 35.8 }
    assert.deepEqual(parseMacTemps(JSON.stringify(m1Max), SMC_KEYS.m1!), { cpuC: 42, gpuC: 36 })
  })

  test("an Intel Mac's cores, else its die or proximity; never its power board", () => {
    const intel = SMC_KEYS.intel!
    assert.deepEqual(parseMacTemps(JSON.stringify({ TC0P: 48.25, TC1C: 55, TC2C: 57.5, TCGC: 50, TG0P: 44.5, Tp0P: 70 }), intel), { cpuC: 58, gpuC: 50 })
    assert.deepEqual(parseMacTemps(JSON.stringify({ TC0P: 48, TG0P: 44.5, Tp0P: 70 }), intel), { cpuC: 48, gpuC: 45 }, 'proximity, with no core key')
    assert.equal(parseMacTemps(JSON.stringify({ Tp0P: 70, TB0T: 31 }), intel), null)
  })

  test('figures out of shape are left out, never guessed', () => {
    assert.deepEqual(parseMacTemps(JSON.stringify({ Tp01: 140, Tp05: '60', Tg0f: -3 }), M2), { cpuC: null, gpuC: null, gpuOff: true })
    assert.equal(parseMacTemps('{}', M2), null)
    assert.equal(parseMacTemps('not json', M2), null)
    assert.equal(parseMacTemps('[1,2]', M2), null)
    assert.equal(parseMacTemps('null', M2), null)
    assert.equal(parseMacTemps(7, M2), null)
    assert.equal(parseMacTemps(`{"Tp01":50,"x":"${'a'.repeat(70_000)}"}`, M2), null, 'too long')
  })

  test('the script only reads: it sends the SMC no command but a key info (9) and a read (5)', () => {
    assert.ok(MAC_TEMP_SCRIPT.startsWith('function run(argv) {'))
    assert.equal(MAC_TEMP_SCRIPT.includes('${'), false)
    assert.ok(MAC_TEMP_SCRIPT.includes("IOServiceMatching('AppleSMC')"))
    // Every SMC call goes through call(), which sets the command byte from its first argument.
    assert.equal(MAC_TEMP_SCRIPT.match(/IOConnectCallStructMethod\(conn/g)?.length, 1)
    assert.ok(MAC_TEMP_SCRIPT.includes('a[42] = cmd;'))
    assert.ok(MAC_TEMP_SCRIPT.includes('function call(cmd, key, size) {'))
    assert.deepEqual([...MAC_TEMP_SCRIPT.matchAll(/(?<!function )\bcall\(([^,)]*),/g)].map((m) => m[1]).sort(), ['5', '9'], 'every call but its definition')
    assert.equal(MAC_TEMP_SCRIPT.split('a[42]').length, 2, 'the command byte is set nowhere else')
  })

  function smcMac(answers: (string | null)[], cpuModel = 'Apple M2 Pro') {
    const state = { t: 0, heavy: true }
    const runs: string[][] = []
    const exec: ExecFile = async (file, args) => {
      if (file !== OSASCRIPT_PATH) return { error: null, stdout: file.endsWith('route') ? '  interface: en0\n' : '' }
      runs.push([...args])
      const answer = answers.length > 1 ? answers.shift()! : answers[0]!
      return answer === null ? { error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), stdout: '' } : { error: null, stdout: `${answer}\n` }
    }
    const reader = new MacSystemReader({ exec, mono: () => state.t, statfs: () => null, platform: 'darwin', heavyAllowed: () => state.heavy, volumeName: () => null, cpuModel })
    return { state, runs, reader }
  }

  test("the chip's keys are read on the cadence; carried with their age, then dropped", async () => {
    const mac = smcMac([JSON.stringify(M2_REST), JSON.stringify(M2_GPU)])
    await mac.reader.refresh()
    assert.deepEqual(mac.reader.snapshot()!.temp, { cpuC: 53, gpuC: null, gpuOff: true })
    assert.deepEqual(mac.runs[0], ['-l', 'JavaScript', '-e', MAC_TEMP_SCRIPT, JSON.stringify(smcKeyList(M2))])
    mac.state.t = 5_000
    await mac.reader.refresh()
    assert.equal(mac.runs.length, 1, 'on its cadence')
    assert.equal(mac.reader.snapshot()!.temp?.ageMs, 5_000)
    mac.state.t = SYSTEM_CADENCE.tempMs
    await mac.reader.refresh()
    assert.deepEqual(mac.reader.snapshot()!.temp, { cpuC: 68, gpuC: 75 })
    mac.state.t = SYSTEM_CADENCE.tempMs + SYSTEM_MAX_AGE.tempMs + 1
    mac.state.heavy = false
    await mac.reader.refresh()
    assert.equal(mac.runs.length, 2, 'not asked while optional work should wait')
    assert.equal(mac.reader.snapshot()!.temp, undefined, 'too old: gone')
  })

  test('a chip that is not known is never asked; one that answers no temperature, a few times only', async () => {
    const unknown = smcMac(['{}'], 'Apple M10')
    await unknown.reader.refresh()
    assert.equal(unknown.runs.length, 0)
    for (const answer of ['{}', null]) {
      const none = smcMac([answer])
      for (let i = 0; i < TEMP_TRIES + 2; i++) {
        none.state.t = i * SYSTEM_CADENCE.tempMs
        await none.reader.refresh()
      }
      assert.equal(none.runs.length, TEMP_TRIES, String(answer))
      assert.equal(none.reader.snapshot()!.temp, undefined)
    }
    const flaky = smcMac(['{}', '{}', JSON.stringify(M2_GPU), '{}', '{}', JSON.stringify(M2_GPU)])
    for (let i = 0; i < 6; i++) {
      flaky.state.t = i * SYSTEM_CADENCE.tempMs
      await flaky.reader.refresh()
    }
    assert.equal(flaky.runs.length, 6, 'misses count only in a row')
  })
})
