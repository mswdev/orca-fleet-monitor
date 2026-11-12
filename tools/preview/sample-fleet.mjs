// Invented sample data for previews and listing screenshots, after the design's own `FLEET`
// sample. Nothing here is a real machine, person or project. It is turned into the worker's
// snapshot shape (src/model.ts) so the preview goes through the real binding and view.

const MIN = 60_000
const GIB = 2 ** 30

/** The design's FLEET, as written there (percentages, per-minute history, GB). */
export const FLEET = {
  machines: [
    {
      id: 'mbp',
      name: 'MacBook Pro',
      local: true,
      online: true,
      tier: 'full',
      chip: 'Apple M3 Max',
      uptimeSec: 6 * 86_400 + 2 * 3_600,
      load: [2.31, 2.64, 2.9],
      cpu: {
        pct: 18,
        history: [12, 14, 11, 13, 22, 31, 27, 16, 12, 11, 13, 15, 14, 12, 19, 34, 41, 29, 17, 13, 12, 14, 16, 13, 12, 15, 21, 24, 19, 18],
        cores: [
          { kind: 'performance', load: [34, 28, 22, 19, 14, 11, 9, 7, 6, 5, 4, 3] },
          { kind: 'efficiency', load: [41, 37, 30, 26] }
        ]
      },
      mem: {
        pct: 54,
        usedGb: 34.6,
        totalGb: 64,
        history: [51, 51, 52, 52, 52, 53, 53, 53, 52, 52, 52, 53, 53, 53, 54, 55, 55, 55, 54, 54, 54, 54, 53, 53, 54, 54, 54, 54, 54, 54]
      },
      workspaces: [
        { name: 'orca-desktop', cpu: 7, memGb: 6.4 },
        { name: 'storefront-web', cpu: 4, memGb: 4.1 },
        { name: 'design-tokens', cpu: 2, memGb: 1.8 },
        { name: 'docs-site', cpu: 1, memGb: 1.2 }
      ],
      orca: { cpu: 3, memGb: 1.4 }
    },
    {
      id: 'studio',
      name: 'Mac Studio',
      online: true,
      tier: 'full',
      chip: 'Apple M2 Ultra',
      uptimeSec: 23 * 86_400 + 7 * 3_600,
      load: [19.84, 18.2, 15.37],
      cpu: {
        pct: 86,
        history: [38, 41, 36, 44, 47, 52, 49, 55, 61, 58, 66, 71, 69, 74, 78, 83, 81, 86, 90, 88, 84, 87, 91, 89, 85, 88, 92, 87, 84, 86],
        cores: [
          { kind: 'performance', load: [98, 97, 96, 95, 94, 93, 92, 91, 90, 89, 88, 86, 84, 82, 79, 76] },
          { kind: 'efficiency', load: [91, 88, 84, 80, 77, 73, 69, 66] }
        ]
      },
      mem: {
        pct: 71,
        usedGb: 90.9,
        totalGb: 128,
        history: [58, 58, 59, 60, 60, 61, 62, 62, 63, 64, 64, 65, 66, 66, 67, 68, 68, 69, 70, 70, 70, 71, 71, 72, 72, 71, 71, 71, 71, 71]
      },
      workspaces: [
        { name: 'ml-eval-harness', cpu: 38, memGb: 31.6 },
        { name: 'payments-api', cpu: 21, memGb: 22.4 },
        { name: 'ios-app', cpu: 14, memGb: 17.9 },
        { name: 'storefront-web', cpu: 8, memGb: 9.3 },
        { name: 'infra-terraform', cpu: 3, memGb: 2.7 }
      ],
      orca: { cpu: 6, memGb: 2.1 }
    },
    {
      id: 'mini',
      name: 'Mac mini',
      online: true,
      tier: 'full',
      chip: 'Apple M4 Pro',
      uptimeSec: 41 * 86_400 + 11 * 3_600,
      load: [8.42, 7.95, 7.1],
      cpu: {
        pct: 64,
        history: [58, 62, 67, 71, 64, 55, 49, 53, 60, 66, 72, 69, 61, 54, 50, 57, 63, 68, 73, 70, 62, 56, 52, 58, 65, 70, 74, 68, 61, 64],
        cores: [
          { kind: 'performance', load: [88, 84, 79, 75, 71, 68, 64, 61, 57, 52] },
          { kind: 'efficiency', load: [58, 52, 47, 41] }
        ]
      },
      mem: {
        pct: 48,
        usedGb: 23,
        totalGb: 48,
        history: [46, 46, 47, 47, 48, 47, 46, 46, 47, 47, 48, 48, 47, 46, 46, 47, 47, 48, 48, 48, 47, 47, 46, 47, 47, 48, 48, 48, 48, 48]
      },
      workspaces: [
        { name: 'ci-runner-pool', cpu: 34, memGb: 9.8 },
        { name: 'payments-api', cpu: 17, memGb: 5.2 },
        { name: 'docs-site', cpu: 8, memGb: 2.4 },
        { name: 'design-tokens', cpu: 3, memGb: 1.1 }
      ],
      orca: { cpu: 2, memGb: 1.1 }
    },
    {
      id: 'ci',
      name: 'ci-runner-02',
      online: true,
      tier: 'basic',
      cores: 16,
      load: [17.62],
      cpu: {
        pct: 97,
        history: [72, 78, 85, 91, 94, 96, 97, 95, 96, 98, 97, 96, 94, 95, 97, 98, 99, 97, 96, 95, 97, 98, 96, 95, 97, 98, 99, 98, 96, 97]
      },
      mem: {
        pct: 78,
        usedGb: 25,
        totalGb: 32,
        history: [64, 65, 67, 68, 70, 71, 72, 73, 74, 74, 75, 75, 76, 76, 76, 77, 77, 77, 78, 78, 77, 77, 78, 78, 78, 79, 78, 78, 78, 78]
      },
      workspaces: [],
      orca: { cpu: 1, memGb: 0.9 }
    },
    {
      id: 'air',
      name: 'MacBook Air',
      online: false,
      tier: 'full',
      chip: 'Apple M2',
      lastSeenAgoMs: (2 * 60 + 14) * MIN,
      cpu: { pct: 9, history: [] },
      mem: { pct: 62, usedGb: 9.9, totalGb: 16, history: [] }
    }
  ]
}

