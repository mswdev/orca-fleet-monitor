// A Windows computer's network, disk, GPU and battery (src/win-system.ts), with invented answers
// from a fake PowerShell host.
import { assert, describe, test } from 'orca/testing'
import { isInterfaceName, SYSTEM_CADENCE, SYSTEM_MAX_AGE } from '../src/mac-system.ts'
import type { SystemReader } from '../src/sampler.ts'
import { interfaceLabel, parseBatteryAnswer, parseDiskAnswer, parseGpuAnswer, parseNetAnswer, systemDriveRoot, WindowsSystemReader } from '../src/win-system.ts'

describe('answers', () => {
  test('net: the adapter and its two counters, or nothing', () => {
    assert.deepEqual(parseNetAnswer({ n: 'Ethernet', rx: 802_678_695_260, tx: 40_040_855_250 }), { name: 'Ethernet', rx: 802_678_695_260, tx: 40_040_855_250 })
    assert.equal(parseNetAnswer({ n: 'x'.repeat(1_000), rx: 0, tx: 0 })?.name.length, 256)
    assert.equal(parseNetAnswer(null), null, 'no adapter with a default gateway, or the read failed')
    assert.equal(parseNetAnswer({ n: '', rx: 1, tx: 2 }), null)
    assert.equal(parseNetAnswer({ n: 7, rx: 1, tx: 2 }), null)
    assert.equal(parseNetAnswer({ n: 'Ethernet', rx: 1.5, tx: 2 }), null, 'not a whole number')
    assert.equal(parseNetAnswer({ n: 'Ethernet', rx: -1, tx: 2 }), null)
    assert.equal(parseNetAnswer({ n: 'Ethernet', rx: 1, tx: 9e20 }), null, 'past a safe integer')
    assert.equal(parseNetAnswer({ n: 'Ethernet', rx: '1', tx: 2 }), null)
    assert.equal(parseNetAnswer({ n: 'Ethernet', rx: 1 }), null)
    assert.equal(parseNetAnswer([{ n: 'Ethernet', rx: 1, tx: 2 }]), null)
    assert.equal(parseNetAnswer('Ethernet'), null)
  })

  test('an adapter name becomes a label a beacon can carry', () => {
    const cases: [string, string][] = [
      ['Ethernet', 'Ethernet'],
      ['Wi-Fi', 'Wi-Fi'],
      ['Ethernet 2', 'Ethernet-2'],
      ['vEthernet (Default Switch)', 'vEthernet-Defaul'],
      ['Local Area Connection* 12', 'Local-Area-Conne'],
      ['Wi-Fi (guest) ', 'Wi-Fi-guest'],
      ['2nd adapter', 'nd-adapter'],
      ['イーサネット 2', 'net'],
      ['Сеть', 'net'],
      ['---', 'net'],
      ['', 'net'],
      ['a', 'a'],
      ['up; rm -rf', 'up-rm--rf']
    ]
    for (const [name, label] of cases) {
      assert.equal(interfaceLabel(name), label, name)
      assert.equal(isInterfaceName(interfaceLabel(name)), true, name)
    }
    assert.equal(isInterfaceName(interfaceLabel('x'.repeat(300))), true)
  })

  test('disk and GPU', () => {
    assert.deepEqual(parseDiskAnswer({ r: 2_000, w: 1_000 }), { read: 2_000, write: 1_000 })
    assert.equal(parseDiskAnswer({ r: 2_000 }), null)
    assert.equal(parseDiskAnswer({ r: 2_000, w: -5 }), null)
    assert.equal(parseDiskAnswer({ r: 2 ** 60, w: 1 }), null)
    assert.equal(parseDiskAnswer(null), null)
    assert.equal(parseGpuAnswer({ p: 37.4 }), 37)
    assert.equal(parseGpuAnswer({ p: 0 }), 0)
    assert.equal(parseGpuAnswer({ p: 100 }), 100)
    assert.equal(parseGpuAnswer({ p: 250 }), null)
    assert.equal(parseGpuAnswer({ p: -1 }), null)
    assert.equal(parseGpuAnswer({ p: '12' }), null)
    assert.equal(parseGpuAnswer({ p: Number.NaN }), null)
    assert.equal(parseGpuAnswer(null), null, 'no GPU counters, or the first request')
    assert.equal(parseGpuAnswer(12), null)
  })

  test('battery: each state, a computer without one, and what Windows does not know', () => {
    assert.deepEqual(parseBatteryAnswer({ line: 1, flag: 8, pct: 81, secs: -1 }), { present: true, percent: 81, state: 'charging', source: 'ac', minutesRemaining: null })
    assert.deepEqual(parseBatteryAnswer({ line: 1, flag: 9, pct: 97, secs: 600 }), { present: true, percent: 97, state: 'charging', source: 'ac', minutesRemaining: null }, 'high and charging; time left is for a battery in use only')
    assert.deepEqual(parseBatteryAnswer({ line: 0, flag: 0, pct: 55, secs: 5_430 }), { present: true, percent: 55, state: 'discharging', source: 'battery', minutesRemaining: 91 })
    assert.deepEqual(parseBatteryAnswer({ line: 0, flag: 4, pct: 3, secs: -1 }), { present: true, percent: 3, state: 'discharging', source: 'battery', minutesRemaining: null }, 'critical, no estimate')
    assert.deepEqual(parseBatteryAnswer({ line: 1, flag: 1, pct: 100, secs: -1 }), { present: true, percent: 100, state: 'charged', source: 'ac', minutesRemaining: null })
    assert.deepEqual(parseBatteryAnswer({ line: 1, flag: 1, pct: 80, secs: -1 }), { present: true, percent: 80, state: 'not-charging', source: 'ac', minutesRemaining: null }, 'held at a charge limit')
    // A desktop.
    assert.deepEqual(parseBatteryAnswer({ line: 1, flag: 128, pct: 100, secs: -1 }), { present: false, percent: null, state: null, source: 'ac', minutesRemaining: null })
    assert.deepEqual(parseBatteryAnswer({ line: 255, flag: 128, pct: 255, secs: -1 }), { present: false, percent: null, state: null, source: null, minutesRemaining: null })
    assert.equal(parseBatteryAnswer({ line: 1, flag: 255, pct: 100, secs: -1 }), null, 'status unknown: no reading, not a full battery')
    assert.deepEqual(parseBatteryAnswer({ line: 255, flag: 2, pct: 255, secs: -1 }), { present: true, percent: null, state: null, source: null, minutesRemaining: null }, 'neither the line nor the charge known')
    assert.equal(parseBatteryAnswer({ line: 0, flag: 0, pct: 181, secs: 60 })?.percent, null)
    assert.equal(parseBatteryAnswer({ line: 0, flag: 0, pct: 50, secs: 0 })?.minutesRemaining, null)
    assert.equal(parseBatteryAnswer({ line: 0, flag: 0, pct: 50, secs: 1e12 })?.minutesRemaining, null, 'no estimate that long')
    assert.equal(parseBatteryAnswer({ line: 0, flag: 0, pct: 50, secs: '900' })?.minutesRemaining, null)
    assert.equal(parseBatteryAnswer({ line: 1, pct: 50, secs: -1 }), null, 'no flags')
    assert.equal(parseBatteryAnswer({ line: 1, flag: 1.5, pct: 50, secs: -1 }), null)
    assert.equal(parseBatteryAnswer({ line: 1, flag: 4096, pct: 50, secs: -1 }), null)
    assert.equal(parseBatteryAnswer(null), null)
    assert.equal(parseBatteryAnswer('charging'), null)
  })

  test('the system drive, C: when the variable is not a drive', () => {
    assert.equal(systemDriveRoot({ SystemDrive: 'D:' }), 'D:\\')
    assert.equal(systemDriveRoot({ SYSTEMDRIVE: 'e:' }), 'e:\\')
    assert.equal(systemDriveRoot({}), 'C:\\')
    assert.equal(systemDriveRoot({ SystemDrive: 'C:\\Users' }), 'C:\\')
    assert.equal(systemDriveRoot({ SystemDrive: '..' }), 'C:\\')
  })
})

