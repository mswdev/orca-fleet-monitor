// A Linux computer's network, disk, GPU and battery (src/linux-system.ts), with invented files: a
// map of paths stands in for /proc and /sys, and the clock only moves when told. No test reads
// this computer's own /proc or /sys.
import { fileURLToPath } from 'node:url'
import { assert, describe, test } from 'orca/testing'
import {
  isRuntimeSuspended,
  LINUX_SPACE_PATHS,
  LinuxSystemReader,
  listDir,
  NVIDIA_SMI_ARGS,
  NVIDIA_SMI_PATH,
  parseDiskstats,
  parseGpuBusyPercent,
  parseNvidiaSmi,
  parsePowerSupplies,
  parseProcNetDev,
  parseProcNetIpv6Route,
  parseProcNetRoute,
  physicalDisks,
  type PowerSupply,
  readBytesBounded,
  readTextBounded,
  REFRESH_DEADLINE_MS
} from '../src/linux-system.ts'
import type { ExecFile } from '../src/mac-memory.ts'
import { SYSTEM_CADENCE, SYSTEM_MAX_AGE } from '../src/mac-system.ts'
import type { SystemReader } from '../src/sampler.ts'
import { fixtureText, flush } from './helpers.ts'

const ROUTE_HEAD = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT'
const routeRow = (iface: string, destination = '00000000', flags = '0003', metric = 100, mask = '00000000'): string =>
  [iface, destination, '010200C0', flags, 0, 0, metric, mask, 0, 0, 0].join('\t').padEnd(127)
const routes = (...rows: string[]): string => [ROUTE_HEAD.padEnd(127), ...rows, ''].join('\n')

const ZEROS = '0'.repeat(32)
const route6Row = (iface: string, metric = '00000400', flags = '00000003', destination = ZEROS, prefix = '00'): string =>
  `${destination} ${prefix} ${ZEROS} 00 fe800000000000000000000000000001 ${metric} 00000002 00000000 ${flags} ${iface.padStart(8)}`

const NET_DEV_HEAD =
  'Inter-|   Receive                                                |  Transmit\n face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n'
const netDevRow = (iface: string, rx: number | string, tx: number | string): string => `${iface.padStart(6)}: ${rx}  6120    0    0    0     0          0        11 ${tx}  3018    0    0    0     0       0          0`
const netDev = (...rows: string[]): string => `${NET_DEV_HEAD}${rows.join('\n')}\n`

/** One /proc/diskstats row; `read` and `write` are sectors of 512 bytes. */
const diskRow = (name: string, read: number | string, write: number | string, major = 8): string =>
  `${String(major).padStart(4)} ${'0'.padStart(7)} ${name} 4123 12 ${read} 812 9112 220 ${write} 4120 0 3012 5123 0 0 0 0 30 14`

