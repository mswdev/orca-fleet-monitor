import { assert, describe, test } from 'orca/testing'
import { cliCandidates, createProcessRunner, resolveCli } from '../src/cli.ts'

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
