// Data binding between a Fleet Monitor panel and its worker. No DOM here: the view calls
// createFleetBinding(window.orca), subscribes, turns each view into the panel's model with
// toFleet(view, now) and draws that.
//
// Contract with the worker (src/protocol.ts):
//   plugin.request('fleet.snapshot')  -> the whole fleet with history; counts as a heartbeat
//   plugin.request('fleet.heartbeat') -> keeps the worker polling fast while the panel is visible
//   plugin.request('fleet.retry')     -> reads one machine now ("Retry connection")
//   plugin.request('fleet.processes') -> one machine's processes (watchProcesses, toProcessList)
//   plugin.on('fleet.update', ...)    -> current states plus each machine's recent points
//
// toFleet() is where the live data meets the visual design: it produces the shape of the design's
// sample `FLEET` object (machines with CPU and memory percentages, 30 one-minute history points,
// per-core groups, top workspaces, facts), with the gaps the live data has made explicit.

export const HEARTBEAT_MS = 5_000
const REQUEST_TIMEOUT_MS = 10_000
/** How often watchProcesses asks: this computer's list is read only while asked (its memory
 *  figures come every 5 s, as Activity Monitor's do), and a paired Mac publishes its top list
 *  about every 30 s, which this computer reads within 5 s while a panel is open. */
export const PROCESS_POLL_MS = Object.freeze({ local: 5_000, remote: 10_000 })
/** Older history rewritten (a back-fill) re-fetches the fleet at most this often. */
export const REWRITE_REFRESH_MS = 15_000

/** Merges `extra` history columns into `base` by time (same time: extra wins), oldest first,
 *  keeping only points within `windowMs` of the newest. `ram` (RAM in use, from a Mac's own
 *  reading) is kept when either side has it, and left out when neither does. */
export function mergeColumns(base, extra, windowMs) {
  const byTime = new Map()
  // Optional columns: `ram`, then the 1.2 ones (network, disk, GPU, battery).
  const optional = ['ram', ...EXTRA_HISTORY_KEYS]
  const present = new Set()
  for (const cols of [base, extra]) {
    if (!cols || !Array.isArray(cols.t)) continue
    const columns = optional.map((key) => (Array.isArray(cols[key]) ? cols[key] : null))
    optional.forEach((key, k) => columns[k] && present.add(key))
    for (let i = 0; i < cols.t.length; i += 1) {
      byTime.set(cols.t[i], [cols.cpu?.[i] ?? null, cols.mem?.[i] ?? null, ...columns.map((c) => c?.[i] ?? null)])
    }
  }
  const times = [...byTime.keys()].sort((a, b) => a - b)
  const newest = times[times.length - 1] ?? 0
  const kept = times.filter((t) => t >= newest - windowMs)
  const merged = {
    t: kept,
    cpu: kept.map((t) => byTime.get(t)[0]),
    mem: kept.map((t) => byTime.get(t)[1])
  }
  optional.forEach((key, k) => {
    if (present.has(key)) merged[key] = kept.map((t) => byTime.get(t)[2 + k])
  })
  return merged
}

/** The history columns 1.2 adds: network bytes per second received and sent, disk bytes per
 *  second read and written, GPU %, battery %. */
export const EXTRA_HISTORY_KEYS = Object.freeze(['rx', 'tx', 'dr', 'dw', 'gpu', 'bat'])

const emptyColumns = () => ({ t: [], cpu: [], mem: [] })

/**
 * A machine state as the panel keeps it. One the worker sent lean (marked `lean`: without per-core
 * values and workspaces, to fit Orca's size caps) gets the detail this panel already holds for it
 * where that still applies: per-core values while its CPU is read the same way on the same tier,
 * workspaces while it stays online. A machine that dropped a tier or went offline loses them.
 * Any other state is taken as it is.
 */
