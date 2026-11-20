// Every local volume (1.4): how each platform lists them, how a beacon carries them, and how the
// Activity tab shows them. Every value is invented.
import { assert, describe, test } from 'orca/testing'
import { decodeBeacon, encodeBeacon } from '../src/beacon.ts'
import { LinuxSystemReader, linuxVolumePlaces, parseZfsList } from '../src/linux-system.ts'
import { MacSystemReader, macMainVolumeName, macVolumePlaces, MAX_VOLUMES, MOUNT_PATH, parseMacMounts, readVolumes, systemSnapshot } from '../src/mac-system.ts'
import { parseVolAnswer } from '../src/win-system.ts'
import { localSample } from './helpers.ts'

const statfs = (sizes: Record<string, [number, number]>) => async (path: string) => {
  const s = sizes[path]
  return s ? { bsize: 4096, blocks: s[0] / 4096, bavail: (s[0] - s[1]) / 4096 } : null
}
const GB = 1e9
const blocks = (n: number) => n - (n % 4096)

describe('a Mac', () => {
  const mount = [
    '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
    'devfs on /dev (devfs, local, nobrowse)',
    '/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect, root data)',
    '/dev/disk3s3 on /Volumes/Recovery (apfs, local, journaled, nobrowse)',
    '/dev/disk5s1 on /Volumes/My Backup (apfs, local, nodev, nosuid, journaled, noowners)',
    '/dev/disk6s2 on /Volumes/Install App (hfs, local, nodev, nosuid, read-only, noowners, quarantine, mounted by me)',
    '//me@nas/share on /Volumes/share (smbfs, nodev, nosuid, mounted by me)',
    'map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)'
  ].join('\n')

  test('the start-up disk, then each local volume Finder shows that can be written to', () => {
    const places = macVolumePlaces(parseMacMounts(mount), 'Macintosh HD')
    assert.deepEqual(places, [
      { path: '/System/Volumes/Data', name: 'Macintosh HD', main: true },
      { path: '/Volumes/My Backup', name: 'My Backup' }
    ], 'not Recovery (hidden), not an installer image (read-only), never a network share')
  })

  test('the start-up disk is named as Finder names it: the entry in /Volumes that links to /', async () => {
    const asked: string[] = []
    const link = async (p: string) => {
      asked.push(p)
      if (p === '/Volumes/Work SSD') return '/'
      throw new Error('not a link')
    }
    const list = async () => [{ name: 'My Backup', link: false }, { name: 'Old', link: true }, { name: 'Work SSD', link: true }]
    assert.equal(await macMainVolumeName(list, link), 'Work SSD')
    assert.deepEqual(asked, ['/Volumes/Old', '/Volumes/Work SSD'], 'a mounted volume is never asked about')
    // A /Volumes that cannot be listed is not "no name": the reader keeps the last name found.
    await assert.rejects(macMainVolumeName(async () => Promise.reject(new Error('no /Volumes'))), /no \/Volumes/)
    assert.equal(macVolumePlaces(parseMacMounts(mount), null)[0]?.name, 'Macintosh HD', 'and Macintosh HD when it cannot be told')
  })

  test('each place read with statfs; one that cannot be read is left out', async () => {
    const places = macVolumePlaces(parseMacMounts(mount), 'Macintosh HD')
    assert.deepEqual((await readVolumes(places, statfs({ '/System/Volumes/Data': [blocks(994 * GB), blocks(412 * GB)] }))).map((v) => v.name), ['Macintosh HD'])
  })

  test('a name lookup that fails keeps the last name found', async () => {
    const lookups: (() => Promise<string | null>)[] = [async () => 'Work SSD', async () => Promise.reject(new Error('EIO'))]
    let t = 0
    const mounts = '/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect, root data)\n'
    const reader = new MacSystemReader({
      exec: async (file) => ({ error: null, stdout: file === MOUNT_PATH ? mounts : '' }),
      mono: () => t,
      statfs: () => null,
      statfsAsync: async () => ({ bsize: 4096, blocks: 1_000_000, bavail: 500_000 }),
      platform: 'darwin',
      volumeName: () => lookups.shift()!()
    })
    await reader.refresh()
    assert.equal(reader.snapshot()?.disk?.volumes?.[0]?.name, 'Work SSD')
    t = 61_000
    await reader.refresh()
    assert.equal(reader.snapshot()?.disk?.volumes?.[0]?.name, 'Work SSD')
  })

  test('APFS volumes in one container share its space: one disk, named after them all', () => {
    const shared = [
      '/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect, root data)',
      '/dev/disk3s7 on /Volumes/Work (apfs, local, journaled)',
      '/dev/disk7s1 on /Volumes/Media (apfs, local, nodev, nosuid, journaled, noowners)',
      '/dev/disk7s2 on /Volumes/Scratch (apfs, local, nodev, nosuid, journaled, noowners)',
      '/dev/disk8s1 on /Volumes/Old Drive (hfs, local, nodev, nosuid, journaled, noowners)',
      '/dev/disk8s2 on /Volumes/Old Photos (hfs, local, nodev, nosuid, journaled, noowners)'
    ].join('\n')
    assert.deepEqual(macVolumePlaces(parseMacMounts(shared), 'Macintosh HD'), [
      { path: '/System/Volumes/Data', name: 'Macintosh HD · Work', main: true },
      { path: '/Volumes/Media', name: 'Media · Scratch' },
      { path: '/Volumes/Old Drive', name: 'Old Drive' },
      { path: '/Volumes/Old Photos', name: 'Old Photos' }
    ], 'partitions of another kind are disks of their own')
  })
})