describe('parsers', () => {
  test('the IPv4 default route: up, all-zero destination and mask, the lowest metric', () => {
    // Wi-Fi is listed first, but the wired interface has the lower metric.
    assert.equal(parseProcNetRoute(fixtureText('linux-net-route.txt')), 'enp3s0')
    assert.equal(parseProcNetRoute(routes(routeRow('wlan0', '00000000', '0003', 600), routeRow('eth0', '00000000', '0003', 600))), 'wlan0', 'the first of equals')
    assert.equal(parseProcNetRoute(routes()), null, 'the header alone')
    assert.equal(parseProcNetRoute(routes(routeRow('eth0', '000200C0', '0001', 100, '00FFFFFF'))), null, 'only a route to the local network')
    assert.equal(parseProcNetRoute(routes(routeRow('eth0', '00000000', '0002'))), null, 'not up')
    assert.equal(parseProcNetRoute(routes(routeRow('*', '00000000', '0201'))), null, 'a route that rejects')
    assert.equal(parseProcNetRoute(routes(routeRow('eth0', '00000000', '0001', 100, '000000FF'))), null, '0.0.0.0/8 is not the default')
    assert.equal(parseProcNetRoute(routes(routeRow('eth0', '00000000', 'zz'))), null, 'flags out of shape')
    assert.equal(parseProcNetRoute(routes(routeRow('eth0', '00000000', '0003', -1))), null, 'metric out of shape')
    assert.equal(parseProcNetRoute(routes(routeRow('-rf'))), null)
    assert.equal(parseProcNetRoute(routes(routeRow('eth0;ls'))), null)
    assert.equal(parseProcNetRoute(routes(routeRow('eth0'), routeRow('tun0', '00000000', '0003', 50))), 'tun0')
    assert.equal(parseProcNetRoute('eth0 00000000 010200C0 0003'), null, 'a row cut short')
    assert.equal(parseProcNetRoute(42), null)
    assert.equal(parseProcNetRoute('x'.repeat(1024 * 1024 + 1)), null)
  })

  test('the IPv6 default route: hexadecimal metrics, and never the rejecting one on lo', () => {
    // enp3s0 has metric 0x100 (256), wlp2s0 0xc8 (200); lo's rejects everything.
    assert.equal(parseProcNetIpv6Route(fixtureText('linux-net-ipv6-route.txt')), 'wlp2s0')
    assert.equal(parseProcNetIpv6Route(route6Row('lo', 'ffffffff', '00200200')), null)
    assert.equal(parseProcNetIpv6Route(route6Row('lo', '00000001', '00000001')), null, 'lo is never the way out')
    assert.equal(parseProcNetIpv6Route(route6Row('eth0', '00000400', '00000003', '20010db8000100000000000000000000', '40')), null, 'not the default')
    assert.equal(parseProcNetIpv6Route(route6Row('eth0', '00000400', '00000003', ZEROS, '40')), null, 'all zeros, but a prefix of 64')
    assert.equal(parseProcNetIpv6Route(route6Row('eth0', '00000400', '00000000')), null, 'not up')
    assert.equal(parseProcNetIpv6Route(route6Row('', '00000400', '00000003')), null, 'no device')
    assert.equal(parseProcNetIpv6Route(route6Row('eth0', '1024', '00000003')), null, 'metric out of shape')
    assert.equal(parseProcNetIpv6Route(`${route6Row('eth0')}\n${route6Row('wg0', '00000032')}\n`), 'wg0')
    assert.equal(parseProcNetIpv6Route(null), null)
  })

  test('/proc/net/dev: bytes received are the 1st number of a row, bytes sent the 9th', () => {
    const text = fixtureText('linux-net-dev.txt')
    assert.deepEqual(parseProcNetDev(text, 'enp3s0'), { rx: 8_026_786_952, tx: 400_408_552 })
    assert.deepEqual(parseProcNetDev(text, 'lo'), { rx: 48_213_907, tx: 48_213_907 })
    assert.deepEqual(parseProcNetDev(text, 'br-3f9a1c2d4e5f'), { rx: 1_204, tx: 9_120 })
    assert.deepEqual(parseProcNetDev(text, 'wlp2s0'), { rx: 0, tx: 0 })
    assert.equal(parseProcNetDev(text, 'enp3'), null, 'the start of a name is not the name')
    assert.equal(parseProcNetDev(text, 'eth9'), null, 'another interface')
    // An old kernel leaves no space after the colon once the count is wide.
    assert.deepEqual(parseProcNetDev(`${NET_DEV_HEAD}  eth0:1234567890 100 0 0 0 0 0 0 987654321 90 0 0 0 0 0 0\n`, 'eth0'), { rx: 1_234_567_890, tx: 987_654_321 })
    assert.equal(parseProcNetDev(netDev(netDevRow('eth0', '5x', 6)), 'eth0'), null, 'not digits')
    assert.equal(parseProcNetDev(netDev(netDevRow('eth0', 9e20, 6)), 'eth0'), null, 'past a safe integer')
    assert.equal(parseProcNetDev(`${NET_DEV_HEAD}  eth0: 1 2 3 4\n`, 'eth0'), null, 'a row cut short')
    assert.equal(parseProcNetDev(undefined, 'eth0'), null)
  })

  test('whole physical disks: what /sys/block lists, less what only passes traffic on', () => {
    const listing = ['loop0', 'loop1', 'nvme0n1', 'sda', 'dm-0', 'zram0', 'sr0', 'md0']
    assert.deepEqual([...physicalDisks(listing)], ['nvme0n1', 'sda'])
    const kept = ['sda', 'sdaa', 'vda', 'xvda', 'mmcblk0', 'nvme1n1', 'nbd0', 'mtdblock0', 'pmem0']
    assert.deepEqual([...physicalDisks(kept)], kept)
    const left = ['loop12', 'ram15', 'zram1', 'dm-3', 'md127', 'md_d0', 'sr1', 'fd0', 'zd16', 'bcache0', 'drbd0', 'nvme0c0n1']
    assert.deepEqual([...physicalDisks(left)], [], 'none of these is a disk of its own')
    assert.deepEqual([...physicalDisks(['cciss!c0d0'])], ['cciss/c0d0'], 'as /proc/diskstats names it')
    assert.deepEqual([...physicalDisks(['../etc', '', 7, 'sd a', 'sdb'])], ['sdb'])
    assert.equal(physicalDisks(null).size, 0)
  })

  test('/proc/diskstats: sectors read are the 3rd figure, sectors written the 7th, 512 bytes each', () => {
    const text = fixtureText('linux-diskstats.txt')
    const stats = parseDiskstats(text, physicalDisks(['loop0', 'loop1', 'nvme0n1', 'sda', 'dm-0', 'zram0', 'sr0', 'md0']))!
    assert.deepEqual(
      [...stats.entries()],
      [
        ['nvme0n1', { read: 39_120_840 * 512, write: 71_220_480 * 512 }],
        ['sda', { read: 4_120_480 * 512, write: 204_120 * 512 }]
      ],
      'neither the partitions nor the LVM volume over the disk'
    )
    const set = new Set(['sda', 'sdb', 'sdc', 'sdd'])
    const odd = [diskRow('sda', 10, 20), diskRow('sda', 99, 99), diskRow('sdb', 'x', 20), '   8      32 sdc 1 2 3 4', diskRow('sdd', '9'.repeat(19), 1), 'garbage'].join('\n')
    assert.deepEqual([...parseDiskstats(odd, set)!.entries()], [['sda', { read: 5_120, write: 10_240 }]], 'a second row for a disk, and rows out of shape, are left out')
    assert.equal(parseDiskstats(text, new Set())!.size, 0)
    assert.equal(parseDiskstats(null, set), null)
  })

  test('GPU: one whole number from 0 to 100, the busiest of several', () => {
    assert.equal(parseGpuBusyPercent('37\n'), 37)
    assert.equal(parseGpuBusyPercent('0\n'), 0)
    assert.equal(parseGpuBusyPercent('100'), 100)
    assert.equal(parseGpuBusyPercent('101\n'), null)
    assert.equal(parseGpuBusyPercent('-1\n'), null)
    assert.equal(parseGpuBusyPercent('12.5\n'), null)
    assert.equal(parseGpuBusyPercent(''), null)
    assert.equal(parseGpuBusyPercent(null), null)
    assert.equal(parseNvidiaSmi('12\n'), 12)
    assert.equal(parseNvidiaSmi('4\n87\n'), 87)
    assert.equal(parseNvidiaSmi('[N/A]\n9\n'), 9, 'a GPU that reports none is skipped')
    assert.equal(parseNvidiaSmi('[N/A]\n'), null)
    assert.equal(parseNvidiaSmi('250\n'), null)
    assert.equal(parseNvidiaSmi('12 %\n'), null, 'not the format asked for')
    assert.equal(parseNvidiaSmi("NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver.\n"), null)
    assert.equal(parseNvidiaSmi(7), null)
    assert.equal(isRuntimeSuspended('suspended\n'), true)
    assert.equal(isRuntimeSuspended('suspending\n'), true)
    assert.equal(isRuntimeSuspended('active\n'), false)
    assert.equal(isRuntimeSuspended('unsupported\n'), false)
    assert.equal(isRuntimeSuspended(null), false, 'a status that cannot be read is not "asleep"')
  })
})

const AC = (online: 0 | 1): PowerSupply => ({ type: 'Mains\n', online: `${online}\n` })
const MOUSE: PowerSupply = { type: 'Battery\n', scope: 'Device\n' }
/** A laptop battery that counts in energy: 50 Wh when full. Figures are µWh and µW. */
const bat = (status: string, capacity: number | string, energyNow: number, powerNow: number | string, more: PowerSupply = {}): PowerSupply => ({
  type: 'Battery\n',
  scope: null,
  present: '1\n',
  status: `${status}\n`,
  capacity: `${capacity}\n`,
  energy_now: `${energyNow}\n`,
  energy_full: '50000000\n',
  power_now: `${powerNow}\n`,
  charge_now: null,
  charge_full: null,
  current_now: null,
  ...more
})

