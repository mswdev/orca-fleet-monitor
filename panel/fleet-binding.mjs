// Data binding between a Fleet Monitor panel and its worker. No DOM here: the view calls
// createFleetBinding(window.orca), subscribes, turns each view into the panel's model with
// toFleet(view, now) and draws that.
//
// Contract with the worker (src/protocol.ts):
//   plugin.request('fleet.snapshot')  -> the whole fleet with history; counts as a heartbeat
//   plugin.request('fleet.heartbeat') -> keeps the worker polling fast while the panel is visible
//   plugin.request('fleet.retry')     -> reads one machine now ("Retry connection")
//   plugin.on('fleet.update', ...)    -> current states plus each machine's recent points
//
// toFleet() is where the live data meets the visual design: it produces the shape of the design's
// sample `FLEET` object (machines with CPU and memory percentages, 30 one-minute history points,
// per-core groups, top workspaces, facts), with the gaps the live data has made explicit.

export const HEARTBEAT_MS = 5_000
const REQUEST_TIMEOUT_MS = 10_000

/** Merges `extra` history columns into `base` by time (same time: extra wins), oldest first,
 *  keeping only points within `windowMs` of the newest. */
export function mergeColumns(base, extra, windowMs) {
  const byTime = new Map()
  for (const cols of [base, extra]) {
    if (!cols || !Array.isArray(cols.t)) continue
    for (let i = 0; i < cols.t.length; i += 1) {
      byTime.set(cols.t[i], [cols.cpu?.[i] ?? null, cols.mem?.[i] ?? null])
    }
  }
  const times = [...byTime.keys()].sort((a, b) => a - b)
  const newest = times[times.length - 1] ?? 0
  const kept = times.filter((t) => t >= newest - windowMs)
  return {
    t: kept,
    cpu: kept.map((t) => byTime.get(t)[0]),
    mem: kept.map((t) => byTime.get(t)[1])
  }
}

const emptyColumns = () => ({ t: [], cpu: [], mem: [] })

/**
 * @param {{ plugin: { request: Function, on: Function } }} orca  the frame's window.orca
 * @param {object} [options] test seams: setInterval, clearInterval, isVisible, onVisibilityChange
 */
