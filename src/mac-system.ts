// A Mac's network, disk, GPU, battery and temperatures, from tools macOS ships, read without
// privileges:
//
//   network   `netstat -ibn -I <iface>` every reading (5 s), for the interface the default route
//             goes out of (`route -n get default`, about once a minute): bytes in and out per
//             second from the interface's cumulative 64-bit counters
//   disk      `statfs` of the main volume about once a minute (no child process): the APFS
//             container's size, and used = size − available, as `df` counts available; `mount`
//             about once a minute, and `statfs` of each local volume it lists that Finder shows;
//             `ioreg -r -d 1 -c IOBlockStorageDriver` about every 20 s: bytes read and written
//             per second, summed over every disk, as Activity Monitor's Disk tab sums them
//   GPU       `ioreg -r -d 1 -c IOAccelerator` about every 30 s: "Device Utilization %", the
//             busiest GPU when there are several
//   battery   `pmset -g batt` about once a minute: power source, charge, state, time remaining
//   temp      the SMC about every 30 s, through `osascript -l JavaScript` (MAC_TEMP_SCRIPT): the
//             hottest CPU core and GPU sensor, from the keys this Mac's chip has (SMC_KEYS),
//             about 90 ms on an M1 Max. A chip not in SMC_KEYS is not asked
//
// What is read less often than every reading is carried until the next read, with its age; a
// read that fails carries the last value for a while longer, then the value is dropped. Every
// output is parsed defensively: a figure out of shape is left out, never guessed.
//
// Cost on an Apple M2 Max with about 1,000 processes (child CPU, user + system): netstat 1.5 ms,
// route 1.4 ms, ioreg 19 ms per class (it walks the whole I/O Kit registry), pmset 5 ms. See
// tools/measure-cost.ts for the whole sampler.
import { statfsSync } from 'node:fs'
import { cpus } from 'node:os'
import { performance } from 'node:perf_hooks'
import { createRunBounded, type ExecFile } from './mac-memory.ts'
import { readdir, readlink, statfs as statfsAsync } from 'node:fs/promises'
import type { BatteryReading, DiskReading, GpuReading, MacSystem, NetReading, TempReading, VolumeReading } from './model.ts'

export const NETSTAT_PATH = '/usr/sbin/netstat'
export const ROUTE_PATH = '/sbin/route'
export const IOREG_PATH = '/usr/sbin/ioreg'
export const PMSET_PATH = '/usr/bin/pmset'
export const MOUNT_PATH = '/sbin/mount'
export const OSASCRIPT_PATH = '/usr/bin/osascript'
const TIMEOUT_MS = 2_000
/** A Mac whose SMC answers this many times in a row with no temperature (a virtual machine's
 *  has none) is not asked again; one whose script fails this many times in a row (timed out, too
 *  many commands running, or stopped by security software) is asked every TEMP_RETRY_MS instead. */
export const TEMP_TRIES = 3
export const TEMP_RETRY_MS = 10 * 60_000
/** This reader's own bounded runner, apart from the memory reads' (src/mac-memory.ts). */
export const systemRunBounded: ExecFile = createRunBounded()
/** ioreg prints every property of each matching object: about 45 KB for one Apple GPU. */
const IOREG_MAX_BYTES = 1024 * 1024
const MAX_OUTPUT_BYTES = 64 * 1024

/** How often each part is read, and how long a value may be carried past a failed read. */
export const SYSTEM_CADENCE = {
  routeMs: 60_000,
  diskIoMs: 20_000,
  gpuMs: 30_000,
  tempMs: 30_000,
  batteryMs: 60_000,
  spaceMs: 60_000
} as const
export const SYSTEM_MAX_AGE = {
  netMs: 12_000,
  diskIoMs: 50_000,
  gpuMs: 70_000,
  tempMs: 70_000,
  batteryMs: 180_000,
  spaceMs: 180_000
} as const

/** A network interface name `netstat -I` may be given: letters, digits, `.`, `_`, `-`. */
export function isInterfaceName(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9._-]{0,15}$/.test(name)
}

/**
 * A network interface's name in the shape a beacon carries (isInterfaceName), for the platforms
 * whose own names need not fit it: Windows' adapter names ("Ethernet 3", "Wi-Fi"), and a Linux
 * name that starts with a digit. Anything else than a letter, digit, `.`, `_` or `-` becomes `-`;
 * what comes before the first letter is dropped; a name with nothing left is `net`.
 */
export function interfaceLabel(name: string): string {
  const label = name
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z]+/, '')
    .slice(0, 16)
    .replace(/-+$/, '')
  return isInterfaceName(label) ? label : 'net'
}

/** The interface of the default route, from `route -n get default`, or null. */
export function parseDefaultRoute(text: unknown): string | null {
  if (typeof text !== 'string' || text.length > MAX_OUTPUT_BYTES) return null
  const match = /^\s*interface:\s*(\S+)\s*$/m.exec(text)
  return match && isInterfaceName(match[1]) ? match[1] : null
}

const DIGITS = /^\d{1,20}$/

/**
 * Cumulative bytes in and out of `iface` from `netstat -ibn -I <iface>`: its `<Link#n>` row,
 * which carries the interface's own counters (the address rows repeat them). The columns are
 * found by the header, counted from the right, because a row without a hardware address (a VPN
 * tunnel) has one field fewer in the middle.
 */
