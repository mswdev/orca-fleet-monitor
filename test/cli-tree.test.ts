// The process-tree killer and the launcher name (src/cli.ts), with nothing really spawned or
// killed: the platform, spawn and kill are stand-ins. Invented values only.
import { EventEmitter } from 'node:events'
import { assert, test } from 'orca/testing'
import { cliLauncherName, createProcessRunner, killTree, type Spawner } from '../src/cli.ts'

test('the launcher a person types: orca-ide on Linux, orca elsewhere', () => {
  assert.deepEqual(['linux', 'darwin', 'win32'].map(cliLauncherName), ['orca-ide', 'orca', 'orca'])
})

test('killTree on Windows: taskkill /T /F from the system folder, and the launcher is left to it', () => {
  const killers: { file: string; args: readonly string[]; emitter: EventEmitter }[] = []
  const fakeSpawn = ((file: string, args: readonly string[]) => {
    const emitter = new EventEmitter()
    killers.push({ file, args, emitter })
    return emitter
  }) as unknown as Spawner
  const launcher = () => {
    const state = { killed: false }
    return { state, child: { pid: 4321, kill: () => ((state.killed = true), true) } }
  }
  // taskkill works: the launcher is not killed first (taskkill needs it to find the tree).
  const ok = launcher()
  killTree(ok.child, 'win32', { spawn: fakeSpawn, systemRoot: 'C:\\Windows' })
  assert.deepEqual(
    killers.map((k) => [k.file, k.args]),
    [['C:\\Windows\\System32\\taskkill.exe', ['/PID', '4321', '/T', '/F']]]
  )
  assert.equal(ok.state.killed, false, 'not killed before taskkill has walked the tree')
  killers[0]!.emitter.emit('exit', 0)
  assert.equal(ok.state.killed, false)
  // taskkill fails, or cannot start: the launcher at least goes.
  const failed = launcher()
  killTree(failed.child, 'win32', { spawn: fakeSpawn, systemRoot: 'C:\\Windows' })
  killers[1]!.emitter.emit('exit', 1)
  assert.equal(failed.state.killed, true)
  const missing = launcher()
  killTree(missing.child, 'win32', { spawn: fakeSpawn, systemRoot: 'C:\\Windows' })
  killers[2]!.emitter.emit('error', new Error('ENOENT'))
  assert.equal(missing.state.killed, true)
  const throwing = launcher()
  killTree(throwing.child, 'win32', {
    spawn: (() => {
      throw new Error('no')
    }) as unknown as Spawner
  })
  assert.equal(throwing.state.killed, true)
})

test('killTree on POSIX kills the whole process group', () => {
  const signals: [number, string][] = []
  killTree({ pid: 4321, kill: () => true }, 'darwin', { kill: (pid, signal) => void signals.push([pid, signal]) })
  assert.deepEqual(signals, [[-4321, 'SIGKILL']])
})

test('children lead their own process group on POSIX, and not on Windows', async () => {
  const seen: unknown[] = []
  const fake = (platform: string) =>
    createProcessRunner(() => '/x/orca', {
      platform,
      spawn: ((_file: string, _args: readonly string[], options: { detached?: boolean }) => {
        seen.push(options.detached)
        throw new Error('not really')
      }) as unknown as Spawner
    })
  await fake('linux').run(['x'])
  await fake('win32').run(['x'])
  assert.deepEqual(seen, [true, false])
})

