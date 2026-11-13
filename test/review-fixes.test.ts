// Fixes from the 1.2 data-layer review, each with a test that the code before it failed. Every
// value here is invented.
import { assert, describe, test } from 'orca/testing'
import { createRunBounded, runBounded, type ExecFile } from '../src/mac-memory.ts'
import { MacSystemReader, systemRunBounded } from '../src/mac-system.ts'
import type { MacSystem } from '../src/model.ts'
import { localAnswer } from '../src/process-answer.ts'
import { decodeProcessLine, encodeProcessLine, PROCESS_INTERVAL_MS, PROCESS_PREFIX } from '../src/process-line.ts'
import { processRunBounded, ProcessSampler, PS_ARGS, PS_ENV, TopStream, type SpawnTop, type TopChild } from '../src/processes.ts'
import { LocalSampler, SYSTEM_WAIT_MS, type OsSource } from '../src/sampler.ts'
import { FakeTime, flush } from './helpers.ts'

const SECRET = 'INVENTED_SECRET_12'
const line = (pid: number, name: string) => `${String(pid).padStart(5)}     1   501 example         0:01.00 Thu Nov 12 09:30:05 2026     ${name}`

/** A fake `ps` that answers what was asked for: process titles that carry arguments, tokens and
 *  paths for `comm`, and the kernel's short names for `ucomm`. */
const fakePs: ExecFile = async (_file, args) => {
  const columns = args[2] ?? ''
  const long = [`npm exec some-mcp --api-token=${SECRET}`, `/Users/someone/bin/tool --password ${SECRET}`, `node https://example.invalid/?key=${SECRET}`]
  const short = ['npm', 'tool', 'node']
  const names = columns.includes('ucomm=') ? short : long
  return { error: null, stdout: names.map((n, i) => line(100 + i, n)).join('\n') }
}
const quietTop: SpawnTop = () => ({ stdout: { on: () => {} }, on: () => {}, kill: () => true }) as unknown as TopChild

describe('1. names never carry arguments, tokens or paths', () => {
  test('ps is asked for the kernel short name (ucomm), never comm', () => {
    assert.ok(PS_ARGS.join(' ').includes('ucomm='))
    assert.ok(!/(^|,)comm=/.test(PS_ARGS[2]!))
  })

  test('not in the local answer, and not in the published line', async () => {
    const time = new FakeTime()
    const sampler = new ProcessSampler({ exec: fakePs, spawnTop: quietTop, timers: time, mono: time.now, wall: time.now, platform: 'darwin' })
    const table = await sampler.publishTable()
    assert.deepEqual(table!.rows.map((r) => r.name), ['npm', 'tool', 'node'])
    const published = encodeProcessLine(table!, { run: 'r', seq: 1, intervalMs: PROCESS_INTERVAL_MS })!
    const answered = JSON.stringify(localAnswer('local', table, 1, 1))
    for (const text of [published, answered]) {
      assert.ok(!text.includes(SECRET), 'no token')
      assert.ok(!text.includes('--'), 'no flags')
      assert.ok(!text.includes('/Users/'), 'no paths')
    }
    sampler.stop()
  })
})

describe('2. the optional readers have their own bounded runners', () => {
  test('separate from the memory reads\' runner, and from each other', () => {
    assert.notEqual(systemRunBounded, runBounded)
    assert.notEqual(processRunBounded, runBounded)
    assert.notEqual(processRunBounded, systemRunBounded)
  })

  test('children stuck in one runner never stop another from starting', async () => {
    let spawned = 0
    const stuck = (() => {
      spawned += 1
      return { exitCode: null, signalCode: null, kill: () => true, once: () => undefined }
    }) as never
    const optional = createRunBounded(stuck)
    const memory = createRunBounded(stuck)
    await Promise.all([1, 2, 3, 4].map(() => optional('/sbin/route', [], { timeout: 1, maxBuffer: 1 })))
    const refused = await optional('/usr/sbin/ioreg', [], { timeout: 1, maxBuffer: 1 })
    assert.equal(refused.error?.code, 'EBUSY', 'four stuck: no fifth')
    const before = spawned
    await memory('/usr/bin/vm_stat', [], { timeout: 1, maxBuffer: 1 })
    assert.equal(spawned, before + 1, 'the memory read still started')
  })
})