export function parseNetstat(text: unknown, iface: string): { rx: number; tx: number } | null {
  if (typeof text !== 'string' || text.length > MAX_OUTPUT_BYTES) return null
  const lines = text.split('\n')
  const header = (lines[0] ?? '').trim().split(/\s+/)
  const rxAt = header.indexOf('Ibytes')
  const txAt = header.indexOf('Obytes')
  if (header[0] !== 'Name' || rxAt === -1 || txAt === -1) return null
  const rxFromEnd = header.length - 1 - rxAt
  const txFromEnd = header.length - 1 - txAt
  for (const line of lines.slice(1)) {
    const fields = line.trim().split(/\s+/)
    // `en1*` is an interface that is down.
    if (fields[0]?.replace(/\*$/, '') !== iface || !/^<Link#\d+>$/.test(fields[2] ?? '')) continue
    const rx = fields[fields.length - 1 - rxFromEnd]
    const tx = fields[fields.length - 1 - txFromEnd]
    if (rx === undefined || tx === undefined || !DIGITS.test(rx) || !DIGITS.test(tx)) return null
    const rxN = Number(rx)
    const txN = Number(tx)
    return Number.isSafeInteger(rxN) && Number.isSafeInteger(txN) ? { rx: rxN, tx: txN } : null
  }
  return null
}

/** Cumulative bytes read and written per block storage driver, keyed by its registry id, from
 *  `ioreg -r -d 1 -c IOBlockStorageDriver`. A driver without readable statistics is left out. */
export function parseDiskStats(text: unknown): Map<string, { read: number; write: number }> | null {
  if (typeof text !== 'string' || text.length > IOREG_MAX_BYTES) return null
  const out = new Map<string, { read: number; write: number }>()
  let id: string | null = null
  for (const line of text.split('\n')) {
    const object = /\+-o .*<class [A-Za-z0-9_]+, id (0x[0-9a-f]{1,16})\b/.exec(line)
    if (object) {
      id = object[1]!
      continue
    }
    if (id === null || !/^\s*"Statistics" = \{/.test(line)) continue
    const read = /"Bytes \(Read\)"=(\d{1,20})\b/.exec(line)
    const write = /"Bytes \(Write\)"=(\d{1,20})\b/.exec(line)
    const r = read ? Number(read[1]) : Number.NaN
    const w = write ? Number(write[1]) : Number.NaN
    if (Number.isSafeInteger(r) && Number.isSafeInteger(w) && !out.has(id)) out.set(id, { read: r, write: w })
    id = null
  }
  return out
}

/** The busiest GPU's "Device Utilization %" from `ioreg -r -d 1 -c IOAccelerator`, or null when
 *  no accelerator reports one (some Intel GPUs, virtual machines). */
export function parseGpu(text: unknown): number | null {
  if (typeof text !== 'string' || text.length > IOREG_MAX_BYTES) return null
  let best: number | null = null
  for (const line of text.split('\n')) {
    if (!/^\s*"PerformanceStatistics" = \{/.test(line)) continue
    const match = /"Device Utilization %"=(\d{1,3})\b/.exec(line)
    const value = match ? Number(match[1]) : Number.NaN
    if (value >= 0 && value <= 100) best = best === null ? value : Math.max(best, value)
  }
  return best
}

/** The lowest and highest temperature kept, in °C, on every platform: a sensor that reads 0 is
 *  not there, and a key that is not a temperature can read anything. */
export const TEMP_MIN_C = 1
export const TEMP_MAX_C = 125

/** A temperature in the range a CPU or GPU can be at, as a whole °C, or null. */
export function plausibleTemp(value: unknown, min = TEMP_MIN_C): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= TEMP_MAX_C ? Math.round(value) : null
}

/** Below this an Apple silicon sensor is off, not cold: its block is powered down (an M2 Pro's GPU
 *  reads about 6 within a second of going idle). Stats leaves out a CPU core under 10 too. */
export const SMC_SENSOR_OFF_C = 10

/** The keys of one kind of Mac: the CPU's cores and the GPU's sensors, each read as the hottest.
 *  `cpuSpare` and `gpuSpare` are read only for a figure the main keys do not give. */
export type SmcKeys = { cpu: readonly string[]; gpu: readonly string[]; cpuSpare?: readonly string[]; gpuSpare?: readonly string[] }

const digits = (pattern: string) => Array.from({ length: 10 }, (_, i) => pattern.replace('%', String(i)))

/**
 * The SMC's temperature keys for each kind of Mac, as Stats lists them (github.com/exelban/stats,
 * MIT, Modules/Sensors/values.swift, November 2026): for Apple silicon, the keys it averages for
 * "CPU" and "GPU"; for an Intel Mac, its CPU and GPU keys.
 * The SMC has others with the same letters that are not a core's (an M1 Max's Tp0I reads 8 °C
 * above its hottest core, and an Intel Mac's Tp0P is its power board), so only these are read.
 */
export const SMC_KEYS: Readonly<Record<string, SmcKeys>> = Object.freeze({
  m1: {
    cpu: ['Tp09', 'Tp0T', 'Tp01', 'Tp05', 'Tp0D', 'Tp0H', 'Tp0L', 'Tp0P', 'Tp0X', 'Tp0b'],
    gpu: ['Tg05', 'Tg0D', 'Tg0L', 'Tg0T']
  },
  m2: {
    cpu: ['Tp1h', 'Tp1t', 'Tp1p', 'Tp1l', 'Tp01', 'Tp05', 'Tp09', 'Tp0D', 'Tp0X', 'Tp0b', 'Tp0f', 'Tp0j'],
    gpu: ['Tg0f', 'Tg0j']
  },
  m3: {
    cpu: ['Te05', 'Te0L', 'Te0P', 'Te0S', 'Tf04', 'Tf09', 'Tf0A', 'Tf0B', 'Tf0D', 'Tf0E', 'Tf44', 'Tf49', 'Tf4A', 'Tf4B', 'Tf4D', 'Tf4E'],
    gpu: ['Tf14', 'Tf18', 'Tf19', 'Tf1A', 'Tf24', 'Tf28', 'Tf29', 'Tf2A']
  },
  m4: {
    cpu: ['Te05', 'Te0S', 'Te09', 'Te0H', 'Tp01', 'Tp05', 'Tp09', 'Tp0D', 'Tp0V', 'Tp0Y', 'Tp0b', 'Tp0e'],
    gpu: ['Tg0G', 'Tg0H', 'Tg0K', 'Tg0L', 'Tg0d', 'Tg0e', 'Tg0j', 'Tg0k']
  },
  // An M4 Pro's and an M4 Max's first two GPU keys are not a plain M4's.
  m4Pro: {
    cpu: ['Te05', 'Te0S', 'Te09', 'Te0H', 'Tp01', 'Tp05', 'Tp09', 'Tp0D', 'Tp0V', 'Tp0Y', 'Tp0b', 'Tp0e'],
    gpu: ['Tg1U', 'Tg1k', 'Tg0K', 'Tg0L', 'Tg0d', 'Tg0e', 'Tg0j', 'Tg0k']
  },
  m5: {
    cpu: ['Tp00', 'Tp04', 'Tp08', 'Tp0C', 'Tp0G', 'Tp0K', 'Tp0O', 'Tp0R', 'Tp0U', 'Tp0X', 'Tp0a', 'Tp0d', 'Tp0g', 'Tp0j', 'Tp0m', 'Tp0p', 'Tp0u', 'Tp0y'],
    gpu: ['Tg0U', 'Tg0X', 'Tg0d', 'Tg0g', 'Tg0j', 'Tg1Y', 'Tg1c', 'Tg1g']
  },
  m6: {
    cpu: ['Tp0j', 'Tp0g', 'Tp09', 'Tp07', 'Tp0m', 'Tp0L', 'Tp0I', 'Tp0d', 'Tp0E', 'Tp0G', 'Tp0b', 'Tp05', 'Te07', 'Te08', 'Te09', 'Te0c', 'Te0h', 'Te0i'],
    gpu: ['Tg1e', 'Tg0d', 'Tg0c', 'Tg0b', 'Tg1c', 'Tg1d', 'Tg07', 'Tg1f', 'Tg09', 'Tg0a', 'Tg1g', 'Tg1h']
  },
  a18Pro: {
    cpu: ['Te05', 'Te0S', 'Tp05', 'Tp0D'],
    gpu: ['Tg05', 'Tg0D', 'Tg0L', 'Tg0e']
  },
  // An Intel Mac: its cores (two CPUs' on a Mac Pro), else its package, die or proximity; Intel
  // graphics, an AMD GPU, else the GPU's diode or proximity.
  intel: {
    cpu: [...digits('TC%C'), ...digits('TC%c'), 'TCAC', 'TCBC'],
    cpuSpare: ['TCAD', 'TC0D', 'TC0E', 'TC0F', 'TC0P'],
    gpu: ['TCGC', 'TGDD', 'TG0D'],
    gpuSpare: ['TG0P']
  }
})

/** The keys for a Mac whose CPU is `model` (`os.cpus()[0].model`, as "Apple M1 Max" or
 *  "Intel(R) Core(TM) i9-9980HK CPU @ 2.40GHz"); null for a chip SMC_KEYS does not have. */
export function smcKeysFor(model: unknown): SmcKeys | null {
  if (typeof model !== 'string') return null
  const text = model.trim()
  if (/\bIntel\b/i.test(text)) return SMC_KEYS.intel!
  if (/^Apple A18 Pro$/.test(text)) return SMC_KEYS.a18Pro!
  const apple = /^Apple M(\d{1,2})(?: (Pro|Max|Ultra))?$/.exec(text)
  if (!apple) return null
  const generation = `m${apple[1]}`
  if (generation === 'm4' && apple[2]) return SMC_KEYS.m4Pro!
  return Object.hasOwn(SMC_KEYS, generation) ? SMC_KEYS[generation]! : null
}

/** Every key `keys` reads, each once, main keys first. */
export function smcKeyList(keys: SmcKeys): string[] {
  return [...new Set([...keys.cpu, ...keys.gpu, ...(keys.cpuSpare ?? []), ...(keys.gpuSpare ?? [])])]
}

const SMC_ANSWER_MAX_BYTES = 64 * 1024

/** Whether `text` is an answer from MAC_TEMP_SCRIPT, whatever it holds: a JSON object. */
function isSmcAnswer(text: unknown): boolean {
  if (typeof text !== 'string' || text.length > SMC_ANSWER_MAX_BYTES) return false
  try {
    const raw: unknown = JSON.parse(text)
    return Boolean(raw) && typeof raw === 'object' && !Array.isArray(raw)
  } catch {
    return false
  }
}

/**
 * The CPU's and the GPU's temperature from MAC_TEMP_SCRIPT's answer, `{ "Tp01": 62.5, … }`, for
 * a Mac with `keys`: the hottest of the CPU keys and of the GPU keys, each from SMC_SENSOR_OFF_C to
 * TEMP_MAX_C (the spare keys when the main ones give none). A GPU with no figure in that range but
 * a key that reads from 0 to SMC_SENSOR_OFF_C is at rest, its sensors off (`gpuOff`). Null when
 * neither is known.
 */
export function parseMacTemps(text: unknown, keys: SmcKeys): TempReading | null {
  if (typeof text !== 'string' || text.length > SMC_ANSWER_MAX_BYTES) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const answer = raw as Record<string, unknown>
  const hottest = (list: readonly string[] | undefined) => {
    let best: number | null = null
    let off = 0
    for (const key of list ?? []) {
      const value = Object.hasOwn(answer, key) ? answer[key] : undefined
      if (typeof value !== 'number' || !Number.isFinite(value)) continue
      if (value >= 0 && value < SMC_SENSOR_OFF_C) off += 1
      const c = plausibleTemp(value, SMC_SENSOR_OFF_C)
      if (c !== null) best = best === null ? c : Math.max(best, c)
    }
    return { best, off }
  }
  const cpu = hottest(keys.cpu).best ?? hottest(keys.cpuSpare).best
  const main = hottest(keys.gpu)
  const gpu = main.best ?? hottest(keys.gpuSpare).best
  const gpuOff = gpu === null && main.off > 0
  if (cpu === null && gpu === null && !gpuOff) return null
  return { cpuC: cpu, gpuC: gpu, ...(gpuOff ? { gpuOff: true as const } : {}) }
}

/**
 * Reads SMC keys without privileges, as JavaScript for Automation (macOS 10.10 and later) through
 * IOKit: `IOServiceOpen` on AppleSMC, then `IOConnectCallStructMethod` with the 80-byte
 * SMCKeyData_t (key at 0, key info at 28, result at 40, command at 42, value at 48). It asks the
 * SMC only two things, a key's type and size (command 9) and its value (command 5), for each key
 * in its first argument, a JSON list of at most 64. Prints `{ key: °C }`; a key the SMC does not
 * have, or of a type that is not a temperature's (`flt ` on Apple silicon, `sp78` on Intel), is
 * left out.
 */
export const MAC_TEMP_SCRIPT = `function run(argv) {
ObjC.import('Foundation'); ObjC.import('IOKit');
ObjC.bindFunction('mach_task_self', ['unsigned int', []]);
ObjC.bindFunction('IOServiceMatching', ['id', ['char *']]);
ObjC.bindFunction('IOServiceGetMatchingService', ['unsigned int', ['unsigned int', 'id']]);
ObjC.bindFunction('IOServiceOpen', ['int', ['unsigned int', 'unsigned int', 'unsigned int', 'void *']]);
ObjC.bindFunction('IOServiceClose', ['int', ['unsigned int']]);
ObjC.bindFunction('IOObjectRelease', ['int', ['unsigned int']]);
ObjC.bindFunction('IOConnectCallStructMethod', ['int', ['unsigned int', 'unsigned int', 'void *', 'unsigned long', 'void *', 'void *']]);
var keys = [];
try { keys = JSON.parse(argv[0]); } catch (e) { return '{}'; }
if (!Array.isArray(keys)) return '{}';
var A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function enc(a) { var s = ''; for (var i = 0; i < a.length; i += 3) { var n = (a[i] << 16) | ((a[i + 1] || 0) << 8) | (a[i + 2] || 0); s += A[n >> 18 & 63] + A[n >> 12 & 63] + (i + 1 < a.length ? A[n >> 6 & 63] : '=') + (i + 2 < a.length ? A[n & 63] : '='); } return s; }
function dec(s) { var o = []; s = s.replace(/=+$/, ''); for (var i = 0; i < s.length; i += 4) { var n = 0; for (var j = 0; j < 4; j++) n = (n << 6) | (i + j < s.length ? A.indexOf(s[i + j]) : 0); o.push(n >> 16 & 255); if (i + 2 < s.length) o.push(n >> 8 & 255); if (i + 3 < s.length) o.push(n & 255); } return o; }
function data(bytes) { return $.NSData.alloc.initWithBase64EncodedStringOptions($(enc(bytes)), 0).mutableCopy; }
function bytes(d) { return dec(ObjC.unwrap(d.base64EncodedStringWithOptions(0))); }
function u32(a, at) { return (a[at] | a[at + 1] << 8 | a[at + 2] << 16 | a[at + 3] << 24) >>> 0; }
function fcc(n) { return String.fromCharCode(n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255); }
var svc = $.IOServiceGetMatchingService(0, $.IOServiceMatching('AppleSMC'));
if (!svc) return '{}';
var cd = data([0, 0, 0, 0]);
var opened = $.IOServiceOpen(svc, $.mach_task_self(), 0, cd.mutableBytes);
$.IOObjectRelease(svc);
if (opened !== 0) return '{}';
var conn = u32(bytes(cd), 0);
function call(cmd, key, size) {
  var a = []; for (var i = 0; i < 80; i++) a.push(0);
  for (var k = 0; k < 4; k++) a[3 - k] = key.charCodeAt(k) & 255;
  a[28] = size; a[42] = cmd;
  var input = data(a); var output = data(a); var length = data([80, 0, 0, 0, 0, 0, 0, 0]);
  if ($.IOConnectCallStructMethod(conn, 2, input.mutableBytes, 80, output.mutableBytes, length.mutableBytes) !== 0) return null;
  var r = bytes(output); return r[40] === 0 ? r : null;
}
function read(key) {
  var info = call(9, key, 0); if (!info) return null;
  var size = u32(info, 28); var type = fcc(u32(info, 32));
  if (!(type === 'flt ' && size === 4) && !(type === 'sp78' && size === 2)) return null;
  var r = call(5, key, size); if (!r) return null;
  if (size === 2) return ((r[48] << 8 | r[49]) << 16 >> 16) / 256;
  var v = new DataView(new ArrayBuffer(4)); for (var q = 0; q < 4; q++) v.setUint8(q, r[48 + q]); return v.getFloat32(0, true);
}
var out = {};
for (var y = 0; y < keys.length && y < 64; y++) {
  var key = String(keys[y]); if (!/^[A-Za-z0-9#]{4}$/.test(key)) continue;
  var value = read(key); if (value !== null && isFinite(value)) out[key] = Math.round(value * 10) / 10;
}
$.IOServiceClose(conn);
return JSON.stringify(out);
}`

const STATE_OF: Record<string, BatteryReading['state']> = {
  charging: 'charging',
  'finishing charge': 'charging',
  discharging: 'discharging',
  charged: 'charged',
  'ac attached': 'not-charging',
  'not charging': 'not-charging'
}

/**
 * `pmset -g batt`:
 *   Now drawing from 'AC Power'
 *    -InternalBattery-0 (id=1234567)	81%; charging; 1:05 remaining present: true
 * A Mac without a battery has the first line only. Time remaining is "(no estimate)" while
 * macOS works it out, and "0:00" once charged; neither is an estimate.
 */
export function parsePmset(text: unknown): BatteryReading | null {
  if (typeof text !== 'string' || text.length > MAX_OUTPUT_BYTES) return null
  const from = /Now drawing from '([^']{1,40})'/.exec(text)
  if (!from) return null
  const sourceText = from[1]!.toLowerCase()
  const source: BatteryReading['source'] = sourceText.startsWith('ac') ? 'ac' : sourceText.startsWith('battery') ? 'battery' : sourceText.startsWith('ups') ? 'ups' : null
  const line = text.split('\n').find((l) => /^\s*-InternalBattery-\d+/.test(l))
  const none: BatteryReading = { present: false, percent: null, state: null, source, minutesRemaining: null }
  if (!line || /present:\s*false/.test(line)) return none
  const match = /\t\s*(\d{1,3})%;\s*([^;]*?)\s*;\s*(.*)$/.exec(line) ?? /\s(\d{1,3})%;\s*([^;]*?)\s*;\s*(.*)$/.exec(line)
  if (!match) return { ...none, present: true }
  const percent = Number(match[1])
  let state = Object.hasOwn(STATE_OF, match[2]!.toLowerCase()) ? STATE_OF[match[2]!.toLowerCase()]! : null
  const rest = match[3]!
  if (/not charging/i.test(rest)) state = 'not-charging'
  const time = /\b(\d{1,3}):(\d{2}) remaining/.exec(rest)
  let minutes = time ? Number(time[1]) * 60 + Number(time[2]) : null
  if (minutes !== null && (Number(time![2]) > 59 || (minutes === 0 && state !== 'discharging') || (state !== 'charging' && state !== 'discharging'))) minutes = null
  return { present: true, percent: percent <= 100 ? percent : null, state, source, minutesRemaining: minutes }
}

