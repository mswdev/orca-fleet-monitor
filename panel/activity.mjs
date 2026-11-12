// What 1.2 adds to a machine's detail: the Overview | Activity control, the Activity tab (one card
// of tiles for network, disk, GPU and battery, then the Processes card) and, on Overview, one line
// in the Memory card naming the process that uses the most memory while memory is short.
//
// Everything here draws from one plain view-model, made by toActivityModel() and nothing else:
// that function is the only code that reads the binding's shapes (a MachineModel from toFleet(),
// and a `fleet.processes` answer through toProcessList()), so it is the only thing that changes
// when those shapes change. Untrusted text (process,
// user and machine names, command lines) only ever becomes text nodes or attribute values.
//
// --- The view-model -----------------------------------------------------------------------------
//
// ActivityModel = {
//   tabs: boolean                  // Overview | Activity is shown (the machine has activity to show)
//   notice: string | null          // one fm-notice under Overview's sections (Fleet Monitor there is too old)
//   tiles: {                       // each null when the machine does not report it: no tile is drawn
//     network: { down: number | null, up: number | null,             // bytes per second, now
//                downHistory: (number | null)[], upHistory: (number | null)[] } | null  // 30 one-minute slots
//     disk: { usedBytes: number, totalBytes: number, readBps: number | null, writeBps: number | null } | null
//     gpu: { pct: number, peak: number | null, history: (number | null)[] } | null
//     battery: { pct: number, state: 'charging' | 'discharging' | 'charged' | 'not-charging',
//                minutes: number | null, watts: number | null } | null
//   }
//   processes: ProcessesModel | null   // null: this machine has no process list, so no card
//   suggest: { name: string, memory: number, ageSec: number | null } | null
//                                  // the memory line, already past its 5 % floor; ageSec: how old the figure is
// }
// ProcessesModel = {
//   state: 'loading' | 'ready' | 'failed'
//   top: boolean                   // a remote machine's own top list, not every process
//   truncated: boolean             // this computer had more processes than one answer carries
//   total: number | null           // every process on the machine, when known
//   listed: number                 // rows in this list
//   energy: boolean                // energy impact is reported (a Mac): its column and sort option
//   takenAt: number | null         // when the list was taken, worker clock ("Updated 8s ago")
//   sort: 'cpu' | 'memory' | 'energy' | 'name'
//   query: string                  // the search text as typed
//   rows: ProcRow[]                // every row, in no order: sorting, search and the cut are the view's
// }
// ProcRow = {
//   key: string                    // `${pid}:${start}`, stable for one process
//   pid: number, name: string, user: string | null
//   cpu: number | null             // percent of ONE core, as Activity Monitor shows it: can exceed 100
//   memory: number | null          // bytes (memory footprint on a Mac)
//   energy: number | null          // energy impact (a Mac)
//   runningSec: number | null
//   command: string | null, hint: string | null   // the command line and, without its program path, the wide row's hint
// }
import { seriesPaths } from './charts.mjs'
import { h, s } from './dom.mjs'
import { toProcessList } from './fleet-binding.mjs'
import { duration, size } from './format.mjs'

/** Rows drawn before "Show all N". */
export const FIRST_ROWS = 25
/** The memory line names a process only when it holds at least this share of the machine's RAM. */
export const SUGGEST_FLOOR = 0.05
/** From this age on, the memory line speaks of its figure in the past, with its age. */
export const SUGGEST_PAST_SEC = 60

const finite = (value) => typeof value === 'number' && Number.isFinite(value)
const orNull = (value) => (finite(value) ? value : null)

// --- the adapter: the only code that reads the binding's shapes -------------------------------------

