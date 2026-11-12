import { assert, describe, test } from 'orca/testing'
import {
  findPluginKeys,
  parseDiagnostics,
  parseEnvelope,
  parseEnvironments,
  parseLocalHostName,
  parseLogs,
  topWorkspaces
} from '../src/parse.ts'
import { decodeBeacon, encodeBeacon } from '../src/beacon.ts'
import { clipText } from '../src/bounds.ts'
import { fixtureText, localSample } from './helpers.ts'

describe('parseEnvelope', () => {
  test('reads an ok answer and its _meta', () => {
    const env = parseEnvelope(fixtureText('diagnostics-remote.json'))
    assert.equal(env.ok, true)
    if (env.ok) assert.equal(env.meta?.runtimeId, 'rt-remote-0001')
  })

  test('reads the error envelope the CLI prints on stdout when it exits 1', () => {
    const env = parseEnvelope(fixtureText('error-unknown-environment.json'))
    assert.equal(env.ok, false)
    if (!env.ok) {
      assert.equal(env.code, 'invalid_argument')
      assert.match(env.message, /Unknown Orca server/)
    }
  })

  test('finds JSON after a stray line, and falls back to stderr', () => {
    const warned = parseEnvelope('warning: something\n{"ok":true,"result":{"x":1}}')
    assert.equal(warned.ok, true)
    const fromStderr = parseEnvelope('', '{"ok":false,"error":{"code":"unavailable","message":"down"}}')
    assert.deepEqual(fromStderr, { ok: false, code: 'unavailable', message: 'down' })
  })

  test('turns non-JSON output into bad_output with a hint', () => {
    const env = parseEnvelope('', 'bash: orca: command not found\n')
    assert.deepEqual(env, { ok: false, code: 'bad_output', message: 'bash: orca: command not found' })
  })
})

describe('parseDiagnostics', () => {
  test('maps host, app and workspaces', () => {
    const sample = parseDiagnostics(parseEnvelope(fixtureText('diagnostics-remote.json')))
    assert.ok(sample)
    assert.equal(sample.collectedAt, 1_800_000_000_000)
    assert.equal(sample.runtimeId, 'rt-remote-0001')
    assert.equal(sample.host.cores, 8)
    assert.equal(sample.host.load1, 6)
    assert.equal(sample.host.memoryPercent, 50)
    assert.equal(sample.host.availableMemorySource, 'memory-pressure')
    assert.deepEqual(sample.app, { cpu: 5, memory: 780_000_000 })
    assert.equal(sample.totalCpu, 157)
    assert.equal(sample.workspaces.length, 3)
    assert.deepEqual(sample.workspaces[0], {
      id: 'wt-alpha',
      name: 'feature-alpha',
      repo: 'demo-app',
      cpu: 140,
      memory: 900_000_000,
      sessions: 2
    })
  })

  test('refuses an answer without a host block, and error envelopes', () => {
    assert.equal(parseDiagnostics(parseEnvelope('{"ok":true,"result":{"app":{}}}')), null)
    assert.equal(parseDiagnostics(parseEnvelope(fixtureText('error-unknown-environment.json'))), null)
  })

  test('clamps nonsense numbers', () => {
    const env = parseEnvelope(
      JSON.stringify({ ok: true, result: { host: { totalMemory: 100, availableMemory: 500, usedMemory: -3, memoryUsagePercent: 140, cpuCoreCount: 0, loadAverage1m: -1 } } })
    )
    const sample = parseDiagnostics(env)
    assert.ok(sample)
    assert.equal(sample.host.availableMemory, 100)
    assert.equal(sample.host.usedMemory, 0)
    assert.equal(sample.host.memoryPercent, 100)
    assert.equal(sample.host.cores, 1)
    assert.equal(sample.host.load1, 0)
  })
})

test('topWorkspaces orders by CPU and by memory and drops idle ones', () => {
  const sample = parseDiagnostics(parseEnvelope(fixtureText('diagnostics-remote.json')))!
  const top = topWorkspaces(sample.workspaces, 5)
  assert.deepEqual(top.byCpu.map((w) => w.id), ['wt-alpha', 'wt-beta'])
  assert.deepEqual(top.byMemory.map((w) => w.id), ['wt-beta', 'wt-alpha'])
  assert.equal(topWorkspaces(sample.workspaces, 1).byCpu.length, 1)
})