/** A scripted Windows computer: what PowerShell answers to each command now, and a clock that
 *  only moves when told. */
function fakeWindows(options: { heavyAllowed?: () => boolean } = {}) {
  const state = {
    t: 0,
    net: { n: 'Ethernet 2', rx: 1_000_000, tx: 50_000 } as unknown,
    disk: { r: 10_000_000, w: 5_000_000 } as unknown,
    gpu: { p: 20 } as unknown,
    bat: { line: 1, flag: 8, pct: 70, secs: -1 } as unknown,
    fail: new Set<string>()
  }
  const calls: string[] = []
  const timeouts = new Set<number>()
  const host = {
    request: async (command: string, timeoutMs: number): Promise<unknown> => {
      calls.push(command)
      timeouts.add(timeoutMs)
      return state.fail.has(command) ? null : ((state as Record<string, unknown>)[command] ?? null)
    }
  }
  const paths: string[] = []
  const statfs = (path: string) => {
    paths.push(path)
    return { bsize: 4096, blocks: 250_000_000, bavail: 100_000_000 }
  }
  const reader = new WindowsSystemReader({ host, mono: () => state.t, statfs, platform: 'win32', env: { SystemDrive: 'D:' }, ...options })
  const count = (command: string) => calls.filter((c) => c === command).length
  return { state, calls, timeouts, paths, reader, count }
}

