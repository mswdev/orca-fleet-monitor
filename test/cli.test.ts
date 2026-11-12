import { assert, describe, test } from 'orca/testing'
import { appDataFromPluginFile, cliCandidates, cliProcessEnv, createProcessRunner, resolveCli } from '../src/cli.ts'

// Invented install locations; nothing here is read from this machine.
describe('cliCandidates', () => {
  test('macOS: setting, then the launcher beside Orca\'s resources, then PATH and defaults', () => {
    const list = cliCandidates({
      platform: 'darwin',
      override: ' /opt/custom/orca ',
      resourcesPath: '/Apps/Orca.app/Contents/Resources',
      execPath: '/Apps/Orca.app/Contents/MacOS/Orca',
      entryScript: '/Apps/Orca.app/Contents/Resources/app.asar.unpacked/out/main/plugin-host-entry.js',
      home: '/home/tester',
      pathEnv: '/usr/bin:relative/bin::/opt/bin'
    })
    assert.deepEqual(list.slice(0, 5), [
      { path: '/opt/custom/orca', source: 'setting' },
      { path: '/Apps/Orca.app/Contents/Resources/bin/orca', source: 'bundled' },
      { path: '/home/tester/.orca/cli/bin/orca', source: 'server launcher' },
      { path: '/usr/bin/orca', source: 'PATH' },
      { path: '/opt/bin/orca', source: 'PATH' }
    ])
    assert.ok(list.some((c) => c.path === '/Applications/Orca.app/Contents/Resources/bin/orca'))
    assert.ok(!list.some((c) => c.path.startsWith('relative')))
  })

  test('macOS without resourcesPath falls back to the exec path and the worker entry', () => {
    const fromExec = cliCandidates({ platform: 'darwin', execPath: '/Apps/Orca.app/Contents/MacOS/Orca' })
    assert.deepEqual(fromExec[0], { path: '/Apps/Orca.app/Contents/Resources/bin/orca', source: 'bundled (exec path)' })
    const fromEntry = cliCandidates({ platform: 'darwin', entryScript: '/X/Orca.app/Contents/Resources/app.asar.unpacked/plugin-host-entry.js' })
    assert.deepEqual(fromEntry[0], { path: '/X/Orca.app/Contents/Resources/bin/orca', source: 'bundled (worker entry)' })
    // A bare Node binary is not inside an app bundle: no bundled guess.
    assert.ok(!cliCandidates({ platform: 'darwin', execPath: '/usr/local/bin/node' }).some((c) => c.source.startsWith('bundled')))
  })

  test('Linux: orca-ide first (GNOME owns `orca`), resources next to the binary', () => {
    const list = cliCandidates({ platform: 'linux', execPath: '/opt/Orca/orca', home: '/home/tester', pathEnv: '/usr/local/bin' })
    assert.deepEqual(list.slice(0, 2), [
      { path: '/opt/Orca/resources/bin/orca-ide', source: 'bundled (exec path)' },
      { path: '/opt/Orca/resources/bin/orca', source: 'bundled (exec path)' }
    ])
    assert.ok(list.some((c) => c.path === '/home/tester/.orca/cli/bin/orca'))
    assert.ok(list.some((c) => c.path === '/usr/local/bin/orca-ide'))
  })

  test('Linux: never a plain `orca` from PATH, which is usually GNOME\'s screen reader', () => {
    const list = cliCandidates({ platform: 'linux', home: '/home/tester', pathEnv: '/usr/bin:/usr/local/bin' })
    assert.ok(!list.some((c) => c.source === 'PATH' && c.path.endsWith('/orca')), JSON.stringify(list))
    assert.deepEqual(list.filter((c) => c.source === 'PATH').map((c) => c.path), ['/usr/bin/orca-ide', '/usr/local/bin/orca-ide'])
    const r = resolveCli({ platform: 'linux', pathEnv: '/usr/bin' }, (file) => file === '/usr/bin/orca')
    assert.equal(r.path, null, 'the screen reader is not taken for Orca')
  })


  test('Windows: orca.exe only, never orca.cmd, with Windows paths', () => {
    const list = cliCandidates({
      platform: 'win32',
      resourcesPath: 'C:\\Programs\\Orca\\resources',
      execPath: 'C:\\Programs\\Orca\\Orca.exe',
      home: 'C:\\Users\\tester',
      pathEnv: 'C:\\Tools;relative'
    })
    assert.deepEqual(list[0], { path: 'C:\\Programs\\Orca\\resources\\bin\\orca.exe', source: 'bundled' })
    assert.ok(list.every((c) => !c.path.endsWith('.cmd')))
    assert.ok(list.some((c) => c.path === 'C:\\Tools\\orca.exe'))
    assert.ok(list.some((c) => c.path === 'C:\\Users\\tester\\AppData\\Local\\Programs\\Orca\\resources\\bin\\orca.exe'))
  })

  test('Windows: a setting that names orca.cmd means the orca.exe beside it', () => {
    const first = (override: string, platform = 'win32') => cliCandidates({ platform, override })[0]
    assert.deepEqual(first('C:\\Programs\\Orca\\resources\\bin\\ORCA.CMD'), { path: 'C:\\Programs\\Orca\\resources\\bin\\orca.exe', source: 'setting' })
    assert.equal(first('C:/Programs/Orca/resources/bin/orca.cmd')?.path, 'C:/Programs/Orca/resources/bin/orca.exe')
    assert.equal(first('C:\\Tools\\other.cmd')?.path, 'C:\\Tools\\other.cmd')
    assert.equal(first('/opt/bin/orca.cmd', 'linux')?.path, '/opt/bin/orca.cmd')
  })
})