describe('power supplies', () => {
  test('a laptop on battery: charge, state, and time left from energy over power', () => {
    assert.deepEqual(parsePowerSupplies([AC(0), bat('Discharging', 71, 35_500_000, 10_000_000)]), {
      present: true,
      percent: 71,
      state: 'discharging',
      source: 'battery',
      minutesRemaining: 213
    })
    // Some drivers sign the power drawn while discharging.
    assert.equal(parsePowerSupplies([AC(0), bat('Discharging', 71, 35_500_000, '-10000000')]).minutesRemaining, 213)
  })

  test('a laptop charging: time until full from what is missing over power', () => {
    assert.deepEqual(parsePowerSupplies([AC(1), bat('Charging', 80, 40_000_000, 20_000_000)]), {
      present: true,
      percent: 80,
      state: 'charging',
      source: 'ac',
      minutesRemaining: 30
    })
    assert.equal(parsePowerSupplies([{ type: 'USB\n', online: '1\n' }, bat('Charging', 80, 40_000_000, 20_000_000)]).source, 'ac', 'a USB-C charger')
    assert.equal(parsePowerSupplies([{ type: 'USB_PD\n', online: '2\n' }, bat('Charging', 80, 40_000_000, 20_000_000)]).source, 'ac', 'a negotiated supply is online as 2')
    assert.equal(parsePowerSupplies([{ type: 'UPS\n', online: '1\n' }, bat('Charging', 80, 40_000_000, 20_000_000)]).source, null, 'a type that is not external power')
  })

  test('charged, held below full, and a status the kernel does not know', () => {
    assert.deepEqual(parsePowerSupplies([AC(1), bat('Full', 100, 50_000_000, 0)]), { present: true, percent: 100, state: 'charged', source: 'ac', minutesRemaining: null })
    assert.deepEqual(parsePowerSupplies([AC(1), bat('Not charging', 80, 40_000_000, 0)]), { present: true, percent: 80, state: 'not-charging', source: 'ac', minutesRemaining: null })
    assert.deepEqual(parsePowerSupplies([AC(1), bat('Unknown', 80, 40_000_000, 0)]), { present: true, percent: 80, state: null, source: 'ac', minutesRemaining: null })
    assert.equal(parsePowerSupplies([bat('Levitating', 80, 40_000_000, 5_000_000)]).state, null)
    assert.equal(parsePowerSupplies([bat('constructor', 80, 40_000_000, 5_000_000)]).state, null)
    assert.equal(parsePowerSupplies([bat('Full', 100, 50_000_000, 0)]).source, null, 'no charger listed and nothing discharging: not known')
  })

  test('a battery that counts in charge: µAh over µA', () => {
    const coulomb: PowerSupply = { type: 'Battery', status: 'Discharging', capacity: '50', charge_now: '3000000', charge_full: '6000000', current_now: '1500000' }
    assert.deepEqual(parsePowerSupplies([coulomb]), { present: true, percent: 50, state: 'discharging', source: 'battery', minutesRemaining: 120 })
    assert.equal(parsePowerSupplies([{ ...coulomb, status: 'Charging' }, AC(1)]).minutesRemaining, 120)
    assert.equal(parsePowerSupplies([{ ...coulomb, capacity: null }]).percent, 50, 'no capacity file: what it holds of what it can hold')
  })

  test('time left only when it is an estimate', () => {
    const minutes = (supply: PowerSupply) => parsePowerSupplies([supply]).minutesRemaining
    assert.equal(minutes(bat('Discharging', 71, 35_500_000, 0)), null, 'no power figure yet')
    assert.equal(minutes(bat('Discharging', 71, 35_500_000, 'lots')), null)
    assert.equal(minutes(bat('Discharging', 71, 35_500_000, 5_000)), null, '7,100 hours is no estimate')
    assert.equal(minutes(bat('Discharging', 71, 35_500_000, 355_060)), 5_999, 'a hair under 100 hours')
    assert.equal(minutes(bat('Discharging', 0, 1_000, 10_000_000)), null, 'under half a minute')
    assert.equal(minutes(bat('Charging', 100, 50_000_000, 5_000_000)), null, 'nothing left to charge')
    assert.equal(minutes(bat('Charging', 80, 40_000_000, 20_000_000, { energy_full: null })), null, 'charging needs the full figure')
    assert.equal(minutes(bat('Discharging', 71, 35_500_000, 10_000_000, { energy_full: null })), 213, 'discharging does not')
    assert.equal(minutes(bat('Full', 100, 50_000_000, 10_000_000)), null, 'neither charging nor discharging')
  })

  test('figures out of shape are left out, not guessed', () => {
    assert.equal(parsePowerSupplies([bat('Discharging', 171, 35_500_000, 10_000_000)]).percent, null)
    assert.equal(parsePowerSupplies([bat('Discharging', '-5', 35_500_000, 10_000_000)]).percent, null)
    assert.equal(parsePowerSupplies([bat('Discharging', 'high', 35_500_000, 10_000_000)]).percent, null)
    const noCapacity = (now: number) => parsePowerSupplies([bat('Discharging', 0, now, 10_000_000, { capacity: null })]).percent
    assert.equal(noCapacity(25_000_000), 50)
    assert.equal(noCapacity(51_000_000), 100, 'a little over its last full charge is full')
    assert.equal(noCapacity(80_000_000), null, 'far over it, the figures are wrong')
    assert.deepEqual(parsePowerSupplies([{ type: 'x'.repeat(100) }, { type: 7 as unknown as string }, {}]), { present: false, percent: null, state: null, source: null, minutesRemaining: null })
  })

  test('a desktop: no battery of its own, whatever its mouse has', () => {
    const none = { present: false, percent: null, state: null, minutesRemaining: null }
    assert.deepEqual(parsePowerSupplies([]), { ...none, source: null })
    assert.deepEqual(parsePowerSupplies([MOUSE, { ...MOUSE, status: 'Discharging', capacity: '40' }]), { ...none, source: null }, 'a mouse running down is not this computer on battery')
    assert.deepEqual(parsePowerSupplies([AC(1), MOUSE]), { ...none, source: 'ac' })
    assert.deepEqual(parsePowerSupplies([AC(1), bat('Unknown', 0, 0, 0, { present: '0\n' })]), { ...none, source: 'ac' }, 'an empty battery bay')
  })

  test('two batteries are given as one', () => {
    // The first is kept full while the second runs down: 50 + 20 of 100 Wh, 10 W drawn.
    const both = [bat('Unknown', 100, 50_000_000, 0), bat('Discharging', 40, 20_000_000, 10_000_000), AC(0)]
    assert.deepEqual(parsePowerSupplies(both), { present: true, percent: 70, state: 'discharging', source: 'battery', minutesRemaining: 420 })
    const charging = [bat('Full', 100, 50_000_000, 0), bat('Charging', 40, 20_000_000, 15_000_000), AC(1)]
    assert.deepEqual(parsePowerSupplies(charging), { present: true, percent: 70, state: 'charging', source: 'ac', minutesRemaining: 120 })
    assert.equal(parsePowerSupplies([bat('Full', 100, 50_000_000, 0), bat('Full', 100, 50_000_000, 0)]).state, 'charged')
    assert.equal(parsePowerSupplies([bat('Full', 100, 50_000_000, 0), bat('Not charging', 80, 40_000_000, 0)]).state, 'not-charging')
    assert.equal(parsePowerSupplies([bat('Full', 100, 50_000_000, 0), bat('Unknown', 80, 40_000_000, 0)]).state, null, 'one of them says nothing')
    const mixed = [bat('Discharging', 40, 20_000_000, 10_000_000), { type: 'Battery', status: 'Unknown', capacity: '90', charge_now: '1', charge_full: '2', current_now: '0' }]
    assert.deepEqual([parsePowerSupplies(mixed).percent, parsePowerSupplies(mixed).minutesRemaining], [null, null], 'energy and charge do not add up')
  })
})