/** A small deterministic wobble, so 5-second readings look measured and still average out. */
function wobble(seed) {
  const x = Math.sin(seed * 12.9898) * 43_758.5453
  return (x - Math.floor(x) - 0.5) * 4
}

/** Per-minute values as 5-second readings across the last 30 minutes, ending at `now`. */
function readings(perMinute, now, endAt = now) {
  const t = []
  const v = []
  perMinute.forEach((value, minute) => {
    for (let k = 11; k >= 0; k -= 1) {
      const at = endAt - (perMinute.length - 1 - minute) * MIN - k * 5_000
      if (at > now) continue
      t.push(at)
      v.push(Math.min(100, Math.max(0, Math.round((value + (k === 0 ? 0 : wobble(minute * 13 + k))) * 10) / 10)))
    }
  })
  return { t, v }
}

const health = (pct, t) => (pct >= t.critical ? 'critical' : pct >= t.strained ? 'strained' : pct >= t.busy ? 'busy' : 'ok')
const rank = { ok: 0, busy: 1, strained: 2, critical: 3 }

/** Thresholds for the sample: the design's single set, used for both CPU and memory. */
export const SAMPLE_THRESHOLDS = {
  cpu: { busy: 60, strained: 80, critical: 92 },
  memory: { busy: 60, strained: 80, critical: 92 }
}