describe('WindowsSystemReader', () => {
  test('rates from counters between readings; the first reading has none', async () => {
    const win = fakeWindows()
    await win.reader.refresh()
    const first = win.reader.snapshot()!
    assert.deepEqual(first.net, { iface: 'Ethernet-2', rxBytesPerSec: null, txBytesPerSec: null })
    assert.equal(first.disk?.readBytesPerSec, null)
    assert.equal(first.disk?.totalBytes, 1_024_000_000_000)
    assert.equal(first.disk?.usedBytes, 614_400_000_000)
    assert.deepEqual(win.paths, ['D:\\'], 'the system drive')
    assert.equal(first.gpu?.percent, 20)
    assert.deepEqual(first.battery, { present: true, percent: 70, state: 'charging', source: 'ac', minutesRemaining: null })
    assert.deepEqual(win.calls, ['net', 'disk', 'gpu', 'bat'], 'the network is asked for first')
    win.state.t = 5_000
    win.state.net = { n: 'Ethernet 2', rx: 3_500_000, tx: 550_000 }
    await win.reader.refresh()
    const second = win.reader.snapshot()!
    assert.deepEqual([second.net?.rxBytesPerSec, second.net?.txBytesPerSec], [500_000, 100_000])
    assert.equal(second.net?.ageMs, undefined, 'just read')
    // The slow parts were not read again: they are carried, with their age.
    assert.equal(second.gpu?.ageMs, 5_000)
    assert.equal(second.battery?.ageMs, 5_000)
    assert.equal(second.disk?.spaceAgeMs, 5_000)
    assert.deepEqual([win.count('net'), win.count('disk'), win.count('gpu'), win.count('bat'), win.paths.length], [2, 1, 1, 1, 1])
    win.state.t = SYSTEM_CADENCE.diskIoMs
    const seconds = SYSTEM_CADENCE.diskIoMs / 1000
    win.state.disk = { r: 10_000_000 + seconds * 1_000_000, w: 5_000_000 + seconds * 100_000 }
    await win.reader.refresh()
    const third = win.reader.snapshot()!
    assert.deepEqual([third.disk?.readBytesPerSec, third.disk?.writeBytesPerSec], [1_000_000, 100_000])
    assert.equal(third.disk?.ioAgeMs, undefined, 'just read')
    assert.equal(win.timeouts.size, 1, 'one timeout for every request')
  })

  test('the first GPU answer is none, so the second is asked for with the next reading, once', async () => {
    const win = fakeWindows()
    win.state.gpu = null
    await win.reader.refresh()
    assert.equal(win.reader.snapshot()!.gpu, null)
    win.state.t = 5_000
    win.state.gpu = { p: 42.6 }
    await win.reader.refresh()
    assert.equal(win.count('gpu'), 2, 'not half a minute later')
    assert.deepEqual(win.reader.snapshot()!.gpu, { percent: 43 })
    win.state.t = 10_000
    await win.reader.refresh()
    assert.equal(win.count('gpu'), 2, 'then on its cadence')
    win.state.t = 5_000 + SYSTEM_CADENCE.gpuMs
    await win.reader.refresh()
    assert.equal(win.count('gpu'), 3)
    // A computer without the counters answers null every time: asked again once, then on cadence.
    const none = fakeWindows()
    none.state.gpu = null
    for (const t of [0, 5_000, 10_000, 15_000]) {
      none.state.t = t
      await none.reader.refresh()
    }
    assert.equal(none.count('gpu'), 2)
    assert.equal(none.reader.snapshot()!.gpu, null)
  })

  test('counters that go back, or another adapter, start the rates again', async () => {
    const win = fakeWindows()
    await win.reader.refresh()
    win.state.t = 5_000
    win.state.net = { n: 'Ethernet 2', rx: 10, tx: 50_000 }
    await win.reader.refresh()
    assert.equal(win.reader.snapshot()!.net?.rxBytesPerSec, null, 'the counter went back')
    win.state.t = 10_000
    win.state.net = { n: 'Ethernet 2', rx: 1_010, tx: 50_000 }
    await win.reader.refresh()
    assert.deepEqual([win.reader.snapshot()!.net?.rxBytesPerSec, win.reader.snapshot()!.net?.txBytesPerSec], [200, 0])
    // The default gateway moves to another adapter, whose counters happen to be higher.
    win.state.t = 15_000
    win.state.net = { n: 'Wi-Fi', rx: 9_000_000, tx: 9_000_000 }
    await win.reader.refresh()
    assert.deepEqual(win.reader.snapshot()!.net, { iface: 'Wi-Fi', rxBytesPerSec: null, txBytesPerSec: null })
    // Two adapters that share a label are still two adapters.
    win.state.t = 20_000
    win.state.net = { n: 'Wi-Fi!', rx: 9_500_000, tx: 9_500_000 }
    await win.reader.refresh()
    assert.deepEqual(win.reader.snapshot()!.net, { iface: 'Wi-Fi', rxBytesPerSec: null, txBytesPerSec: null })
    // Two readings on top of each other give no rate.
    win.state.t = 20_100
    await win.reader.refresh()
    assert.equal(win.reader.snapshot()!.net?.rxBytesPerSec, null)
  })

  test('a disk total that went back gives no rate for that reading', async () => {
    const win = fakeWindows()
    await win.reader.refresh()
    const seconds = SYSTEM_CADENCE.diskIoMs / 1000
    win.state.t = SYSTEM_CADENCE.diskIoMs
    win.state.disk = { r: 10_000_000 + seconds * 3_000, w: 5_000_000 + seconds * 2_000 }
    await win.reader.refresh()
    assert.deepEqual([win.reader.snapshot()!.disk?.readBytesPerSec, win.reader.snapshot()!.disk?.writeBytesPerSec], [3_000, 2_000])
    // A disk is taken out: its bytes leave the read total; writes on the others went on.
    win.state.t = 2 * SYSTEM_CADENCE.diskIoMs
    win.state.disk = { r: 500, w: 5_000_000 + seconds * 2_000 + seconds * 700 }
    await win.reader.refresh()
    assert.deepEqual([win.reader.snapshot()!.disk?.readBytesPerSec, win.reader.snapshot()!.disk?.writeBytesPerSec], [null, 700])
    win.state.t = 3 * SYSTEM_CADENCE.diskIoMs
    win.state.disk = { r: 100, w: 100 }
    await win.reader.refresh()
    const both = win.reader.snapshot()!.disk
    assert.deepEqual([both?.readBytesPerSec, both?.writeBytesPerSec, both?.ioAgeMs], [null, null, undefined], 'nothing carried from before')
    win.state.t = 4 * SYSTEM_CADENCE.diskIoMs
    win.state.disk = { r: 100 + seconds * 10, w: 100 }
    await win.reader.refresh()
    assert.deepEqual([win.reader.snapshot()!.disk?.readBytesPerSec, win.reader.snapshot()!.disk?.writeBytesPerSec], [10, 0])
  })

  test('a failed read carries the last value until it is too old', async () => {
    const win = fakeWindows()
    await win.reader.refresh()
    for (const command of ['net', 'disk', 'gpu', 'bat']) win.state.fail.add(command)
    win.state.t = 5_000
    await win.reader.refresh()
    assert.equal(win.reader.snapshot()!.net?.ageMs, 5_000)
    win.state.t = SYSTEM_MAX_AGE.netMs + 1
    assert.equal(win.reader.snapshot()!.net, null)
    win.state.t = SYSTEM_CADENCE.batteryMs
    await win.reader.refresh()
    assert.equal(win.count('bat'), 2, 'asked again when due')
    assert.equal(win.reader.snapshot()!.battery?.ageMs, SYSTEM_CADENCE.batteryMs)
    assert.equal(win.reader.snapshot()!.gpu?.ageMs, SYSTEM_CADENCE.batteryMs)
    win.state.t = SYSTEM_MAX_AGE.gpuMs + 1
    assert.equal(win.reader.snapshot()!.gpu, null)
    win.state.t = SYSTEM_MAX_AGE.batteryMs + 1
    assert.equal(win.reader.snapshot()!.battery, null)
    // The network comes back: a rate over the whole gap, from the counters kept.
    win.state.fail.delete('net')
    win.state.t = 200_000
    win.state.net = { n: 'Ethernet 2', rx: 1_000_000 + 200 * 1_000, tx: 50_000 }
    await win.reader.refresh()
    assert.equal(win.reader.snapshot()!.net?.rxBytesPerSec, 1_000)
  })

  test('disk traffic and the GPU wait while optional work should', async () => {
    let heavy = false
    const win = fakeWindows({ heavyAllowed: () => heavy })
    await win.reader.refresh()
    assert.deepEqual(win.calls, ['net', 'bat'])
    assert.equal(win.reader.snapshot()!.gpu, null)
    assert.equal(win.reader.snapshot()!.disk?.totalBytes, 1_024_000_000_000, 'space needs no request')
    heavy = true
    win.state.t = 5_000
    await win.reader.refresh()
    assert.deepEqual(win.calls, ['net', 'bat', 'net', 'disk', 'gpu'])
  })

  test('a refresh still running is joined; anything but Windows asks nothing', async () => {
    const win = fakeWindows()
    // What the sampler asks of a system reader, checked by the compiler.
    const reader: SystemReader = win.reader
    const a = reader.refresh()
    const b = reader.refresh()
    assert.equal(a, b)
    await a
    assert.equal(win.count('net'), 1)
    const asked: string[] = []
    const mac = new WindowsSystemReader({ host: { request: async (command) => (asked.push(command), null) }, statfs: () => { throw new Error('must not run') }, platform: 'darwin' })
    await mac.refresh()
    assert.equal(mac.snapshot(), null)
    assert.deepEqual(asked, [])
  })

  test('a host that throws or answers nonsense, and a drive that cannot be read, give nothing rather than a guess', async () => {
    const throwing = new WindowsSystemReader({ host: { request: () => { throw new Error('gone') } }, mono: () => 0, statfs: () => { throw new Error('EIO') }, platform: 'win32', env: {} })
    await throwing.refresh()
    assert.deepEqual(throwing.snapshot(), { net: null, disk: null, gpu: null, battery: null })
    const rejecting = new WindowsSystemReader({ host: { request: () => Promise.reject(new Error('gone')) }, mono: () => 0, statfs: () => null, platform: 'win32', env: {} })
    await rejecting.refresh()
    assert.deepEqual(rejecting.snapshot(), { net: null, disk: null, gpu: null, battery: null })
    const nonsense = new WindowsSystemReader({ host: { request: async () => ({ n: ['x'], rx: 'many', r: {}, p: 'full', flag: 'on' }) }, mono: () => 0, statfs: () => ({ bsize: 0, blocks: 1, bavail: 0 }), platform: 'win32', env: {} })
    await nonsense.refresh()
    assert.deepEqual(nonsense.snapshot(), { net: null, disk: null, gpu: null, battery: null })
    const broken = new WindowsSystemReader({ host: { request: async () => null }, mono: () => 0, heavyAllowed: () => { throw new Error('no') }, statfs: () => null, platform: 'win32', env: {} })
    await broken.refresh()
    assert.equal(broken.snapshot()?.net, null)
  })
})
