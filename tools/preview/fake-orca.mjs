// A stand-in for the `window.orca` an Orca panel frame gets, answering the panel's requests with
// the invented sample fleet. Only what the Fleet Monitor panel uses is here.
import { sampleSnapshot } from './sample-fleet.mjs'

/**
 * state: live | empty | connecting | loading (never answers) | error (worker unreachable)
 * live: true posts a changing update every 2 s, as the worker does while a panel is open.
 */
export function createFakeOrca({ state = 'live', live = false, now = () => Date.now() } = {}) {
  const handlers = new Map()
  let seq = 1
  let snapshot = null
  const requests = []

  function post(event, payload) {
    for (const handler of handlers.get(event) ?? []) handler(payload)
  }

  if (live && state !== 'loading' && state !== 'error') {
    setInterval(() => {
      if (!snapshot) return
      seq += 1
      const t = now()
      const machines = snapshot.machines.map(({ history, ...m }) => {
        if (!m.online || typeof m.cpu.percent !== 'number') return m
        const cpu = Math.min(100, Math.max(0, m.cpu.percent + (Math.random() - 0.5) * 6))
        return { ...m, lastSeenAt: t, cpu: { ...m.cpu, percent: cpu, perCore: m.cpu.perCore?.map((v) => Math.min(100, Math.max(0, v + (Math.random() - 0.5) * 8))) ?? null } }
      })
      const appended = {}
      for (const m of machines) {
        if (m.online && typeof m.cpu.percent === 'number') appended[m.id] = { t: [t], cpu: [Math.round(m.cpu.percent * 10) / 10], mem: [m.memory?.percent ?? null] }
      }
      snapshot = { ...snapshot, machines: snapshot.machines.map((m, i) => ({ ...machines[i], history: m.history })) }
      post('fleet.update', { ...snapshot, seq, generatedAt: t, recentMs: 30_000, machines, appended })
    }, 2_000)
  }

  const orca = {
    api: Object.freeze({ major: 1, minor: 6 }),
    locale: 'en',
    plugin: {
      request(name, input) {
        requests.push({ name, input })
        if (name === 'fleet.snapshot') {
          if (state === 'loading') return new Promise(() => {})
          if (state === 'error') return Promise.reject(Object.assign(new Error('The plugin worker is not running'), { code: 'unavailable' }))
          snapshot = { ...sampleSnapshot(state, now()), seq }
          return Promise.resolve(snapshot)
        }
        if (name === 'fleet.heartbeat') return Promise.resolve({ ok: true, mode: 'fast', seq })
        if (name === 'fleet.retry') return Promise.resolve({ ok: true })
        return Promise.reject(Object.assign(new Error(`no handler for ${name}`), { code: 'unknown_method' }))
      },
      on(event, handler) {
        if (!handlers.has(event)) handlers.set(event, new Set())
        handlers.get(event).add(handler)
        return { dispose: () => handlers.get(event)?.delete(handler) }
      }
    }
  }
  return { orca, requests }
}
