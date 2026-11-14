// Process owners on Windows (src/win-owners.ts): qprocess's output as a desktop prints it, the
// names Task Manager shows, and when it is run.
import { assert, describe, test } from 'orca/testing'
import { OWNER_MIN_GAP_MS, OWNER_REFRESH_MS, OWNER_RETRY_MS, ownerName, parseQprocess, WindowsOwners, type QprocessRun } from '../src/win-owners.ts'
import { buildWindowsTable, WindowsProcessSampler } from '../src/win-processes.ts'

const OUTPUT = [
  ' USERNAME              SESSIONNAME         ID    PID  IMAGE',
  '>(unknown)             services             0      0  ',
  '>(unknown)             services             0      4  system',
  '>system                services             0    472  registry',
  ' local service         services             0   2196  svchost.exe',
  ' network service       services             0   3100  svchost.exe',
  ' dwm-2                 rdp-tcp#0            2   9000  dwm.exe',
  ' matt                  rdp-tcp#0            2  22548  wavebox.exe',
  ' matt                  rdp-tcp#0            2  22572  Docker Desktop.exe',
  ' matt                                       3 123456  disconnected.exe',
  ' someone               console              1   7000  explorer.exe',
  ' a-very-long-service-account-name  services  0   8000  svc.exe',
  ' garbage',
  ''
].join('\r\n')

describe('qprocess', () => {
  test('every pid\'s user, as Task Manager names them', () => {
    const owners = parseQprocess(OUTPUT, 'Matt')
    assert.deepEqual([...owners], [
      [472, 'SYSTEM'],
      [2196, 'LOCAL SERVICE'],
      [3100, 'NETWORK SERVICE'],
      [9000, 'DWM-2'],
      [22548, 'Matt'],
      [22572, 'Matt'],
      [123456, 'Matt'],
      [7000, 'someone']
    ])
    assert.equal(parseQprocess(OUTPUT, null).get(22548), 'matt', 'without knowing this user, as printed')
    assert.equal(parseQprocess('', 'Matt').size, 0)
  })

  test('a name nothing can be made of is none', () => {
    assert.equal(ownerName('(unknown)', null), null)
    assert.equal(ownerName('(unbekannt)', null), null, 'the placeholder in another language')
    assert.equal(ownerName('   ', null), null)
    assert.equal(ownerName('josé', null), null, 'not ASCII: the code page cannot be trusted')
    assert.equal(ownerName('x'.repeat(40), null), null)
    assert.equal(ownerName('umfd-0', null), 'UMFD-0')
  })
})

describe('when qprocess is run', () => {
  const fake = () => {
    const state = { t: 0, wall: 1_800_000_000_000, runs: 0, run: { output: OUTPUT } as QprocessRun }
    const owners = new WindowsOwners({
      run: async () => {
        state.runs += 1
        return state.run
      },
      mono: () => state.t,
      wall: () => state.wall,
      me: 'Matt'
    })
    return { state, owners }
  }

  test('every ten seconds, and sooner (two at most) for a process newer than the last run', async () => {
    const { state, owners } = fake()
    const first = await owners.lookup(null)
    assert.equal(first.owners.get(22548), 'Matt')
    assert.equal(first.readAt, 1_800_000_000_000, 'when the run began')
    state.t = OWNER_MIN_GAP_MS + 1
    state.wall += OWNER_MIN_GAP_MS + 1
    await owners.lookup(1_700_000_000)
    assert.equal(state.runs, 1, 'nothing newer than the run')
    await owners.lookup((state.wall + 500) / 1000)
    assert.equal(state.runs, 2, 'a process started since: read again')
    state.t += 500
    await owners.lookup((state.wall + 1_000) / 1000)
    assert.equal(state.runs, 2, 'but not twice in two seconds')
    state.t += OWNER_REFRESH_MS
    await owners.lookup(null)
    assert.equal(state.runs, 3, 'ten seconds on')
  })

  test('missing: no owners, and tried again an hour later', async () => {
    const { state, owners } = fake()
    state.run = 'missing'
    assert.equal((await owners.lookup(null)).owners.size, 0)
    state.run = { output: OUTPUT }
    state.t = OWNER_REFRESH_MS * 2
    assert.equal((await owners.lookup(null)).owners.size, 0)
    assert.equal(state.runs, 1)
    state.t = OWNER_RETRY_MS + 1
    assert.equal((await owners.lookup(null)).owners.size, 8)
  })

  test('a run that fails or times out keeps the owners known, and the next comes at the usual cadence', async () => {
    const { state, owners } = fake()
    await owners.lookup(null)
    state.run = 'failed'
    state.t = OWNER_REFRESH_MS
    state.wall += OWNER_REFRESH_MS
    const kept = await owners.lookup(null)
    assert.equal(kept.owners.size, 8)
    assert.equal(kept.readAt, 1_800_000_000_000, 'still the run they came from')
    state.run = { output: OUTPUT.replace('matt   ', 'other  ') }
    state.t += 1_000
    await owners.lookup(null)
    assert.equal(state.runs, 2, 'not straight away')
    state.t += OWNER_REFRESH_MS
    assert.equal((await owners.lookup(null)).owners.get(22548), 'other')
    // Runs that give nothing: no sooner than the usual cadence (not for each newer process), and
    // after three in a row, an hour.
    state.run = 'failed'
    const runs = state.runs
    for (let i = 0; i < 4; i += 1) {
      state.t += OWNER_MIN_GAP_MS + 1
      state.wall += OWNER_MIN_GAP_MS + 1
      await owners.lookup(state.wall / 1000 + 1)
    }
    assert.equal(state.runs, runs + 1, 'a newer process does not bring on a run after one that gave nothing')
    state.t += OWNER_REFRESH_MS
    await owners.lookup(null)
    state.t += OWNER_REFRESH_MS
    await owners.lookup(null)
    assert.equal(state.runs, runs + 3)
    state.t += OWNER_REFRESH_MS
    await owners.lookup(null)
    assert.equal(state.runs, runs + 3, 'three in a row: left alone')
    assert.equal((await owners.lookup(null)).owners.get(22548), 'other', 'what was known is still known')
    state.run = { output: OUTPUT }
    state.t += OWNER_RETRY_MS
    assert.equal((await owners.lookup(null)).owners.get(22548), 'Matt')
    const thrown = new WindowsOwners({ run: async () => { throw new Error('no') }, mono: () => 0, me: null })
    assert.equal((await thrown.lookup(null)).owners.size, 0)
  })
})