/** A machine's tiles from its MachineModel (toFleet: `net`, `disk`, `gpu`, `battery`). */
function tilesOf(machine) {
  const { net, disk, gpu, battery } = machine
  return {
    network: net
      ? { down: orNull(net.rxBytesPerSec), up: orNull(net.txBytesPerSec), downHistory: net.rx?.history ?? [], upHistory: net.tx?.history ?? [] }
      : null,
    disk:
      disk && finite(disk.totalBytes) && disk.totalBytes > 0 && finite(disk.usedBytes)
        ? { usedBytes: disk.usedBytes, totalBytes: disk.totalBytes, readBps: orNull(disk.readBytesPerSec), writeBps: orNull(disk.writeBytesPerSec) }
        : null,
    gpu: gpu && finite(gpu.pct) ? { pct: gpu.pct, peak: orNull(gpu.stats?.peak), history: gpu.history ?? [] } : null,
    battery:
      battery && battery.present && finite(battery.pct)
        ? {
            pct: battery.pct,
            state: battery.state ?? (battery.source === 'battery' ? 'discharging' : 'not-charging'),
            minutes: orNull(battery.minutesRemaining),
            // Not reported: the caption leaves it out.
            watts: null
          }
        : null
  }
}

/** View rows from toProcessList's rows. */
function rowsOf(rows, now) {
  const out = []
  const seen = new Set()
  for (const r of rows) {
    if (!Number.isSafeInteger(r.pid) || r.pid < 0) continue
    const start = finite(r.start) ? Math.round(r.start) : null
    const key = `${r.pid}:${start ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      key,
      pid: r.pid,
      name: r.name || `Process ${r.pid}`,
      user: r.user || null,
      cpu: orNull(r.cpuPct),
      // A process a minute or two old may have no figure yet: absent, not zero.
      memory: orNull(r.memBytes),
      energy: orNull(r.energy),
      // Start times are epoch seconds.
      runningSec: start === null ? null : Math.max(0, Math.round(now / 1000 - start)),
      // The worker sends no command line, so the open row has none and the wide row no hint.
      command: null,
      hint: null
    })
  }
  return out
}

function processesOf(machine, list, ui, now) {
  const summary = machine.processes
  if (!summary || !['full', 'top', 'waiting'].includes(summary.state)) return null
  const base = { top: summary.topList, truncated: false, total: null, listed: 0, energy: false, takenAt: null, sort: ui.sort, query: ui.query, rows: [] }
  if (list === undefined || list === null) return { ...base, state: 'loading' }
  // Every row, unfiltered: sort, search and the cut are the view's (its order can hold still).
  const model = toProcessList(list, {}, now)
  if (model.state === 'loading' || model.state === 'waiting' || (model.state === 'unavailable' && model.reason === 'not-read-yet')) {
    return { ...base, state: 'loading' }
  }
  if (model.state !== 'ok') return { ...base, state: 'failed' }
  const rows = rowsOf(model.rows, now)
  const energy = rows.some((r) => r.energy !== null)
  return {
    ...base,
    state: 'ready',
    top: model.topList || model.scope === 'top',
    truncated: model.truncated,
    total: orNull(model.total),
    listed: rows.length,
    energy,
    takenAt: orNull(model.takenAt),
    // Energy is only offered where it is reported.
    sort: ui.sort === 'energy' && !energy ? 'cpu' : ui.sort,
    rows
  }
}

/** The memory line: the process using the most memory, while memory is strained or critical and
 *  it holds at least SUGGEST_FLOOR of the machine's RAM. Under pressure a machine can pause its own
 *  process sampling, so the figure may be the last one known: its age goes with it. */
function suggestOf(machine) {
  if (!machine.online || (machine.mem.tone !== 'strained' && machine.mem.tone !== 'critical')) return null
  const top = machine.processes?.largest
  if (!top || !top.name || !finite(top.memBytes)) return null
  const share = finite(top.memPct) ? top.memPct / 100 : finite(machine.mem.totalBytes) && machine.mem.totalBytes > 0 ? top.memBytes / machine.mem.totalBytes : null
  if (share === null || share < SUGGEST_FLOOR) return null
  const ageSec = orNull(machine.processes.memAgeSec) ?? orNull(machine.processes.ageSec)
  return { name: top.name, memory: top.memBytes, ageSec }
}

/**
 * The view-model for one machine. `machine` is its MachineModel (toFleet), `list` the newest
 * answer binding.watchProcesses gave for it (undefined before one arrives), `ui` the person's sort
 * and search, and `now` the worker's clock.
 */
export function toActivityModel({ machine, list, ui = { sort: 'cpu', query: '' }, now }) {
  const live = machine.online && machine.tier === 'full'
  const tiles = live ? tilesOf(machine) : { network: null, disk: null, gpu: null, battery: null }
  const processes = live ? processesOf(machine, list, ui, now) : null
  const tabs = live && (processes !== null || Object.values(tiles).some(Boolean))
  // Fleet Monitor there is older than 1.2.
  const older = live && !tabs && machine.processes?.state === 'unavailable' && machine.processes.reason === 'outdated'
  return {
    tabs,
    notice: older ? `Update Fleet Monitor on ${machine.name} to 1.2 or later to see its network, disk and processes here.` : null,
    tiles,
    processes,
    suggest: suggestOf(machine)
  }
}

// --- numbers, as the design writes them --------------------------------------------------------------

/** A process's CPU, percent of one core: "38%", "5.4%", "<0.1%", "0%", "312%". */
export function procCpu(value) {
  if (!finite(value)) return '–'
  if (value <= 0) return '0%'
  if (value < 0.1) return '<0.1%'
  if (value < 9.95) return `${value.toFixed(1)}%`
  return `${Math.round(value)}%`
}

/** Energy impact: one decimal, whole numbers from 100. */
export function energyText(value) {
  if (!finite(value)) return '–'
  if (value <= 0) return '0.0'
  return value < 99.95 ? value.toFixed(1) : String(Math.round(value))
}

/** A rate in decimal units, at most three figures: { n: '4.2', unit: 'MB/s', text: '4.2 MB/s' }. */
export function rate(bytesPerSec) {
  const make = (n, unit) => ({ n, unit, text: `${n} ${unit}` })
  if (!finite(bytesPerSec) || bytesPerSec < 0) return { n: '–', unit: '', text: '–' }
  if (Math.round(bytesPerSec / 1e3) < 1000) return make(String(Math.round(bytesPerSec / 1e3)), 'KB/s')
  const units = ['MB/s', 'GB/s', 'TB/s']
  let value = bytesPerSec / 1e6
  let u = 0
  while (value >= 999.5 && u < units.length - 1) {
    value /= 1000
    u += 1
  }
  return make(value < 9.95 ? value.toFixed(1) : String(Math.round(value)), units[u])
}

/** A disk's space as the OS reports a disk (decimal): "412 / 994 GB", or "1.42 / 2 TB" from 1,000 GB. */
export function diskSpace(used, total) {
  if (total >= 1e12 - 5e8) {
    const tb = (bytes) => (bytes / 1e12).toFixed(2).replace(/\.?0+$/, '')
    return `${tb(used)} / ${tb(total)} TB`
  }
  return `${Math.round(used / 1e9)} / ${Math.round(total / 1e9)} GB`
}

const pctText = (value) => String(Math.round(value))

// --- icons -----------------------------------------------------------------------------------------

function icon(body, { box = 16, px = 16, cls = null } = {}) {
  return s(
    'svg',
    {
      viewBox: `0 0 ${box} ${box}`,
      width: px,
      height: px,
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 1.5,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
      focusable: 'false',
      class: cls
    },
    body
  )
}
const iconSearch = () => icon([s('circle', { cx: 7, cy: 7, r: 4.25 }), s('path', { d: 'M10.25 10.25L13.5 13.5' })])
const iconClear = () => icon(s('path', { d: 'M4.75 4.75l6.5 6.5M11.25 4.75l-6.5 6.5' }))
const iconSort = () => icon(s('path', { d: 'M2.5 4.5h11M2.5 8h7.5M2.5 11.5h4' }), { cls: 'fm-sort-icon' })
const iconCaret = () => icon(s('path', { d: 'M4.5 6.5L8 10l3.5-3.5' }), { cls: 'fm-sort-caret' })
const arrowDown = (px) => icon(s('path', { d: 'M5 1.5v7M2 5.5l3 3 3-3' }), { box: 10, px, cls: 'fm-dir' })
const arrowUp = (px) => icon(s('path', { d: 'M5 8.5v-7M2 4.5l3-3 3 3' }), { box: 10, px, cls: 'fm-dir' })

// --- the control: Overview | Activity ---------------------------------------------------------------

export const TAB_IDS = { overview: 'fm-tab-overview', activity: 'fm-tab-activity' }
export const TAB_PANEL_ID = 'fm-panel'

/** Two tabs in one segmented control; one tab stop (roving tabindex). Labelled by the machine's name. */
export function segControl(name, tab) {
  const button = (id, label) =>
    h(
      'button',
      {
        type: 'button',
        role: 'tab',
        class: 'fm-seg-btn',
        id: TAB_IDS[id],
        'aria-selected': tab === id ? 'true' : 'false',
        'aria-controls': TAB_PANEL_ID,
        tabindex: tab === id ? null : '-1',
        'data-action': 'tab',
        'data-tab': id
      },
      label
    )
  return h('div', { class: 'fm-seg', role: 'tablist', 'aria-label': name, 'data-key': 'seg' }, button('overview', 'Overview'), button('activity', 'Activity'))
}

// --- the memory line (Overview) ----------------------------------------------------------------------

/** "3 min ago", "1h 5m ago". */
function ageText(seconds) {
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes} min ago` : `${duration(seconds)} ago`
}

/** "python3.12 is using 28.4 GB, more than any other process.", or, for a figure a minute old or
 *  more, "python3.12 was using 28.4 GB 3 min ago, more than any other process." */
export function suggestLine(suggest) {
  if (!suggest) return null
  const past = suggest.ageSec !== null && suggest.ageSec >= SUGGEST_PAST_SEC
  return h(
    'div',
    { class: 'fm-suggest', 'data-key': 'suggest' },
    past
      ? h('p', {}, h('strong', {}, suggest.name), ' was using ', h('strong', {}, size(suggest.memory)), ` ${ageText(suggest.ageSec)}, more than any other process.`)
      : h('p', {}, h('strong', {}, suggest.name), ' is using ', h('strong', {}, size(suggest.memory)), ', more than any other process.')
  )
}

// --- tiles (Activity) ----------------------------------------------------------------------------------

function sparkSvg(series, label) {
  const [first, second] = series
  const a = seriesPaths(first, 100, 28, 2)
  const b = second ? seriesPaths(second, 100, 28, 2) : null
  return s(
    'svg',
    { class: 'fm-spark', viewBox: '0 0 100 28', preserveAspectRatio: 'none', role: 'img', 'aria-label': label, focusable: 'false' },
    s('path', { class: 'fm-area', d: a.area || 'M0 0' }),
    b ? s('path', { class: 'fm-line fm-line--second', d: b.line || 'M0 0' }) : null,
    s('path', { class: 'fm-line', d: a.line || 'M0 0' })
  )
}

function meter(pct, caption) {
  return [
    h('span', { class: 'fm-ws-bar', 'aria-hidden': 'true' }, h('span', { style: { width: `${Math.min(100, Math.max(0, pct))}%` } })),
    caption ? h('span', { class: 'fm-tile-cap' }, caption) : null
  ]
}

function tile({ key, label, tone = 'ok', figure, sub, slot, aria }) {
  return h(
    'div',
    { class: 'fm-metric fm-tile', data: { tone }, role: 'group', 'aria-label': aria, 'data-key': `tile:${key}` },
    h('span', { class: 'fm-metric-label' }, label),
    h('span', { class: 'fm-metric-row' }, figure, h('span', { class: 'fm-sub' }, sub)),
    h('div', { class: 'fm-tile-slot' }, slot)
  )
}

const bigPct = (value) => h('span', { class: 'fm-big' }, pctText(value), h('span', { class: 'fm-unit' }, '%'))

function networkTile(net) {
  const down = rate(net.down)
  const up = rate(net.up)
  // Both series on one scale: the larger one's peak in the window, plus 15 %.
  const values = [...net.downHistory, ...net.upHistory].filter(finite)
  const top = values.length > 0 ? Math.max(...values) * 1.15 : 0
  const scale = (series) => series.map((v) => (finite(v) && top > 0 ? (v / top) * 100 : null))
  const peak = net.downHistory.filter(finite)
  return tile({
    key: 'network',
    label: 'Network',
    figure: h('span', { class: 'fm-big' }, arrowDown(11), down.n, down.unit ? h('span', { class: 'fm-unit fm-unit--sp' }, down.unit) : null),
    sub: [arrowUp(9), up.text],
    slot: sparkSvg(
      [scale(net.downHistory), scale(net.upHistory)],
      peak.length > 0 ? `Network over the last 30 minutes: download peaked at ${rate(Math.max(...peak)).text}` : 'Network over the last 30 minutes: no history yet'
    ),
    aria: `Network: down ${down.text}, up ${up.text}`
  })
}

function diskTile(disk) {
  const pct = (disk.usedBytes / disk.totalBytes) * 100
  const space = diskSpace(disk.usedBytes, disk.totalBytes)
  const parts = [disk.readBps !== null ? `R ${rate(disk.readBps).text}` : null, disk.writeBps !== null ? `W ${rate(disk.writeBps).text}` : null].filter(Boolean)
  const spoken = [disk.readBps !== null ? `reading ${rate(disk.readBps).text}` : null, disk.writeBps !== null ? `writing ${rate(disk.writeBps).text}` : null].filter(Boolean)
  return tile({
    key: 'disk',
    label: 'Disk',
    tone: pct >= 95 ? 'strained' : pct >= 90 ? 'busy' : 'ok',
    figure: bigPct(pct),
    sub: space,
    slot: meter(pct, parts.join(' · ')),
    aria: `Disk: ${pctText(pct)}% used, ${space}${spoken.length > 0 ? `; ${spoken.join(', ')}` : ''}`
  })
}

function gpuTile(gpu) {
  const known = gpu.history.filter(finite)
  const avg = known.length > 0 ? known.reduce((a, b) => a + b, 0) / known.length : null
  const peak = gpu.peak ?? gpu.pct
  return tile({
    key: 'gpu',
    label: 'GPU',
    figure: bigPct(gpu.pct),
    sub: `peak ${pctText(peak)}%`,
    slot: sparkSvg([gpu.history], avg === null ? 'GPU over the last 30 minutes: no history yet' : `GPU over the last 30 minutes: average ${pctText(avg)}%, peak ${pctText(peak)}%`),
    aria: `GPU: ${pctText(gpu.pct)}%, peak ${pctText(peak)}%`
  })
}

const BATTERY_WORD = { charging: 'Charging', discharging: 'On battery', charged: 'Charged', 'not-charging': 'Not charging' }

function batteryTile(b) {
  const time = b.minutes !== null && b.minutes > 0 ? duration(b.minutes * 60) : null
  const watts = b.watts !== null ? `${Math.round(b.watts)} W` : null
  const caption =
    b.state === 'charging'
      ? [time ? `${time} to full` : null, watts]
      : b.state === 'discharging'
        ? [time ? `${time} left` : null, watts]
        : ['Power adapter']
  const text = caption.filter(Boolean).join(' · ')
  const tone = b.state === 'discharging' ? (b.pct <= 10 ? 'critical' : b.pct <= 20 ? 'busy' : 'ok') : 'ok'
  return tile({
    key: 'battery',
    label: 'Battery',
    tone,
    figure: bigPct(b.pct),
    sub: BATTERY_WORD[b.state],
    slot: meter(b.pct, text),
    aria: `Battery: ${pctText(b.pct)}%, ${BATTERY_WORD[b.state]}${text ? `, ${text}` : ''}`
  })
}

/** One card of tiles; a tile the machine does not report is not drawn, and with none, no card. */
export function tilesSection(tiles) {
  const out = []
  const names = []
  if (tiles.network) out.push(networkTile(tiles.network)), names.push('network')
  if (tiles.disk) out.push(diskTile(tiles.disk)), names.push('disk')
  if (tiles.gpu) out.push(gpuTile(tiles.gpu)), names.push('GPU')
  if (tiles.battery) out.push(batteryTile(tiles.battery)), names.push('battery')
  if (out.length === 0) return null
  const label = names.join(', ')
  return h('section', { class: 'fm-section fm-tiles', 'aria-label': label.charAt(0).toUpperCase() + label.slice(1), 'data-key': 'tiles' }, out)
}

// --- the list: order, search, the cut ---------------------------------------------------------------

/** Highest first, nulls last. */
function desc(a, b) {
  if (a === b) return 0
  if (a === null) return 1
  if (b === null) return -1
  return b - a
}
const COMPARE = {
  cpu: (a, b) => desc(a.cpu, b.cpu),
  memory: (a, b) => desc(a.memory, b.memory),
  energy: (a, b) => desc(a.energy, b.energy),
  name: (a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })
}

