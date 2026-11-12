// Invented sample data for the 1.2 preview: what the sample fleet (sample-fleet.mjs) would add
// with Fleet Monitor 1.2 (network, disk, GPU and battery readings, the process using the most
// memory, and each machine's process list), in the worker's shapes (src/model.ts). Nothing here is a real machine, person, process
// argument or path. Lists come without command lines, as the worker sends them.
import { sampleSnapshot } from './sample-fleet.mjs'

const MIN = 60_000
const MB = 1e6
const MIB = 2 ** 20

/** Per-minute series, oldest first, 30 points (MB/s for network, % for GPU). */
const SERIES = {
  mbp: {
    down: [0.4, 0.6, 0.5, 1.2, 3.8, 6.4, 5.1, 2.2, 0.8, 0.5, 0.6, 0.9, 0.7, 0.5, 1.4, 7.9, 12.6, 9.8, 4.1, 1.2, 0.7, 0.8, 1.1, 0.9, 0.6, 1.8, 3.4, 5.2, 4.6, 4.2],
    up: [0.1, 0.1, 0.1, 0.2, 0.3, 0.4, 0.3, 0.2, 0.1, 0.1, 0.1, 0.2, 0.1, 0.1, 0.2, 0.6, 0.9, 0.7, 0.4, 0.2, 0.1, 0.1, 0.2, 0.2, 0.1, 0.2, 0.3, 0.4, 0.3, 0.31],
    gpu: [8, 9, 7, 8, 14, 22, 18, 10, 8, 7, 9, 11, 10, 8, 12, 31, 38, 27, 14, 9, 8, 9, 11, 9, 8, 10, 13, 15, 13, 12]
  },
  studio: {
    down: [9.8, 10.4, 11.2, 10.1, 9.6, 12.8, 14.1, 13.2, 11.9, 10.6, 10.2, 11.4, 12.9, 13.6, 12.2, 11.1, 10.8, 12.4, 15.2, 16.8, 14.9, 13.1, 12.2, 11.8, 12.6, 13.4, 12.9, 12.1, 12.6, 12.4],
    up: [1.4, 1.5, 1.6, 1.5, 1.4, 1.8, 2.1, 1.9, 1.7, 1.5, 1.5, 1.6, 1.9, 2.0, 1.8, 1.6, 1.6, 1.8, 2.2, 2.4, 2.1, 1.9, 1.8, 1.7, 1.8, 1.9, 1.9, 1.8, 1.8, 1.8],
    gpu: [41, 44, 48, 52, 49, 55, 61, 66, 72, 78, 83, 88, 91, 87, 82, 76, 71, 68, 72, 77, 81, 79, 74, 70, 66, 63, 61, 65, 66, 64]
  },
  mini: {
    down: [2.1, 3.4, 18.6, 44.2, 61.8, 38.4, 12.2, 4.1, 2.8, 2.2, 6.4, 22.8, 48.6, 57.2, 31.4, 9.8, 3.6, 2.4, 2.9, 8.8, 26.4, 52.1, 64.3, 41.7, 16.2, 6.1, 4.4, 12.6, 24.1, 28.4],
    up: [0.6, 0.8, 1.9, 3.8, 5.2, 3.4, 1.4, 0.8, 0.7, 0.6, 1.1, 2.4, 4.1, 4.9, 2.9, 1.2, 0.8, 0.7, 0.7, 1.3, 2.6, 4.4, 5.6, 3.7, 1.8, 1.0, 0.9, 1.6, 2.7, 3.1],
    gpu: null
  }
}

/** Each machine's readings, as a 1.2 worker sends them. `battery` is the scene's. */
function systemOf(id, scene) {
  const s = SERIES[id]
  if (id === 'mbp') {
    return {
      net: { iface: 'en0', rxBytesPerSec: s.down.at(-1) * MB, txBytesPerSec: s.up.at(-1) * MB },
      disk: { totalBytes: 994e9, usedBytes: 412e9, readBytesPerSec: 2.1 * MB, writeBytesPerSec: 0.64 * MB },
      gpu: { percent: s.gpu.at(-1) },
      battery:
        scene === 'on-battery'
          ? { present: true, percent: 18, state: 'discharging', source: 'battery', minutesRemaining: 52 }
          : { present: true, percent: 82, state: 'charging', source: 'ac', minutesRemaining: 38 }
    }
  }
  if (id === 'studio') {
    return {
      net: { iface: 'en0', rxBytesPerSec: s.down.at(-1) * MB, txBytesPerSec: s.up.at(-1) * MB },
      disk: { totalBytes: 2e12, usedBytes: 1.42e12, readBytesPerSec: 184 * MB, writeBytesPerSec: 96 * MB },
      gpu: { percent: s.gpu.at(-1) },
      battery: { present: false, percent: null, state: null, source: 'ac', minutesRemaining: null }
    }
  }
  if (id === 'mini') {
    return {
      net: { iface: 'en0', rxBytesPerSec: s.down.at(-1) * MB, txBytesPerSec: s.up.at(-1) * MB },
      disk: { totalBytes: 916e9, usedBytes: 572e9, readBytesPerSec: 84 * MB, writeBytesPerSec: 212 * MB },
      gpu: null,
      battery: { present: false, percent: null, state: null, source: 'ac', minutesRemaining: null }
    }
  }
  return null
}