describe('3. the memory reading and the beacon wait a quarter of a second at most for the optional reads', () => {
  const system: MacSystem = { net: null, disk: null, gpu: { percent: 3 }, battery: null }
  const os: OsSource = { cpus: () => [], totalmem: () => 2 ** 34, freemem: () => 2 ** 33, loadavg: () => [0, 0, 0], uptime: () => 1, hostname: () => 'h', platform: () => 'darwin', arch: () => 'arm64', release: () => '25', now: () => 1 }
  const memory = { read: async () => null }

  test('prepare() gives network, disk, GPU and battery SYSTEM_WAIT_MS, then settles without them', async () => {
    const time = new FakeTime()
    const sampler = new LocalSampler(os, memory, time.now, time, { refresh: () => new Promise<void>(() => {}), snapshot: () => system })
    let settled = false
    void sampler.prepare().then(() => (settled = true))
    await flush()
    assert.equal(settled, false, 'the reads may still make this sample')
    time.advance(SYSTEM_WAIT_MS - 1)
    await flush()
    assert.equal(settled, false)
    time.advance(1)
    await flush()
    assert.equal(settled, true, 'not held for the hung system read past that (nor for memory\'s 2.75 s deadline)')
    assert.deepEqual(sampler.sample().system, system, 'what it last read rides on the sample')
  })

  test('reads that answer in time are on this sample, not the next', async () => {
    const time = new FakeTime()
    let read: MacSystem | null = null
    const reader = {
      refresh: async () => {
        read = system
      },
      snapshot: () => read
    }
    const sampler = new LocalSampler(os, memory, time.now, time, reader)
    await sampler.prepare()
    assert.deepEqual(sampler.sample().system, system)
    // No timer is left behind once the reads have answered.
    let late = false
    void sampler.prepare().then(() => (late = true))
    await flush()
    assert.equal(late, true)
  })

  test('a reader that throws holds nothing up', async () => {
    const time = new FakeTime()
    const sampler = new LocalSampler(os, null, time.now, time, {
      refresh: () => {
        throw new Error('boom')
      },
      snapshot: () => null
    })
    await sampler.prepare()
    assert.equal(sampler.sample().system, undefined)
  })
})

describe('4. footprints from before a pause are not shown as current', () => {
  test('a stopped stream forgets its sample', () => {
    const time = new FakeTime()
    let write: ((t: string) => void) | null = null
    const spawnTop: SpawnTop = () => ({ stdout: { on: (_e: string, fn: (t: string) => void) => (write = fn) }, on: () => {}, kill: () => true }) as unknown as TopChild
    const stream = new TopStream(120, { spawnTop, timers: time, mono: time.now, wall: time.now })
    stream.start()
    write!('Processes: 1 total\n\nPID    MEM    POWER\n10     5M     0.0\n')
    time.advance(200)
    assert.ok(stream.latest())
    stream.stop()
    assert.equal(stream.latest(), null)
    stream.start()
    assert.equal(stream.latest(), null, 'until the new stream\'s first sample, none')
    stream.stop()
  })
})

describe('5. ps runs in UTF-8 and UTC', () => {
  test('its environment', async () => {
    const seen: (Record<string, string> | undefined)[] = []
    const exec: ExecFile = async (file, args, options) => {
      seen.push(options.env)
      return fakePs(file, args, options)
    }
    const time = new FakeTime()
    const sampler = new ProcessSampler({ exec, spawnTop: quietTop, timers: time, mono: time.now, wall: time.now, platform: 'darwin' })
    await sampler.publishTable()
    assert.deepEqual(seen[0], { LC_CTYPE: 'UTF-8', TZ: 'UTC' })
    assert.deepEqual({ ...PS_ENV }, { LC_CTYPE: 'UTF-8', TZ: 'UTC' })
    sampler.stop()
  })
})