/** A scripted Linux computer: the text of each file now, and a clock that only moves when told.
 *  A directory's listing is the next path segment of every file under it, unless one is given. */
function fakeLinux(options: { platform?: string; heavyAllowed?: () => boolean } = {}) {
  const files = new Map<string, string>()
  const dirs = new Map<string, string[]>()
  const state = { t: 0, smi: '55\n' as string | null, reads: [] as string[], lists: [] as string[], runs: [] as string[][], space: { bsize: 4096, blocks: 250_000_000, bavail: 100_000_000 } as { bsize: number; blocks: number; bavail: number } | null }
  const readFile = async (path: string): Promise<string | null> => {
    state.reads.push(path)
    return files.get(path) ?? null
  }
  const readDir = async (path: string): Promise<string[] | null> => {
    state.lists.push(path)
    const given = dirs.get(path)
    if (given) return [...given]
    const names = new Set<string>()
    for (const file of files.keys()) if (file.startsWith(`${path}/`)) names.add(file.slice(path.length + 1).split('/')[0]!)
    return names.size > 0 ? [...names] : null
  }
  const exec: ExecFile = async (file, args) => {
    state.runs.push([file, ...args])
    return state.smi === null ? { error: Object.assign(new Error('failed'), { code: 9 }), stdout: '' } : { error: null, stdout: state.smi }
  }
  const reader = new LinuxSystemReader({ readFile, readDir, exec, mono: () => state.t, statfs: () => state.space, platform: options.platform ?? 'linux', ...(options.heavyAllowed ? { heavyAllowed: options.heavyAllowed } : {}) })
  const supply = (name: string, attributes: PowerSupply): void => {
    for (const [file, text] of Object.entries(attributes)) {
      if (typeof text === 'string') files.set(`/sys/class/power_supply/${name}/${file}`, text)
      else files.delete(`/sys/class/power_supply/${name}/${file}`)
    }
  }
  const readsOf = (path: string): number => state.reads.filter((p) => p === path).length
  return { state, files, dirs, reader, supply, readsOf }
}

/** A laptop: wired default route, one NVMe disk under an LVM volume, an AMD GPU, on its charger. */
function laptop(options: { platform?: string; heavyAllowed?: () => boolean } = {}) {
  const pc = fakeLinux(options)
  const net = { iface: 'enp3s0', rx: 1_000_000, tx: 50_000 }
  const disk = { read: 20_000, write: 10_000 }
  const write = (): void => {
    pc.files.set('/proc/net/route', routes(routeRow(net.iface)))
    pc.files.set('/proc/net/dev', netDev(netDevRow('lo', 77, 77), netDevRow(net.iface, net.rx, net.tx)))
    // The LVM volume repeats the disk's traffic, and must not be counted with it.
    pc.files.set('/proc/diskstats', [diskRow('loop0', 5, 0, 7), diskRow('nvme0n1', disk.read, disk.write, 259), diskRow('nvme0n1p2', disk.read, disk.write, 259), diskRow('dm-0', disk.read, disk.write, 253)].join('\n'))
  }
  write()
  pc.dirs.set('/sys/block', ['loop0', 'nvme0n1', 'dm-0'])
  pc.files.set('/sys/class/drm/version', 'drm 1.1.0 20060810\n')
  pc.files.set('/sys/class/drm/card0-DP-1/status', 'connected\n')
  pc.files.set('/sys/class/drm/renderD128/dev', '226:128\n')
  pc.files.set('/sys/class/drm/card0/device/power/runtime_status', 'active\n')
  pc.files.set('/sys/class/drm/card0/device/gpu_busy_percent', '20\n')
  pc.supply('AC', AC(1))
  pc.supply('BAT0', bat('Charging', 70, 35_000_000, 15_000_000))
  return { ...pc, net, disk, write }
}

