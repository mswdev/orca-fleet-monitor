// Data binding between a Fleet Monitor panel and its worker. No DOM drawing here: a view calls
// createFleetBinding(window.orca), subscribes, and draws what it is given. The visual design can
// replace index.html, style.css and view.mjs and keep this file.
//
// Contract with the worker (src/protocol.ts):
//   plugin.request('fleet.snapshot')  -> the whole fleet with history; counts as a heartbeat
//   plugin.request('fleet.heartbeat') -> keeps the worker polling fast while the panel is visible
//   plugin.on('fleet.update', ...)    -> current states plus each machine's recent points

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
    if (update.seq <= model.seq) return
    // Missed posts only lose points when the gap is longer than what each post repeats.
    const missed = update.seq > model.seq + 1 && update.generatedAt - model.generatedAt > (update.recentMs ?? 0)
    apply(update)
    emit()
    if (missed) refresh()
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
          if (update.seq > model.seq && !update.resync) apply(update)
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

  return {
    ready,
    current: view,
    refresh,
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