export function createFleetBinding(orca, options = {}) {
  const plugin = orca.plugin
  const startTimer = options.setInterval ?? ((fn, ms) => setInterval(fn, ms))
  const stopTimer = options.clearInterval ?? ((handle) => clearInterval(handle))
  const isVisible =
    options.isVisible ?? (() => typeof document === 'undefined' || document.visibilityState !== 'hidden')
  const onVisibilityChange =
    options.onVisibilityChange ??
    ((handler) => {
      if (typeof document === 'undefined') return () => {}
      document.addEventListener('visibilitychange', handler)
      return () => document.removeEventListener('visibilitychange', handler)
    })

  const listeners = new Set()
  /** { seq, generatedAt, mode, intervalMs, historyWindowMs, cli, order: string[], machines: Map } */
  let model = null
  let error = null
  let fetching = null
  let buffered = []
  let wasVisible = isVisible()
  let disposed = false

  function view() {
    if (!model) return { ready: false, error, machines: [] }
    return {
      ready: true,
      error,
      seq: model.seq,
      generatedAt: model.generatedAt,
      mode: model.mode,
      intervalMs: model.intervalMs,
      historyWindowMs: model.historyWindowMs,
      cli: model.cli,
      thresholds: model.thresholds,
      machines: model.order.map((id) => model.machines.get(id))
    }
  }

  function emit() {
    const current = view()
    for (const listener of listeners) {
      try {
        listener(current)
      } catch (err) {
        console.error('fleet view failed', err)
      }
    }
  }

  function fromSnapshot(snapshot) {
    const machines = new Map()
    for (const machine of snapshot.machines ?? []) {
      machines.set(machine.id, { ...machine, history: machine.history ?? emptyColumns() })
    }
    return {
      seq: snapshot.seq,
      generatedAt: snapshot.generatedAt,
      mode: snapshot.mode,
      intervalMs: snapshot.intervalMs,
      historyWindowMs: snapshot.historyWindowMs ?? 30 * 60_000,
      cli: snapshot.cli ?? null,
      thresholds: readThresholds(snapshot.thresholds),
      historyRev: typeof snapshot.historyRev === 'number' ? snapshot.historyRev : null,
      run: typeof snapshot.run === 'string' ? snapshot.run : null,
      order: (snapshot.machines ?? []).map((m) => m.id),
      machines
    }
  }

  function apply(update) {
    const machines = new Map()
    for (const state of update.machines ?? []) {
      const previous = model.machines.get(state.id)
      const history = mergeColumns(previous?.history ?? emptyColumns(), update.appended?.[state.id], model.historyWindowMs)
      machines.set(state.id, { ...state, history })
    }
    model = {
      ...model,
      seq: update.seq,
      generatedAt: update.generatedAt,
      mode: update.mode,
      intervalMs: update.intervalMs,
      cli: update.cli ?? model.cli,
      thresholds: update.thresholds ? readThresholds(update.thresholds) : model.thresholds,
      order: (update.machines ?? []).map((m) => m.id),
      machines
    }
  }

  function onUpdate(update) {
    if (disposed || !update || update.v !== 1) return
    if (fetching) buffered.push(update)
    if (update.resync) {
      refresh()
      return
    }
    if (!model) return
    // A restarted worker counts from 1 again and has its own history: start over from a snapshot.
    if (typeof update.run === 'string' && model.run !== null && update.run !== model.run) {
      refresh()
      return
    }
    if (update.seq <= model.seq) return
    // Missed posts only lose points when the gap is longer than what each post repeats.
    const missed = update.seq > model.seq + 1 && update.generatedAt - model.generatedAt > (update.recentMs ?? 0)
    // Older history was rewritten (a machine reached the full tier and its earlier beacons were
    // back-filled); posts only repeat recent points, so fetch the whole history again.
    const rewritten =
      typeof update.historyRev === 'number' && model.historyRev !== null && update.historyRev !== model.historyRev
    apply(update)
    emit()
    if (missed || rewritten) refresh()
  }

  function refresh() {
    if (disposed) return Promise.resolve()
    if (fetching) return fetching
    buffered = []
    fetching = plugin
      .request('fleet.snapshot', undefined, { timeoutMs: REQUEST_TIMEOUT_MS })
      .then((snapshot) => {
        model = fromSnapshot(snapshot)
        error = null
        for (const update of buffered) {
          const sameRun = (update.run ?? null) === model.run && (update.historyRev ?? null) === model.historyRev
          if (update.seq > model.seq && !update.resync && sameRun) apply(update)
        }
      })
      .catch((err) => {
        error = (err && (err.code || err.message)) || 'request failed'
      })
      .finally(() => {
        fetching = null
        buffered = []
        if (!disposed) emit()
      })
    return fetching
  }

  function heartbeat() {
    if (disposed || !isVisible()) return
    // No snapshot yet (the first one failed): keep asking; plugin.request starts the worker.
    if (!model) {
      refresh()
      return
    }
    plugin
      .request('fleet.heartbeat', undefined, { timeoutMs: REQUEST_TIMEOUT_MS })
      .then((answer) => {
        // Posts can be dropped; a worker well ahead of us means a re-fetch.
        if (model && answer && typeof answer.seq === 'number' && answer.seq > model.seq + 2) refresh()
      })
      .catch(() => {})
  }

  const subscription = plugin.on('fleet.update', onUpdate)
  const timer = startTimer(heartbeat, HEARTBEAT_MS)
  const stopWatchingVisibility = onVisibilityChange(() => {
    const visible = isVisible()
    // Coming back after a while: the worker has slowed down and stopped posting.
    if (visible && !wasVisible) refresh()
    wasVisible = visible
  })
  const ready = refresh()

  /** "Retry connection": resolves true when the worker took the request. */
  function retry(id) {
    if (disposed) return Promise.resolve(false)
    return plugin
      .request('fleet.retry', { id }, { timeoutMs: REQUEST_TIMEOUT_MS })
      .then((answer) => Boolean(answer && answer.ok))
      .catch(() => false)
  }

  return {
    ready,
    current: view,
    refresh,
    retry,
    subscribe(listener) {
      listeners.add(listener)
      listener(view())
      return () => listeners.delete(listener)
    },
    dispose() {
      disposed = true
      stopTimer(timer)
      stopWatchingVisibility()
      subscription?.dispose?.()
      listeners.clear()
    },
    /** Test seam: what the next heartbeat tick does. */
    _heartbeat: heartbeat
  }
}

// --- From the live model to the design's FLEET shape ------------------------------------------