describe('LinuxSystemReader', () => {
  test('rates from counters between readings; the first reading has none', async () => {
    const pc = laptop()
    await pc.reader.refresh()
    const first = pc.reader.snapshot()!
    assert.deepEqual(first.net, { iface: 'enp3s0', rxBytesPerSec: null, txBytesPerSec: null })
    assert.equal(first.disk?.readBytesPerSec, null)
    assert.equal(first.disk?.totalBytes, 1_024_000_000_000)
    assert.equal(first.disk?.usedBytes, 614_400_000_000)
    assert.deepEqual(first.gpu, { percent: 20 })
    assert.deepEqual(first.battery, { present: true, percent: 70, state: 'charging', source: 'ac', minutesRemaining: 60 })
    pc.state.t = 5_000
    pc.net.rx += 2_500_000
    pc.net.tx += 500_000
    pc.write()
    await pc.reader.refresh()
    const second = pc.reader.snapshot()!
    assert.deepEqual([second.net?.rxBytesPerSec, second.net?.txBytesPerSec], [500_000, 100_000])
    assert.equal(second.net?.ageMs, undefined, 'just read')
    // The slow parts were not read again: they are carried, with their age.
    assert.equal(second.gpu?.ageMs, 5_000)
    assert.equal(second.battery?.ageMs, 5_000)
    assert.equal(second.disk?.spaceAgeMs, 5_000)
    assert.deepEqual([pc.readsOf('/proc/net/dev'), pc.readsOf('/proc/net/route'), pc.readsOf('/proc/diskstats'), pc.readsOf('/sys/class/drm/card0/device/gpu_busy_percent')], [2, 1, 1, 1])
    pc.state.t = SYSTEM_CADENCE.diskIoMs
    const seconds = SYSTEM_CADENCE.diskIoMs / 1000
    pc.disk.read += seconds * 2_000
    pc.disk.write += seconds * 200
    pc.write()
    await pc.reader.refresh()
    const third = pc.reader.snapshot()!
    assert.deepEqual([third.disk?.readBytesPerSec, third.disk?.writeBytesPerSec], [2_000 * 512, 200 * 512], 'the disk once: not its partition, not the LVM volume over it')
    assert.equal(third.disk?.ioAgeMs, undefined, 'just read')
    pc.state.t = SYSTEM_CADENCE.routeMs
    await pc.reader.refresh()
    assert.equal(pc.readsOf('/proc/net/route'), 2, 'the default route is found again about once a minute')
    assert.equal(pc.readsOf('/proc/net/ipv6_route'), 0, 'never read while there is an IPv4 default')
    assert.equal(pc.state.runs.length, 0, "no child process without NVIDIA's driver")
  })

  test('a disk that appears, goes or resets costs only its own share', async () => {
    const pc = laptop()
    pc.dirs.set('/sys/block', ['sda', 'sdb', 'sdc', 'sdd'])
    pc.files.set('/proc/diskstats', [diskRow('sda', 1_000, 1_000), diskRow('sdb', 9_000_000, 9_000_000), diskRow('sdd', 5_000, 5_000)].join('\n'))
    await pc.reader.refresh()
    pc.state.t = SYSTEM_CADENCE.diskIoMs
    const seconds = SYSTEM_CADENCE.diskIoMs / 1000
    // sda read on; sdb was unplugged; sdc is new; sdd's counters started again.
    pc.files.set('/proc/diskstats', [diskRow('sda', 1_000 + seconds * 4, 1_000), diskRow('sdc', 70_000, 70_000), diskRow('sdd', 12, 6_000)].join('\n'))
    await pc.reader.refresh()
    assert.deepEqual([pc.reader.snapshot()!.disk?.readBytesPerSec, pc.reader.snapshot()!.disk?.writeBytesPerSec], [4 * 512, 0])
  })

  test('no disk traffic without a listing of whole disks, or without a disk in it', async () => {
    const pc = laptop()
    pc.dirs.delete('/sys/block')
    await pc.reader.refresh()
    pc.state.t = SYSTEM_CADENCE.diskIoMs
    await pc.reader.refresh()
    assert.equal(pc.reader.snapshot()!.disk?.readBytesPerSec, null, 'which rows are whole disks is not guessed')
    assert.equal(pc.reader.snapshot()!.disk?.totalBytes, 1_024_000_000_000, 'the space is still known')
    pc.dirs.set('/sys/block', ['loop0', 'dm-0'])
    pc.state.t = 2 * SYSTEM_CADENCE.diskIoMs
    await pc.reader.refresh()
    pc.state.t = 3 * SYSTEM_CADENCE.diskIoMs
    await pc.reader.refresh()
    assert.equal(pc.reader.snapshot()!.disk?.readBytesPerSec, null)
  })

  test('counters that go back, or a new default interface, start the rates again', async () => {
    const pc = laptop()
    await pc.reader.refresh()
    pc.state.t = 5_000
    pc.net.rx = 10
    pc.write()
    await pc.reader.refresh()
    assert.equal(pc.reader.snapshot()!.net?.rxBytesPerSec, null, 'the counter went back')
    pc.state.t = 10_000
    pc.net.rx = 1_010
    pc.write()
    await pc.reader.refresh()
    assert.equal(pc.reader.snapshot()!.net?.rxBytesPerSec, 200)
    // The cable is pulled: the default route moves to Wi-Fi, and the old interface is gone.
    pc.net.iface = 'wlp2s0'
    pc.write()
    pc.state.t = 15_000
    await pc.reader.refresh()
    assert.equal(pc.reader.snapshot()!.net?.iface, 'enp3s0', 'the last reading is carried for now')
    pc.state.t = 20_000
    await pc.reader.refresh()
    const net = pc.reader.snapshot()!.net
    assert.deepEqual(net, { iface: 'wlp2s0', rxBytesPerSec: null, txBytesPerSec: null })
    pc.state.t = 25_000
    pc.net.rx += 5_000
    pc.write()
    await pc.reader.refresh()
    assert.equal(pc.reader.snapshot()!.net?.rxBytesPerSec, 1_000)
  })

  test('an IPv6 default route serves where there is no IPv4 one; with neither there is no reading', async () => {
    const pc = laptop()
    pc.files.set('/proc/net/route', routes(routeRow('enp3s0', '000200C0', '0001', 100, '00FFFFFF')))
    pc.files.set('/proc/net/ipv6_route', `${route6Row('lo', 'ffffffff', '00200200')}\n${route6Row('enp3s0')}\n`)
    await pc.reader.refresh()
    assert.equal(pc.reader.snapshot()!.net?.iface, 'enp3s0')
    const offline = laptop()
    offline.files.set('/proc/net/route', routes())
    await offline.reader.refresh()
    assert.equal(offline.reader.snapshot()!.net, null)
    assert.equal(offline.readsOf('/proc/net/dev'), 0, 'nothing to read counters for')
    // Offline, the route is looked for with every reading, and found as soon as there is one.
    offline.state.t = 5_000
    offline.write()
    await offline.reader.refresh()
    assert.equal(offline.reader.snapshot()!.net?.iface, 'enp3s0')
    assert.equal(offline.readsOf('/proc/net/route'), 2)
  })

  test('an interface name out of shape gives no reading', async () => {
    const pc = laptop()
    pc.net.iface = '9lives'
    pc.write()
    await pc.reader.refresh()
    assert.equal(pc.reader.snapshot()!.net, null, 'the beacon would refuse the name')
  })

  test('a failed read carries the last value until it is too old', async () => {
    const pc = laptop()
    await pc.reader.refresh()
    pc.state.t = SYSTEM_CADENCE.diskIoMs
    pc.disk.read += 4_000
    pc.write()
    await pc.reader.refresh()
    assert.equal(pc.reader.snapshot()!.disk?.readBytesPerSec, (4_000 * 512) / 20)
    // Everything stops answering.
    pc.files.clear()
    pc.dirs.clear()
    pc.state.space = null
    pc.state.t = SYSTEM_CADENCE.batteryMs
    await pc.reader.refresh()
    const carried = pc.reader.snapshot()!
    assert.equal(carried.battery?.ageMs, SYSTEM_CADENCE.batteryMs)
    assert.equal(carried.battery?.percent, 70)
    assert.equal(carried.gpu?.ageMs, SYSTEM_CADENCE.batteryMs)
    assert.equal(carried.disk?.spaceAgeMs, SYSTEM_CADENCE.batteryMs)
    assert.equal(carried.disk?.ioAgeMs, SYSTEM_CADENCE.batteryMs - SYSTEM_CADENCE.diskIoMs)
    assert.equal(carried.disk?.readBytesPerSec, (4_000 * 512) / 20, 'the traffic figures are still young enough')
    assert.equal(carried.net, null, 'the network reading is not')
    pc.state.t = SYSTEM_MAX_AGE.gpuMs + 1
    assert.equal(pc.reader.snapshot()!.gpu, null)
    assert.notEqual(pc.reader.snapshot()!.battery, null)
    pc.state.t = SYSTEM_MAX_AGE.batteryMs + 1
    assert.deepEqual(pc.reader.snapshot(), { net: null, disk: null, gpu: null, battery: null })
  })

  test('the network reading is carried over one failed read, then dropped', async () => {
    const pc = laptop()
    await pc.reader.refresh()
    pc.files.delete('/proc/net/dev')
    pc.state.t = 5_000
    await pc.reader.refresh()
    assert.equal(pc.reader.snapshot()!.net?.ageMs, 5_000)
    pc.state.t = SYSTEM_MAX_AGE.netMs + 1
    await pc.reader.refresh()
    assert.equal(pc.reader.snapshot()!.net, null)
  })

  test('GPU: the busiest of the cards that say; a card that says nothing gives none', async () => {
    const pc = laptop()
    pc.files.set('/sys/class/drm/card1/device/gpu_busy_percent', '64\n')
    pc.files.set('/sys/class/drm/card2/device/gpu_busy_percent', 'busy\n')
    await pc.reader.refresh()
    assert.equal(pc.reader.snapshot()!.gpu?.percent, 64)
    // An Intel GPU: a card, but no figure to read without privileges.
    const intel = laptop()
    intel.files.delete('/sys/class/drm/card0/device/gpu_busy_percent')
    await intel.reader.refresh()
    assert.equal(intel.reader.snapshot()!.gpu, null)
    assert.equal(intel.state.runs.length, 0)
    // No graphics at all (a server, a container).
    const none = laptop()
    for (const path of [...none.files.keys()]) if (path.startsWith('/sys/class/drm/')) none.files.delete(path)
    await none.reader.refresh()
    assert.equal(none.reader.snapshot()!.gpu, null)
  })

  test('GPU: nvidia-smi only where the NVIDIA driver is loaded, by its full path, without a shell', async () => {
    const pc = laptop()
    pc.files.set('/proc/driver/nvidia/version', 'NVRM version: NVIDIA UNIX x86_64 Kernel Module  999.99\n')
    pc.state.smi = '3\n91\n'
    await pc.reader.refresh()
    assert.deepEqual(pc.state.runs, [[NVIDIA_SMI_PATH, ...NVIDIA_SMI_ARGS]])
    assert.deepEqual(pc.state.runs[0], ['/usr/bin/nvidia-smi', '--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'])
    assert.equal(pc.reader.snapshot()!.gpu?.percent, 91, 'the busiest of the AMD card (20) and the NVIDIA ones')
    // nvidia-smi fails: the AMD figure still stands.
    pc.state.smi = null
    pc.files.set('/sys/class/drm/card0/device/gpu_busy_percent', '8\n')
    pc.state.t = SYSTEM_CADENCE.gpuMs
    await pc.reader.refresh()
    assert.deepEqual(pc.reader.snapshot()!.gpu, { percent: 8 })
    assert.equal(pc.state.runs.length, 2, 'once each time the GPU is due')
  })

  test('GPU: one that is asleep is not woken to be asked', async () => {
    const pc = laptop()
    pc.files.set('/sys/class/drm/card1/device/power/runtime_status', 'suspended\n')
    pc.files.set('/sys/class/drm/card1/device/gpu_busy_percent', '99\n')
    pc.files.set('/proc/driver/nvidia/version', 'NVRM version: NVIDIA UNIX x86_64 Kernel Module  999.99\n')
    pc.files.set('/proc/driver/nvidia/gpus/0000:01:00.0/information', 'Model: Example\n')
    pc.files.set('/sys/bus/pci/devices/0000:01:00.0/power/runtime_status', 'suspended\n')
    await pc.reader.refresh()
    assert.equal(pc.reader.snapshot()!.gpu?.percent, 20, 'only the card that is awake')
    assert.equal(pc.readsOf('/sys/class/drm/card1/device/gpu_busy_percent'), 0)
    assert.equal(pc.state.runs.length, 0, 'nvidia-smi would wake the GPU')
    // It wakes by itself (something uses it): now it is asked.
    pc.files.set('/sys/bus/pci/devices/0000:01:00.0/power/runtime_status', 'active\n')
    pc.files.set('/sys/class/drm/card1/device/power/runtime_status', 'active\n')
    pc.state.t = SYSTEM_CADENCE.gpuMs
    await pc.reader.refresh()
    assert.equal(pc.state.runs.length, 1)
    assert.equal(pc.reader.snapshot()!.gpu?.percent, 99)
    // A driver that lists its GPUs some other way is asked as before.
    const other = laptop()
    other.files.set('/proc/driver/nvidia/version', 'NVRM version: NVIDIA UNIX x86_64 Kernel Module  999.99\n')
    other.files.set('/proc/driver/nvidia/gpus/0/information', 'Model: Example\n')
    await other.reader.refresh()
    assert.equal(other.state.runs.length, 1)
  })

  test('the GPU read waits while optional work should', async () => {
    let heavy = false
    const pc = laptop({ heavyAllowed: () => heavy })
    pc.files.set('/proc/driver/nvidia/version', 'NVRM version: NVIDIA UNIX x86_64 Kernel Module  999.99\n')
    await pc.reader.refresh()
    assert.equal(pc.reader.snapshot()!.gpu, null)
    assert.deepEqual([pc.state.lists.includes('/sys/class/drm'), pc.state.runs.length], [false, 0])
    assert.notEqual(pc.reader.snapshot()!.disk?.totalBytes, null, 'the file reads go on')
    assert.notEqual(pc.reader.snapshot()!.battery, null)
    heavy = true
    pc.state.t = 5_000
    await pc.reader.refresh()
    assert.equal(pc.reader.snapshot()!.gpu?.percent, 55)
    assert.equal(pc.state.runs.length, 1)
    const thrower = laptop({ heavyAllowed: () => { throw new Error('no') } })
    await thrower.reader.refresh()
    assert.equal(thrower.reader.snapshot()!.gpu, null)
  })

  test('battery: on battery, then plugged in, each about once a minute', async () => {
    const pc = laptop()
    pc.supply('AC', AC(0))
    pc.supply('BAT0', bat('Discharging', 71, 35_500_000, 10_000_000))
    await pc.reader.refresh()
    assert.deepEqual(pc.reader.snapshot()!.battery, { present: true, percent: 71, state: 'discharging', source: 'battery', minutesRemaining: 213 })
    pc.supply('AC', AC(1))
    pc.supply('BAT0', bat('Charging', 72, 36_000_000, 28_000_000))
    pc.state.t = SYSTEM_CADENCE.batteryMs - 1
    await pc.reader.refresh()
    assert.equal(pc.reader.snapshot()!.battery?.state, 'discharging', 'not read again yet')
    pc.state.t = SYSTEM_CADENCE.batteryMs
    await pc.reader.refresh()
    assert.deepEqual(pc.reader.snapshot()!.battery, { present: true, percent: 72, state: 'charging', source: 'ac', minutesRemaining: 30 })
  })

  test('battery: a desktop has none, and its mouse is asked only what it is', async () => {
    const pc = laptop()
    for (const path of [...pc.files.keys()]) if (path.startsWith('/sys/class/power_supply/')) pc.files.delete(path)
    pc.supply('hidpp_battery_0', { type: 'Battery\n', scope: 'Device\n', status: 'Discharging\n', capacity: '40\n', online: '1\n' })
    await pc.reader.refresh()
    assert.deepEqual(pc.reader.snapshot()!.battery, { present: false, percent: null, state: null, source: null, minutesRemaining: null })
    const asked = pc.state.reads.filter((p) => p.startsWith('/sys/class/power_supply/')).sort()
    assert.deepEqual(asked, ['/sys/class/power_supply/hidpp_battery_0/scope', '/sys/class/power_supply/hidpp_battery_0/type'], 'its charge would be asked of the mouse itself')
    // With nothing listed at all, the same.
    const bare = laptop()
    for (const path of [...bare.files.keys()]) if (path.startsWith('/sys/class/power_supply/')) bare.files.delete(path)
    bare.dirs.set('/sys/class/power_supply', [])
    await bare.reader.refresh()
    assert.deepEqual(bare.reader.snapshot()!.battery, { present: false, percent: null, state: null, source: null, minutesRemaining: null })
  })

  test('battery: no power supply directory, or one that cannot be read, says nothing', async () => {
    const pc = laptop()
    for (const path of [...pc.files.keys()]) if (path.startsWith('/sys/class/power_supply/')) pc.files.delete(path)
    await pc.reader.refresh()
    assert.equal(pc.reader.snapshot()!.battery, null, 'not the same as a computer without a battery')
    const blind = laptop()
    for (const path of [...blind.files.keys()]) if (path.startsWith('/sys/class/power_supply/')) blind.files.delete(path)
    blind.dirs.set('/sys/class/power_supply', ['AC', 'BAT0'])
    await blind.reader.refresh()
    assert.equal(blind.reader.snapshot()!.battery, null, 'entries, but no type could be read')
  })

  test('a listing cannot lead a read out of its directory', async () => {
    const pc = laptop()
    pc.dirs.set('/sys/class/power_supply', ['../../../etc', 'a/b', '..', '.', 'BAT0'])
    pc.dirs.set('/sys/class/drm', ['card0/../../x', 'card0'])
    await pc.reader.refresh()
    assert.equal(pc.state.reads.some((p) => p.includes('..') || p.includes('/etc') || p.includes('a/b')), false)
    assert.equal(pc.reader.snapshot()!.battery?.percent, 70)
  })

  test('disk space: read about once a minute, and left out when out of shape', async () => {
    const pc = laptop()
    pc.state.space = { bsize: 4096, blocks: 1_000, bavail: 2_000 }
    await pc.reader.refresh()
    assert.equal(pc.reader.snapshot()!.disk, null)
    pc.state.space = { bsize: 4096, blocks: 1_000, bavail: 400 }
    pc.state.t = SYSTEM_CADENCE.spaceMs
    await pc.reader.refresh()
    assert.deepEqual([pc.reader.snapshot()!.disk?.totalBytes, pc.reader.snapshot()!.disk?.usedBytes], [4_096_000, 2_457_600])
    const reader = new LinuxSystemReader({ readFile: async () => null, readDir: async () => null, mono: () => 0, statfs: () => { throw new Error('EIO') }, platform: 'linux' })
    await reader.refresh()
    assert.equal(reader.snapshot()!.disk, null)
  })

  test('a refresh still running is joined; anything but Linux reads nothing', async () => {
    const pc = laptop()
    const a = pc.reader.refresh()
    const b = pc.reader.refresh()
    assert.equal(a, b)
    await a
    assert.equal(pc.readsOf('/proc/net/dev'), 1)
    const never = async (): Promise<never> => {
      throw new Error('must not run')
    }
    // The sampler takes it as it takes a Mac's reader.
    const mac: SystemReader = new LinuxSystemReader({ readFile: never, readDir: never, exec: never, statfs: () => { throw new Error('must not run') }, platform: 'darwin' })
    await mac.refresh()
    assert.equal(mac.snapshot(), null)
    const windows = laptop({ platform: 'win32' })
    await windows.reader.refresh()
    assert.equal(windows.reader.snapshot(), null)
    assert.deepEqual([windows.state.reads.length, windows.state.lists.length, windows.state.runs.length], [0, 0, 0])
  })

  test('reads that throw, or give something that is not text, give nothing rather than a guess', async () => {
    const boom = async (): Promise<never> => {
      throw new Error('EACCES')
    }
    const reader = new LinuxSystemReader({ readFile: boom, readDir: boom, exec: boom, mono: () => 0, statfs: () => null, platform: 'linux' })
    await reader.refresh()
    assert.deepEqual(reader.snapshot(), { net: null, disk: null, gpu: null, battery: null })
    const odd = new LinuxSystemReader({
      readFile: (async () => 42) as unknown as (path: string) => Promise<string | null>,
      readDir: (async () => 'card0') as unknown as (path: string) => Promise<string[] | null>,
      mono: () => 0,
      statfs: () => null,
      platform: 'linux'
    })
    await odd.refresh()
    assert.deepEqual(odd.snapshot(), { net: null, disk: null, gpu: null, battery: null })
  })

  test('the whole laptop from its fixture files', async () => {
    const pc = laptop()
    pc.files.set('/proc/net/route', fixtureText('linux-net-route.txt'))
    pc.files.set('/proc/net/dev', fixtureText('linux-net-dev.txt'))
    pc.files.set('/proc/diskstats', fixtureText('linux-diskstats.txt'))
    pc.dirs.set('/sys/block', ['loop0', 'loop1', 'nvme0n1', 'sda', 'dm-0', 'zram0', 'sr0', 'md0'])
    await pc.reader.refresh()
    pc.state.t = SYSTEM_CADENCE.diskIoMs
    pc.files.set('/proc/net/dev', fixtureText('linux-net-dev.txt').replace('8026786952', '8026986952').replace('400408552', '400428552'))
    pc.files.set('/proc/diskstats', fixtureText('linux-diskstats.txt').replace('nvme0n1 412345 1204 39120840', 'nvme0n1 412345 1204 39121240').replace('sda 20412 310 4120480 30412 1204 88 204120', 'sda 20412 310 4120480 30412 1204 88 204160'))
    await pc.reader.refresh()
    const snapshot = pc.reader.snapshot()!
    assert.deepEqual(snapshot.net, { iface: 'enp3s0', rxBytesPerSec: 10_000, txBytesPerSec: 1_000 })
    assert.deepEqual([snapshot.disk?.readBytesPerSec, snapshot.disk?.writeBytesPerSec], [(400 * 512) / 20, (40 * 512) / 20])
  })
})