describe('the process list with owners', () => {
  test('a row takes its owner where one is known', async () => {
    // Windows file times (100 ns since 1601): started at epoch second 1,800,000,000, read 10 s on.
    const started = (1_800_000_000 + 11_644_473_600) * 10_000_000
    const answer = { t: started + 100_000_000, p: [[22548, 1, 'wavebox', 5_000_000, 1_048_576, started], [1, 0, 'mystery', 0, 4096, null]] }
    const host = { request: async () => answer }
    const owners = { lookup: async () => ({ owners: new Map([[22548, 'Matt'], [1, 'SYSTEM']]), readAt: 1_800_000_005_000 }) }
    const sampler = new WindowsProcessSampler({ host, platform: 'win32', owners, mono: () => 0, wall: () => 1_800_000_000_000 })
    const table = (await sampler.localTable())!
    assert.deepEqual(table.rows.map((r) => [r.pid, r.user]), [[22548, 'Matt'], [1, 'SYSTEM']])
    // A process that started after the owners were read: its pid may have changed hands.
    const late = new WindowsProcessSampler({ host, platform: 'win32', owners: { lookup: async () => ({ owners: new Map([[22548, 'Matt'], [1, 'SYSTEM']]), readAt: 1_799_999_999_000 }) }, mono: () => 0 })
    assert.deepEqual((await late.localTable())!.rows.map((r) => r.user), [null, 'SYSTEM'], 'none for the one that started later; one with no start time keeps its own')
    const none = new WindowsProcessSampler({ host, platform: 'win32', owners: { lookup: async () => { throw new Error('no') } }, mono: () => 0 })
    assert.deepEqual((await none.localTable())!.rows.map((r) => r.user), [null, null])
    assert.equal(buildWindowsTable({ t: 1, rows: [], at: 0, wallAt: 0 } as never, null).rows.length, 0)
  })

  test('callers that come while the owners are looked up share the one reading and its table', async () => {
    let t = 0
    let asked = 0
    const host = {
      request: async () => {
        asked += 1
        t += 10_000_000
        return { t, p: [[22548, 1, 'wavebox', asked * 5_000_000, 1_048_576, 9_000_000]] }
      }
    }
    let release: () => void = () => {}
    const owners = { lookup: () => new Promise<{ owners: ReadonlyMap<number, string>; readAt: number }>((resolve) => (release = () => resolve({ owners: new Map(), readAt: 0 }))) }
    const sampler = new WindowsProcessSampler({ host, platform: 'win32', owners, mono: () => 0 })
    const a = sampler.publishTable()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const b = sampler.localTable()
    await new Promise((resolve) => setTimeout(resolve, 0))
    release()
    const [ta, tb] = await Promise.all([a, b])
    assert.equal(asked, 1, 'one proc request')
    assert.equal(ta, tb)
  })
})