/** What `fs.statfs` gives, or null when it cannot read the volume. */
export type StatFs = (path: string) => { bsize: number; blocks: number; bavail: number } | null

export const realStatfs: StatFs = (path) => {
  try {
    const s = statfsSync(path)
    return { bsize: Number(s.bsize), blocks: Number(s.blocks), bavail: Number(s.bavail) }
  } catch {
    return null
  }
}

/** The main volume: on macOS 10.15 and later the Data volume, which shares its APFS container's
 *  size and free space with the system volume; `/` before that, or should it not be there. */
export const SPACE_PATHS = ['/System/Volumes/Data', '/'] as const

/** The container's size and what is used of it, or null for figures out of shape. */
export function diskSpaceOf(s: { bsize: number; blocks: number; bavail: number } | null): { total: number; used: number } | null {
  if (!s) return null
  const { bsize, blocks, bavail } = s
  if (![bsize, blocks, bavail].every((n) => Number.isSafeInteger(n) && n >= 0) || bsize === 0 || blocks === 0 || bavail > blocks) return null
  const total = bsize * blocks
  const used = bsize * (blocks - bavail)
  return Number.isSafeInteger(total) ? { total, used } : null
}

/** The most volumes read and carried for one machine, and the longest name kept for one. */
export const MAX_VOLUMES = 8
export const VOLUME_NAME_MAX = 40

