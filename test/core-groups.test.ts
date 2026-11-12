import { assert, test } from 'orca/testing'
import { coreGroupsFrom, groupsFit, readCoreGroups, SYSCTL_ARGS, SYSCTL_PATH, type ExecFile } from '../src/core-groups.ts'

test('sysctl counts become performance cores after the efficiency cores', () => {
  // 8 performance + 4 efficiency, as measured: efficiency cores are os.cpus() 0-3.
  assert.deepEqual(coreGroupsFrom('8\n4\n', 12), [
    { kind: 'performance', start: 4, count: 8 },
    { kind: 'efficiency', start: 0, count: 4 }
  ])
})

test('anything unexpected is no split', () => {
  assert.equal(coreGroupsFrom('8\n', 8), null, 'an Intel Mac has one perf level')
  assert.equal(coreGroupsFrom('8\n4\n', 10), null, 'counts that do not add up')
  assert.equal(coreGroupsFrom('8\nfour\n', 12), null)
  assert.equal(coreGroupsFrom('', 12), null)
  assert.equal(coreGroupsFrom('0\n12\n', 12), null)
})

test('groupsFit wants every core exactly once', () => {
  assert.ok(groupsFit([{ kind: 'performance', start: 0, count: 2 }, { kind: 'efficiency', start: 2, count: 2 }], 4))
  assert.ok(!groupsFit([{ kind: 'performance', start: 0, count: 2 }], 4))
  assert.ok(!groupsFit([{ kind: 'performance', start: 0, count: 3 }, { kind: 'efficiency', start: 2, count: 2 }], 4))
  assert.ok(!groupsFit(null, 4))
  assert.ok(!groupsFit([], 4))
})

test('readCoreGroups asks sysctl once on macOS and nothing elsewhere', async () => {
  const calls: { file: string; args: readonly string[] }[] = []
  const fake =
    (stdout: string, error: Error | null = null): ExecFile =>
    (file, args, _options, callback) => {
      calls.push({ file, args })
      callback(error, stdout)
    }
  assert.deepEqual(await readCoreGroups('darwin', 12, fake('8\n4\n')), coreGroupsFrom('8\n4\n', 12))
  assert.deepEqual(calls, [{ file: SYSCTL_PATH, args: SYSCTL_ARGS }])
  assert.equal(await readCoreGroups('darwin', 8, fake('8\n', new Error('unknown oid'))), null)
  assert.equal(await readCoreGroups('linux', 16, fake('8\n8\n')), null)
  assert.equal(calls.length, 2, 'linux never runs sysctl')
  const throwing: ExecFile = () => {
    throw new Error('spawn failed')
  }
  assert.equal(await readCoreGroups('darwin', 12, throwing), null)
})