describe('8. a hostile time on a process line', () => {
  const wire = (t: unknown) => PROCESS_PREFIX + JSON.stringify({ v: 1, r: 'r', q: 1, t, iv: 30_000, n: 1, u: [], p: [] })
  test('is refused, not carried', () => {
    for (const t of [-1e300, 1e300, -1, 2e13]) assert.equal(decodeProcessLine(wire(t)), null, String(t))
    assert.ok(decodeProcessLine(wire(1_800_000_000_000)))
  })
})

describe('10. what the review\'s mutations showed untested', () => {
  test('the publish beat never starts the fast stream', async () => {
    const time = new FakeTime()
    const started: string[] = []
    const spawnTop: SpawnTop = (_f, args) => {
      started.push(String(args[3]))
      return { stdout: { on: () => {} }, on: () => {}, kill: () => true } as unknown as TopChild
    }
    const sampler = new ProcessSampler({ exec: fakePs, spawnTop, timers: time, mono: time.now, wall: time.now, platform: 'darwin' })
    sampler.setPublishing(true)
    await sampler.publishTable()
    time.advance(3_000)
    await sampler.publishTable()
    assert.deepEqual(started, ['120'], 'only the slow stream')
    assert.equal(sampler.fast.active, false)
    sampler.stop()
  })

  test('user names from a hostile line are cleaned', () => {
    const wire = PROCESS_PREFIX + JSON.stringify({ v: 1, r: 'r', q: 1, t: 1_800_000_000_000, iv: 30_000, n: 2, u: ['ro‮ot\u0007', 'x'.repeat(200)], p: [[5, 1, 0, 'a', 0, 0, 0, 0], [6, 1, 1, 'b', 0, 0, 0, 0], [7, 1, 9, 'c', 0, 0, 0, 0]] })
    const rows = decodeProcessLine(wire)!.rows
    assert.deepEqual(rows.map((r) => r.user), ['ro�ot', 'x'.repeat(32), null])
  })

  test('answers pass through plainJson: nothing but plain data leaves', () => {
    const odd = { pid: 5, ppid: 1, name: 'n', user: (() => 'x') as unknown as string, cpu: Number.NaN, mem: 7, energy: null, start: 1 }
    const answer = localAnswer('local', { takenAt: 1, rows: [odd], cpuWindowMs: null, memAgeMs: null, energyWindowMs: null, total: 1 }, 1, 1)
    assert.deepEqual([answer.columns.user[0], answer.columns.cpu[0], answer.columns.mem[0]], [null, null, 7])
  })

  test('a disk whose counters reset counts nothing for that reading, never less than nothing', async () => {
    let disks = [{ id: '0xa', read: 9_000_000, write: 9_000_000 }, { id: '0xb', read: 0, write: 0 }]
    let t = 0
    const exec: ExecFile = async (file, args) => {
      if (file.endsWith('route')) return { error: null, stdout: '  interface: en0\n' }
      if (file.endsWith('ioreg') && args.includes('IOBlockStorageDriver')) return { error: null, stdout: disks.map((d) => `+-o IOBlockStorageDriver  <class IOBlockStorageDriver, id ${d.id}, registered>\n      "Statistics" = {"Bytes (Read)"=${d.read},"Bytes (Write)"=${d.write}}`).join('\n') }
      return { error: null, stdout: '' }
    }
    const reader = new MacSystemReader({ exec, mono: () => t, statfs: () => null, platform: 'darwin' })
    await reader.refresh()
    t = 20_000
    disks = [{ id: '0xa', read: 1_000, write: 500 }, { id: '0xb', read: 200_000, write: 0 }]
    await reader.refresh()
    const disk = reader.snapshot()!.disk!
    assert.deepEqual([disk.readBytesPerSec, disk.writeBytesPerSec], [10_000, 0], 'the reset disk adds nothing; the other its own')
  })
})