/** Rows in the order of `sort` (numbers highest first, names A to Z). With `held` (a previous
 *  order, as keys), rows keep that order instead; rows new since then follow, sorted. */
export function arrangeRows(rows, sort, held = null) {
  const compare = COMPARE[sort] ?? COMPARE.cpu
  const sorted = [...rows].sort((a, b) => compare(a, b) || a.pid - b.pid)
  if (!held) return sorted
  const byKey = new Map(rows.map((r) => [r.key, r]))
  const before = new Set(held)
  return held.filter((key) => byKey.has(key)).map((key) => byKey.get(key)).concat(sorted.filter((r) => !before.has(r.key)))
}

/** Search: the name, case ignored, and the process ID, as typed. */
export function matchRows(rows, query) {
  const q = query.trim().toLowerCase()
  if (!q) return rows
  return rows.filter((r) => r.name.toLowerCase().includes(q) || String(r.pid).includes(q))
}

// --- the Processes card -------------------------------------------------------------------------------

const SORT_LABEL = { cpu: 'CPU', memory: 'Memory', energy: 'Energy', name: 'Name' }
/** What the live region says after the sort changes. */
export const SORT_SPOKEN = {
  cpu: 'Sorted by CPU, highest first',
  memory: 'Sorted by memory, highest first',
  energy: 'Sorted by energy impact, highest first',
  name: 'Sorted by name, A to Z'
}
/** The CPU column's label: a process's CPU is percent of one core, so 100% is one core busy. */
export const CPU_HEAD = '% of core'