describe('a disk that does not answer', () => {
  test('never holds the reading up, and is not asked again while it is still answering', async () => {
    const asked: string[] = []
    const stuck = async (path: string) => {
      asked.push(path)
      if (path === '/Volumes/Stuck') return new Promise<null>(() => {})
      return { bsize: 4096, blocks: 1_000_000, bavail: 250_000 }
    }
    const places = [
      { path: '/', name: 'Macintosh HD', main: true },
      { path: '/Volumes/Stuck', name: 'Stuck' },
      { path: '/Volumes/Fine', name: 'Fine' }
    ]
    const pending = new Set<string>()
    let ticks = 0
    const timer = setInterval(() => (ticks += 1), 1)
    const started = performance.now()
    const first = await readVolumes(places, stuck, pending, 40)
    const took = performance.now() - started
    clearInterval(timer)
    assert.deepEqual(first.map((v) => v.name), ['Macintosh HD', 'Fine'])
    assert.ok(took < 1_000, `answered in ${took.toFixed(0)} ms`)
    assert.ok(ticks > 0, 'timers ran while it waited: the worker was not held')
    assert.deepEqual((await readVolumes(places, stuck, pending, 40)).map((v) => v.name), ['Macintosh HD', 'Fine'])
    assert.equal(asked.filter((p) => p === '/Volumes/Stuck').length, 1, 'asked once')
  })

  test('at most two reads are outstanding at once, stuck ones included, so Node’s file threads stay free', async () => {
    let outstanding = 0
    let most = 0
    const asked: string[] = []
    const stuck = async (path: string) => {
      asked.push(path)
      outstanding += 1
      most = Math.max(most, outstanding)
      return new Promise<null>(() => {})
    }
    const places = ['/', '/a', '/b', '/c', '/d'].map((path) => ({ path, name: path }))
    const pending = new Set<string>()
    assert.deepEqual(await readVolumes(places, stuck, pending, 20), [])
    assert.equal(most, 2)
    assert.deepEqual(await readVolumes(places, stuck, pending, 20), [])
    assert.deepEqual(asked, ['/', '/a'], 'nothing more is asked while two are stuck')
  })

  test('two slow disks never keep a healthy one from being read', async () => {
    const slowPaths = new Set(['/a', '/b'])
    const statfs = async (path: string) => {
      if (slowPaths.has(path)) await new Promise((resolve) => setTimeout(resolve, 30))
      return { bsize: 4096, blocks: 1_000, bavail: 500 }
    }
    const places = ['/a', '/b', '/c'].map((path) => ({ path, name: path }))
    const pending = new Set<string>()
    const slow = new Set<string>()
    const seen: string[][] = []
    for (let round = 0; round < 3; round += 1) {
      seen.push((await readVolumes(places, statfs, pending, 10, 2, slow)).map((v) => v.name))
      // The slow reads finish before the next reading.
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    assert.ok(seen.slice(1).every((names) => names.includes('/c')), JSON.stringify(seen))
  })

  test('a reading that could read none of the disks it listed keeps what it held of those still listed', async () => {
    let answer: 'ok' | 'stuck' = 'ok'
    let mounts = ['/dev/nvme0n1p2 / ext4 rw 0 0', '/dev/sdb1 /mnt/archive ext4 rw 0 0'].join('\n')
    let t = 0
    const reader = new LinuxSystemReader({
      readFile: async (path) => (path === '/proc/self/mounts' ? mounts : null),
      readDir: async () => null,
      mono: () => t,
      statfs: () => ({ bsize: 4096, blocks: 1_000_000, bavail: 500_000 }),
      statfsAsync: async () => (answer === 'ok' ? { bsize: 4096, blocks: 1_000_000, bavail: 500_000 } : null),
      platform: 'linux'
    })
    await reader.refresh()
    assert.deepEqual(reader.snapshot()?.disk?.volumes?.map((v) => v.name), ['/', '/mnt/archive'])
    answer = 'stuck'
    t = 61_000
    await reader.refresh()
    assert.deepEqual(reader.snapshot()?.disk?.volumes?.map((v) => v.name), ['/', '/mnt/archive'])
    // The archive taken out and another disk put in its place, which does not answer either.
    mounts = ['/dev/nvme0n1p2 / ext4 rw 0 0', '/dev/sdc1 /mnt/new ext4 rw 0 0'].join('\n')
    t = 122_000
    await reader.refresh()
    assert.deepEqual(reader.snapshot()?.disk?.volumes?.map((v) => v.name), ['/'], 'the archive goes at once')
  })
})

describe('Linux', () => {
  const mounts = [
    '/dev/nvme0n1p2 / ext4 rw,relatime 0 0',
    'proc /proc proc rw 0 0',
    'tmpfs /run tmpfs rw 0 0',
    '/dev/nvme0n1p1 /boot/efi vfat rw 0 0',
    '/dev/sda1 /mnt/big\\040disk xfs rw 0 0',
    '/dev/sdb1 /home btrfs rw,subvol=/@home 0 0',
    '/dev/sdb1 /srv btrfs rw,subvol=/@srv 0 0',
    '/dev/loop3 /snap/core/1 squashfs ro 0 0',
    'nas:/export /mnt/nfs nfs4 rw 0 0',
    'overlay /var/lib/docker/overlay2/x/merged overlay rw 0 0'
  ].join('\n')

  test('each local filesystem on a disk, once per device, named where it is mounted; / first', () => {
    assert.deepEqual(linuxVolumePlaces(mounts, '/'), [
      { path: '/', name: '/', main: true },
      { path: '/mnt/big disk', name: '/mnt/big disk' },
      { path: '/home', name: '/home' }
    ], 'no boot partition, snap, network share or second subvolume of one disk')
  })

  test('where / is a small image, the real disk under /sysroot is the main one', () => {
    const atomic = ['composefs / overlay ro 0 0', '/dev/vda4 /sysroot xfs ro 0 0', '/dev/vda4 /var xfs rw 0 0'].join('\n')
    assert.deepEqual(linuxVolumePlaces(atomic, '/sysroot'), [{ path: '/sysroot', name: '/sysroot', main: true }])
  })

  test('a disk a desktop mounts under /run/media is named by its label', () => {
    const desktop = ['/dev/nvme0n1p2 / ext4 rw 0 0', 'tmpfs /run/user/1000 tmpfs rw 0 0', '/dev/sdb1 /run/media/sam/USB\\040Stick exfat rw 0 0', '/dev/sdc1 /media/sam/Photos ext4 rw 0 0'].join('\n')
    assert.deepEqual(linuxVolumePlaces(desktop, '/'), [
      { path: '/', name: '/', main: true },
      { path: '/run/media/sam/USB Stick', name: 'USB Stick' },
      { path: '/media/sam/Photos', name: 'Photos' }
    ])
  })

  test('in a container, files bound in are not a disk, and its data mount is not taken for its start-up disk', () => {
    const docker = [
      'overlay / overlay rw,lowerdir=/var/lib/docker/overlay2/l/A 0 0',
      '/dev/sda1 /etc/resolv.conf ext4 rw 0 0',
      '/dev/sda1 /etc/hostname ext4 rw 0 0',
      '/dev/sda1 /etc/hosts ext4 rw 0 0',
      '/dev/sda1 /app/config.json ext4 rw 0 0',
      '/dev/sda1 /data ext4 rw 0 0'
    ].join('\n')
    // No main: the root is an overlay, so the panel shows the machine's own figures for it.
    assert.deepEqual(linuxVolumePlaces(docker, '/'), [{ path: '/data', name: '/data' }])
  })

  test('each ZFS pool is a disk, its datasets one space, marked with the pool; / on ZFS is the main one', () => {
    const zfs = ['rpool/ROOT/ubuntu / zfs rw 0 0', 'rpool/USERDATA/home /home zfs rw 0 0', 'backup /backup zfs rw 0 0', 'backup/daily /backup/daily zfs rw 0 0', '-o /x zfs rw 0 0', '/dev/sdc1 /archive xfs rw 0 0'].join('\n')
    assert.deepEqual(linuxVolumePlaces(zfs, '/'), [
      { path: '/', name: '/', main: true, pool: 'rpool' },
      { path: '/backup', name: '/backup', pool: 'backup' },
      { path: '/archive', name: '/archive' }
    ], 'and never a pool whose name would read as an option')
  })

  test('a pool’s space is the pool’s, from zfs list, never one dataset’s; with no answer from zfs, the pool is left out', async () => {
    assert.deepEqual([...parseZfsList('rpool\t900000000000\t100000000000\nWork Pool\t1\t1\n-bad\t1\t1\nbackup\tx\t1\n').entries()], [
      ['rpool', { used: 900e9, available: 100e9 }],
      ['Work Pool', { used: 1, available: 1 }]
    ], 'a pool may have a space in its name')
    const mounts = ['rpool/ROOT/ubuntu / zfs rw 0 0', 'rpool/data /data zfs rw 0 0', '/dev/sdc1 /archive xfs rw 0 0'].join('\n')
    const reader = (answer: string | null) => {
      const runs: string[][] = []
      const r = new LinuxSystemReader({
        readFile: async (path) => (path === '/proc/self/mounts' ? mounts : null),
        readDir: async () => null,
        exec: async (file, args) => {
          runs.push([file, ...args])
          return answer === null ? { error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }), stdout: '' } : { error: null, stdout: answer }
        },
        mono: () => 0,
        // One dataset alone: 10 GB of its own and 100 GB free, as statfs would say of it.
        statfs: () => ({ bsize: 4096, blocks: blocks(110 * GB) / 4096, bavail: blocks(100 * GB) / 4096 }),
        statfsAsync: async () => ({ bsize: 4096, blocks: 1_000_000, bavail: 500_000 }),
        platform: 'linux'
      })
      return { r, runs }
    }
    const ok = reader('rpool\t900000000000\t100000000000\n')
    await ok.r.refresh()
    assert.deepEqual(ok.r.snapshot()?.disk?.volumes?.[0], { name: '/', totalBytes: 1000e9, usedBytes: 900e9, main: true })
    assert.deepEqual(ok.runs[0], ['/usr/sbin/zfs', 'list', '-Hp', '-o', 'name,used,available', '-d', '0', 'rpool'])
    const none = reader(null)
    await none.r.refresh()
    assert.deepEqual(none.r.snapshot()?.disk?.volumes?.map((v) => v.name), ['/archive'])
  })

  test('the main disk is the one the machine’s own figures were read at; a disk at /var is not taken for an overlay root', () => {
    const container = ['overlay / overlay rw 0 0', '/dev/sdb1 /var ext4 rw 0 0'].join('\n')
    assert.deepEqual(linuxVolumePlaces(container, '/'), [{ path: '/var', name: '/var' }])
    assert.deepEqual(linuxVolumePlaces(container, '/var'), [{ path: '/var', name: '/var', main: true }], 'unless that is where they were read')
  })

  test('from mountinfo, a file bound in from a disk never names it, however short its path', () => {
    const info = [
      '22 1 0:21 / / rw - overlay overlay rw',
      '30 22 8:1 /srv/app/config.yaml /config.yaml rw - ext4 /dev/sda1 rw',
      '31 22 8:1 /srv/storage /mnt/storage rw - ext4 /dev/sda1 rw',
      '32 22 0:44 / /tank/media rw - zfs Work\\040Pool/media rw'
    ].join('\n')
    assert.deepEqual(linuxVolumePlaces(info, '/'), [
      { path: '/mnt/storage', name: '/mnt/storage' },
      { path: '/tank/media', name: '/tank/media', pool: 'Work Pool' }
    ])
  })

  test('a disk taken out goes from the list at the next reading', async () => {
    let mounts = ['/dev/nvme0n1p2 / ext4 rw 0 0', '/dev/sdb1 /data ext4 rw 0 0'].join('\n')
    let t = 0
    const reader = new LinuxSystemReader({
      readFile: async (path) => (path === '/proc/self/mounts' ? mounts : null),
      readDir: async () => null,
      mono: () => t,
      statfs: () => ({ bsize: 4096, blocks: 1_000_000, bavail: 500_000 }),
      statfsAsync: async () => ({ bsize: 4096, blocks: 1_000_000, bavail: 500_000 }),
      platform: 'linux'
    })
    await reader.refresh()
    assert.deepEqual(reader.snapshot()?.disk?.volumes?.map((v) => v.name), ['/', '/data'])
    mounts = '/dev/nvme0n1p2 / ext4 rw 0 0'
    t = 61_000
    await reader.refresh()
    assert.deepEqual(reader.snapshot()?.disk?.volumes?.map((v) => v.name), ['/'])
  })
})