describe('a Linux that does not behave', () => {
  test('a file that never answers holds up only its own part, and is not read a second time', async () => {
    const pc = laptop()
    const never = new Promise<string | null>(() => {})
    const hung = '/sys/class/power_supply/BAT0/type'
    let hangs = 0
    const reader = new LinuxSystemReader({
      readFile: (path) => {
        if (path === hung) {
          hangs += 1
          return never
        }
        pc.state.reads.push(path)
        return Promise.resolve(pc.files.get(path) ?? null)
      },
      readDir: async (path) => (path === '/sys/block' ? ['nvme0n1'] : path === '/sys/class/power_supply' ? ['AC', 'BAT0'] : null),
      mono: () => pc.state.t,
      statfs: () => pc.state.space,
      platform: 'linux'
    })
    const first = reader.refresh()
    await flush(20)
    assert.equal(hangs, 1)
    assert.equal(reader.snapshot()?.net?.iface, 'enp3s0', 'the network was read all the same')
    // The refresh is still waiting on the battery: until the deadline, a new one joins it.
    pc.state.t = REFRESH_DEADLINE_MS - 1
    assert.equal(reader.refresh(), first)
    // Past it, the parts that answer are read again, and the network has rates.
    pc.state.t = REFRESH_DEADLINE_MS
    pc.net.rx += 50_000
    pc.write()
    const second = reader.refresh()
    assert.notEqual(second, first)
    await second
    assert.equal(reader.snapshot()?.net?.rxBytesPerSec, 10_000)
    // The battery is due again a minute later, and is left alone: its first read never returned.
    pc.state.t = 120_000
    await reader.refresh()
    assert.equal(hangs, 1)
    assert.equal(reader.snapshot()?.battery, null)
  })

  test('disk space is the real disk where / is a small image that is always full', () => {
    const GIB = 2 ** 30
    const at = (volumes: Record<string, { bsize: number; blocks: number; bavail: number } | null>) => {
      const asked: string[] = []
      const reader = new LinuxSystemReader({
        readFile: async () => null,
        readDir: async () => null,
        mono: () => 0,
        statfs: (path) => {
          asked.push(path)
          return volumes[path] ?? null
        },
        platform: 'linux'
      })
      return { reader, asked }
    }
    const image = { bsize: 4096, blocks: 2_000, bavail: 0 } // about 8 MB, full: a composefs root
    const disk = { bsize: 4096, blocks: 100 * (GIB / 4096), bavail: 60 * (GIB / 4096) }
    // An ordinary machine: `/` is the disk, and nothing else is asked.
    const usual = at({ '/': disk })
    void usual.reader.refresh()
    assert.deepEqual(usual.asked, ['/'])
    assert.deepEqual([usual.reader.snapshot()?.disk?.totalBytes, usual.reader.snapshot()?.disk?.usedBytes], [100 * GIB, 40 * GIB])
    // Fedora Atomic: the real disk is at /sysroot.
    const atomic = at({ '/': image, '/sysroot': disk, '/var': disk })
    void atomic.reader.refresh()
    assert.deepEqual(atomic.asked, ['/', '/sysroot'])
    assert.equal(atomic.reader.snapshot()?.disk?.totalBytes, 100 * GIB)
    // Nothing of a real size anywhere (a tiny container): `/` as it is, rather than nothing.
    const tiny = at({ '/': image })
    void tiny.reader.refresh()
    assert.deepEqual(tiny.asked, [...LINUX_SPACE_PATHS])
    assert.equal(tiny.reader.snapshot()?.disk?.totalBytes, 4096 * 2_000)
  })
})