/** "8 processes match chrome". */
export function matchesSpoken(count, query) {
  const q = query.trim()
  if (count === 0) return `No process matches ${q}`
  return `${count} ${count === 1 ? 'process matches' : 'processes match'} ${q}`
}

function countText(p, matches) {
  if (p.state !== 'ready') return ''
  const searching = p.query.trim() !== ''
  // A top list, or this computer's list cut at the answer's size: the count says how many are
  // listed, so it agrees with "Show all N".
  if (p.top || p.truncated) {
    if (searching) return `${matches} of ${p.listed}`
    return p.total !== null && p.total > p.listed ? `top ${p.listed} of ${p.total}` : `top ${p.listed}`
  }
  const total = p.total ?? p.listed
  return searching ? `${matches} of ${total}` : String(total)
}

function toolbar(p) {
  const sorts = ['cpu', 'memory', ...(p.energy ? ['energy'] : []), 'name']
  return h(
    'div',
    { class: 'fm-proc-bar' },
    h(
      'div',
      { class: 'fm-search' },
      iconSearch(),
      h('input', {
        type: 'search',
        class: 'fm-search-input',
        placeholder: 'Search',
        'aria-label': 'Search processes',
        autocomplete: 'off',
        spellcheck: 'false',
        'data-input': 'search'
      }),
      p.query
        ? h('button', { type: 'button', class: 'fm-icon-btn fm-ghost fm-search-clear', 'data-action': 'clear-search', 'aria-label': 'Clear search', title: 'Clear search' }, iconClear())
        : null
    ),
    h(
      'span',
      { class: 'fm-sort' },
      iconSort(),
      h(
        'select',
        { class: 'fm-sort-select', 'aria-label': 'Sort by', title: 'Sort by', 'data-input': 'sort' },
        sorts.map((key) => h('option', { value: key, selected: key === p.sort }, SORT_LABEL[key]))
      ),
      iconCaret()
    )
  )
}