/** The worker's defaults (src/health.ts), for a snapshot that carries no thresholds. */
export const DEFAULT_THRESHOLDS = Object.freeze({
  cpu: Object.freeze({ busy: 70, strained: 85, critical: 95 }),
  memory: Object.freeze({ busy: 75, strained: 88, critical: 95 })
})
/** The charts show 30 one-minute points, as the design does. */
export const HISTORY_SLOTS = 30
export const SLOT_MS = 60_000
export const TOP_WORKSPACES = 5
/** What `orca plugin install` takes to install Fleet Monitor from its repository. */
export const INSTALL_SOURCE = 'mswdev/orca-fleet-monitor'
export const LEVEL_LABELS = Object.freeze({
  ok: 'OK',
  busy: 'Busy',
  strained: 'Strained',
  critical: 'Critical',
  unknown: 'Waiting'
})

const finite = (value) => typeof value === 'number' && Number.isFinite(value)

function readThresholds(raw) {
  const one = (r, fallback) => {
    const values = ['busy', 'strained', 'critical']
      .map((key) => (r && finite(r[key]) ? Math.min(100, Math.max(0, r[key])) : fallback[key]))
      .sort((a, b) => a - b)
    return { busy: values[0], strained: values[1], critical: values[2] }
  }
  return { cpu: one(raw?.cpu, DEFAULT_THRESHOLDS.cpu), memory: one(raw?.memory, DEFAULT_THRESHOLDS.memory) }
}

/** ok | busy | strained | critical for a percentage, as the worker judges health. */
export function levelFor(value, thresholds) {
  if (!finite(value)) return 'ok'
  if (value >= thresholds.critical) return 'critical'
  if (value >= thresholds.strained) return 'strained'
  if (value >= thresholds.busy) return 'busy'
  return 'ok'
}

/**
 * History columns as `slots` points, one per `slotMs`, ending at `end`: slot i holds the mean of
 * the readings in (end - (slots - i) * slotMs, end - (slots - 1 - i) * slotMs], or null where
 * there were none (a machine seen for 3 minutes fills only the last 3 slots). The last slot is
 * the newest reading itself, so the line ends where the big number is.
 */
export function bucketHistory(columns, key, end, slots = HISTORY_SLOTS, slotMs = SLOT_MS) {
  const sums = new Array(slots).fill(0)
  const counts = new Array(slots).fill(0)
  const times = Array.isArray(columns?.t) ? columns.t : []
  const values = Array.isArray(columns?.[key]) ? columns[key] : []
  const start = end - slots * slotMs
  let latest = null
  let latestAt = Number.NEGATIVE_INFINITY
  for (let i = 0; i < times.length; i += 1) {
    const t = times[i]
    const value = values[i]
    if (!finite(t) || !finite(value) || t <= start) continue
    const slot = Math.min(slots - 1, Math.max(0, Math.ceil((t - start) / slotMs) - 1))
    sums[slot] += value
    counts[slot] += 1
    if (t >= latestAt) {
      latestAt = t
      latest = value
    }
  }
  const out = sums.map((sum, i) => (counts[i] > 0 ? sum / counts[i] : null))
  if (counts[slots - 1] > 0 && latest !== null) out[slots - 1] = latest
  return out
}

/** Average and peak of the raw readings in the window, or null when there are none. */
export function windowStats(columns, key, end, windowMs = HISTORY_SLOTS * SLOT_MS) {
  const times = Array.isArray(columns?.t) ? columns.t : []
  const values = Array.isArray(columns?.[key]) ? columns[key] : []
  let sum = 0
  let count = 0
  let peak = Number.NEGATIVE_INFINITY
  for (let i = 0; i < times.length; i += 1) {
    const value = values[i]
    if (!finite(times[i]) || !finite(value) || times[i] <= end - windowMs) continue
    sum += value
    count += 1
    peak = Math.max(peak, value)
  }
  return count > 0 ? { avg: sum / count, peak } : null
}

/** The newest reading in the columns, with its time. */
export function newestReading(columns, key) {
  const times = Array.isArray(columns?.t) ? columns.t : []
  const values = Array.isArray(columns?.[key]) ? columns[key] : []
  for (let i = times.length - 1; i >= 0; i -= 1) {
    if (finite(values[i]) && finite(times[i])) return { value: values[i], t: times[i] }
  }
  return null
}