// --- process lists ------------------------------------------------------------------------------

/** name, % of one core, memory MiB, energy impact, pid, user, minutes running. Names are the
 *  system's short names, as the worker sends them: at most 16 characters ("Google Chrome He"). */
const P = (name, cpu, memMib, energy, pid, user, minutes) => ({ name: name.slice(0, 16), cpu, mem: memMib * MIB, energy, pid, user, minutes })

const MBP = [
  P('node', 86.4, 2150, 48.6, 48211, 'sam', 192),
  P('Google Chrome Helper (Renderer)', 49.6, 1434, 21.3, 5127, 'sam', 1800),
  P('WindowServer', 33.6, 1126, 14.8, 412, '_windowserver', 8760),
  P('claude', 25.6, 812, 12.4, 51873, 'sam', 47),
  P('Orca Helper (Renderer)', 19.2, 946, 9.7, 2291, 'sam', 2940),
  P('rust-analyzer', 14.4, 3277, 6.1, 30412, 'sam', 340),
  P('python3.12', 12.8, 4710, 5.4, 44790, 'sam', 1560),
  P('Google Chrome', 9.6, 688, 4.2, 5098, 'sam', 1800),
  P('Google Chrome Helper (GPU)', 8, 412, 3.9, 5121, 'sam', 1800),
  P('postgres', 6.4, 312, 1.8, 1184, 'sam', 8760),
  P('kernel_task', 4.8, 942, 0, 0, 'root', 8760),
  P('Orca', 4.8, 418, 2.2, 2274, 'sam', 2940),
  P('node', 3.2, 486, 1.4, 48377, 'sam', 192),
  P('mds_stores', 3.2, 264, 1.1, 611, 'root', 8760),
  P('esbuild', 1.6, 96, 0.8, 48290, 'sam', 192),
  P('Google Chrome Helper (Renderer)', 1.6, 508, 0.6, 5340, 'sam', 544),
  P('redis-server', 1.6, 44, 0.4, 1201, 'sam', 8760),
  P('node', 1.6, 318, 0.5, 39902, 'sam', 1620),
  P('Finder', 0.8, 212, 0.3, 688, 'sam', 8760),
  P('Google Chrome Helper (Renderer)', 0.6, 356, 0.2, 6012, 'sam', 151),
  P('fseventsd', 0.5, 38, 0.1, 371, 'root', 8760),
  P('zsh', 0.3, 6, 0, 48102, 'sam', 194),
  P('launchd', 0.3, 22, 0.1, 1, 'root', 8760),
  P('nginx', 0.2, 12, 0, 1310, 'sam', 8760),
  P('Terminal', 0.2, 148, 0.1, 902, 'sam', 8760),
  P('Google Chrome Helper (Renderer)', 0, 212, 0, 6377, 'sam', 41),
  P('Google Chrome Helper', 0, 84, 0, 5133, 'sam', 1800),
  P('chrome_crashpad_handler', 0, 4, 0, 5110, 'sam', 1800)
]

const STUDIO = [
  P('python3.12', 744, 29082, 212, 71204, 'ci', 171),
  P('node', 288, 9830, 86.4, 68011, 'ci', 2460),
  P('xcodebuild', 226, 5530, 71.2, 73310, 'ci', 14),
  P('swift-frontend', 163, 2355, 52.8, 73388, 'ci', 2),
  P('java', 125, 6963, 38.1, 60122, 'ci', 5880),
  P('postgres', 94, 8397, 27.4, 1410, 'ci', 33540),
  P('clang', 74, 1229, 24.9, 73402, 'ci', 1),
  P('clang', 67, 1126, 22.1, 73405, 'ci', 1),
  P('node', 53, 3482, 16.3, 69344, 'ci', 2460),
  P('Google Chrome Helper (Renderer)', 46, 4198, 13.2, 9120, 'ci', 4560),
  P('swift-frontend', 41, 1946, 12.4, 73391, 'ci', 2),
  P('WindowServer', 34, 1434, 9.8, 402, '_windowserver', 33540),
  P('redis-server', 26, 2253, 7.6, 1422, 'ci', 33540),
  P('Orca Helper', 22, 1126, 6.2, 2140, 'ci', 13020),
  P('kernel_task', 19, 1638, 0, 0, 'root', 33540),
  P('terraform', 14, 1331, 4.1, 72960, 'ci', 21),
  P('ld', 12, 2458, 3.6, 73410, 'ci', 1),
  P('node', 9.6, 1229, 2.9, 69350, 'ci', 2460),
  P('Orca', 7.2, 640, 2.4, 2118, 'ci', 13020),
  P('mds_stores', 7.2, 512, 2.0, 590, 'root', 33540),
  P('git', 4.8, 420, 1.3, 73377, 'ci', 3),
  P('esbuild', 4.8, 380, 1.1, 69361, 'ci', 2460),
  P('python3.12', 2.4, 2662, 0.8, 70990, 'ci', 182),
  P('sshd', 2.4, 12, 0.4, 73001, 'ci', 18),
  P('launchd', 2.4, 28, 0.2, 1, 'root', 33540)
]