export function keepDetail(state, previous) {
  if (!state || state.lean !== true || !previous || state.online !== true || previous.online !== true) return state
  const sameCpu =
    state.tier === previous.tier && state.cpu?.source === previous.cpu?.source && state.cpu?.perCore == null
  return {
    ...state,
    cpu: sameCpu ? { ...state.cpu, perCore: previous.cpu?.perCore ?? null, groups: previous.cpu?.groups ?? null } : state.cpu,
    workspaces: previous.workspaces ?? state.workspaces
  }
}

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

  const now = options.now ?? (() => Date.now())
  const listeners = new Set()
  /** { seq, generatedAt, mode, intervalMs, historyWindowMs, cli, order: string[], machines: Map } */
  let model = null
  let error = null
  let fetching = null
  let buffered = []
  let wasVisible = isVisible()
  let disposed = false
  /** When older history being rewritten last made this panel re-fetch (this frame's clock). */
  let rewriteRefreshAt = Number.NEGATIVE_INFINITY
  /** The worker's clock minus this frame's, from the newest answer or post (see src/worker.ts:
   *  the worker keeps its own steady clock, which a wall-clock step does not move). */
  let clockOffsetMs = 0
  const noteClock = (generatedAt) => {
    if (finite(generatedAt)) clockOffsetMs = generatedAt - now()
  }

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
      omitted: model.omitted,
      clockOffsetMs,
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

  function fromSnapshot(snapshot, previous) {
    const machines = new Map()
    for (const machine of snapshot.machines ?? []) {
      const state = keepDetail(machine, previous?.machines.get(machine.id))
      machines.set(machine.id, { ...state, history: machine.history ?? emptyColumns() })
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
      omitted: finite(snapshot.omitted) && snapshot.omitted > 0 ? snapshot.omitted : 0,
      order: (snapshot.machines ?? []).map((m) => m.id),
      machines
    }
  }

  function apply(update) {
    const machines = new Map()
    for (const state of update.machines ?? []) {
      const previous = model.machines.get(state.id)
      const history = mergeColumns(previous?.history ?? emptyColumns(), update.appended?.[state.id], model.historyWindowMs)
      machines.set(state.id, { ...keepDetail(state, previous), history })
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
    noteClock(update.generatedAt)
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
    if (missed) refresh()
    else if (rewritten && now() - rewriteRefreshAt >= REWRITE_REFRESH_MS) {
      // A long round of reads can back-fill a little with nearly every read; one re-fetch per
      // REWRITE_REFRESH_MS catches all of it without fetching the whole fleet every second.
      rewriteRefreshAt = now()
      refresh()
    }
  }

  /**
   * Fetches the whole fleet again. Only a visible panel does: every snapshot request counts as a
   * heartbeat and keeps the worker polling fast, so a hidden panel that re-fetched on each
   * resync would keep it fast for ever. A hidden panel notes that it is behind and fetches as it
   * comes back into view.
   */
  function refresh() {
    if (disposed) return Promise.resolve()
    if (!isVisible()) return fetching ?? Promise.resolve()
    if (fetching) return fetching
    buffered = []
    fetching = plugin
      .request('fleet.snapshot', undefined, { timeoutMs: REQUEST_TIMEOUT_MS })
      .then((snapshot) => {
        noteClock(snapshot?.generatedAt)
        model = fromSnapshot(snapshot, model)
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
    // Coming back: the worker has slowed down and stopped posting, and anything a hidden panel
    // was told to re-fetch is still to do.
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

  /** One machine's processes (`fleet.processes`): the answer, or `{ state: 'error', error }`. */
  function processes(id) {
    if (disposed) return Promise.resolve({ state: 'error', error: 'disposed', machineId: id })
    return plugin
      .request('fleet.processes', { id }, { timeoutMs: REQUEST_TIMEOUT_MS })
      .then((answer) => (answer && typeof answer === 'object' ? answer : { state: 'error', error: 'bad answer', machineId: id }))
      .catch((err) => ({ state: 'error', error: (err && (err.code || err.message)) || 'request failed', machineId: id }))
  }

  /**
   * Keeps one machine's process list coming while the panel is visible: asks now, then every
   * `intervalMs` (PROCESS_POLL_MS: 5 s for this computer, whose list is read only while asked;
   * 10 s for a paired Mac, which publishes every 30 s), never two at once, and not while hidden
   * (asking again as it comes back). Returns a function that stops it; stop it as soon as the
   * list is off screen, so this computer stops reading its processes.
   */
  function watchProcesses(id, listener, opts = {}) {
    const intervalMs = finite(opts.intervalMs) && opts.intervalMs >= 1_000 ? opts.intervalMs : id === 'local' ? PROCESS_POLL_MS.local : PROCESS_POLL_MS.remote
    let stopped = false
    let inFlight = false
    const ask = () => {
      if (stopped || disposed || inFlight || !isVisible()) return
      inFlight = true
      processes(id)
        .then((answer) => {
          if (stopped || disposed) return
          try {
            listener(answer)
          } catch (err) {
            console.error('process view failed', err)
          }
        })
        .finally(() => {
          inFlight = false
        })
    }
    const handle = startTimer(ask, intervalMs)
    const stopWatching = onVisibilityChange(() => {
      if (isVisible()) ask()
    })
    ask()
    return () => {
      stopped = true
      stopTimer(handle)
      stopWatching()
    }
  }

  return {
    ready,
    current: view,
    refresh,
    retry,
    processes,
    watchProcesses,
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

/**
 * The frame's `orca.shell.openExternal`, when this Orca offers it to a panel, else null. It exists
 * only in the desktop app and needs a click or key press; `orca.host.has` says whether it is
 * there, so the panel shows a link only where it can open it.
 */
export function externalOpener(orca) {
  try {
    if (typeof orca?.host?.has !== 'function' || orca.host.has('shell.openExternal') !== true) return null
    if (typeof orca.shell?.openExternal !== 'function') return null
  } catch {
    return null
  }
  return (url) => orca.shell.openExternal(url)
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
/** What `orca plugin install` takes to install Fleet Monitor from Orca's community catalog (its catalog id). */
export const INSTALL_SOURCE = 'mswdev.fleet-monitor'
export const LEVEL_LABELS = Object.freeze({
  ok: 'OK',
  busy: 'Busy',
  strained: 'Strained',
  critical: 'Critical',
  unknown: 'Waiting'
})

const finite = (value) => typeof value === 'number' && Number.isFinite(value)
/** Own keys only: a lookup by remote text must never reach Object.prototype (`toString`, ...). */
const own = (table, key) => (typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined)
const LEVELS = ['ok', 'busy', 'strained', 'critical']
const levelOrNull = (value) => (LEVELS.includes(value) ? value : null)
/** More cores than this are not drawn one by one. */
export const MAX_CORES_DRAWN = 256

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

/** The launcher names Orca's CLI goes by: `orca-ide` on Linux desktops (where `orca` is GNOME's
 *  screen reader), `orca` elsewhere. */
export const LAUNCHERS = Object.freeze(['orca', 'orca-ide'])

/** A machine name that reads the same, as one argument, in every common shell (sh, bash, zsh,
 *  fish, cmd.exe and PowerShell) inside straight double quotes: plain ASCII letters, digits,
 *  spaces, `.`, `_`, `-` and the straight apostrophe. Not curly quotes, which PowerShell takes for
 *  quote marks; not `$`, backticks, `%`, `!` or `^`; and not a leading `-`, which the CLI would
 *  read as an option. */
const SAFE_NAME = /^[A-Za-z0-9._' -]{1,64}$/
/** An environment id that needs no quotes anywhere: Orca makes them (UUIDs) when it pairs. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function safeMachineName(name) {
  return typeof name === 'string' && SAFE_NAME.test(name) && !name.startsWith('-') && name.trim() === name
}

/** A server name as Orca's CLI compares what is typed after `--environment` (its
 *  normalizeTypedName): trimmed, one pair of wrapping straight quotes dropped, trimmed again,
 *  case ignored. */
export function typedName(name) {
  if (typeof name !== 'string') return ''
  let value = name.trim()
  const quote = value[0]
  if (value.length >= 2 && (quote === "'" || quote === '"') && value[value.length - 1] === quote) value = value.slice(1, -1)
  return value.trim().toLowerCase()
}

/** `--environment local`, in any case and quoted or not, is this computer to Orca's CLI. */
const LOCAL_SELECTOR = 'local'

/**
 * The command that installs Fleet Monitor on a paired machine, run on this computer, or null when
 * none can be written safely. The machine name comes from that machine, so it is untrusted text
 * a person will paste into a shell: it is used only when `safeMachineName` allows it, when the CLI
 * would not read it as `local` (this computer), and when no other paired machine answers to it
 * (`ambiguous`, worked out by toFleet); otherwise the environment id, which Orca also accepts, in
 * the `--environment=<id>` form. With neither, there is no command, only words.
 */
export function installCommand(machine, options = {}) {
  const name = typeof machine?.name === 'string' ? machine.name : ''
  const id = typeof machine?.id === 'string' ? machine.id : ''
  const launcher = LAUNCHERS.includes(options.launcher) ? options.launcher : 'orca'
  const head = `${launcher} plugin install ${INSTALL_SOURCE}`
  if (safeMachineName(name) && !options.ambiguous && typedName(name) !== LOCAL_SELECTOR) return `${head} --environment "${name}"`
  if (SAFE_ID.test(id)) return `${head} --environment=${id}`
  return null
}

/** Ids of the paired machines whose name does not pick out only them in `--environment <name>`:
 *  Orca takes an exact id first, then a name compared as `typedName` does, so a name another
 *  machine also answers to (or that is another machine's id) is ambiguous. */
function ambiguousNames(remotes) {
  const counts = new Map()
  for (const m of remotes) counts.set(typedName(m.name), (counts.get(typedName(m.name)) ?? 0) + 1)
  const ids = new Set(remotes.map((m) => m.id))
  const out = new Set()
  for (const m of remotes) {
    if (counts.get(typedName(m.name)) > 1 || (ids.has(m.name) && m.name !== m.id)) out.add(m.id)
  }
  return out
}

/** Unicode's bidirectional controls, which could reorder how remote text is drawn. The worker
 *  already replaces them (src/bounds.ts); this is the panel's own check. */
const BIDI_CONTROLS = /[؜‎‏‪-‮⁦-⁩]/g
const plainText = (value) => String(value).replace(BIDI_CONTROLS, '�')

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
    if (!g || own(GROUP_ORDER, g.kind) === undefined || !Number.isInteger(g.start) || !Number.isInteger(g.count) || g.start < 0 || g.count < 1) return null
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
  if (!perCore || perCore.length === 0 || perCore.length > MAX_CORES_DRAWN) return null
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
      name: plainText(w.name || w.id || ''),
      repo: typeof w.repo === 'string' ? plainText(w.repo) : '',
      cpuPct: Math.min(100, Math.max(0, finite(w.cpu) ? w.cpu : 0) / Math.max(1, cores ?? 1)),
      memBytes: Math.max(0, finite(w.memory) ? w.memory : 0)
    })
  }
  return [...seen.values()].sort((a, b) => b.cpuPct - a.cpuPct || b.memBytes - a.memBytes).slice(0, TOP_WORKSPACES)
}

/** What the basic-tier row should say: install it there, enable it there, or check its beacon.
 *  `mac: true` on the install hint says the machine is a Mac, where installing Fleet Monitor also
 *  adds RAM in use, swap and pressure. */
function installHintOf(machine, context, mac) {
  switch (machine.beacon?.remotePlugin) {
    case 'absent':
      return {
        reason: 'absent',
        command: installCommand(machine, { launcher: context.launcher, ambiguous: context.ambiguous.has(machine.id) }),
        launcher: context.launcher,
        ...(mac ? { mac: true } : {})
      }
    case 'installed':
      return { reason: 'installed', command: null }
    case 'running':
      return { reason: 'quiet', command: null }
    default:
      return null
  }
}

const PRESSURE_LEVELS = ['normal', 'warning', 'critical']
const bytesOrNull = (value) => (finite(value) && value >= 0 ? value : null)
const rateOrNull = (value) => (finite(value) && value >= 0 ? value : null)

/**
 * How a machine's memory is to be shown:
 *   used      a Mac's own reading (Fleet Monitor 1.1 there, or this Mac): RAM in use as Activity
 *             Monitor counts it, with its parts, swap and macOS's pressure level
 *   pressure  Orca's reading of a Mac: memory pressure, never to be called "used"
 *   orca      Orca's figure elsewhere (Linux MemAvailable, Windows), shown as it always was
 */
function memoryKindOf(memory) {
  if (memory?.kind === 'used' && memory.mac && typeof memory.mac === 'object') return 'used'
  if (memory?.kind === 'pressure') return 'pressure'
  if (memory?.kind === 'unavailable') return 'unavailable'
  return 'orca'
}

const LOST_LABELS = Object.freeze({ unanswered: 'Stopped answering', stale: 'Readings stopped' })

/** A machine that stopped answering (or whose readings stopped) while its memory was elevated:
 *  what to say, its last reading, and the level it is drawn at (never below strained). */
function lostOf(m) {
  const lost = m.lost
  if (!lost || typeof lost !== 'object') return null
  const how = own(LOST_LABELS, lost.how) ? lost.how : 'unanswered'
  const last = levelOrNull(lost.level)
  return {
    how,
    label: LOST_LABELS[how],
    summary: typeof lost.summary === 'string' ? plainText(lost.summary.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')).slice(0, 200) : '',
    level: last === 'critical' ? 'critical' : 'strained',
    lastReadingAt: finite(lost.lastReadingAt) ? lost.lastReadingAt : null,
    since: finite(lost.since) ? lost.since : null
  }
}

/** A Mac's own reading, as the detail rows show it; null for any other machine. */
function macDetailOf(mac) {
  if (!mac || typeof mac !== 'object') return null
  const level = PRESSURE_LEVELS.includes(mac.pressure) ? mac.pressure : null
  const available = finite(mac.availablePercent) ? Math.min(100, Math.max(0, mac.availablePercent)) : null
  return {
    appBytes: bytesOrNull(mac.app),
    wiredBytes: bytesOrNull(mac.wired),
    compressedBytes: bytesOrNull(mac.compressed),
    cachedBytes: bytesOrNull(mac.cached),
    swapUsedBytes: bytesOrNull(mac.swapUsed),
    swapTotalBytes: bytesOrNull(mac.swapTotal),
    swapInsPerSec: rateOrNull(mac.swapInsPerSec),
    swapOutsPerSec: rateOrNull(mac.swapOutsPerSec),
    pressure: level,
    availablePct: available
  }
}

/** Why a memory pressure reading is all there is for a Mac, and what would add RAM in use. */
function pressureNoteOf(m, local, basic) {
  if (local) return 'own'
  if (basic) {
    const plugin = m.beacon?.remotePlugin
    return plugin === 'installed' ? 'enable' : plugin === 'running' ? 'quiet' : 'install'
  }
  return 'update'
}

const ageSecOf = (ms) => (finite(ms) && ms >= 1_000 ? Math.round(ms / 1_000) : null)
const nonNegative = (value) => (finite(value) && value >= 0 ? value : null)
const BATTERY_STATES = ['charging', 'discharging', 'charged', 'not-charging']
const POWER_SOURCES = ['ac', 'battery', 'ups']

/** A history column as the charts take it: HISTORY_SLOTS one-minute means, and the window's
 *  average and peak. */
function seriesOf(history, key, now) {
  return { history: bucketHistory(history, key, now), stats: windowStats(history, key, now) }
}

/**
 * A Mac's network, disk, GPU and battery, as the panel shows them; each null where the machine
 * reports none (anything but a Mac running Fleet Monitor 1.2, or this Mac) or it is not online.
 * Rates are bytes per second; `ageSec` is set only on a figure carried from an earlier read.
 */
function systemOf(m, history, now) {
  const s = m.online === true && m.system && typeof m.system === 'object' ? m.system : null
  const net = s?.net && typeof s.net === 'object' && typeof s.net.iface === 'string' ? s.net : null
  const disk = s?.disk && typeof s.disk === 'object' ? s.disk : null
  const gpu = s?.gpu && typeof s.gpu === 'object' && finite(s.gpu.percent) ? s.gpu : null
  const bat = s?.battery && typeof s.battery === 'object' && typeof s.battery.present === 'boolean' ? s.battery : null
  const total = disk ? nonNegative(disk.totalBytes) : null
  const used = disk && total !== null && total > 0 ? nonNegative(disk.usedBytes) : null
  return {
    net: net
      ? {
          iface: plainText(net.iface).slice(0, 16),
          rxBytesPerSec: nonNegative(net.rxBytesPerSec),
          txBytesPerSec: nonNegative(net.txBytesPerSec),
          ageSec: ageSecOf(net.ageMs),
          rx: seriesOf(history, 'rx', now),
          tx: seriesOf(history, 'tx', now)
        }
      : null,
    disk: disk
      ? {
          totalBytes: used === null ? null : total,
          usedBytes: used === null ? null : Math.min(used, total),
          freeBytes: used === null ? null : Math.max(0, total - used),
          usedPct: used === null ? null : Math.min(100, (used / total) * 100),
          spaceAgeSec: ageSecOf(disk.spaceAgeMs),
          readBytesPerSec: nonNegative(disk.readBytesPerSec),
          writeBytesPerSec: nonNegative(disk.writeBytesPerSec),
          ioAgeSec: ageSecOf(disk.ioAgeMs),
          read: seriesOf(history, 'dr', now),
          write: seriesOf(history, 'dw', now)
        }
      : null,
    gpu: gpu ? { pct: Math.min(100, Math.max(0, gpu.percent)), ageSec: ageSecOf(gpu.ageMs), ...seriesOf(history, 'gpu', now) } : null,
    battery: bat
      ? {
          present: bat.present,
          pct: bat.present && finite(bat.percent) ? Math.min(100, Math.max(0, bat.percent)) : null,
          state: bat.present && BATTERY_STATES.includes(bat.state) ? bat.state : null,
          source: POWER_SOURCES.includes(bat.source) ? bat.source : null,
          minutesRemaining: bat.present ? nonNegative(bat.minutesRemaining) : null,
          ageSec: ageSecOf(bat.ageMs),
          ...seriesOf(history, 'bat', now)
        }
      : null
  }
}

const PROCESS_STATES = ['full', 'top', 'waiting', 'unavailable']
const PROCESS_REASONS = ['not-mac', 'basic', 'outdated', 'no-reader', 'publishing-off', 'not-read-yet', 'offline', 'unknown-machine', 'failed']

/** Whether a machine has a process list, and the process using the most memory in its newest
 *  one, with its share of the machine's RAM. */
function processSummaryOf(m, memTotal, now) {
  const p = m.processes && typeof m.processes === 'object' ? m.processes : null
  const state = p && PROCESS_STATES.includes(p.state) ? p.state : 'unavailable'
  const l = p?.largest && typeof p.largest === 'object' ? p.largest : null
  const largest =
    l && Number.isInteger(l.pid) && typeof l.name === 'string' && finite(l.mem) && l.mem > 0
      ? { pid: l.pid, name: cleanName(l.name), memBytes: l.mem, memPct: finite(memTotal) && memTotal > 0 ? Math.min(100, (l.mem / memTotal) * 100) : null }
      : null
  const takenAt = p && finite(p.takenAt) ? p.takenAt : null
  const ageMs = takenAt === null ? null : Math.max(0, now - takenAt)
  const memAgeMs = p && finite(p.memAgeMs) && p.memAgeMs >= 0 ? p.memAgeMs : null
  const largestAt = p && finite(p.largestAt) ? p.largestAt : null
  return {
    state,
    reason: state === 'unavailable' ? (PROCESS_REASONS.includes(p?.reason) ? p.reason : null) : null,
    /** A paired Mac's own top list (about 60 processes), not the whole list. */
    topList: state === 'top' || state === 'waiting',
    takenAt,
    ageSec: ageMs === null ? null : Math.round(ageMs / 1_000),
    /** How old the largest process's memory figure is now: it is carried through pauses (memory
     *  critical there), so it can be minutes old while the list itself is newer, or gone. */
    memAgeSec:
      largest === null
        ? null
        : largestAt !== null
          ? Math.max(0, Math.round((now - largestAt) / 1_000))
          : ageMs === null || memAgeMs === null
            ? null
            : Math.round((ageMs + memAgeMs) / 1_000),
    largest
  }
}

/** A process name or user name from a list: plain text on one line, bounded. */
function cleanName(value) {
  return plainText(String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')).trim().slice(0, 128)
}

function toMachine(m, thresholds, now, context) {
  const local = m.kind === 'local'
  const online = m.online === true
  const status = online ? 'online' : m.status === 'connecting' ? 'connecting' : 'offline'
  const history = m.history ?? { t: [], cpu: [], mem: [] }
  const platform = m.host?.platform ?? null
  const cores = finite(m.host?.cores) && m.host.cores > 0 ? m.host.cores : Array.isArray(m.cpu?.perCore) ? m.cpu.perCore.length || null : null
  const basic = !local && m.tier !== 'full'
  const percent = (value) => (finite(value) ? Math.min(100, Math.max(0, value)) : null)
  const cpuPct = percent(m.cpu?.percent)
  // An estimate from the load average is shown, labelled, but never judged or coloured.
  const estimated = m.cpu?.source === 'load'
  const memReliable = Boolean(m.memory) && m.memory.reliable !== false
  const memPct = m.memory ? percent(m.memory.percent) : null
  const memKind = memoryKindOf(m.memory)
  // Each kind has its own history column, so RAM in use and pressure never share a chart.
  const memKey = memKind === 'used' ? 'ram' : 'mem'
  const mac = memKind === 'used' ? macDetailOf(m.memory.mac) : null
  // A Mac: its own reading, Orca's pressure reading of it, or its beacon says so.
  const isMac = memKind === 'used' || memKind === 'pressure' || platform === 'darwin'
  const newestCpu = newestReading(history, 'cpu')
  const newestMem = newestReading(history, memKey)
  const seen = [m.lastSeenAt, newestCpu?.t, newestMem?.t].filter(finite)
  const lost = local ? null : lostOf(m)
  // Offline and lost: drawn at the level of its last reading, so it is not mistaken for a quiet one.
  const health = online ? (levelOrNull(m.health?.level) ?? 'unknown') : lost ? lost.level : 'unknown'
  const perCoreCount = Array.isArray(m.cpu?.perCore) ? m.cpu.perCore.length : 0
  return {
    id: String(m.id),
    name: plainText(m.name || m.id),
    kind: local ? 'local' : 'remote',
    local,
    status,
    online,
    tier: basic ? 'basic' : 'full',
    tag: local ? localTag(platform) : basic ? 'Basic' : '',
    health,
    healthLabel: !online && lost ? lost.label : (own(LEVEL_LABELS, health) ?? LEVEL_LABELS.unknown),
    reasons: (online || lost) && Array.isArray(m.health?.reasons) ? m.health.reasons.filter((r) => typeof r === 'string' && r !== 'offline').map(plainText).slice(0, 4) : [],
    lost,
    updatedAt: seen.length > 0 ? Math.max(...seen) : null,
    lastSeenAt: finite(m.lastSeenAt) ? m.lastSeenAt : null,
    error: typeof m.error === 'string' && m.error ? plainText(m.error) : null,
    platform,
    chip: typeof m.host?.cpuModel === 'string' && m.host.cpuModel ? plainText(m.host.cpuModel) : null,
    cores,
    uptimeSec: online && finite(m.host?.uptimeSec) ? m.host.uptimeSec : null,
    load: m.load && finite(m.load.one) ? { one: m.load.one, five: finite(m.load.five) ? m.load.five : null, fifteen: finite(m.load.fifteen) ? m.load.fifteen : null } : null,
    cpu: {
      pct: cpuPct,
      estimated,
      tone: estimated ? 'ok' : (levelOrNull(m.health?.cpu) ?? (cpuPct === null ? 'ok' : levelFor(cpuPct, thresholds.cpu))),
      history: bucketHistory(history, 'cpu', now),
      stats: windowStats(history, 'cpu', now),
      groups: online ? coreGroupsOf(m.cpu, thresholds) : null,
      // Too many to draw one by one: the view says so rather than leave the section out unsaid.
      coresHidden: online && perCoreCount > MAX_CORES_DRAWN ? perCoreCount : 0
    },
    mem: {
      kind: memKind,
      /** What the figure is called: never "used" for Orca's pressure reading of a Mac. */
      label: memKind === 'pressure' ? 'Memory pressure' : 'Memory',
      // Orca's free memory on a Mac is neither RAM in use nor pressure: no figure is shown.
      pct: memKind === 'unavailable' ? null : memPct,
      reliable: memReliable && memKind !== 'unavailable',
      /** Carried over a failed read on that Mac, for longer than a reading or two: how old, in s. */
      carriedSec: memKind === 'used' && finite(m.memory.mac.ageMs) && m.memory.mac.ageMs >= 1_000 ? Math.round(m.memory.mac.ageMs / 1_000) : null,
      // Orca's "used" on a Mac is pressure, not RAM in use, so it is not shown as such.
      usedBytes: memKind !== 'pressure' && memKind !== 'unavailable' && m.memory && finite(m.memory.used) ? m.memory.used : null,
      totalBytes: m.memory && finite(m.memory.total) ? m.memory.total : null,
      tone: levelOrNull(m.health?.memory) ?? (memReliable && memPct !== null ? levelFor(memPct, thresholds.memory) : 'ok'),
      history: bucketHistory(history, memKey, now),
      stats: windowStats(history, memKey, now),
      mac,
      /** Memory pressure (100 − available) beside RAM in use, for a Mac's own reading. */
      pressurePct: memKind === 'used' ? percent(m.memory.pressurePercent) : null,
      pressureNote: memKind === 'pressure' ? pressureNoteOf(m, local, basic) : null
    },
    orca: m.orca && finite(m.orca.cpu) ? { cpuPct: m.orca.cpu / Math.max(1, cores ?? 1), memBytes: finite(m.orca.memory) ? m.orca.memory : null } : null,
    workspaces: online ? workspacesOf(m.workspaces, cores) : [],
    install: !local && online && basic ? installHintOf(m, context, isMac) : null,
    lastKnown: { cpuPct: newestCpu?.value ?? cpuPct, memPct: newestMem?.value ?? (memReliable ? memPct : null) },
    ...systemOf(m, history, now),
    processes: processSummaryOf(m, m.memory && finite(m.memory.total) ? m.memory.total : null, now)
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
      launcher: 'orca',
      omitted: 0,
      online: 0,
      total: 0,
      remotes: 0,
      machines: []
    }
  }
  const thresholds = view.thresholds ?? readThresholds(null)
  const raw = (view.machines ?? []).filter((m) => m && m.id)
  const localPlatform = raw.find((m) => m.kind === 'local')?.host?.platform ?? null
  const launcher = LAUNCHERS.includes(view.cli?.launcher) ? view.cli.launcher : localPlatform === 'linux' ? 'orca-ide' : 'orca'
  const ambiguous = ambiguousNames(raw.filter((m) => m.kind !== 'local'))
  const machines = raw.map((m) => toMachine(m, thresholds, now, { launcher, ambiguous }))
  const cliError = [view.cli?.error, view.cli?.runError].map((e) => (typeof e === 'string' && e ? plainText(e) : null)).find(Boolean) ?? null
  return {
    state: 'live',
    error: view.error ?? null,
    thresholds,
    cliError,
    launcher,
    omitted: finite(view.omitted) && view.omitted > 0 ? view.omitted : 0,
    online: machines.filter((m) => m.online).length,
    total: machines.length,
    remotes: machines.filter((m) => !m.local).length,
    machines
  }
}

// --- Process lists ----------------------------------------------------------------------------

/** The keys a process list sorts by, and the direction each starts in. */
export const PROCESS_SORT_KEYS = Object.freeze({ name: 'asc', pid: 'asc', user: 'asc', cpu: 'desc', mem: 'desc', energy: 'desc' })
/** Most rows a list model holds: far more than any Mac runs. */
export const MAX_PROCESS_ROWS = 10_000

const LIST_STATES = ['ok', 'waiting', 'unavailable']

/** One process row from an answer's columns, checked; null when its pid is not a whole number. */
function processRowAt(c, i) {
  const pid = c.pid[i]
  if (!Number.isInteger(pid) || pid < 0) return null
  const name = typeof c.name?.[i] === 'string' ? cleanName(c.name[i]) : ''
  const user = typeof c.user?.[i] === 'string' ? cleanName(c.user[i]).slice(0, 32) : null
  return {
    pid,
    ppid: Number.isInteger(c.ppid?.[i]) ? c.ppid[i] : null,
    name: name || String(pid),
    user,
    cpuPct: nonNegative(c.cpu?.[i]),
    memBytes: nonNegative(c.mem?.[i]),
    energy: nonNegative(c.energy?.[i]),
    start: nonNegative(c.start?.[i]),
    largest: false
  }
}

const SORT_FIELD = { name: 'name', pid: 'pid', user: 'user', cpu: 'cpuPct', mem: 'memBytes', energy: 'energy' }

/** A comparison for `key` in `dir`: rows without a figure last whichever way, then by pid. */
export function compareProcesses(key, dir) {
  const field = own(SORT_FIELD, key) ?? 'memBytes'
  const sign = dir === 'asc' ? 1 : -1
  return (a, b) => {
    const x = a[field]
    const y = b[field]
    if (x === null || x === undefined) return y === null || y === undefined ? a.pid - b.pid : 1
    if (y === null || y === undefined) return -1
    const order = typeof x === 'string' ? x.localeCompare(y, undefined, { sensitivity: 'base', numeric: true }) : x - y
    return order !== 0 ? sign * order : a.pid - b.pid
  }
}

/** Does a row match a filter (already trimmed and lower case)? Its name or user contains it, or
 *  its pid starts with it. */
function matches(row, query) {
  if (!query) return true
  if (/^\d+$/.test(query) && String(row.pid).startsWith(query)) return true
  return row.name.toLowerCase().includes(query) || (row.user !== null && row.user.toLowerCase().includes(query))
}

/**
 * A `fleet.processes` answer as the panel shows it: rows checked, filtered by `query` (name, user
 * or pid), sorted by `sort` (a PROCESS_SORT_KEYS key; `dir` defaults to that key's own), and the
 * row using the most memory marked `largest` (worked out here from the figures, whatever the
 * worker or a remote said). `now` is the worker's clock, as for toFleet().
 */
export function toProcessList(answer, options = {}, now = Date.now()) {
  const key = typeof options.sort === 'string' && own(PROCESS_SORT_KEYS, options.sort) ? options.sort : 'mem'
  const dir = options.dir === 'asc' || options.dir === 'desc' ? options.dir : PROCESS_SORT_KEYS[key]
  const query = typeof options.query === 'string' ? options.query.trim().toLowerCase().slice(0, 100) : ''
  const base = { machineId: typeof answer?.machineId === 'string' ? answer.machineId : null, sort: { key, dir }, query, rows: [], count: 0, shown: 0, largest: null }
  if (!answer || typeof answer !== 'object') return { ...base, state: 'loading', reason: null, error: null, scope: null, topList: false, takenAt: null, ageSec: null, cpuWindowSec: null, memAgeSec: null, energyWindowSec: null, total: null, truncated: false }
  const state = answer.state === 'error' ? 'error' : LIST_STATES.includes(answer.state) ? answer.state : 'error'
  const c = answer.columns && typeof answer.columns === 'object' && Array.isArray(answer.columns.pid) ? answer.columns : null
  const rows = []
  const seen = new Set()
  if (state === 'ok' && c) {
    for (let i = 0; i < c.pid.length && rows.length < MAX_PROCESS_ROWS; i += 1) {
      const row = processRowAt(c, i)
      if (row && !seen.has(row.pid)) {
        seen.add(row.pid)
        rows.push(row)
      }
    }
  }
  let largest = null
  for (const row of rows) if (row.memBytes !== null && row.memBytes > 0 && (!largest || row.memBytes > largest.memBytes)) largest = row
  if (largest) largest.largest = true
  const shown = rows.filter((row) => matches(row, query)).sort(compareProcesses(key, dir))
  const takenAt = finite(answer.takenAt) ? answer.takenAt : null
  const sec = (ms) => (finite(ms) && ms >= 0 ? Math.round(ms / 1_000) : null)
  return {
    ...base,
    state,
    reason: state === 'unavailable' && PROCESS_REASONS.includes(answer.reason) ? answer.reason : null,
    error: state === 'error' ? plainText(String(answer.error ?? 'bad answer')).slice(0, 200) : null,
    scope: answer.scope === 'top' ? 'top' : answer.scope === 'full' ? 'full' : null,
    /** A paired Mac's own top list (about 40 by memory and 20 by CPU), not every process. */
    topList: answer.scope === 'top',
    takenAt,
    ageSec: takenAt === null ? null : Math.max(0, Math.round((now - takenAt) / 1_000)),
    cpuWindowSec: sec(answer.cpuWindowMs),
    memAgeSec: sec(answer.memAgeMs),
    energyWindowSec: sec(answer.energyWindowMs),
    total: Number.isInteger(answer.total) && answer.total >= 0 ? answer.total : null,
    truncated: answer.truncated === true,
    count: rows.length,
    shown: shown.length,
    largest: largest ? { pid: largest.pid, name: largest.name, memBytes: largest.memBytes } : null,
    rows: shown
  }
}