describe('Windows', () => {
  test('each fixed drive, named as Explorer names it, the system drive first', () => {
    const answer = [
      { n: 'D:\\', l: 'Data', s: 2e12, f: 0.5e12 },
      { n: 'C:\\', l: '', s: 512e9, f: 100e9 },
      { n: 'E:\\', l: 'Bad\u0007Label', s: 1e12, f: 1e12 },
      { n: '\\\\nas\\share', l: 'x', s: 1, f: 0 },
      { n: 'F:\\', l: 'x', s: 100, f: 200 }
    ]
    assert.deepEqual(parseVolAnswer(answer, 'C:\\'), [
      { name: 'C:', totalBytes: 512e9, usedBytes: 412e9, main: true },
      { name: 'Data (D:)', totalBytes: 2e12, usedBytes: 1.5e12 },
      { name: 'Bad Label (E:)', totalBytes: 1e12, usedBytes: 0 }
    ])
    assert.deepEqual(parseVolAnswer('nonsense', 'C:\\'), [])
  })

  test('a volume mounted in a folder: by its label, else its folder; one with no place is left out', () => {
    const answer = [
      { n: 'C:\\', l: 'Windows', s: 512e9, f: 100e9 },
      { n: 'C:\\Mounts\\Games\\', l: 'Games', s: 2e12, f: 1e12 },
      { n: 'C:\\Mounts\\Scratch\\', l: '', s: 1e12, f: 0.9e12 },
      { n: '\\\\?\\Volume{0b6a3d5e-0000-0000-0000-100000000000}\\', l: 'Recovery', s: 1e9, f: 0.5e9 },
      { n: 'C:\\\u0007\\', l: '', s: 1e12, f: 0.9e12 }
    ]
    assert.deepEqual(parseVolAnswer(answer, 'C:\\').map((v) => v.name), ['Windows (C:)', 'Games', 'C:\\Mounts\\Scratch'])
  })

  test('the system drive is kept however many drives come before it', () => {
    const answer = [...'DEFGHIJKLM'].map((d) => ({ n: `${d}:\\`, l: '', s: 1e12, f: 0.5e12 })).concat({ n: 'C:\\', l: '', s: 512e9, f: 100e9 })
    const volumes = parseVolAnswer(answer, 'C:\\')
    assert.equal(volumes.length, MAX_VOLUMES)
    assert.deepEqual(volumes[0], { name: 'C:', totalBytes: 512e9, usedBytes: 412e9, main: true })
  })
})