function head(p) {
  const key = (name) => (p.sort === name ? 'is-key' : null)
  return h(
    'div',
    { class: 'fm-proc-head', 'aria-hidden': 'true', 'data-key': 'proc-head' },
    h('span', { class: key('name') }, 'Name'),
    h('span', { class: 'fm-proc-hint' }),
    h('span', { class: ['fm-proc-cpu', key('cpu') ?? (p.sort === 'name' ? 'is-key' : null)], title: 'Percent of one core, as Activity Monitor shows it: a process busy on four cores shows 400%' }, CPU_HEAD),
    p.energy ? h('span', { class: ['fm-proc-energy', key('energy')] }, 'Energy') : null,
    h('span', { class: ['fm-proc-mem', key('memory')] }, 'Memory')
  )
}

/** A row's accessible name: complete at every width, whatever columns show. */
function rowLabel(r, p) {
  const parts = [r.name, `CPU ${procCpu(r.cpu)} of one core`]
  if (p.energy && p.sort === 'energy') parts.push(`energy impact ${energyText(r.energy)}`)
  parts.push(`memory ${size(r.memory)}`)
  return parts.join(', ')
}

const moreId = (r) => `fm-proc-more-${r.key.replace(/[^0-9]/g, '-')}`

function rowFacts(r, p) {
  const facts = [
    { k: 'CPU', v: `${procCpu(r.cpu)} of one core`, cls: 'fm-fact--cpu' },
    { k: 'Memory', v: size(r.memory), cls: 'fm-fact--mem' },
    p.energy ? { k: 'Energy impact', v: energyText(r.energy), cls: 'fm-fact--energy' } : null,
    { k: 'PID', v: String(r.pid) },
    r.user ? { k: 'User', v: r.user } : null,
    r.runningSec !== null ? { k: 'Running for', v: duration(r.runningSec) } : null
  ].filter(Boolean)
  return h(
    'dl',
    { class: 'fm-facts' },
    facts.map((f) => h('div', { class: f.cls ? `fm-fact ${f.cls}` : 'fm-fact' }, h('dt', {}, f.k), h('dd', {}, f.v)))
  )
}