describe('resolveCli', () => {
  test('takes the first candidate that can run', () => {
    const r = resolveCli(
      { platform: 'darwin', resourcesPath: '/A/Resources', pathEnv: '/usr/bin' },
      (file) => file === '/usr/bin/orca'
    )
    assert.equal(r.path, '/usr/bin/orca')
    assert.equal(r.source, 'PATH')
    assert.equal(r.tried[0], '/A/Resources/bin/orca')
  })

  test('a setting that cannot run is an error, not silently skipped', () => {
    const r = resolveCli({ platform: 'darwin', override: '/nope/orca', resourcesPath: '/A/Resources' }, () => false)
    assert.equal(r.path, null)
    assert.match(r.error ?? '', /settings cannot be run/)
  })

  test('nothing found says how to fix it', () => {
    const r = resolveCli({ platform: 'linux' }, () => false)
    assert.equal(r.path, null)
    assert.match(r.error ?? '', /set its path/)
  })
})

// Orca's worker environment on Windows has USERPROFILE but no APPDATA, and Orca's CLI stops with
// "APPDATA is not set" without it.
describe('cliProcessEnv', () => {
  const worker = { PATH: 'C:\\Windows', USERPROFILE: 'C:\\Users\\tester', SystemRoot: 'C:\\Windows', ELECTRON_RUN_AS_NODE: '1' }

  test('Windows: fills in a missing APPDATA from the user profile and keeps the rest', () => {
    assert.deepEqual(cliProcessEnv(worker, 'win32'), { ...worker, APPDATA: 'C:\\Users\\tester\\AppData\\Roaming' })
    assert.equal('APPDATA' in worker, false) // the worker's own environment is left alone
  })

  test('Windows: an APPDATA that is already set wins, whatever its case', () => {
    const set = { ...worker, AppData: 'D:\\Redirected\\Roaming' }
    assert.equal(cliProcessEnv(set, 'win32'), set)
  })

  test('Windows: reads the profile whatever its case, and adds nothing without one', () => {
    assert.equal(cliProcessEnv({ UserProfile: 'C:\\Users\\tester' }, 'win32').APPDATA, 'C:\\Users\\tester\\AppData\\Roaming')
    const bare = { PATH: 'C:\\Windows' }
    assert.equal(cliProcessEnv(bare, 'win32'), bare)
  })

  test('macOS and Linux: untouched', () => {
    assert.equal(cliProcessEnv(worker, 'darwin'), worker)
    assert.equal(cliProcessEnv(worker, 'linux'), worker)
  })

  test('Windows: where the plugin is installed says where APPDATA is, ahead of the default', () => {
    const installed = 'D:\\Redirected\\Roaming\\orca\\plugins\\mswdev.fleet-monitor\\src\\worker.ts'
    assert.equal(appDataFromPluginFile(installed), 'D:\\Redirected\\Roaming')
    assert.equal(cliProcessEnv(worker, 'win32', installed).APPDATA, 'D:\\Redirected\\Roaming')
    assert.equal(appDataFromPluginFile('C:/Users/tester/AppData/Roaming/Orca/Plugins/x/src/worker.ts'), 'C:\\Users\\tester\\AppData\\Roaming')
  })

  test('Windows: a plugin run from a dev folder falls back to the default', () => {
    const dev = 'C:\\Code\\orca-fleet-monitor\\src\\worker.ts'
    assert.equal(appDataFromPluginFile(dev), null)
    assert.equal(appDataFromPluginFile('orca\\plugins\\x\\worker.ts'), null) // nothing above `orca`
    assert.equal(appDataFromPluginFile(null), null)
    assert.equal(cliProcessEnv(worker, 'win32', dev).APPDATA, 'C:\\Users\\tester\\AppData\\Roaming')
  })

  test('the runner hands that environment to the CLI on Windows', async () => {
    let seen: NodeJS.ProcessEnv | undefined
    const { run } = createProcessRunner(() => 'C:\\Programs\\Orca\\resources\\bin\\orca.exe', {
      platform: 'win32',
      env: worker,
      spawn: (_file, _args, options) => {
        seen = options.env
        throw new Error('stop here')
      }
    })
    const result = await run(['environment', 'list', '--json'])
    assert.equal(result.spawnError, 'stop here')
    assert.equal(seen?.APPDATA, 'C:\\Users\\tester\\AppData\\Roaming')
  })
})

