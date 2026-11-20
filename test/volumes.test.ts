// Every local volume (1.4): how each platform lists them, how a beacon carries them, and how the
// Activity tab shows them. Every value is invented.
import { assert, describe, test } from 'orca/testing'
import { decodeBeacon, encodeBeacon } from '../src/beacon.ts'
import { linuxVolumePlaces } from '../src/linux-system.ts'
import { macMainVolumeName, macVolumePlaces, MAX_VOLUMES, parseMacMounts, readVolumes, systemSnapshot } from '../src/mac-system.ts'
import { parseVolAnswer } from '../src/win-system.ts'
import { localSample } from './helpers.ts'

const statfs = (sizes: Record<string, [number, number]>) => (path: string) => {
  const s = sizes[path]
  return s ? { bsize: 4096, blocks: s[0] / 4096, bavail: (s[0] - s[1]) / 4096 } : null
}

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

  test('the start-up disk is named as Finder names it: the entry in /Volumes that links to /', () => {
    const links: Record<string, string> = { '/Volumes/Work SSD': '/' }
    assert.equal(macMainVolumeName(() => ['My Backup', 'Work SSD'], (p) => {
      if (!(p in links)) throw new Error('not a link')
      return links[p]!
    }), 'Work SSD')
    assert.equal(macMainVolumeName(() => { throw new Error('no /Volumes') }), null)
    assert.equal(macVolumePlaces(parseMacMounts(mount), null)[0]?.name, 'Macintosh HD', 'and Macintosh HD when it cannot be told')
  })

  test('each place read with statfs; one that cannot be read is left out', () => {
    const places = macVolumePlaces(parseMacMounts(mount), 'Macintosh HD')
    assert.deepEqual(readVolumes(places, statfs({ '/System/Volumes/Data': [994e9 - (994e9 % 4096), 412e9 - (412e9 % 4096)] })).map((v) => v.name), ['Macintosh HD'])
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
    assert.deepEqual(linuxVolumePlaces(mounts), [
      { path: '/', name: '/', main: true },
      { path: '/mnt/big disk', name: '/mnt/big disk' },
      { path: '/home', name: '/home' }
    ], 'no boot partition, snap, network share or second subvolume of one disk')
  })

  test('where / is a small image, the real disk under /sysroot is the main one', () => {
    const atomic = ['composefs / overlay ro 0 0', '/dev/vda4 /sysroot xfs ro 0 0', '/dev/vda4 /var xfs rw 0 0'].join('\n')
    assert.deepEqual(linuxVolumePlaces(atomic), [{ path: '/sysroot', name: '/sysroot', main: true }])
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
