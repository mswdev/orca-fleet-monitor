import { assert, describe, test } from 'orca/testing'
import {
  findPluginKeys,
  parseDiagnostics,
  parseEnvelope,
  parseEnvironments,
  parseLogs,
  topWorkspaces
} from '../src/parse.ts'
import { fixtureText } from './helpers.ts'

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