describe('reading files', () => {
  const path = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))

  test('a file is read whole, refused past the cap, and null when it cannot be read', async () => {
    // These read this test's own fixture files, as fixtureText does: nothing of this computer's.
    assert.equal(await readTextBounded(path('linux-net-dev.txt')), fixtureText('linux-net-dev.txt'))
    const long = fixtureText('beacon-1.1.0.ts')
    assert.ok(Buffer.byteLength(long) > 4_096, 'longer than the first chunk read')
    assert.equal(await readTextBounded(path('beacon-1.1.0.ts')), long)
    assert.equal(await readTextBounded(path('beacon-1.1.0.ts'), Buffer.byteLength(long)), long, 'exactly the cap')
    assert.equal(await readTextBounded(path('beacon-1.1.0.ts'), Buffer.byteLength(long) - 1), null, 'one byte over')
    assert.equal(await readTextBounded(path('linux-net-dev.txt'), 100), null)
    assert.equal((await readBytesBounded(path('linux-stat-systemd.txt')))?.length, Buffer.byteLength(fixtureText('linux-stat-systemd.txt')))
    assert.equal(await readTextBounded(path('linux-no-such-file.txt')), null)
    assert.equal(await readTextBounded(path('')), null, 'a directory')
  })

  test('a directory is listed, or null', async () => {
    assert.equal((await listDir(path('')))?.includes('linux-net-dev.txt'), true)
    assert.equal(await listDir(path('linux-no-such-directory')), null)
    assert.equal(await listDir(path('linux-net-dev.txt')), null, 'a file')
  })
})