/** One volume's reading from its statfs figures, or null for figures out of shape. */
export function volumeOf(name: string, s: { bsize: number; blocks: number; bavail: number } | null, main = false): VolumeReading | null {
  const space = diskSpaceOf(s)
  if (!space || !name) return null
  return { name: name.slice(0, VOLUME_NAME_MAX), totalBytes: space.total, usedBytes: space.used, ...(main ? { main: true } : {}) }
}

/** A place to read a disk's space at: where it is mounted, and its name; on Linux, the ZFS pool
 *  it is (whose space `zfs list` gives). */
export type VolumePlace = { path: string; name: string; main?: boolean; pool?: string }
/** statfs that does not hold the worker while a disk answers (fs.promises.statfs). */
export type StatFsAsync = (path: string) => Promise<{ bsize: number; blocks: number; bavail: number } | null>

export const realStatfsAsync: StatFsAsync = async (path) => {
  try {
    const s = await statfsAsync(path)
    return { bsize: Number(s.bsize), blocks: Number(s.blocks), bavail: Number(s.bavail) }
  } catch {
    return null
  }
}

/** How long one disk may take to say how full it is before this reading goes on without it. */
export const VOLUME_DEADLINE_MS = 2_000
/** The most disk reads outstanding at once, a stuck one included. Node runs file-system work on a
 *  pool of four threads that every other file read in the worker shares: two always stay free. */