describe('in a reading and a beacon', () => {
  const volumes = [
    { name: 'Macintosh HD', totalBytes: 994e9, usedBytes: 412e9, main: true },
    { name: 'My Backup', totalBytes: 2e12, usedBytes: 1.21e12 }
  ]

  test('a snapshot carries the volumes while they are young enough', () => {
    const held = { net: null, diskIo: null, space: null, volumes: { value: volumes, at: 0 }, gpu: null, battery: null }
    assert.deepEqual(systemSnapshot(held, 1_000).disk?.volumes, volumes)
    assert.equal(systemSnapshot(held, 10 * 60_000).disk, null, 'too old: none')
  })

  test('a beacon carries them, bounded; a row out of shape is left out', () => {
    const many = [...volumes, ...Array.from({ length: 10 }, (_, i) => ({ name: `Disk ${i}`, totalBytes: 1e12, usedBytes: 1e11 }))]
    const sample = localSample()
    const line = encodeBeacon({ ...sample, system: { net: null, disk: { totalBytes: 994e9, usedBytes: 412e9, readBytesPerSec: null, writeBytesPerSec: null, volumes: many }, gpu: null, battery: null } }, { run: 'r', seq: 1, intervalMs: 5_000 })!
    const back = decodeBeacon(line)!.system!.disk!.volumes!
    assert.equal(back.length, MAX_VOLUMES)
    assert.deepEqual(back.slice(0, 2), volumes)
    const wire = JSON.parse(line.slice(line.indexOf('{')))
    wire.dk.v.push(['', 1, 0, 0], ['x', -1, 0, 0], ['y', 10, 20, 0], [42, 10, 1, 0])
    wire.dk.v = wire.dk.v.slice(-4)
    assert.equal(decodeBeacon(line.slice(0, line.indexOf('{')) + JSON.stringify(wire))!.system!.disk!.volumes, undefined)
  })
})
