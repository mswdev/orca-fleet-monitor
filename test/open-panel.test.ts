// "Show Fleet Monitor" (src/open-panel.ts) against a fake CLI: which key it opens, and what it runs.
import { assert, describe, test } from 'orca/testing'
import { chooseOwnKey, openOwnPanel, pluginKeyFromPath } from '../src/open-panel.ts'
import { envelope, errorResult, FakeCli, FakeTime, okResult } from './helpers.ts'

const ID = 'fleet-monitor'
const entry = (key: string, status = 'running', isDev = false) => ({ key, status, isDev, panels: true })

describe('which copy is this', () => {
  test('an installed copy is named by its folder; a development folder is not', () => {
    assert.equal(pluginKeyFromPath('/Users/u/Library/Application Support/orca/plugins/example-owner.fleet-monitor/0123456789abcdef0123/src/worker.ts', ID), 'example-owner.fleet-monitor')
    assert.equal(pluginKeyFromPath('C:\\Users\\u\\AppData\\Roaming\\orca\\plugins\\example-owner.fleet-monitor\\current\\src\\worker.ts', ID), 'example-owner.fleet-monitor')
    assert.equal(pluginKeyFromPath('/home/u/code/orca-fleet-monitor/src/worker.ts', ID), null)
    assert.equal(pluginKeyFromPath('/home/u/plugins/someone.fleet-monitor/src/worker.ts', ID), null, 'no content-hash folder under it')
  })

  test('the path key wins when listed; else the only usable copy; else the development copy', () => {
    const both = [entry('local.fleet-monitor', 'running', true), entry('example-owner.fleet-monitor')]
    assert.equal(chooseOwnKey(both, 'example-owner.fleet-monitor', ID), 'example-owner.fleet-monitor')
    assert.equal(chooseOwnKey(both, null, ID), 'local.fleet-monitor')
    assert.equal(chooseOwnKey([entry('example-owner.fleet-monitor')], null, ID), 'example-owner.fleet-monitor')
    assert.equal(chooseOwnKey([entry('x.fleet-monitor', 'disabled')], null, ID), null)
  })
})

describe('openOwnPanel', () => {
  const list = (plugins: unknown[]) => okResult(envelope({ plugins }))

  test('lists this machine\'s plugins, then opens the panel with the CLI', async () => {
    const time = new FakeTime()
    const cli = new FakeCli(time, (args) =>
      args[1] === 'list'
        ? list([
            { pluginKey: 'local.fleet-monitor', status: 'running', isDev: true, panels: [{ id: 'fleet' }] },
            { pluginKey: 'someone.other', status: 'running', panels: [{ id: 'x' }] }
          ])
        : okResult(envelope({ pluginKey: 'local.fleet-monitor', panelId: 'fleet' }))
    )
    await openOwnPanel(cli.run, ID, '/home/u/code/orca-fleet-monitor/src/worker.ts')
    assert.deepEqual(
      cli.calls.map((c) => c.args),
      [
        ['plugin', 'list', '--json'],
        ['plugin', 'open', 'local.fleet-monitor', '--panel', 'fleet', '--json']
      ]
    )
    assert.ok(cli.calls.every((c) => !c.args.includes('--environment')), 'only ever this machine')
  })

  test('fails loudly (Orca then says the command failed) when the CLI refuses', async () => {
    const time = new FakeTime()
    const cli = new FakeCli(time, (args) =>
      args[1] === 'list'
        ? list([{ pluginKey: 'local.fleet-monitor', status: 'running', isDev: true, panels: [{ id: 'fleet' }] }])
        : errorResult('no_workspace', 'Orca shows plugin panels beside an open workspace')
    )
    let message = ''
    try {
      await openOwnPanel(cli.run, ID, null)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    assert.match(message, /no workspace|open workspace/i)
  })

  test('does not guess when no copy is listed', async () => {
    const time = new FakeTime()
    const cli = new FakeCli(time, () => list([]))
    let failed = false
    try {
      await openOwnPanel(cli.run, ID, null)
    } catch {
      failed = true
    }
    assert.ok(failed)
    assert.equal(cli.calls.length, 1, 'nothing opened')
  })
})