export const VOLUME_READS_MAX = 2

/** `promise`'s outcome when it settles within `ms`, else `{ done: false }`. The work goes on
 *  either way; only the wait for it ends. */
export async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<{ done: true; value: T } | { done: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<{ done: false }>((resolve) => {
    timer = setTimeout(() => resolve({ done: false }), ms)
    ;(timer as { unref?: () => void }).unref?.()
  })
  try {
    return await Promise.race([promise.then((value) => ({ done: true as const, value })), late])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Reads each of `places` (at most MAX_VOLUMES) off the worker's thread: the volumes that answer
 * within VOLUME_DEADLINE_MS each, main first. Those that miss it are noted in `slow`. At most VOLUME_READS_MAX reads are outstanding at
 * once, across readings: a disk still answering an earlier read (in `pending`; a drive spinning
 * up, or one that has stopped answering) holds its place and is not asked again, and while that
 * many are stuck, the rest wait for the next reading. A failing disk can never take every one of
 * Node's file-system threads.
 */
export async function readVolumes(
  places: readonly VolumePlace[],
  statfs: StatFsAsync,
  pending: Set<string> = new Set(),
  deadlineMs = VOLUME_DEADLINE_MS,
  limit = VOLUME_READS_MAX,
  slow: Set<string> = new Set()
): Promise<VolumeReading[]> {
  // A disk that missed its deadline is asked after the others, and the slow ones in turn, the one
  // that missed it longest ago first: two slow disks cannot keep a healthy one, or one that has
  // recovered, from ever being read.
  const listed = places.slice(0, MAX_VOLUMES).filter((p) => !pending.has(p.path))
  const slowOnes = [...slow].flatMap((path) => listed.filter((p) => p.path === path))
  const queue = [...listed.filter((p) => !slow.has(p.path)), ...slowOnes]
  const out: VolumeReading[] = []
  const lane = async (): Promise<void> => {
    while (queue.length > 0 && pending.size < limit) {
      const place = queue.shift()!
      pending.add(place.path)
      const read = statfs(place.path)
        .catch(() => null)
        .finally(() => pending.delete(place.path))
      const got = await withDeadline(read, deadlineMs)
      // Missed again: to the back of the slow ones.
      slow.delete(place.path)
      if (!got.done) slow.add(place.path)
      try {
        const v = got.done ? volumeOf(place.name, got.value, place.main === true) : null
        if (v) out.push(v)
      } catch {
        // Figures out of shape: left out.
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, limit) }, lane))
  // In the order they were asked for, main first.
  const order = new Map(places.map((p, i) => [p.name, i]))
  return out.sort((a, b) => Number(b.main === true) - Number(a.main === true) || (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0))
}

/** `mount`'s lines: `<device> on <path> (<type>, <option>, …)`. A path may hold spaces. */
export function parseMacMounts(text: unknown): { device: string; path: string; options: string[] }[] {
  if (typeof text !== 'string') return []
  const out: { device: string; path: string; options: string[] }[] = []
  for (const line of text.split('\n')) {
    const m = /^(\S.*?) on (\/.*) \(([^()]*)\)$/.exec(line.trim())
    if (!m) continue
    out.push({ device: m[1]!, path: m[2]!, options: m[3]!.split(',').map((o) => o.trim()) })
    if (out.length >= 256) break
  }
  return out
}

/** The disk an APFS volume lives on: its container (`/dev/disk5s2` → disk5), whose space every
 *  volume in it shares; any other volume is a disk of its own. */
function macDiskOf(mount: { device: string; options: string[] }): string {
  const apfs = mount.options[0] === 'apfs' ? /^\/dev\/(disk\d+)s\d+(?:s\d+)?$/.exec(mount.device) : null
  return apfs ? apfs[1]! : mount.device
}

/**
 * Which of a Mac's mounts are disks a person thinks of as its own: the start-up disk (its Data
 * volume, named `mainName`, "Macintosh HD"), then each local volume under /Volumes that Finder
 * shows (not `nobrowse`) and can be written to (not `read-only`: a mounted installer image, a
 * recovery volume). APFS volumes in one container share its space, so they are one disk, named
 * after them all ("Media · Scratch") and read once; one in the start-up disk's container joins it.
 * Network shares are not `local`, so a stale one is never asked about.
 */
export function macVolumePlaces(mounts: readonly { device?: string; path: string; options: string[] }[], mainName: string | null): VolumePlace[] {
  const groups = new Map<string, { path: string; names: string[]; main: boolean }>()
  const disk = (m: { device?: string; path: string; options: string[] }) => macDiskOf({ device: m.device ?? m.path, options: m.options })
  const data = mounts.find((m) => m.path === SPACE_PATHS[0]) ?? mounts.find((m) => m.path === '/')
  if (data) groups.set(disk(data), { path: data.path, names: [mainName || 'Macintosh HD'], main: true })
  for (const m of mounts) {
    if (!m.path.startsWith('/Volumes/')) continue
    if (!m.options.includes('local') || m.options.includes('nobrowse') || m.options.includes('read-only')) continue
    const name = m.path.slice('/Volumes/'.length)
    if (!name || name.includes('/') || name === mainName) continue
    const key = disk(m)
    const group = groups.get(key)
    if (group) group.names.push(name)
    else groups.set(key, { path: m.path, names: [name], main: false })
  }
  return [...groups.values()].map((g) => ({ path: g.path, name: g.names.join(' · '), ...(g.main ? { main: true } : {}) }))
}

/** The start-up disk's name as Finder shows it: the entry in /Volumes that links to `/`. */
export async function macMainVolumeName(
  list: () => Promise<{ name: string; link: boolean }[]> = async () => (await readdir('/Volumes', { withFileTypes: true })).map((d) => ({ name: d.name, link: d.isSymbolicLink() })),
  link: (path: string) => Promise<string> = (path) => readlink(path)
): Promise<string | null> {
  // Only the links: a mounted volume is never asked about, so a slow one cannot hold this up. A
  // /Volumes that cannot be listed, or a link that cannot be read, rejects rather than say there
  // is no name, so the last name found can stand.
  let unread: unknown = null
  for (const entry of (await list()).slice(0, 64)) {
    if (!entry.link) continue
    try {
      if ((await link(`/Volumes/${entry.name}`)) === '/') return entry.name
    } catch (error) {
      unread ??= error
    }
  }
  if (unread !== null) throw unread
  return null
}

/** A value and when it was read, on the reader's monotonic clock. */
export type Held<T> = { value: T; at: number }

/** The disks to hold after a reading of `places` that read `volumes`: those read; or, when it
 *  listed disks but could read none of them (all still answering), what was held of the disks
 *  still listed, so a disk taken out goes at once. Null: keep what is held as it is. */
export function heldVolumes(places: readonly VolumePlace[], volumes: VolumeReading[], held: Held<VolumeReading[]> | null, now: number): Held<VolumeReading[]> | null {
  if (volumes.length > 0 || places.length === 0) return { value: volumes, at: now }
  if (!held) return null
  const names = new Set(places.map((p) => p.name.slice(0, VOLUME_NAME_MAX)))
  const still = held.value.filter((v) => names.has(v.name))
  return still.length === held.value.length ? held : { value: still, at: held.at }
}

/** What a system reader holds between reads, on any platform. Disk traffic may know only one of
 *  read and write (a counter that went back gives none for that reading). */
export type HeldSystem = {
  net: Held<NetReading> | null
  diskIo: Held<{ read: number | null; write: number | null }> | null
  space: Held<{ total: number; used: number }> | null
  /** Every local volume, where the platform's reader lists them. */
  volumes?: Held<VolumeReading[]> | null
  gpu: Held<number> | null
  battery: Held<BatteryReading> | null
  /** CPU and GPU temperature, where the platform's reader reads them. */
  temp?: Held<TempReading> | null
}

/** What is known at `now`: each part with its age (from a second on), or null where there is
 *  nothing young enough (SYSTEM_MAX_AGE). The same for every platform's reader. */
export function systemSnapshot(held: HeldSystem, now: number): MacSystem {
  const age = (part: { at: number } | null, max: number): number | null => {
    if (!part) return null
    const a = Math.max(0, Math.round(now - part.at))
    return a <= max ? a : null
  }
  const withAge = <T extends object>(value: T, a: number, key: string): T => (a >= 1_000 ? { ...value, [key]: a } : value)
  const netAge = age(held.net, SYSTEM_MAX_AGE.netMs)
  const net = held.net && netAge !== null ? withAge(held.net.value, netAge, 'ageMs') : null
  const ioAge = age(held.diskIo, SYSTEM_MAX_AGE.diskIoMs)
  const spaceAge = age(held.space, SYSTEM_MAX_AGE.spaceMs)
  const volumesAge = age(held.volumes ?? null, SYSTEM_MAX_AGE.spaceMs)
  const volumes = volumesAge !== null && held.volumes && held.volumes.value.length > 0 ? held.volumes.value : null
  let disk: DiskReading | null = null
  if (ioAge !== null || spaceAge !== null || volumes) {
    const io = ioAge !== null && held.diskIo ? held.diskIo.value : null
    const space = spaceAge !== null && held.space ? held.space.value : null
    disk = {
      totalBytes: space?.total ?? null,
      usedBytes: space?.used ?? null,
      ...(space && spaceAge! >= 1_000 ? { spaceAgeMs: spaceAge! } : {}),
      readBytesPerSec: io?.read ?? null,
      writeBytesPerSec: io?.write ?? null,
      ...(io && ioAge! >= 1_000 ? { ioAgeMs: ioAge! } : {}),
      ...(volumes ? { volumes } : {})
    }
  }
  const gpuAge = age(held.gpu, SYSTEM_MAX_AGE.gpuMs)
  const gpu: GpuReading | null = held.gpu && gpuAge !== null ? withAge({ percent: held.gpu.value }, gpuAge, 'ageMs') : null
  const batteryAge = age(held.battery, SYSTEM_MAX_AGE.batteryMs)
  const battery = held.battery && batteryAge !== null ? withAge(held.battery.value, batteryAge, 'ageMs') : null
  const tempAge = age(held.temp ?? null, SYSTEM_MAX_AGE.tempMs)
  const temp = held.temp && tempAge !== null ? withAge(held.temp.value, tempAge, 'ageMs') : null
  return temp ? { net, disk, gpu, battery, temp } : { net, disk, gpu, battery }
}

/**
 * The temperatures at `now`, from a platform's own sensors (`sensors`) and nvidia-smi's (`nvidia`,
 * read apart, with the GPU on Linux and on its own on Windows), each left out once older than
 * SYSTEM_MAX_AGE.tempMs; the GPU the hotter of the two, the CPU (and whether it is a thermal
 * zone's) the sensors'. As old as the older of the reads it takes a figure from.
 */
export function heldTemp(sensors: Held<TempReading> | null, nvidia: Held<number | null> | null, now: number): Held<TempReading> | null {
  const young = <T>(part: Held<T> | null): Held<T> | null => (part && Math.max(0, now - part.at) <= SYSTEM_MAX_AGE.tempMs ? part : null)
  const s = young(sensors)
  const n = young(nvidia)
  const cpuC = s?.value.cpuC ?? null
  const sensorGpu = s?.value.gpuC ?? null
  const nvidiaC = n?.value ?? null
  const gpuC = sensorGpu === null ? nvidiaC : nvidiaC === null ? sensorGpu : Math.max(sensorGpu, nvidiaC)
  if (cpuC === null && gpuC === null) return null
  const from = [cpuC !== null || sensorGpu !== null ? s : null, nvidiaC !== null ? n : null].flatMap((p) => (p ? [p.at] : []))
  return { value: { cpuC, gpuC, ...(cpuC !== null && s?.value.cpuZone ? { cpuZone: true as const } : {}) }, at: Math.min(...from) }
}

/** Whether a part last tried at `triedAt` is due again (also when the clock went back). */
export function due(triedAt: number, now: number, interval: number): boolean {
  return now - triedAt >= interval || now < triedAt
}

/**
 * Reads a Mac's network, disk, GPU, battery and temperatures, each on its own cadence. `refresh()`
 * runs the commands that are due (with every reading), side by side, each with a timeout;
 * `snapshot()` gives what is known now, with ages. Never throws; on any other platform it runs
 * nothing and `snapshot()` is null.
 */
export class MacSystemReader {
  private readonly exec: ExecFile
  private readonly mono: () => number
  private readonly statfs: StatFs
  private readonly platform: string
  /** False while optional work should wait (macOS memory pressure critical): the I/O Kit and SMC
   *  reads are skipped then, and what they last read is carried until it is too old. */
  private readonly heavyAllowed: () => boolean
  private iface: { name: string; at: number } | null = null
  private netCounters: { iface: string; rx: number; tx: number; at: number } | null = null
  private net: Held<NetReading> | null = null
  private diskCounters: { byId: Map<string, { read: number; write: number }>; at: number } | null = null
  private diskIo: Held<{ read: number; write: number }> | null = null
  private diskIoTriedAt = Number.NEGATIVE_INFINITY
  private gpu: Held<number> | null = null
  private gpuTriedAt = Number.NEGATIVE_INFINITY
  private battery: Held<BatteryReading> | null = null
  private batteryTriedAt = Number.NEGATIVE_INFINITY
  private temp: Held<TempReading> | null = null
  private tempTriedAt = Number.NEGATIVE_INFINITY
  /** The SMC keys this Mac's chip has (smcKeysFor); null for a chip that has none known, and
   *  after TEMP_TRIES answers in a row with no temperature. */
  private smcKeys: SmcKeys | null
  /** Answers in a row that had no temperature, and runs in a row that gave no answer. */
  private tempMisses = 0
  private tempFailures = 0
  private space: Held<{ total: number; used: number }> | null = null
  private spaceTriedAt = Number.NEGATIVE_INFINITY
  private volumes: Held<VolumeReading[]> | null = null
  private volumesTriedAt = Number.NEGATIVE_INFINITY
  private readonly volumeName: () => Promise<string | null> | string | null
  private readonly statfsVolume: StatFsAsync
  private readonly volumesPending = new Set<string>()
  private readonly volumesSlow = new Set<string>()
  /** The start-up disk's name being looked up, while it is, and the last one found. */
  private nameLookup: Promise<string | null> | null = null
  private lastName: string | null = null
  private running: Promise<void> | null = null

  constructor(
    options: {
      exec?: ExecFile
      mono?: () => number
      statfs?: StatFs
      statfsAsync?: StatFsAsync
      platform?: string
      heavyAllowed?: () => boolean
      volumeName?: () => Promise<string | null> | string | null
      /** The CPU's name, as `os.cpus()` gives it: which SMC keys are its temperatures. */
      cpuModel?: string
    } = {}
  ) {
    this.exec = options.exec ?? systemRunBounded
    this.mono = options.mono ?? (() => performance.now())
    this.statfs = options.statfs ?? realStatfs
    const sync = options.statfs
    this.statfsVolume = options.statfsAsync ?? (sync ? async (path) => sync(path) : realStatfsAsync)
    this.platform = options.platform ?? process.platform
    this.heavyAllowed = options.heavyAllowed ?? (() => true)
    this.volumeName = options.volumeName ?? (() => macMainVolumeName())
    this.smcKeys = smcKeysFor(options.cpuModel ?? cpus()[0]?.model)
  }

  /** Reads what is due. A refresh still running is joined, not started again. */
  refresh(): Promise<void> {
    if (this.platform !== 'darwin') return Promise.resolve()
    this.running ??= this.readDue().finally(() => {
      this.running = null
    })
    return this.running
  }

  /** What is known now: each part with its age, or null where there is nothing young enough. */
  snapshot(): MacSystem | null {
    if (this.platform !== 'darwin') return null
    return systemSnapshot({ net: this.net, diskIo: this.diskIo, space: this.space, volumes: this.volumes, gpu: this.gpu, battery: this.battery, temp: this.temp }, this.mono())
  }

  private async readDue(): Promise<void> {
    const now = this.mono()
    const heavy = this.heavyAllowed()
    const jobs: Promise<void>[] = []
    if (!this.iface || now - this.iface.at >= SYSTEM_CADENCE.routeMs || now < this.iface.at) {
      jobs.push(this.readRoute().then(() => this.readNet()))
    } else {
      jobs.push(this.readNet())
    }
    if (heavy && due(this.diskIoTriedAt, now, SYSTEM_CADENCE.diskIoMs)) jobs.push(this.readDiskIo(now))
    if (heavy && due(this.gpuTriedAt, now, SYSTEM_CADENCE.gpuMs)) jobs.push(this.readGpu(now))
    const tempEvery = this.tempFailures >= TEMP_TRIES ? TEMP_RETRY_MS : SYSTEM_CADENCE.tempMs
    if (heavy && this.smcKeys && due(this.tempTriedAt, now, tempEvery)) jobs.push(this.readTemp(now, this.smcKeys))
    if (due(this.batteryTriedAt, now, SYSTEM_CADENCE.batteryMs)) jobs.push(this.readBattery(now))
    if (due(this.spaceTriedAt, now, SYSTEM_CADENCE.spaceMs)) this.readSpace(now)
    if (due(this.volumesTriedAt, now, SYSTEM_CADENCE.spaceMs)) jobs.push(this.readVolumes(now))
    await Promise.all(jobs)
  }

  /** The SMC's CPU and GPU temperatures, from the keys this Mac's chip has. */
  private async readTemp(now: number, keys: SmcKeys): Promise<void> {
    this.tempTriedAt = now
    const answer = await this.run(OSASCRIPT_PATH, ['-l', 'JavaScript', '-e', MAC_TEMP_SCRIPT, JSON.stringify(smcKeyList(keys))])
    const reading = parseMacTemps(answer, keys)
    // An answer the script did not give is no sign that the SMC has none: tried again, less often.
    this.tempFailures = reading || isSmcAnswer(answer) ? 0 : this.tempFailures + 1
    if (reading) {
      this.tempMisses = 0
      this.temp = { value: reading, at: this.mono() }
    } else if (isSmcAnswer(answer) && ++this.tempMisses >= TEMP_TRIES) {
      this.smcKeys = null
    }
  }

  /** The volumes a person thinks of as this Mac's disks (macVolumePlaces), each with its space. */
  private async readVolumes(now: number): Promise<void> {
    this.volumesTriedAt = now
    const [name, listed] = await Promise.all([this.mainVolumeName(), this.run(MOUNT_PATH, [])])
    // Kept as it was only when the list could not be read: a disk taken out goes at once.
    if (listed === null) return
    const places = macVolumePlaces(parseMacMounts(listed), name)
    const volumes = await readVolumes(places, this.statfsVolume, this.volumesPending, VOLUME_DEADLINE_MS, VOLUME_READS_MAX, this.volumesSlow)
    this.volumes = heldVolumes(places, volumes, this.volumes, now)
  }

  /** The start-up disk's name, off the worker's thread and within VOLUME_DEADLINE_MS; the last
   *  one found while a lookup is slow. One lookup at a time: a slow one is waited on, not repeated. */
  private async mainVolumeName(): Promise<string | null> {
    if (!this.nameLookup) {
      let lookup: Promise<string | null>
      try {
        lookup = Promise.resolve(this.volumeName())
      } catch {
        lookup = Promise.resolve(null)
      }
      // A lookup that fails keeps the last name found; one that finds no link says there is none.
      this.nameLookup = lookup
        .then(
          (name) => {
            this.lastName = name
            return name
          },
          () => this.lastName
        )
        .finally(() => {
          this.nameLookup = null
        })
    }
    const got = await withDeadline(this.nameLookup, VOLUME_DEADLINE_MS)
    return got.done ? got.value : this.lastName
  }

  private async run(file: string, args: readonly string[], maxBuffer = MAX_OUTPUT_BYTES): Promise<string | null> {
    try {
      const out = await this.exec(file, args, { timeout: TIMEOUT_MS, maxBuffer })
      return out.error ? null : out.stdout
    } catch {
      return null
    }
  }

  private async readRoute(): Promise<void> {
    const name = parseDefaultRoute(await this.run(ROUTE_PATH, ['-n', 'get', 'default']))
    // No default route (offline): nothing to read until there is one again.
    this.iface = name ? { name, at: this.mono() } : null
    if (!name) this.netCounters = null
  }

  private async readNet(): Promise<void> {
    const iface = this.iface?.name
    if (!iface) return
    const counters = parseNetstat(await this.run(NETSTAT_PATH, ['-ibn', '-I', iface]), iface)
    const at = this.mono()
    if (!counters) {
      // The interface went away: find the default route again with the next reading.
      this.iface = null
      return
    }
    const last = this.netCounters
    let rates: { rx: number; tx: number } | null = null
    if (last && last.iface === iface && counters.rx >= last.rx && counters.tx >= last.tx) {
      const seconds = (at - last.at) / 1000
      if (seconds >= 0.5) rates = { rx: Math.round((counters.rx - last.rx) / seconds), tx: Math.round((counters.tx - last.tx) / seconds) }
    }
    this.netCounters = { iface, ...counters, at }
    this.net = { value: { iface, rxBytesPerSec: rates?.rx ?? null, txBytesPerSec: rates?.tx ?? null }, at }
  }

  private async readDiskIo(now: number): Promise<void> {
    this.diskIoTriedAt = now
    const stats = parseDiskStats(await this.run(IOREG_PATH, ['-r', '-d', '1', '-w', '0', '-c', 'IOBlockStorageDriver'], IOREG_MAX_BYTES))
    const at = this.mono()
    if (!stats || stats.size === 0) return
    const last = this.diskCounters
    this.diskCounters = { byId: stats, at }
    if (!last) return
    const seconds = (at - last.at) / 1000
    if (!(seconds >= 0.5)) return
    // Per disk, so a disk that appears, goes or resets its counters costs only its own share.
    let read = 0
    let write = 0
    for (const [id, now] of stats) {
      const before = last.byId.get(id)
      if (!before || now.read < before.read || now.write < before.write) continue
      read += now.read - before.read
      write += now.write - before.write
    }
    this.diskIo = { value: { read: Math.round(read / seconds), write: Math.round(write / seconds) }, at }
  }

  private async readGpu(now: number): Promise<void> {
    this.gpuTriedAt = now
    const percent = parseGpu(await this.run(IOREG_PATH, ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'], IOREG_MAX_BYTES))
    if (percent !== null) this.gpu = { value: percent, at: this.mono() }
  }

  private async readBattery(now: number): Promise<void> {
    this.batteryTriedAt = now
    const battery = parsePmset(await this.run(PMSET_PATH, ['-g', 'batt']))
    if (battery) this.battery = { value: battery, at: this.mono() }
  }

  private readSpace(now: number): void {
    this.spaceTriedAt = now
    for (const path of SPACE_PATHS) {
      const space = diskSpaceOf(this.statfs(path))
      if (space) {
        this.space = { value: space, at: now }
        return
      }
    }
  }
}
