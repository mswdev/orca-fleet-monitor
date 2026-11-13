// "Star on GitHub", done with the person's own GitHub CLI (src/star.ts): where `gh` is looked for,
// exactly what it is asked, and that nothing but a press asks it.
import { assert, describe, test } from 'orca/testing'
import type { ExecFile } from '../src/mac-memory.ts'
import { AVAILABLE_CACHE_MS, createStar, findGh, ghCandidates, STAR_ARGS, STAR_REPOSITORY } from '../src/star.ts'

describe('where gh is looked for', () => {
  test('PATH first (full paths only), then where its installers put it', () => {
    const mac = ghCandidates({ platform: 'darwin', pathEnv: '/usr/bin:relative/bin::/opt/tools', home: '/Users/tester' })
    assert.deepEqual(mac.slice(0, 2), ['/usr/bin/gh', '/opt/tools/gh'])
    assert.ok(mac.includes('/opt/homebrew/bin/gh') && mac.includes('/usr/local/bin/gh') && mac.includes('/Users/tester/.local/bin/gh'))
    assert.equal(mac.filter((file) => file === '/usr/bin/gh').length, 1, 'each place once')
    assert.ok(mac.every((file) => file.startsWith('/')))
    const windows = ghCandidates({ platform: 'win32', pathEnv: 'C:\\Tools;relative', programFiles: 'D:\\Program Files' })
    assert.deepEqual(windows, ['C:\\Tools\\gh.exe', 'D:\\Program Files\\GitHub CLI\\gh.exe'])
    assert.deepEqual(ghCandidates({ platform: 'win32' }), ['C:\\Program Files\\GitHub CLI\\gh.exe'])
  })

  test('the first that can run, or none', () => {
    const env = { platform: 'linux', pathEnv: '/a:/b' }
    assert.equal(findGh(env, (file) => file === '/b/gh'), '/b/gh')
    assert.equal(findGh(env, () => false), null)
  })
})

describe('starring', () => {
  const fake = (result: { error: Error | null } = { error: null }) => {
    const calls: { file: string; args: readonly string[]; env: Record<string, string> | undefined; timeout: number }[] = []
    const exec: ExecFile = async (file, args, options) => {
      calls.push({ file, args, env: options.env, timeout: options.timeout })
      return { error: result.error, stdout: '' }
    }
    return { calls, exec }
  }
  const only = (file: string) => (candidate: string) => candidate === file

  test('asks gh for one thing: to star this plugin’s own repository, with no way to prompt', async () => {
    const gh = fake()
    const star = createStar({ platform: 'darwin', env: { PATH: '/opt/homebrew/bin', HOME: '/Users/tester' }, exec: gh.exec, runnable: only('/opt/homebrew/bin/gh') })
    assert.equal(await star.star(), true)
    assert.equal(gh.calls.length, 1)
    const call = gh.calls[0]!
    assert.equal(call.file, '/opt/homebrew/bin/gh')
    assert.deepEqual([...call.args], ['api', '--method', 'PUT', '-H', 'Accept: application/vnd.github+json', '/user/starred/mswdev/orca-fleet-monitor'])
    assert.deepEqual([...call.args], [...STAR_ARGS])
    assert.equal(STAR_REPOSITORY, 'mswdev/orca-fleet-monitor')
    assert.deepEqual([call.env?.GH_PROMPT_DISABLED, call.env?.HOME, call.env?.PATH], ['1', '/Users/tester', '/opt/homebrew/bin'])
    assert.ok(call.timeout > 0 && call.timeout <= 30_000)
  })

  test('false wherever it could not be done: no gh, not signed in, or gh failing to start', async () => {
    const none = fake()
    assert.equal(await createStar({ platform: 'linux', env: { PATH: '/usr/bin' }, exec: none.exec, runnable: () => false }).star(), false)
    assert.equal(none.calls.length, 0, 'nothing is run without gh')
    const refused = fake({ error: Object.assign(new Error('exit 1'), { code: 1 }) })
    assert.equal(await createStar({ platform: 'linux', env: { PATH: '/usr/bin' }, exec: refused.exec, runnable: only('/usr/bin/gh') }).star(), false)
    const thrower: ExecFile = async () => {
      throw new Error('spawn EACCES')
    }
    assert.equal(await createStar({ platform: 'linux', env: { PATH: '/usr/bin' }, exec: thrower, runnable: only('/usr/bin/gh') }).star(), false)
  })

  test('Windows: gh is given the APPDATA its sign-in is under, which a worker lacks', async () => {
    const gh = fake()
    const star = createStar({ platform: 'win32', env: { Path: 'C:\\Tools', USERPROFILE: 'C:\\Users\\tester' }, exec: gh.exec, runnable: only('C:\\Tools\\gh.exe') })
    assert.equal(await star.star(), true)
    assert.equal(gh.calls[0]!.env?.APPDATA, 'C:\\Users\\tester\\AppData\\Roaming')
  })

  test('two presses at once are one call, and a later press is a new one', async () => {
    let finish: () => void = () => {}
    const calls: number[] = []
    const exec: ExecFile = () =>
      new Promise((resolve) => {
        calls.push(1)
        finish = () => resolve({ error: null, stdout: '' })
      })
    const star = createStar({ platform: 'linux', env: { PATH: '/usr/bin' }, exec, runnable: only('/usr/bin/gh') })
    const a = star.star()
    const b = star.star()
    await Promise.resolve()
    assert.equal(calls.length, 1)
    finish()
    assert.deepEqual(await Promise.all([a, b]), [true, true])
    void star.star()
    await Promise.resolve()
    assert.equal(calls.length, 2)
    finish()
  })

  test('whether gh is there is a look at the disk, at most once a minute, and never a call', () => {
    const gh = fake()
    let looks = 0
    let now = 0
    const star = createStar({
      platform: 'linux',
      env: { PATH: '/usr/bin' },
      exec: gh.exec,
      mono: () => now,
      runnable: (file) => {
        looks += 1
        return file === '/usr/bin/gh'
      }
    })
    assert.equal(star.available(), true)
    const first = looks
    assert.equal(star.available(), true)
    assert.equal(looks, first, 'not looked for again so soon')
    now = AVAILABLE_CACHE_MS
    star.available()
    assert.ok(looks > first)
    assert.equal(gh.calls.length, 0, 'gh itself is never run for this')
  })
})