function procRow(r, p, open, tabStop) {
  const num = (cls, key, text) => h('span', { class: ['fm-proc-num', cls, p.sort === key || (key === 'cpu' && p.sort === 'name') ? 'is-key' : null] }, text)
  return h(
    'li',
    { class: open ? 'fm-proc is-open' : 'fm-proc', 'data-key': `proc:${r.key}` },
    h(
      'button',
      {
        type: 'button',
        class: 'fm-proc-row',
        'data-action': 'proc',
        'data-id': r.key,
        'aria-expanded': open ? 'true' : 'false',
        'aria-controls': open ? moreId(r) : null,
        'aria-label': rowLabel(r, p),
        title: r.name,
        tabindex: tabStop ? '0' : '-1'
      },
      h('span', { class: 'fm-proc-name' }, r.name),
      h('span', { class: 'fm-proc-hint', 'aria-hidden': 'true' }, r.hint ?? ''),
      num('fm-proc-cpu', 'cpu', procCpu(r.cpu)),
      p.energy ? num('fm-proc-energy', 'energy', energyText(r.energy)) : null,
      num('fm-proc-mem', 'memory', size(r.memory))
    ),
    open
      ? h(
          'div',
          { class: 'fm-proc-more', role: 'region', id: moreId(r), 'aria-label': `${r.name}, process ${r.pid}` },
          r.command ? h('p', { class: 'fm-proc-cmd', title: r.command }, r.command) : null,
          rowFacts(r, p)
        )
      : null
  )
}