function toMachineView(m, now, thresholds) {
  const local = m.local === true
  const cores = m.cpu.cores ? m.cpu.cores.reduce((n, g) => n + g.load.length, 0) : m.cores
  // os.cpus() lists efficiency cores first on Apple silicon (see src/core-groups.ts).
  const efficiency = m.cpu.cores?.find((g) => g.kind === 'efficiency')?.load ?? []
  const performance = m.cpu.cores?.find((g) => g.kind === 'performance')?.load ?? []
  const perCore = m.cpu.cores ? [...efficiency, ...performance] : null
  const groups = m.cpu.cores
    ? [
        { kind: 'performance', start: efficiency.length, count: performance.length },
        { kind: 'efficiency', start: 0, count: efficiency.length }
      ]
    : null
  const lastSeenAt = m.online ? now - 2_000 : now - m.lastSeenAgoMs
  const cpuHistory = readings(m.cpu.history, now, m.online ? now : lastSeenAt)
  const memHistory = readings(m.mem.history, now, m.online ? now : lastSeenAt)
  if (!m.online) {
    cpuHistory.t.push(lastSeenAt)
    cpuHistory.v.push(m.cpu.pct)
    memHistory.t.push(lastSeenAt)
    memHistory.v.push(m.mem.pct)
  }
  const basic = m.tier === 'basic'
  // As the worker judges it: a basic machine's CPU is an estimate, which never sets a level.
  const cpuLevel = basic ? null : health(m.cpu.pct, thresholds.cpu)
  const memLevel = health(m.mem.pct, thresholds.memory)
  const level = cpuLevel !== null && rank[cpuLevel] >= rank[memLevel] ? cpuLevel : memLevel
  const threshold = (lvl, t) => (lvl === 'critical' ? t.critical : lvl === 'strained' ? t.strained : t.busy)
  const reasons = level === 'ok' ? [] : [
    ...(cpuLevel === level ? [`CPU ${Math.round(m.cpu.pct)}% ≥ ${threshold(level, thresholds.cpu)}%`] : []),
    ...(memLevel === level ? [`memory ${Math.round(m.mem.pct)}% ≥ ${threshold(level, thresholds.memory)}%`] : [])
  ]
  return {
    id: m.id,
    name: m.name,
    kind: local ? 'local' : 'remote',
    tier: basic ? 'basic' : 'full',
    status: m.online ? 'online' : 'offline',
    online: m.online,
    lastSeenAt,
    latencyMs: local ? null : 320,
    error: m.online ? null : 'orca diagnostics memory timed out',
    host: {
      hostname: basic ? null : m.id,
      platform: basic ? null : 'darwin',
      arch: basic ? null : 'arm64',
      cpuModel: m.chip ?? null,
      cores,
      uptimeSec: m.online && !basic ? m.uptimeSec : null
    },
    cpu: m.online
      ? { percent: m.cpu.pct, source: basic ? 'load' : local ? 'sampler' : 'beacon', perCore, groups }
      : { percent: null, source: null, perCore: null, groups: null },
    memory: {
      total: m.mem.totalGb * GIB,
      used: m.mem.usedGb * GIB,
      available: (m.mem.totalGb - m.mem.usedGb) * GIB,
      percent: m.mem.pct,
      source: 'orca',
      reliable: true
    },
    load: m.load ? { one: m.load[0], five: m.load[1] ?? null, fifteen: m.load[2] ?? null } : null,
    orca: m.orca ? { cpu: m.orca.cpu * cores, memory: m.orca.memGb * GIB, totalCpu: m.orca.cpu * cores * 3, totalMemory: m.orca.memGb * 3 * GIB } : null,
    workspaces: {
      byCpu: (m.workspaces ?? []).map((w, i) => ({ id: `${m.id}-ws-${i}`, name: w.name, repo: 'example', cpu: w.cpu * cores, memory: w.memGb * GIB, sessions: 1 })),
      byMemory: []
    },
    health: m.online
      ? { level, reasons, cpu: cpuLevel, memory: memLevel }
      : { level: 'unknown', reasons: ['offline'], cpu: null, memory: null },
    beacon: {
      state: local || (!basic && m.online) ? 'fresh' : basic ? 'absent' : 'stale',
      ageMs: local ? 0 : null,
      seq: null,
      pluginKey: null,
      remotePlugin: local ? 'running' : basic ? 'absent' : 'running'
    },
    updatedAt: now,
    history: { t: cpuHistory.t, cpu: cpuHistory.v, mem: memHistory.v }
  }
}

/**
 * A `fleet.snapshot` answer for a preview state:
 *   live        every design machine (full, basic and offline)
 *   empty       only this computer: nothing paired
 *   connecting  live, plus a machine being read for the first time
 */
export function sampleSnapshot(state = 'live', now = Date.now(), thresholds = SAMPLE_THRESHOLDS) {
  let machines = FLEET.machines.map((m) => toMachineView(m, now, thresholds))
  if (state === 'empty') machines = machines.filter((m) => m.kind === 'local')
  if (state === 'connecting') {
    machines.push({
      ...toMachineView({ ...FLEET.machines[2], id: 'new', name: 'build-box' }, now, thresholds),
      status: 'connecting',
      online: false,
      lastSeenAt: null,
      error: null,
      health: { level: 'unknown', reasons: [], cpu: null, memory: null },
      history: { t: [], cpu: [], mem: [] }
    })
  }
  return {
    v: 1,
    seq: 1,
    generatedAt: now,
    mode: 'fast',
    intervalMs: 5_000,
    historyWindowMs: 30 * MIN,
    cli: { path: '/Applications/Orca.app/Contents/Resources/bin/orca', source: 'bundled', error: null, runError: null, launcher: 'orca' },
    thresholds,
    historyRev: 0,
    run: 'preview',
    machines
  }
}
