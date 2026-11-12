// A Mac's network, disk, GPU and battery (src/mac-system.ts), with invented command output.
import { assert, describe, test } from 'orca/testing'
import type { ExecFile, ExecResult } from '../src/mac-memory.ts'
import {
  diskSpaceOf,
  isInterfaceName,
  MacSystemReader,
  parseDefaultRoute,
  parseDiskStats,
  parseGpu,
  parseNetstat,
  parsePmset,
  SYSTEM_CADENCE,
  SYSTEM_MAX_AGE
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
  const reader = new MacSystemReader({ exec, mono: () => state.t, statfs, platform: 'darwin' })
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