describe('parseEnvironments', () => {
  test('keeps one entry per runtime, drops the local runtime and entries without an id', () => {
    const list = parseEnvironments(parseEnvelope(fixtureText('environments.json')), 'rt-local-0000')
    assert.deepEqual(list, [
      { id: 'env-0001', name: 'Build Box', runtimeId: 'rt-remote-0001' },
      { id: 'env-0002', name: 'Render Node', runtimeId: 'rt-remote-0002' }
    ])
  })

  test('answers nothing for an error', () => {
    assert.deepEqual(parseEnvironments(parseEnvelope(fixtureText('error-unknown-environment.json'))), [])
  })
})

describe('findPluginKeys', () => {
  test('matches the id after the publisher, running copies first', () => {
    const info = findPluginKeys(parseEnvelope(fixtureText('plugins.json')), 'fleet-monitor')
    assert.deepEqual(info, { state: 'running', keys: ['local.fleet-monitor', 'example-owner.fleet-monitor'] })
  })

  test('says absent when no copy is installed, installed when none can be read', () => {
    const none = parseEnvelope(JSON.stringify({ ok: true, result: { plugins: [] } }))
    assert.deepEqual(findPluginKeys(none, 'fleet-monitor'), { state: 'absent', keys: [] })
    const disabled = parseEnvelope(
      JSON.stringify({ ok: true, result: { plugins: [{ pluginKey: 'x.fleet-monitor', status: 'disabled' }] } })
    )
    assert.deepEqual(findPluginKeys(disabled, 'fleet-monitor'), { state: 'installed', keys: [] })
  })

  test('is unknown (null) when the list could not be read', () => {
    assert.equal(findPluginKeys(parseEnvelope(fixtureText('error-unknown-environment.json')), 'fleet-monitor'), null)
  })
})

test('parseLogs reads lines, and an unknown key answers ok with none', () => {
  const env = parseEnvelope(JSON.stringify({ ok: true, result: { pluginKey: 'local.none', lines: [], cursor: 'x:0' } }))
  assert.deepEqual(parseLogs(env), { pluginKey: 'local.none', lines: [] })
})

test('parseLocalHostName takes the local host\'s machine name from `orca host list`', () => {
  const answer = (hosts: unknown) => parseEnvelope(JSON.stringify({ ok: true, result: { hosts } }))
  const hosts = [
    { kind: 'local', name: 'this machine', id: 'local', machineName: '  Example Workstation  ', platform: 'darwin' },
    { kind: 'environment', name: 'Build Box', id: 'env-1' }
  ]
  assert.equal(parseLocalHostName(answer(hosts)), 'Example Workstation')
  assert.equal(parseLocalHostName(answer([{ kind: 'local', name: 'this machine', id: 'local' }])), null, 'older Orca: no machineName')
  assert.equal(parseLocalHostName(answer('nope')), null)
  assert.equal(parseLocalHostName(parseEnvelope(fixtureText('error-unknown-environment.json'))), null)
})

