// The resident PowerShell (src/win-host.ts): what the script may never hold, and the host's life
// with a fake child process and a fake clock. The script itself runs only on Windows.
import { assert, describe, test } from 'orca/testing'
import {
  HOST_COMMANDS,
  HOST_FLAGS,
  HOST_GIVE_UP_MS,
  HOST_GIVE_UP_STARTS,
  HOST_STALL_LIMIT,
  HOST_LINE_MAX,
  HOST_QUEUE_MAX,
  HOST_RESTART_MAX_MS,
  HOST_SCRIPT,
  HOST_START_MS,
  PowerShellHost,
  powershellPath,
  type HostChild,
  type SpawnHost
} from '../src/win-host.ts'
import { FakeTime, flush } from './helpers.ts'

const ENV = { SystemRoot: 'C:\\Windows' }

describe('the script', () => {
  test('no double quote, no backtick, no $input, plain ASCII, and short enough for a command line', () => {
    assert.equal(HOST_SCRIPT.includes('"'), false, 'a double quote would have to survive Windows argument quoting')
    assert.equal(HOST_SCRIPT.includes('`'), false)
    assert.equal(/\$input\b/i.test(HOST_SCRIPT), false, 'PowerShell would read standard input itself')
    assert.equal(/^[\x20-\x7e\n]+$/.test(HOST_SCRIPT), true, 'nothing a code page could change, no tab, no carriage return')
    assert.equal(HOST_SCRIPT.endsWith('\\'), false, 'a last backslash would escape the closing quote')
    // Windows takes 32,767 characters for a whole command line.
    assert.ok(HOST_SCRIPT.length < 16_000, `${HOST_SCRIPT.length} characters`)
  })

  test('every command is there, and the counters by their English names', () => {
    for (const command of HOST_COMMANDS) assert.ok(HOST_SCRIPT.includes(`'${command}' { $r = `), command)
    for (const name of ['PhysicalDisk', 'Disk Read Bytes/sec', 'Disk Write Bytes/sec', 'GPU Engine', 'utilization percentage', 'Process', 'id process', 'creating process id', '% processor time', 'working set - private', 'elapsed time']) {
      assert.ok(HOST_SCRIPT.includes(`'${name}'`), name)
    }
    assert.ok(HOST_SCRIPT.includes('[Console]::In.ReadLine()'))
    assert.equal(/Get-Process|Get-WmiObject|Win32_Process|CommandLine|MainWindowTitle|\.Path\b/i.test(HOST_SCRIPT), false, 'nothing that reads a path, a command line or a title')
    // WMI is asked one thing, once: the names of the display adapters.
    assert.deepEqual(HOST_SCRIPT.match(/Get-CimInstance[^|\n]*/g), ['Get-CimInstance -ClassName Win32_VideoController -Property PNPDeviceID -OperationTimeoutSec 5 '])
  })

  test('the flags: the script as plain text, never encoded', () => {
    assert.deepEqual([...HOST_FLAGS], ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'])
    assert.equal(HOST_FLAGS.some((flag) => /^-e(nc|ncodedcommand)?$/i.test(flag)), false)
    // No script file is run, so the execution policy has nothing to say; asking to bypass it is
    // what security tools look for.
    assert.equal(HOST_FLAGS.some((flag) => /executionpolicy|bypass/i.test(flag)), false)
  })

  test('PowerShell by its full path under the Windows folder, whatever case the variable is in', () => {
    assert.equal(powershellPath({ SystemRoot: 'D:\\WinNT' }), 'D:\\WinNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    assert.equal(powershellPath({ SYSTEMROOT: 'C:\\Windows\\' }), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    assert.equal(powershellPath({ windir: 'E:\\W' }), 'E:\\W\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    const fallback = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    assert.equal(powershellPath({}), fallback)
    assert.equal(powershellPath({ SystemRoot: 'Windows' }), fallback, 'not a full path')
    assert.equal(powershellPath({ SystemRoot: '\\\\server\\share' }), fallback, 'not on a lettered drive')
    assert.equal(powershellPath({ SystemRoot: 'C:\\Win"dows' }), fallback)
  })
})

/** A fake powershell.exe: records each start and what is written to it, lets a test answer,
 *  end it, or break its pipe. */
function fakePowerShell() {
  const children: {
    file: string
    args: readonly string[]
    env: NodeJS.ProcessEnv
    written: string[]
    killed: string | null
    say(text: string | Buffer): void
    exit(): void
    fail(): void
    breakPipe(): void
  }[] = []
  const spawn: SpawnHost = (file, args, env) => {
    const listeners: Record<string, ((...a: unknown[]) => void)[]> = { data: [], exit: [], error: [], pipe: [] }
    const record = {
      file,
      args,
      env,
      written: [] as string[],
      killed: null as string | null,
      say: (text: string | Buffer) => listeners.data!.forEach((fn) => fn(text)),
      exit: () => {
        record.killed = 'exited'
        listeners.exit!.forEach((fn) => fn(1, null))
      },
      fail: () => listeners.error!.forEach((fn) => fn(new Error('spawn ENOENT'))),
      breakPipe: () => listeners.pipe!.forEach((fn) => fn(new Error('write EPIPE')))
    }
    children.push(record)
    const child: HostChild = {
      pid: 2000 + children.length,
      stdin: { write: (text) => record.written.push(text), on: (_e, fn) => listeners.pipe!.push(fn as (...a: unknown[]) => void) },
      stdout: { on: (_e, fn) => listeners.data!.push(fn as (...a: unknown[]) => void) },
      on: (event: string, fn: (...a: never[]) => void) => listeners[event]!.push(fn as (...a: unknown[]) => void),
      kill: (signal) => {
        record.killed = signal ?? 'SIGTERM'
        return true
      }
    } as HostChild
    return child
  }
  const running = () => children.filter((c) => c.killed === null)
  return { children, spawn, running }
}

function setup(platform = 'win32', env: NodeJS.ProcessEnv = ENV) {
  const time = new FakeTime()
  const ps = fakePowerShell()
  const host = new PowerShellHost({ spawn: ps.spawn, timers: time, platform, env, mono: () => time.now() })
  return { time, ps, host }
}

describe('the PowerShell host', () => {
  test('it starts with the first request, and each request is one line with its id', async () => {
    const { time, ps, host } = setup('win32', { windir: 'D:\\Win', PATH: 'C:\\somewhere' })
    assert.equal(ps.children.length, 0, 'nothing runs until asked')
    const net = host.request('net', 2_000)
    assert.equal(ps.children.length, 1)
    const child = ps.children[0]!
    assert.equal(child.file, 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    assert.deepEqual(child.args, [...HOST_FLAGS, HOST_SCRIPT])
    assert.deepEqual(child.env, { windir: 'D:\\Win', PATH: 'C:\\somewhere', SystemRoot: 'D:\\Win' }, 'PowerShell is given SystemRoot when the worker has none')
    assert.deepEqual(child.written, ['1 net\n'])
    child.say('1 {"n":"Ethernet","rx":5,"tx":6}\n')
    assert.deepEqual(await net, { n: 'Ethernet', rx: 5, tx: 6 })
    const disk = host.request('disk', 2_000)
    assert.deepEqual(child.written, ['1 net\n', '2 disk\n'])
    child.say('2 {"r":1,"w":2}\n')
    assert.deepEqual(await disk, { r: 1, w: 2 })
    assert.equal(ps.children.length, 1, 'the same process answers')
    assert.equal(host.running, true)
    assert.equal(time.pending, 0, 'no timer left behind an answer')
  })

  test('an environment that has SystemRoot is passed as it is', () => {
    const env = { SYSTEMROOT: 'C:\\Windows', TEMP: 'C:\\Temp' }
    const { ps, host } = setup('win32', env)
    void host.request('net', 2_000)
    assert.equal(ps.children[0]!.env, env)
    host.stop()
  })

  test('an answer in pieces: a byte order mark, a carriage return, a character cut in two', async () => {
    const { ps, host } = setup()
    const net = host.request('net', 2_000)
    const bytes = Buffer.from('\uFEFF1 {"n":"Réseau","rx":1,"tx":2}\r\n', 'utf8')
    const cut = bytes.indexOf(0xc3) + 1
    ps.children[0]!.say(bytes.subarray(0, cut))
    ps.children[0]!.say(bytes.subarray(cut, cut + 9))
    ps.children[0]!.say(bytes.subarray(cut + 9))
    assert.deepEqual(await net, { n: 'Réseau', rx: 1, tx: 2 })
    // Two answers in one piece, and a name holding a line separator JSON allows.
    const a = host.request('bat', 2_000)
    const b = host.request('proc', 2_000)
    await flush()
    ps.children[0]!.say('2 {"line":1}\n')
    ps.children[0]!.say('3 {"t":1,"p":[[4,0,"a\u2028b",1,2,3]]}\n4 never asked\n')
    assert.deepEqual(await a, { line: 1 })
    assert.deepEqual(await b, { t: 1, p: [[4, 0, 'a\u2028b', 1, 2, 3]] })
    host.stop()
  })

  test('one request at a time, in the order asked', async () => {
    const { ps, host } = setup()
    const asked = [host.request('net', 2_000), host.request('disk', 2_000), host.request('proc', 2_000)]
    const child = ps.children[0]!
    assert.deepEqual(child.written, ['1 net\n'], 'the others wait')
    child.say('1 1\n')
    assert.deepEqual(child.written, ['1 net\n', '2 disk\n'])
    child.say('2 2\n')
    child.say('3 3\n')
    assert.deepEqual(await Promise.all(asked), [1, 2, 3])
    assert.deepEqual(child.written, ['1 net\n', '2 disk\n', '3 proc\n'])
    host.stop()
  })

  test('the time a request waits its turn does not count towards its timeout', async () => {
    const { time, ps, host } = setup()
    const first = host.request('net', 5_000)
    ps.children[0]!.say('1 1\n')
    await first
    const slow = host.request('proc', 5_000)
    const behind = host.request('net', 1_000)
    time.advance(4_000)
    assert.equal(ps.children[0]!.killed, null, 'the one behind has not been asked yet')
    ps.children[0]!.say('2 2\n')
    time.advance(999)
    ps.children[0]!.say('3 3\n')
    assert.deepEqual([await slow, await behind], [2, 3])
    host.stop()
  })

  test('a line that is not the answer waited for is dropped; null and broken JSON are null', async () => {
    const { ps, host } = setup()
    const child = () => ps.children[0]!
    const net = host.request('net', 2_000)
    child().say('WARNING: something PowerShell printed by itself\n')
    child().say('7 {"n":"other"}\n')
    child().say('1\n')
    child().say('\n')
    child().say('1 {"n":"mine"}\n')
    assert.deepEqual(await net, { n: 'mine' })
    child().say('1 {"n":"again"}\n')
    const gpu = host.request('gpu', 2_000)
    child().say('2 null\n')
    assert.equal(await gpu, null, 'the read failed')
    const bat = host.request('bat', 2_000)
    child().say('3 {"line":\n')
    assert.equal(await bat, null, 'not JSON')
    assert.equal(child().killed, null, 'it answered, so it stays')
    const disk = host.request('disk', 2_000)
    child().say('4 {"r":1,"w":2}\n')
    assert.deepEqual(await disk, { r: 1, w: 2 })
    host.stop()
  })

  test('no answer in time kills it; a late answer is ignored; it starts again after a pause', async () => {
    const { time, ps, host } = setup()
    const first = host.request('net', 2_000)
    ps.children[0]!.say('1 {"ok":1}\n')
    await first
    const slow = host.request('disk', 2_000)
    const behind = host.request('gpu', 2_000)
    time.advance(1_999)
    assert.equal(ps.children[0]!.killed, null)
    time.advance(1)
    assert.equal(ps.children[0]!.killed, 'SIGKILL')
    assert.equal(host.running, false)
    assert.deepEqual([await slow, await behind], [null, null], 'everything waiting is answered')
    ps.children[0]!.say('2 {"r":1,"w":2}\n')
    // During the pause nothing is started, and nothing waits.
    assert.equal(await host.request('net', 2_000), null)
    time.advance(4_999)
    assert.equal(await host.request('net', 2_000), null)
    assert.equal(ps.children.length, 1)
    time.advance(1)
    const again = host.request('net', 2_000)
    assert.equal(ps.children.length, 2, 'a new process after 5 s')
    assert.deepEqual(ps.children[1]!.written, ['3 net\n'], 'ids go on, so an old answer can never fit')
    ps.children[0]!.say('3 {"from":"the dead one"}\n')
    ps.children[1]!.say('2 {"r":1,"w":2}\n')
    ps.children[1]!.say('3 {"n":"new"}\n')
    assert.deepEqual(await again, { n: 'new' })
    host.stop()
    assert.equal(ps.running().length, 0)
  })

  test('a new process gets longer for its first answer, because PowerShell has to start', async () => {
    const { time, ps, host } = setup()
    const first = host.request('net', 2_000)
    time.advance(2_000 + HOST_START_MS - 1)
    assert.equal(ps.children[0]!.killed, null)
    time.advance(1)
    assert.equal(ps.children[0]!.killed, 'SIGKILL')
    assert.equal(await first, null)
  })

  test('the pause doubles with each failure, an answer or not, and starts over only after a process that lasted', async () => {
    const { time, ps, host } = setup()
    /** Starts a process, has it answer one request, then ends it `after` ms later. */
    const answerThenEnd = async (after: number): Promise<void> => {
      const asked = host.request('net', 1_000)
      const child = ps.children.at(-1)!
      child.say(`${child.written.at(-1)!.split(' ')[0]} 1\n`)
      assert.equal(await asked, 1)
      time.advance(after)
      child.exit()
    }
    await answerThenEnd(1_000)
    time.advance(4_999)
    assert.equal(await host.request('net', 1_000), null, 'the first pause is 5 s')
    time.advance(1)
    // It answered again, and stalled again: the pause still doubles (it did not start over).
    await answerThenEnd(1_000)
    assert.equal(ps.children.length, 2)
    time.advance(9_999)
    assert.equal(await host.request('net', 1_000), null, 'the second pause is 10 s, though the process answered')
    time.advance(1)
    await answerThenEnd(1_000)
    time.advance(19_999)
    assert.equal(await host.request('net', 1_000), null, 'the third is 20 s')
    time.advance(1)
    // One that lasted five minutes was a working PowerShell: 5 s again after it.
    await answerThenEnd(HOST_RESTART_MAX_MS)
    time.advance(4_999)
    assert.equal(await host.request('net', 1_000), null)
    time.advance(1)
    void host.request('net', 1_000)
    assert.equal(ps.children.length, 5)
    assert.equal(host.unavailable, false)
    host.stop()
  })

  test('the pause never passes five minutes while PowerShell answers at all', async () => {
    const { time, ps, host } = setup()
    for (let i = 0; i < 12; i += 1) {
      const asked = host.request('net', 1_000)
      const child = ps.children.at(-1)!
      child.say(`${child.written.at(-1)!.split(' ')[0]} 1\n`)
      await asked
      child.exit()
      time.advance(HOST_RESTART_MAX_MS)
    }
    assert.equal(ps.children.length, 12, 'one start for each pause that ended')
    void host.request('net', 1_000)
    ps.children.at(-1)!.exit()
    time.advance(HOST_RESTART_MAX_MS - 1)
    assert.equal(await host.request('net', 1_000), null)
    time.advance(1)
    void host.request('net', 1_000)
    assert.equal(ps.children.length, 14)
    host.stop()
  })

  test('five in a row that never answer: PowerShell is unusable here, and is tried once an hour', async () => {
    const { time, ps, host } = setup()
    for (let i = 0; i < HOST_GIVE_UP_STARTS; i += 1) {
      assert.equal(host.unavailable, false)
      void host.request('net', 1_000)
      ps.children.at(-1)!.exit()
      if (i < HOST_GIVE_UP_STARTS - 1) time.advance(HOST_RESTART_MAX_MS)
    }
    assert.equal(ps.children.length, HOST_GIVE_UP_STARTS)
    assert.equal(host.unavailable, true)
    time.advance(HOST_GIVE_UP_MS - 1)
    assert.equal(await host.request('net', 1_000), null)
    assert.equal(ps.children.length, HOST_GIVE_UP_STARTS, 'nothing is started for an hour')
    time.advance(1)
    const asked = host.request('net', 1_000)
    assert.equal(ps.children.length, HOST_GIVE_UP_STARTS + 1)
    // The day it answers, it is usable again.
    const child = ps.children.at(-1)!
    child.say(`${child.written.at(-1)!.split(' ')[0]} 1\n`)
    assert.equal(await asked, 1)
    assert.equal(host.unavailable, false)
    host.stop()
  })

  test('a command that stalls three times in a row on a working PowerShell is left alone for an hour', async () => {
    const { time, ps, host } = setup()
    /** One round: `net` is answered, then `gpu` gets no answer and its time runs out. */
    const round = async (): Promise<void> => {
      const net = host.request('net', 1_000)
      const child = ps.children.at(-1)!
      child.say(`${child.written.at(-1)!.split(' ')[0]} 1\n`)
      assert.equal(await net, 1)
      const gpu = host.request('gpu', 1_000)
      time.advance(1_000)
      assert.equal(await gpu, null)
      time.advance(HOST_RESTART_MAX_MS)
    }
    for (let i = 0; i < HOST_STALL_LIMIT; i += 1) await round()
    assert.equal(ps.children.length, HOST_STALL_LIMIT)
    // Now `gpu` is answered null without being asked, and nothing is started for it.
    assert.equal(await host.request('gpu', 1_000), null)
    assert.equal(ps.children.length, HOST_STALL_LIMIT)
    // The others go on working.
    const net = host.request('net', 1_000)
    const child = ps.children.at(-1)!
    child.say(`${child.written.at(-1)!.split(' ')[0]} 7\n`)
    assert.equal(await net, 7)
    assert.equal(child.written.some((line) => line.endsWith(' gpu\n')), false, 'this PowerShell was never asked for it')
    assert.equal(host.unavailable, false, 'one slow command is not "PowerShell cannot run"')
    // After its hour, it is asked once more.
    time.advance(HOST_GIVE_UP_MS)
    const again = host.request('gpu', 1_000)
    child.say(`${child.written.at(-1)!.split(' ')[0]} 9\n`)
    assert.equal(await again, 9)
    host.stop()
  })

  test('a PowerShell that is only slow to start is not taken for one that cannot run', async () => {
    const { time, ps, host } = setup()
    for (let i = 0; i < HOST_GIVE_UP_STARTS + 2; i += 1) {
      const asked = host.request('net', 1_000)
      time.advance(1_000 + HOST_START_MS)
      assert.equal(await asked, null, 'its first answer did not come in time')
      time.advance(HOST_RESTART_MAX_MS)
    }
    assert.equal(ps.children.length, HOST_GIVE_UP_STARTS + 2, 'still tried every pause')
    assert.equal(host.unavailable, false)
    // And a slow start is not held against the command that happened to be first.
    const net = host.request('net', 1_000)
    const child = ps.children.at(-1)!
    child.say(`${child.written.at(-1)!.split(' ')[0]} 1\n`)
    assert.equal(await net, 1)
    host.stop()
  })

  test('ask() says whether PowerShell answered at all', async () => {
    const { time, ps, host } = setup()
    const first = host.ask('proc', 1_000)
    const child = ps.children[0]!
    child.say(`${child.written.at(-1)!.split(' ')[0]} null\n`)
    assert.deepEqual(await first, { answered: true, value: null }, 'answered, with no reading: the handler failed')
    const lost = host.ask('proc', 1_000)
    child.exit()
    assert.deepEqual(await lost, { answered: false, value: null }, 'the process went before it answered')
    assert.deepEqual(await host.ask('proc', 1_000), { answered: false, value: null }, 'pausing before a restart: nothing was asked')
    assert.deepEqual(await host.ask('no such command!', 1_000), { answered: false, value: null })
    time.advance(HOST_RESTART_MAX_MS)
    host.stop()
    assert.deepEqual(await host.ask('proc', 1_000), { answered: false, value: null }, 'stopped')
  })

  test('when it ends by itself, cannot start, or its pipe breaks, what waits is answered null', async () => {
    const { time, ps, host } = setup()
    const a = host.request('net', 2_000)
    const b = host.request('disk', 2_000)
    ps.children[0]!.exit()
    assert.deepEqual([await a, await b], [null, null])
    assert.equal(time.pending, 1, 'only the pause is left')
    time.advance(5_000)
    const c = host.request('net', 2_000)
    ps.children[1]!.fail()
    assert.equal(await c, null)
    time.advance(10_000)
    const d = host.request('net', 2_000)
    ps.children[2]!.breakPipe()
    assert.equal(await d, null)
    assert.equal(ps.children[2]!.killed, 'SIGKILL', 'a process that cannot be written to is no use')
    host.stop()
  })

  test('a spawn that throws, or gives no pipes, is tried again later', async () => {
    const time = new FakeTime()
    let tries = 0
    const host = new PowerShellHost({ spawn: () => { tries += 1; throw new Error('spawn EAGAIN') }, timers: time, platform: 'win32', env: ENV })
    assert.equal(await host.request('net', 2_000), null)
    assert.equal(await host.request('net', 2_000), null)
    assert.equal(tries, 1, 'not again during the pause')
    time.advance(5_000)
    assert.equal(await host.request('net', 2_000), null)
    assert.equal(tries, 2)
    host.stop()
    let killed = 0
    const bare = new PowerShellHost({ spawn: () => ({ stdin: null, stdout: null, on: () => undefined, kill: () => { killed += 1; return true } }), timers: new FakeTime(), platform: 'win32', env: ENV })
    assert.equal(await bare.request('net', 2_000), null)
    assert.equal(killed, 1)
  })

  test('a line too long ends it', async () => {
    const { time, ps, host } = setup()
    const first = host.request('proc', 2_000)
    ps.children[0]!.say(`1 "${'x'.repeat(HOST_LINE_MAX)}`)
    assert.equal(ps.children[0]!.killed, 'SIGKILL')
    assert.equal(await first, null)
    time.advance(5_000)
    // Whole, newline and all, in one piece.
    const second = host.request('proc', 2_000)
    ps.children[1]!.say(`2 "${'x'.repeat(HOST_LINE_MAX)}"\n`)
    assert.equal(ps.children[1]!.killed, 'SIGKILL')
    assert.equal(await second, null)
    host.stop()
  })

  test('stop kills it for good and answers what waits', async () => {
    const { time, ps, host } = setup()
    const a = host.request('net', 2_000)
    const b = host.request('proc', 2_000)
    host.stop()
    assert.equal(ps.children[0]!.killed, 'SIGKILL')
    assert.deepEqual([await a, await b], [null, null])
    assert.equal(time.pending, 0, 'no timer left')
    time.advance(HOST_RESTART_MAX_MS)
    assert.equal(await host.request('net', 2_000), null)
    assert.equal(ps.children.length, 1, 'nothing starts after stop')
    // Stopped during a pause: the pause's timer goes too.
    const other = setup()
    void other.host.request('net', 2_000)
    other.ps.children[0]!.exit()
    other.host.stop()
    assert.equal(other.time.pending, 0)
    other.host.stop()
  })

  test('on anything but Windows nothing is started; nor for a command that is not one plain word', async () => {
    for (const platform of ['darwin', 'linux']) {
      const { ps, host } = setup(platform)
      assert.equal(await host.request('net', 2_000), null)
      assert.equal(ps.children.length, 0)
      host.stop()
    }
    const { ps, host } = setup()
    for (const command of ['', 'NET', 'net disk', 'net\n2 proc', 'x'.repeat(17), 'gpu;']) assert.equal(await host.request(command, 2_000), null, JSON.stringify(command))
    for (const timeout of [0, -1, Number.NaN]) assert.equal(await host.request('net', timeout), null)
    assert.equal(ps.children.length, 0)
  })

  test('only so many requests may wait', async () => {
    const { ps, host } = setup()
    let answeredNull = 0
    const asked = Array.from({ length: HOST_QUEUE_MAX + 8 }, () => host.request('net', 2_000).then((value) => (value === null ? (answeredNull += 1) : 0)))
    await flush()
    assert.equal(answeredNull, 7, 'one is being answered, the queue is full, the rest are turned away')
    assert.deepEqual(ps.children[0]!.written, ['1 net\n'])
    host.stop()
    await Promise.all(asked)
    assert.equal(answeredNull, HOST_QUEUE_MAX + 8)
  })
})