/**
 * The command that installs Fleet Monitor on a paired machine, run on this computer. The machine
 * name is untrusted text pasted into a shell, so it is used only when double quotes keep it
 * literal in every common shell; otherwise the environment id (which Orca also accepts) is used.
 */
export function installCommand(machine) {
  const name = typeof machine?.name === 'string' ? machine.name : ''
  const id = typeof machine?.id === 'string' ? machine.id : ''
  const safe = (text) => text.length > 0 && text.length <= 128 && !/["$`\\!%^\u0000-\u001f\u007f]/.test(text)
  let target
  if (safe(name)) target = `"${name}"`
  else if (/^[A-Za-z0-9._:-]+$/.test(id)) target = id
  else target = `"${id.replace(/[^A-Za-z0-9._:-]/g, '')}"`
  return `orca plugin install ${INSTALL_SOURCE} --environment ${target}`
}

function localTag(platform) {
  if (platform === 'darwin') return 'This Mac'
  if (platform === 'win32') return 'This PC'
  return 'This machine'
}

const GROUP_ORDER = { performance: 0, efficiency: 1 }
const GROUP_LABEL = { performance: 'P-cores', efficiency: 'E-cores' }
const GROUP_SHORT = { performance: 'P', efficiency: 'E' }

function validGroups(groups, cores) {
  if (!Array.isArray(groups) || groups.length === 0) return null
  const seen = new Array(cores).fill(false)
  for (const g of groups) {
    if (!g || !(g.kind in GROUP_ORDER) || !Number.isInteger(g.start) || !Number.isInteger(g.count) || g.start < 0 || g.count < 1) return null
    for (let i = g.start; i < g.start + g.count; i += 1) {
      if (i >= cores || seen[i]) return null
      seen[i] = true
    }
  }
  return seen.every(Boolean) ? groups : null
}

/** Per-core load in the design's groups: P-cores then E-cores, or one group of every core. */
function coreGroupsOf(cpu, thresholds) {
  const perCore = Array.isArray(cpu?.perCore) && cpu.perCore.every(finite) ? cpu.perCore : null
  if (!perCore || perCore.length === 0) return null
  const groups = validGroups(cpu.groups, perCore.length)
  const list = groups
    ? [...groups].sort((a, b) => GROUP_ORDER[a.kind] - GROUP_ORDER[b.kind])
    : [{ kind: null, start: 0, count: perCore.length }]
  return list.map((g) => {
    const values = perCore.slice(g.start, g.start + g.count).map((v) => Math.min(100, Math.max(0, v)))
    return {
      label: g.kind ? GROUP_LABEL[g.kind] : 'Cores',
      short: g.kind ? GROUP_SHORT[g.kind] : null,
      values,
      tones: values.map((v) => levelFor(v, thresholds.cpu))
    }
  })
}

/** Busiest workspaces by CPU, then memory, from the worker's two top lists. CPU is turned from
 *  Orca's "percent of one core" into a share of the whole machine. */
function workspacesOf(lists, cores) {
  const seen = new Map()
  for (const w of [...(lists?.byCpu ?? []), ...(lists?.byMemory ?? [])]) {
    if (!w || typeof w !== 'object') continue
    const key = String(w.id || w.name || '')
    if (!key || seen.has(key)) continue
    seen.set(key, {
      id: key,
      name: String(w.name || w.id || ''),
      repo: typeof w.repo === 'string' ? w.repo : '',
      cpuPct: Math.max(0, finite(w.cpu) ? w.cpu : 0) / Math.max(1, cores ?? 1),
      memBytes: Math.max(0, finite(w.memory) ? w.memory : 0)
    })
  }
  return [...seen.values()].sort((a, b) => b.cpuPct - a.cpuPct || b.memBytes - a.memBytes).slice(0, TOP_WORKSPACES)
}

/** What the basic-tier row should say: install it there, enable it there, or check its beacon. */
function installHintOf(machine) {
  switch (machine.beacon?.remotePlugin) {
    case 'absent':
      return { reason: 'absent', command: installCommand(machine) }
    case 'installed':
      return { reason: 'installed', command: null }
    case 'running':
      return { reason: 'quiet', command: null }
    default:
      return null
  }
}

function toMachine(m, thresholds, now) {
  const local = m.kind === 'local'
  const online = m.online === true
  const status = online ? 'online' : m.status === 'connecting' ? 'connecting' : 'offline'
  const history = m.history ?? { t: [], cpu: [], mem: [] }
  const platform = m.host?.platform ?? null
  const cores = finite(m.host?.cores) && m.host.cores > 0 ? m.host.cores : Array.isArray(m.cpu?.perCore) ? m.cpu.perCore.length || null : null
  const basic = !local && m.tier !== 'full'
  const cpuPct = finite(m.cpu?.percent) ? m.cpu.percent : null
  const memReliable = Boolean(m.memory) && m.memory.reliable !== false
  const memPct = m.memory && finite(m.memory.percent) ? m.memory.percent : null
  const newestCpu = newestReading(history, 'cpu')
  const newestMem = newestReading(history, 'mem')
  const seen = [m.lastSeenAt, newestCpu?.t, newestMem?.t].filter(finite)
  const health = online ? (m.health?.level ?? 'unknown') : 'unknown'
  return {
    id: String(m.id),
    name: String(m.name || m.id),
    kind: local ? 'local' : 'remote',
    local,
    status,
    online,
    tier: basic ? 'basic' : 'full',
    tag: local ? localTag(platform) : basic ? 'Basic' : '',
    health,
    healthLabel: LEVEL_LABELS[health] ?? LEVEL_LABELS.unknown,
    reasons: Array.isArray(m.health?.reasons) ? m.health.reasons.filter((r) => typeof r === 'string') : [],
    updatedAt: seen.length > 0 ? Math.max(...seen) : null,
    lastSeenAt: finite(m.lastSeenAt) ? m.lastSeenAt : null,
    error: typeof m.error === 'string' && m.error ? m.error : null,
    platform,
    chip: typeof m.host?.cpuModel === 'string' && m.host.cpuModel ? m.host.cpuModel : null,
    cores,
    uptimeSec: online && finite(m.host?.uptimeSec) ? m.host.uptimeSec : null,
    load: m.load && finite(m.load.one) ? { one: m.load.one, five: finite(m.load.five) ? m.load.five : null, fifteen: finite(m.load.fifteen) ? m.load.fifteen : null } : null,
    cpu: {
      pct: cpuPct,
      estimated: m.cpu?.source === 'load',
      tone: m.health?.cpu ?? (cpuPct === null ? 'ok' : levelFor(cpuPct, thresholds.cpu)),
      history: bucketHistory(history, 'cpu', now),
      stats: windowStats(history, 'cpu', now),
      groups: online ? coreGroupsOf(m.cpu, thresholds) : null
    },
    mem: {
      pct: memPct,
      reliable: memReliable,
      usedBytes: m.memory && finite(m.memory.used) ? m.memory.used : null,
      totalBytes: m.memory && finite(m.memory.total) ? m.memory.total : null,
      tone: m.health?.memory ?? (memReliable && memPct !== null ? levelFor(memPct, thresholds.memory) : 'ok'),
      history: bucketHistory(history, 'mem', now),
      stats: windowStats(history, 'mem', now)
    },
    orca: m.orca && finite(m.orca.cpu) ? { cpuPct: m.orca.cpu / Math.max(1, cores ?? 1), memBytes: finite(m.orca.memory) ? m.orca.memory : null } : null,
    workspaces: online ? workspacesOf(m.workspaces, cores) : [],
    install: !local && online && basic ? installHintOf(m) : null,
    lastKnown: { cpuPct: newestCpu?.value ?? cpuPct, memPct: newestMem?.value ?? (memReliable ? memPct : null) }
  }
}

/**
 * The panel's model, in the shape of the design's sample `FLEET`: `state` is `loading` until the
 * first snapshot, `error` when it failed, else `live`. `now` is this machine's clock (the worker
 * runs on the same machine, so history times compare directly).
 */
export function toFleet(view, now = Date.now()) {
  if (!view || !view.ready) {
    return {
      state: view?.error ? 'error' : 'loading',
      error: view?.error ?? null,
      thresholds: readThresholds(null),
      cliError: null,
      online: 0,
      total: 0,
      remotes: 0,
      machines: []
    }
  }
  const thresholds = view.thresholds ?? readThresholds(null)
  const machines = (view.machines ?? []).filter((m) => m && m.id).map((m) => toMachine(m, thresholds, now))
  return {
    state: 'live',
    error: view.error ?? null,
    thresholds,
    cliError: view.cli?.error ?? null,
    online: machines.filter((m) => m.online).length,
    total: machines.length,
    remotes: machines.filter((m) => !m.local).length,
    machines
  }
}