function skeleton(p) {
  const widths = ['46%', '72%', '38%', '58%', '64%', '42%', '52%', '34%']
  return h(
    'div',
    { class: 'fm-proc-skel fm-skel', role: 'status', 'aria-label': 'Loading processes', 'data-key': 'proc-skel' },
    widths.map((width) =>
      h(
        'div',
        { class: 'fm-proc-skel-row' },
        h('span', { class: 'fm-skel-bar', style: { width } }),
        h('span', { class: 'fm-proc-hint' }),
        h('span', { class: 'fm-skel-bar fm-proc-cpu' }),
        p.energy ? h('span', { class: 'fm-skel-bar fm-proc-energy' }) : null,
        h('span', { class: 'fm-skel-bar fm-proc-mem' })
      )
    )
  )
}

/**
 * The Processes card. `shown` are the rows to draw (ordered, searched and cut by the view),
 * `matches` how many rows the search matched in all, `open` the open row's key, `tabStop` the key of
 * the row that holds the list's one tab stop, `machineName` the machine's name (remote text),
 * `announce` what the live region says, and `now` the worker's clock.
 */
export function processesSection(p, { shown, matches, open, tabStop, machineName, announce, since }) {
  const query = p.query.trim()
  const nodes = [h('div', { class: 'fm-proc-top', 'data-key': 'proc-top' }, h('h2', {}, 'Processes'), h('span', { class: 'fm-sub' }, countText(p, matches)), toolbar(p))]
  if (p.state === 'loading') {
    nodes.push(h('div', { class: 'fm-proc-list', 'data-key': 'proc-loading' }, head(p), skeleton(p)))
  } else if (p.state === 'failed') {
    nodes.push(h('p', { class: 'fm-note', 'data-key': 'proc-failed' }, 'The process list could not be read just now. It is asked for again in a few seconds.'))
  } else if (query && matches === 0) {
    nodes.push(
      h(
        'div',
        { class: 'fm-proc-empty', role: 'status', 'data-key': 'proc-empty' },
        h('h3', {}, `No process matches “${query}”`),
        h('p', {}, p.top ? `Only ${machineName}’s ${p.listed} busiest processes are listed, so it may still be running there.` : 'Names and process IDs are searched.'),
        h('button', { type: 'button', class: 'fm-btn fm-ghost', 'data-action': 'clear-search' }, 'Clear search')
      )
    )
  } else {
    nodes.push(
      h(
        'div',
        { class: 'fm-proc-list', 'data-key': 'proc-list' },
        head(p),
        h(
          'ul',
          { class: 'fm-procs', role: 'list', 'aria-label': 'Processes', 'data-key': 'procs' },
          shown.map((r) => procRow(r, p, r.key === open, r.key === tabStop))
        )
      )
    )
    if (shown.length < matches) {
      nodes.push(h('div', { class: 'fm-proc-foot', 'data-key': 'proc-foot' }, h('button', { type: 'button', class: 'fm-foot-link', 'data-action': 'show-all' }, `Show all ${matches}`)))
    }
  }
  if (p.state === 'ready' && !p.top && p.truncated) {
    nodes.push(h('p', { class: 'fm-note fm-proc-note', 'data-key': 'proc-note' }, `This computer has more processes than one answer holds, so its ${p.listed} busiest are listed.`))
  }
  if (p.state === 'ready' && p.top) {
    const template = `${machineName} sends its ${p.listed} busiest processes by memory and CPU, not the full list.`
    nodes.push(
      p.takenAt === null
        ? h('p', { class: 'fm-note fm-proc-note', 'data-key': 'proc-note' }, template)
        : since('p', { class: 'fm-note fm-proc-note', 'data-key': 'proc-note' }, `${template} Updated {ago}.`, p.takenAt)
    )
  }
  nodes.push(h('p', { class: 'fm-sr', role: 'status', 'aria-live': 'polite', 'data-key': 'proc-status' }, announce))
  return h(
    'section',
    {
      class: 'fm-section fm-procs-card',
      'aria-label': 'Processes',
      'aria-busy': p.state === 'loading' ? 'true' : null,
      data: { sort: p.sort, energy: p.energy ? '' : null },
      'data-key': 'procs-card'
    },
    nodes
  )
}