describe('createProcessRunner (spawns the Node running these tests)', () => {
  const node = process.execPath

  test('captures stdout and the exit code', async () => {
    const { run } = createProcessRunner(() => node)
    const r = await run(['-e', 'process.stdout.write(JSON.stringify({ok:true,result:1})); process.exitCode = 3'])
    assert.equal(r.code, 3)
    assert.equal(r.stdout, '{"ok":true,"result":1}')
    assert.equal(r.timedOut, false)
    assert.equal(r.spawnError, null)
  })

  test('kills a call that runs past its timeout', async () => {
    const { run } = createProcessRunner(() => node)
    const r = await run(['-e', 'setTimeout(() => {}, 20000)'], { timeoutMs: 300 })
    assert.equal(r.timedOut, true)
    assert.ok(r.durationMs < 10_000)
  })

  test('stops reading at the output cap', async () => {
    const { run } = createProcessRunner(() => node, { maxOutputBytes: 1_000 })
    const r = await run(['-e', 'process.stdout.write("x".repeat(200000))'])
    assert.equal(r.truncated, true)
    assert.ok(r.stdout.length <= 1_000)
  })

  test('reports a CLI that does not exist instead of throwing', async () => {
    const { run } = createProcessRunner(() => '/nonexistent/path/to/orca')
    const r = await run(['--version'])
    assert.ok(r.spawnError)
    const none = await createProcessRunner(() => null).run(['--version'])
    assert.equal(none.spawnError, 'Orca CLI not found')
  })

  // A launcher that starts the real work as its own child and waits for it, as Windows' orca.exe
  // does. The grandchild inherits the pipes, so they stay open until it ends.
  const LAUNCHER = [
    "const { spawn } = require('node:child_process')",
    "const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 6000)'], { stdio: 'inherit' })",
    "process.stdout.write('grandchild ' + c.pid + '\\n')",
    'c.on("exit", (code) => process.exit(code ?? 1))'
  ].join('\n')
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const gone = async (pid: number): Promise<boolean> => {
    for (let i = 0; i < 40 && alive(pid); i += 1) await new Promise((resolve) => setTimeout(resolve, 25))
    return !alive(pid)
  }

  test('a timeout kills the whole tree and settles at once, not when the grandchild lets go', async () => {
    const { run } = createProcessRunner(() => node)
    const started = Date.now()
    const r = await run(['-e', LAUNCHER], { timeoutMs: 700 })
    const took = Date.now() - started
    assert.equal(r.timedOut, true)
    assert.ok(took < 3_000, `settled after ${took} ms`)
    const pid = Number(/grandchild (\d+)/.exec(r.stdout)?.[1])
    assert.ok(pid > 0, `the launcher said ${JSON.stringify(r.stdout)}`)
    assert.ok(await gone(pid), 'the grandchild was killed too')
  })

  test('a call settles at its timeout even when a grandchild escaped the process group', async () => {
    // This grandchild starts its own process group, so a group kill misses it, and it keeps the
    // pipes open: only settling at the timeout, without waiting for them, ends the call.
    const escaping = LAUNCHER.replace("{ stdio: 'inherit' }", "{ stdio: 'inherit', detached: true }")
    const { run } = createProcessRunner(() => node)
    const started = Date.now()
    const r = await run(['-e', escaping], { timeoutMs: 700 })
    const took = Date.now() - started
    const pid = Number(/grandchild (\d+)/.exec(r.stdout)?.[1])
    if (pid > 0) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
    assert.equal(r.timedOut, true)
    assert.ok(took < 3_000, `settled after ${took} ms`)
  })

  test('stop() kills whole trees and settles their calls', async () => {
    const runner = createProcessRunner(() => node)
    const pending = runner.run(['-e', LAUNCHER], { timeoutMs: 30_000 })
    await new Promise((resolve) => setTimeout(resolve, 500))
    const stoppedAt = Date.now()
    runner.stop()
    const r = await pending
    assert.ok(Date.now() - stoppedAt < 1_500, 'settled right after stop()')
    assert.equal(runner.running(), 0)
    const pid = Number(/grandchild (\d+)/.exec(r.stdout)?.[1])
    if (pid > 0) assert.ok(await gone(pid), 'the grandchild was killed too')
  })

  test('stop() kills what is still running', async () => {
    const runner = createProcessRunner(() => node)
    const pending = runner.run(['-e', 'setTimeout(() => {}, 20000)'], { timeoutMs: 30_000 })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(runner.running(), 1)
    runner.stop()
    const r = await pending
    assert.equal(r.timedOut, false)
    assert.equal(runner.running(), 0)
  })
})