describe('bounds on what another machine sends', () => {
  const ok = (result: unknown, meta: Record<string, unknown> = {}) => parseEnvelope(JSON.stringify({ ok: true, result, _meta: meta }))

  test('workspace text, the runtime id and the memory source are cut, and so is the number of workspaces', () => {
    const huge = 'n'.repeat(250_000)
    const worktrees = Array.from({ length: 3_000 }, (_, i) => ({ worktreeId: `w${i}`.padEnd(300, 'i'), worktreeName: i < 5 ? huge : 'n'.repeat(300), repoName: 'r'.repeat(300), cpu: 1e308, memory: 1e300 }))
    const sample = parseDiagnostics(
      ok({ host: { totalMemory: 1e300, availableMemory: 1, cpuCoreCount: 1e9, loadAverage1m: 1e300, availableMemorySource: 'x'.repeat(5_000) }, worktrees }, { runtimeId: 'z'.repeat(9_000) })
    )
    assert.ok(sample)
    assert.equal(sample.workspaces.length, 1_000)
    assert.ok(sample.workspaces.every((w) => w.id.length <= 128 && w.name.length <= 128 && w.repo.length <= 128))
    assert.ok(sample.workspaces.every((w) => w.cpu <= 1_000_000 && w.memory <= 2 ** 52))
    assert.equal(sample.runtimeId?.length, 128)
    assert.equal(sample.host.availableMemorySource.length, 64)
    assert.deepEqual([sample.host.totalMemory, sample.host.cores, sample.host.load1], [2 ** 52, 4_096, 1_000_000])
  })

  test('CLI error text is cut', () => {
    const env = parseEnvelope(JSON.stringify({ ok: false, error: { code: 'c'.repeat(1_000), message: 'm'.repeat(100_000) } }))
    assert.equal(env.ok, false)
    if (!env.ok) {
      assert.equal(env.code.length, 64)
      assert.equal(env.message.length, 500)
    }
  })

  test('environments: at most 64, names cut, and only ids that can be passed to --environment', () => {
    const environments = [
      { id: '--approve=x', name: 'flag', runtimeId: 'rt-f' },
      { id: 'has space', name: 'space', runtimeId: 'rt-s' },
      { id: 'env-ok', name: '  Long '.padEnd(1_000, 'n'), runtimeId: 'r'.repeat(5_000) },
      ...Array.from({ length: 200 }, (_, i) => ({ id: `env-${i}`, name: `Box ${i}`, runtimeId: `rt-${i}` }))
    ]
    const list = parseEnvironments(ok({ environments }))
    assert.equal(list.length, 64)
    assert.equal(list[0]?.id, 'env-ok')
    assert.ok(list[0]!.name.length <= 128 && !list[0]!.name.startsWith(' '))
    assert.ok(list[0]!.runtimeId!.length <= 128)
  })

  test('a plugin key must look like one before it can become a CLI argument', () => {
    const plugins = [
      '--approve=x.fleet-monitor',
      '-x.fleet-monitor',
      'has space.fleet-monitor',
      'a"b.fleet-monitor',
      `${'o'.repeat(200)}.fleet-monitor`,
      '.fleet-monitor',
      'example-owner.fleet-monitor'
    ].map((pluginKey) => ({ pluginKey, status: 'running', isDev: false }))
    assert.deepEqual(findPluginKeys(ok({ plugins }), 'fleet-monitor'), { state: 'running', keys: ['example-owner.fleet-monitor'] })
  })

  test('bidirectional controls in names, workspaces, messages and beacons become U+FFFD', () => {
    const controls = ['‮', '‪', '‫', '‬', '‭', '⁦', '⁧', '⁨', '⁩', '‎', '‏', '؜']
    const bidi = /[؜‎‏‪-‮⁦-⁩]/
    const tainted = (base: string) => controls.map((c) => `${c}${base}`).join('')
    const [env] = parseEnvironments(ok({ environments: [{ id: 'env-a', name: `‮Build Box`, runtimeId: 'rt-a' }] }))
    assert.equal(env?.name, '�Build Box')
    const sample = parseDiagnostics(ok({ host: { totalMemory: 1 }, worktrees: [{ worktreeId: 'w1', worktreeName: tainted('ws'), repoName: tainted('repo') }] }))
    assert.ok(sample && !bidi.test(sample.workspaces[0]!.name) && !bidi.test(sample.workspaces[0]!.repo))
    const error = parseEnvelope(JSON.stringify({ ok: false, error: { code: tainted('c'), message: tainted('m') } }))
    assert.ok(!error.ok && !bidi.test(error.message) && !bidi.test(error.code))
    const hint = parseEnvelope('', `‮orca: not found\n`)
    assert.ok(!hint.ok && hint.message === '�orca: not found')
    const name = parseLocalHostName(ok({ hosts: [{ kind: 'local', machineName: '⁧Desk' }] }))
    assert.equal(name, '�Desk')
    const beacon = decodeBeacon(encodeBeacon(localSample({ hostname: tainted('host'), cpuModel: tainted('chip'), platform: '‮linux', release: '‏1' }), { run: 'r', seq: 1, intervalMs: 5_000 }))
    assert.ok(beacon)
    for (const text of [beacon.hostname, beacon.cpuModel, beacon.platform, beacon.release]) assert.ok(!bidi.test(text), JSON.stringify(text))
    assert.equal(clipText('a‮b', 128), 'a�b')
  })

  test('a logs answer keeps only its last 400 lines', () => {
    const logs = parseLogs(ok({ pluginKey: 'k', lines: Array.from({ length: 2_000 }, (_, i) => ({ ts: i, line: `l${i}` })) }))
    assert.equal(logs?.lines.length, 400)
  })
})