const MINI = [
  P('java', 410, 3920, 96.2, 31544, 'ci', 840),
  P('node', 192, 2210, 54.1, 30120, 'ci', 2460),
  P('postgres', 88, 1830, 21.7, 912, 'ci', 59160),
  P('docker', 61, 1420, 15.3, 1220, 'ci', 59160),
  P('swift-frontend', 47, 980, 11.8, 31602, 'ci', 3),
  P('clang', 38, 640, 9.2, 31610, 'ci', 1),
  P('WindowServer', 12, 420, 3.1, 402, '_windowserver', 59160),
  P('Orca Helper', 9.6, 610, 2.4, 2140, 'ci', 59160),
  P('git', 6.1, 210, 1.6, 31570, 'ci', 4)
]

/** Quiet background processes, to fill a list out to its full length. */
const DAEMONS = ['cfprefsd', 'distnoted', 'trustd', 'UserEventAgent', 'syslogd', 'mdworker_shared', 'coreaudiod', 'bluetoothd', 'powerd', 'logd', 'notifyd', 'configd', 'secd', 'opendirectoryd', 'airportd', 'sharingd', 'locationd', 'apsd', 'nsurlsessiond', 'cloudd']

function filler(count, firstPid, user) {
  return Array.from({ length: count }, (_, i) => P(DAEMONS[i % DAEMONS.length], (i % 7) * 0.02, 3 + ((i * 7919) % 173), 0, firstPid + i * 3, i % 3 === 0 ? 'root' : user, 8000 + i))
}

function columns(rows, now) {
  return {
    pid: rows.map((r) => r.pid),
    ppid: rows.map(() => 1),
    name: rows.map((r) => r.name),
    user: rows.map((r) => r.user),
    cpu: rows.map((r) => r.cpu),
    mem: rows.map((r) => r.mem),
    energy: rows.map((r) => r.energy),
    start: rows.map((r) => Math.floor((now - r.minutes * MIN) / 1000)),
    protected: rows.map(() => null)
  }
}

/** A `fleet.processes` answer for a machine of the sample fleet, as the worker gives it. */
export function sampleProcesses(id, now = Date.now()) {
  const list = (rows, over) => ({ machineId: id, state: 'ok', reason: null, scope: 'full', takenAt: now - 1_000, ageMs: 1_000, cpuWindowMs: 5_000, memAgeMs: 0, energyWindowMs: 5_000, total: rows.length, columns: columns(rows, now), ...over })
  if (id === 'mbp') return list([...MBP, ...filler(412 - MBP.length, 20_000, 'sam')])
  if (id === 'studio') return list([...STUDIO, ...filler(60 - STUDIO.length, 40_000, 'ci')], { scope: 'top', total: 387, takenAt: now - 8_000 })
  if (id === 'mini') return list([...MINI, ...filler(60 - MINI.length, 50_000, 'ci')], { scope: 'top', total: 214, takenAt: now - 8_000 })
  return { machineId: id, state: 'unavailable', reason: 'not-mac', scope: 'full', takenAt: null, total: null, columns: columns([], now) }
}

/** The sample snapshot with what 1.2 adds. `scene`: 'on-battery' runs this computer on battery. */
export function sampleActivitySnapshot(now = Date.now(), scene = '') {
  const snapshot = sampleSnapshot('live', now)
  snapshot.machines = snapshot.machines.map((m) => {
    if (!m.online || m.tier !== 'full' || !SERIES[m.id]) {
      // A basic machine has no Fleet Monitor to ask.
      return { ...m, processes: { state: 'unavailable', reason: m.tier === 'basic' ? 'basic' : 'offline', takenAt: null, largest: null } }
    }
    const s = SERIES[m.id]
    const t = m.history.t
    // The sample's points are seconds apart; the series are per minute, newest last.
    const tail = (series) => t.map((at) => series[Math.max(0, series.length - 1 - Math.floor((now - at) / MIN))] ?? null)
    const history = { ...m.history, rx: tail(s.down.map((v) => v * MB)), tx: tail(s.up.map((v) => v * MB)) }
    if (s.gpu) history.gpu = tail(s.gpu)
    // The process using the most memory in each machine's newest list.
    const largest = { mbp: { pid: 44790, name: 'python3.12', mem: 4710 * MIB }, studio: { pid: 71204, name: 'python3.12', mem: 29082 * MIB }, mini: { pid: 31544, name: 'java', mem: 3920 * MIB } }[m.id]
    return {
      ...m,
      system: systemOf(m.id, scene),
      processes: { state: m.kind === 'local' ? 'full' : 'top', reason: null, takenAt: now - 8_000, largest },
      history
    }
  })
  return snapshot
}
