// The Fleet Monitor panel: an overview card per machine and a detail screen per machine, after
// the visual design (Main.dc.html in the design project). It draws toFleet() from
// fleet-binding.mjs and, for a machine's Activity tab and memory line, toActivityModel() from
// activity.mjs. Untrusted text (machine, workspace, process and error text) only ever becomes
// text nodes or attribute values; see dom.mjs.
import {
  arrangeRows,
  FIRST_ROWS,
  matchesSpoken,
  matchRows,
  processesSection,
  segControl,
  SORT_SPOKEN,
  suggestLine,
  TAB_IDS,
  TAB_PANEL_ID,
  tilesSection,
  toActivityModel
} from './activity.mjs'
import { seriesPaths } from './charts.mjs'
import { copyText, h, morphChildren, s, selectText } from './dom.mjs'
import { INSTALL_SOURCE, MAX_CORES_DRAWN, toFleet } from './fleet-binding.mjs'
import { ago, duration, gb, loads, pct, share, size } from './format.mjs'

/** Where Orca pairs another machine. There is no host call that opens it, so the panel says where. */
export const PAIR_PATH = 'Settings → Remote Orca servers → Add server'
/** The one address the panel opens: its source, from the quiet "Star on GitHub" link. */
export const REPOSITORY_URL = 'https://github.com/mswdev/orca-fleet-monitor'
const COPIED_MS = 2_000
const RETRY_SETTLE_MS = 1_500

// --- icons (16 px, stroked, from the design) ----------------------------------------------------

function icon(body, extra = {}) {
  return s(
    'svg',
    {
      viewBox: '0 0 16 16',
      width: 16,
      height: 16,
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 1.5,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
      focusable: 'false',
      ...extra
    },
    body
  )
}
const iconPlus = () => icon(s('path', { d: 'M8 3v10M3 8h10' }))
const iconBack = () => icon(s('path', { d: 'M10 3L5 8l5 5' }))
const iconDownload = () => icon(s('path', { d: 'M8 2v8M4.5 6.5L8 10l3.5-3.5M3 13.5h10' }), { class: 'fm-flex-none' })
const iconChevron = () => icon(s('path', { d: 'M6 3l5 5-5 5' }), { class: 'fm-chevron' })
const iconInfo = () =>
  icon([s('circle', { cx: 8, cy: 8, r: 5.5 }), s('path', { d: 'M8 7.25v3.5M8 5.25h.01' })], { class: 'fm-flex-none' })
const iconOffline = () =>
  icon([s('circle', { cx: 8, cy: 8, r: 5.5 }), s('path', { d: 'M4.1 4.1l7.8 7.8' })], { class: 'fm-offline-icon' })
const iconScreen = () =>
  s(
    'svg',
    {
      viewBox: '0 0 24 24',
      width: 36,
      height: 36,
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 1.5,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
      class: 'fm-empty-icon'
    },
    s('rect', { x: 3, y: 4, width: 18, height: 12, rx: 2 }),
    s('path', { d: 'M8 20h8M12 16v4' })
  )

// --- small pieces ------------------------------------------------------------------------------

/** One to four bars, so health never relies on colour alone. The reasons that set the level go
 *  in its tooltip and, for screen readers, after the label. */
function level(health, label, reasons = []) {
  const why = reasons.join('; ')
  return h(
    'span',
    { class: 'fm-level', data: { health }, title: why || null },
    h('span', { class: 'fm-pips', 'aria-hidden': 'true' }, h('span'), h('span'), h('span'), h('span')),
    label,
    why ? h('span', { class: 'fm-sr' }, `: ${why}`) : null
  )
}

function dot(m) {
  return m.online
    ? h('span', { class: 'fm-dot', data: { health: m.health }, 'aria-hidden': 'true' })
    : h('span', { class: 'fm-dot fm-dot--hollow', 'aria-hidden': 'true' })
}

function tag(text) {
  return text ? h('span', { class: 'fm-tag' }, text) : null
}

function big(value, large = false) {
  return h('span', { class: large ? 'fm-big fm-big--lg' : 'fm-big' }, pct(value), h('span', { class: 'fm-unit' }, '%'))
}

/** Text that says how long ago something was, kept current by the panel's one-second ticker. */
function since(tagName, props, template, at, now) {
  return h(tagName, { ...props, data: { ...(props.data ?? {}), since: at, template } }, template.replace('{ago}', ago(at, now)))
}

function coresText(m) {
  return m.cores ? `${m.cores} ${m.cores === 1 ? 'core' : 'cores'}` : ''
}

function memText(m, spaced) {
  if (m.mem.usedBytes === null || m.mem.totalBytes === null) return ''
  return `${gb(m.mem.usedBytes)}${spaced ? ' / ' : '/'}${gb(m.mem.totalBytes)} GB`
}

/** Beside the memory figure: used / total, or for a pressure reading only how much RAM there is
 *  (Orca's "used" on a Mac is pressure, not RAM in use). */
function memSub(m, spaced) {
  if (m.mem.kind === 'pressure') return m.mem.totalBytes === null ? '' : `${gb(m.mem.totalBytes)} GB`
  return memText(m, spaced)
}

const PRESSURE_WORD = { warning: 'Warning', critical: 'Critical', normal: 'Normal' }

/** A quiet word when macOS's memory pressure is not normal: yellow (warning) or red (critical). */
function pressureMarker(m) {
  const level = m.mem.mac?.pressure
  if (level !== 'warning' && level !== 'critical') return null
  return h('span', { class: 'fm-pressure', data: { health: level === 'critical' ? 'critical' : 'strained' } }, `pressure ${level}`)
}

/** Memory for a screen reader, named as the panel names it. */
function memAria(m) {
  if (m.mem.pct === null || !m.mem.reliable) return 'memory unknown'
  if (m.mem.kind === 'used') {
    const pressure = m.mem.mac?.pressure && m.mem.mac.pressure !== 'normal' ? `, memory pressure ${m.mem.mac.pressure}` : ''
    return `RAM ${pct(m.mem.pct)}% used (${gb(m.mem.usedBytes)} of ${gb(m.mem.totalBytes)} GB)${pressure}`
  }
  if (m.mem.kind === 'pressure') return `memory pressure ${pct(m.mem.pct)}%`
  return `memory ${pct(m.mem.pct)}%`
}

function lastSeenText(m) {
  return m.lastSeenAt === null ? null : 'Last seen {ago}'
}

// --- overview ----------------------------------------------------------------------------------

function summaryText(fleet) {
  if (fleet.state === 'loading') return 'Connecting to your machines'
  if (fleet.state === 'error') return 'Fleet Monitor is not answering'
  if (fleet.remotes === 0) return fleet.cliError ? 'Cannot use the Orca CLI' : 'Nothing paired yet'
  return `${fleet.online} of ${fleet.total} online`
}

function overviewHeader(fleet, ui) {
  return h(
    'header',
    { class: 'fm-top', 'data-key': 'top' },
    h(
      'div',
      { class: 'fm-top-text' },
      h('h1', { class: 'fm-title' }, 'Fleet Monitor'),
      h('p', { class: 'fm-summary', 'aria-live': 'polite' }, summaryText(fleet))
    ),
    h(
      'button',
      {
        type: 'button',
        class: 'fm-icon-btn fm-ghost',
        'data-action': 'pair',
        'aria-label': 'How to pair a machine',
        'aria-expanded': ui.pairOpen ? 'true' : 'false',
        'aria-controls': 'fm-pair-hint',
        title: 'How to pair a machine'
      },
      iconPlus()
    )
  )
}

/** Always drawn, hidden while closed, so the button's aria-controls names an element. */
function pairHint(open) {
  return h(
    'div',
    { class: 'fm-hint', id: 'fm-pair-hint', 'data-key': 'pair-hint', hidden: !open },
    iconInfo(),
    h(
      'p',
      {},
      'To watch another computer, pair it with Orca in ',
      h('strong', {}, PAIR_PATH),
      '. It shows up here by itself.'
    )
  )
}

function spark(values, tone) {
  const paths = seriesPaths(values, 100, 28, 2)
  return s(
    'svg',
    { class: 'fm-spark', viewBox: '0 0 100 28', preserveAspectRatio: 'none', 'aria-hidden': 'true', focusable: 'false' },
    s('path', { class: 'fm-area', d: paths.area || 'M0 0' }),
    s('path', { class: 'fm-line', d: paths.line || 'M0 0' })
  )
}

/** "Last reading 2 min ago: memory pressure critical, …", kept current. */
function lostNote(tagName, className, m, now) {
  const lost = m.lost
  const template = lost.lastReadingAt === null ? `Last reading: ${lost.summary}` : `Last reading {ago}: ${lost.summary}`
  const props = { class: className, data: { health: lost.level } }
  return lost.lastReadingAt === null ? h(tagName, props, template) : since(tagName, props, template, lost.lastReadingAt, now)
}

/** `now` is the worker's clock, as the card's own "Last seen" text uses. */
function cardAria(m, now) {
  if (m.status === 'connecting') return `${m.name}, connecting. Open details.`
  const lost = m.lost ? ` ${m.lost.label} while its memory was elevated. Last reading${m.lost.lastReadingAt === null ? '' : ` ${ago(m.lost.lastReadingAt, now)}`}: ${m.lost.summary}.` : ''
  if (!m.online) return `${m.name}, offline.${lost}${m.lastSeenAt === null ? '' : ` Last seen ${ago(m.lastSeenAt, now)}.`} Open details.`
  const cpu = m.cpu.estimated
    ? m.cpu.pct === null
      ? 'no CPU estimate'
      : `CPU about ${pct(m.cpu.pct)}% (estimated, not counted in health)`
    : m.cpu.pct === null
      ? 'CPU unknown'
      : `CPU ${pct(m.cpu.pct)}%`
  const mem = memAria(m)
  const why = m.reasons.length > 0 ? ` (${m.reasons.join('; ')})` : ''
  return `${m.name}${m.tag ? ` (${m.tag})` : ''}, ${m.healthLabel}${why}. ${cpu}, ${mem}. Open details.`
}

/** The card of a machine that stopped answering while its memory was elevated. */
function lostCard(m, now, props) {
  return h(
    'button',
    { ...props, class: 'fm-card fm-card--offline fm-card--lost', data: { health: m.lost.level } },
    h('span', { class: 'fm-card-head' }, dot(m), h('span', { class: 'fm-name' }, m.name), level(m.lost.level, m.lost.label, m.reasons)),
    lostNote('span', 'fm-card-note fm-lost-note', m, now)
  )
}

function metric(label, value, sub, tone, history, marker = null) {
  return h(
    'span',
    { class: 'fm-metric', data: { tone } },
    h('span', { class: 'fm-metric-label' }, label, marker),
    h('span', { class: 'fm-metric-row' }, big(value), sub ? h('span', { class: 'fm-sub' }, sub) : null),
    spark(history, tone)
  )
}

function skeletonMetrics() {
  const column = (labelWidth) =>
    h(
      'div',
      { class: 'fm-skel-col' },
      h('div', { class: 'fm-skel-bar', style: { width: labelWidth, height: '9px' } }),
      h('div', { class: 'fm-skel-bar', style: { width: '54px', height: '18px' } }),
      h('div', { class: 'fm-skel-bar', style: { height: '26px' } })
    )
  return h('div', { class: 'fm-skel-row' }, column('30px'), column('44px'))
}

function card(m, now) {
  const props = { type: 'button', 'data-key': `card:${m.id}`, 'data-action': 'open', 'data-id': m.id, 'aria-label': cardAria(m, now) }
  if (m.status === 'connecting') {
    return h(
      'button',
      { ...props, class: 'fm-card fm-card--waiting' },
      h('span', { class: 'fm-card-head' }, dot(m), h('span', { class: 'fm-name' }, m.name), h('span', { class: 'fm-state' }, 'Connecting…')),
      h('span', { class: 'fm-skel', 'aria-hidden': 'true' }, skeletonMetrics())
    )
  }
  if (!m.online && m.lost) return lostCard(m, now, props)
  if (!m.online) {
    const seen = lastSeenText(m)
    return h(
      'button',
      { ...props, class: 'fm-card fm-card--offline' },
      h('span', { class: 'fm-card-head' }, dot(m), h('span', { class: 'fm-name' }, m.name), h('span', { class: 'fm-state' }, 'Offline')),
      seen
        ? since('span', { class: 'fm-card-note' }, seen, m.lastSeenAt, now)
        : h('span', { class: 'fm-card-note' }, 'Not reached yet')
    )
  }
  return h(
    'button',
    { ...props, class: 'fm-card' },
    h('span', { class: 'fm-card-head' }, dot(m), h('span', { class: 'fm-name' }, m.name), tag(m.tag), level(m.health, m.healthLabel, m.reasons)),
    m.lost ? h('span', { class: 'fm-lost-line', data: { health: m.lost.level } }, m.lost.label, ' · ', lostNote('span', 'fm-lost-note', m, now)) : null,
    h(
      'span',
      { class: 'fm-metrics' },
      metric('CPU', m.cpu.pct, m.cpu.estimated ? (m.cpu.pct === null ? 'no estimate' : 'estimate') : coresText(m), m.cpu.tone, m.cpu.history),
      metric(m.mem.label, m.mem.reliable ? m.mem.pct : null, memSub(m, false), m.mem.tone, m.mem.history, pressureMarker(m))
    )
  )
}

function loadingGrid() {
  return h(
    'div',
    { class: 'fm-grid', role: 'status', 'aria-label': 'Loading machines', 'data-key': 'loading' },
    [1, 2, 3].map(() =>
      h(
        'div',
        { class: 'fm-skel fm-skel-card' },
        h(
          'div',
          { class: 'fm-skel-head' },
          h('div', { class: 'fm-skel-bar fm-skel-dot' }),
          h('div', { class: 'fm-skel-bar', style: { width: '42%', height: '12px' } }),
          h('div', { class: 'fm-skel-bar fm-skel-end', style: { width: '48px', height: '12px' } })
        ),
        skeletonMetrics()
      )
    )
  )
}

function emptyBlock() {
  return h(
    'div',
    { class: 'fm-empty', 'data-key': 'empty' },
    iconScreen(),
    h('h2', {}, 'No other machines paired'),
    h('p', {}, 'Pair another computer that runs Orca to watch its CPU, memory and busiest workspaces from here.'),
    h('p', { class: 'fm-path' }, PAIR_PATH)
  )
}

/** The Orca CLI cannot be found or run: nothing paired can be found or read, so say why rather
 *  than "nothing paired". */
function cliProblemBlock(fleet) {
  return h(
    'div',
    { class: 'fm-section fm-message', role: 'alert', 'data-key': 'cli-problem' },
    h('h2', {}, 'Fleet Monitor cannot use the Orca CLI'),
    h('p', { class: 'fm-error-text' }, fleet.cliError),
    h(
      'p',
      {},
      'Until it can, it cannot find or read paired machines; this computer is still shown. If Orca’s CLI is somewhere unusual, set its path in Fleet Monitor’s settings.'
    )
  )
}

function errorBlock(fleet) {
  return h(
    'div',
    { class: 'fm-section fm-message', 'data-key': 'error' },
    h('h2', {}, 'Fleet Monitor did not answer'),
    h('p', {}, `Its worker did not answer${fleet.error ? ` (${fleet.error})` : ''}. This panel asks again every few seconds.`),
    h('button', { type: 'button', class: 'fm-btn fm-ghost', 'data-action': 'reload' }, 'Try again')
  )
}

function overview(fleet, ui, now) {
  const nodes = [overviewHeader(fleet, ui), pairHint(ui.pairOpen)]
  if (fleet.state === 'loading') {
    nodes.push(loadingGrid())
    return nodes
  }
  if (fleet.state === 'error') {
    nodes.push(errorBlock(fleet))
    return nodes
  }
  nodes.push(h('div', { class: 'fm-grid', 'data-key': 'grid' }, fleet.machines.map((m) => card(m, now))))
  if (fleet.remotes === 0) nodes.push(fleet.cliError ? cliProblemBlock(fleet) : emptyBlock())
  else if (fleet.cliError) {
    nodes.push(h('p', { class: 'fm-notice', role: 'status', 'data-key': 'cli-error' }, `Paired machines cannot be listed or read: ${fleet.cliError}`))
  }
  if (fleet.omitted > 0) {
    const n = fleet.omitted
    nodes.push(
      h('p', { class: 'fm-notice', 'data-key': 'omitted' }, `${n} paired ${n === 1 ? 'machine is' : 'machines are'} not shown: their readings would not fit in one answer to this panel.`)
    )
  }
  const foot = starFoot(fleet, ui)
  if (foot) nodes.push(foot)
  return nodes
}

/**
 * The quiet "Star on GitHub" link, below everything. Where this computer has the GitHub CLI, a
 * press stars the project with it and the link says so; where that fails, or there is no CLI, it
 * opens the project's page (only where the frame can: the desktop app). The page is opened within
 * a press, as Orca requires, so after a failed try it is offered as a link of its own.
 */
function starFoot(fleet, ui) {
  const canStar = ui.canStar && fleet.canStar === true
  const foot = (child) => h('footer', { class: 'fm-foot', 'data-key': 'foot' }, child)
  const link = (action, label, more = {}) => h('button', { type: 'button', class: 'fm-foot-link', 'data-action': action, 'data-key': 'star', ...more }, label)
  if (ui.star === 'done') return foot(h('span', { class: 'fm-foot-note', role: 'status', 'data-key': 'star' }, 'Starred on GitHub. Thank you.'))
  // aria-disabled, not disabled: a disabled button drops keyboard focus to the page.
  if (ui.star === 'busy') return foot(link('star', 'Starring…', { 'aria-disabled': 'true' }))
  if (ui.star === 'failed') {
    return foot(
      ui.canOpenExternal
        ? link('star-open', 'Could not star from here. Open it on GitHub')
        : h('span', { class: 'fm-foot-note', role: 'status', 'data-key': 'star' }, 'Could not star from here.')
    )
  }
  return canStar || ui.canOpenExternal ? foot(link('star', 'Star on GitHub')) : null
}

// --- detail ------------------------------------------------------------------------------------

function detailHeader(m, now, act, tab) {
  let subtitle
  if (m.status === 'connecting') subtitle = h('p', { class: 'fm-summary' }, 'Connecting…')
  else if (!m.online) {
    subtitle = m.lastSeenAt === null ? h('p', { class: 'fm-summary' }, 'Not reached yet') : since('p', { class: 'fm-summary' }, 'Last seen {ago}', m.lastSeenAt, now)
  } else if (m.updatedAt === null) subtitle = h('p', { class: 'fm-summary' }, m.tier === 'basic' ? 'Basic stats' : 'Waiting for a reading')
  else subtitle = since('p', { class: 'fm-summary' }, m.tier === 'basic' ? 'Basic stats · updated {ago}' : 'Updated {ago}', m.updatedAt, now)
  const reasons =
    m.online && m.reasons.length > 0 ? h('p', { class: 'fm-summary fm-reasons', data: { health: m.health }, title: m.reasons.join('; ') }, `${m.healthLabel}: ${m.reasons.join('; ')}`) : null
  return h(
    'header',
    { class: 'fm-top fm-top--detail', 'data-key': `detail-top:${m.id}` },
    h(
      'button',
      { type: 'button', class: 'fm-icon-btn fm-ghost fm-back', 'data-action': 'back', 'aria-label': 'Back to all machines', title: 'Back' },
      iconBack()
    ),
    h(
      'div',
      { class: 'fm-detail-id' },
      h('div', { class: 'fm-detail-name-row' }, dot(m), h('h1', { class: 'fm-detail-name', title: m.name }, m.name), tag(m.tag)),
      subtitle,
      reasons
    ),
    m.online ? level(m.health, m.healthLabel) : m.lost ? level(m.lost.level, m.lost.label) : h('span', { class: 'fm-state' }, m.status === 'connecting' ? 'Connecting…' : 'Offline'),
    act?.tabs ? segControl(m.name, tab) : null
  )
}

/** At the top of a detail screen: this machine stopped answering, or its readings stopped, while
 *  its memory was elevated, with its last reading. */
function lostSection(m, now) {
  const lost = m.lost
  const heading = lost.how === 'stale' ? `${m.name}’s readings stopped` : `${m.name} stopped answering`
  const why =
    lost.how === 'stale'
      ? 'Orca still reaches it, but Fleet Monitor’s readings from it stopped arriving while its memory was short. It may be running out of memory.'
      : 'It stopped answering while its memory was short. It may have run out of memory and locked up.'
  return h(
    'section',
    { class: 'fm-section fm-lost', role: 'status', data: { health: lost.level }, 'data-key': 'lost' },
    h('h2', {}, heading),
    lostNote('p', 'fm-lost-note', m, now),
    h('p', {}, why)
  )
}

function chart(values, tone, label) {
  const paths = seriesPaths(values, 300, 72, 0)
  return h(
    'div',
    { class: 'fm-chart' },
    h('div', { class: 'fm-yaxis', 'aria-hidden': 'true' }, h('span', {}, '100'), h('span', {}, '50'), h('span', {}, '0')),
    h(
      'div',
      { class: 'fm-plot' },
      s(
        'svg',
        { viewBox: '0 0 300 72', preserveAspectRatio: 'none', role: 'img', 'aria-label': label, focusable: 'false' },
        s('line', { class: 'fm-gridline', x1: 0, y1: 0, x2: 300, y2: 0 }),
        s('line', { class: 'fm-gridline fm-gridline--mid', x1: 0, y1: 36, x2: 300, y2: 36 }),
        s('line', { class: 'fm-gridline', x1: 0, y1: 72, x2: 300, y2: 72 }),
        s('path', { class: 'fm-area', d: paths.area || 'M0 0' }),
        s('path', { class: 'fm-line', d: paths.line || 'M0 0' })
      ),
      h('div', { class: 'fm-xaxis', 'aria-hidden': 'true' }, h('span', {}, '-30m'), h('span', {}, '-15m'), h('span', {}, 'now'))
    )
  )
}

function statsText(stats) {
  return stats ? `avg ${pct(stats.avg)}% · peak ${pct(stats.peak)}%` : 'no history yet'
}

function chartLabel(what, value, stats) {
  const now = value === null ? 'now unknown' : `now ${pct(value)}%`
  return `${what} over the last 30 minutes: ${now}${stats ? `, average ${pct(stats.avg)}%, peak ${pct(stats.peak)}%` : ''}`
}

/** Bars per row: past this, a group's cores wrap onto more rows (a 128-core server is four rows
 *  of 32), so a narrow panel never has to fit more bars side by side than it has room for. */
const CORES_PER_ROW = 32

function chunk(values, size) {
  const rows = []
  for (let i = 0; i < values.length; i += size) rows.push(values.slice(i, i + size))
  return rows
}

function cores(groups) {
  const total = groups.reduce((n, g) => n + g.values.length, 0)
  const note = groups.length > 1 && groups.every((g) => g.short) ? groups.map((g) => `${g.values.length}${g.short}`).join(' + ') : `${total} cores`
  const dense = total > 24
  // Every group gets the same number of rows, so bars keep one width across groups.
  const rowCount = Math.max(1, Math.ceil(total / CORES_PER_ROW))
  return h(
    'div',
    { class: 'fm-cores' },
    h('div', { class: 'fm-section-head fm-cores-head' }, h('h3', {}, 'Per core'), h('span', { class: 'fm-sub fm-sub--xs' }, note)),
    h(
      'div',
      { class: 'fm-core-groups' },
      groups.map((g) => {
        const perRow = Math.max(1, Math.ceil(g.values.length / rowCount))
        const tones = chunk(g.tones, perRow)
        return h(
          'div',
          { class: 'fm-core-group', style: { 'flex-grow': perRow } },
          h(
            'div',
            {
              class: rowCount > 1 ? 'fm-core-rows fm-core-rows--multi' : 'fm-core-rows',
              role: 'img',
              'aria-label': `${g.label} load: ${g.values.map((v) => `${Math.round(v)}%`).join(', ')}`
            },
            chunk(g.values, perRow).map((row, r) =>
              h(
                'div',
                { class: dense ? 'fm-core-bars fm-core-bars--dense' : 'fm-core-bars' },
                row.map((v, i) =>
                  h('div', { class: 'fm-core', data: { tone: tones[r][i] } }, h('div', { class: 'fm-core-fill', style: { height: `${Math.max(3, v)}%` } }))
                )
              )
            )
          ),
          h('div', { class: 'fm-core-label' }, g.label)
        )
      })
    )
  )
}

function estimateNote(m) {
  if (!m.cpu.estimated) return null
  return h(
    'p',
    { class: 'fm-note' },
    m.cpu.pct === null
      ? 'No estimate: this machine reports no load average (Windows does not have one). Its health is judged on memory.'
      : 'Estimated from the load average, not measured, so it does not count towards health; this machine is judged on memory.'
  )
}

function cpuSection(m) {
  const sub = [coresText(m), m.cpu.estimated ? (m.cpu.pct === null ? 'no estimate' : 'estimate') : ''].filter(Boolean).join(' · ')
  return h(
    'section',
    { class: 'fm-section', data: { tone: m.cpu.tone }, 'aria-label': 'CPU', 'data-key': 'cpu' },
    h('div', { class: 'fm-section-head' }, h('h2', {}, 'CPU'), sub ? h('span', { class: 'fm-sub' }, sub) : null),
    h('div', { class: 'fm-reading' }, big(m.cpu.pct, true), h('span', { class: 'fm-sub' }, statsText(m.cpu.stats))),
    estimateNote(m),
    chart(m.cpu.history, m.cpu.tone, chartLabel(m.cpu.estimated ? 'CPU estimate' : 'CPU', m.cpu.pct, m.cpu.stats)),
    m.cpu.groups
      ? cores(m.cpu.groups)
      : m.cpu.coresHidden > 0
        ? h('p', { class: 'fm-note', 'data-key': 'cores-hidden' }, `Per-core load is not drawn above ${MAX_CORES_DRAWN} cores.`)
        : null
  )
}

/** Page rates as a person reads them: "12", "0.4", "<0.1". */
function rate(value) {
  if (value === null || value === undefined) return '–'
  if (value > 0 && value < 0.1) return '<0.1'
  return value >= 10 ? String(Math.round(value)) : String(Math.round(value * 10) / 10)
}

/** Rows under a Mac's own reading: what the RAM in use is made of, swap, and macOS's pressure. */
function macRows(m) {
  const mac = m.mem.mac
  const swapNote = [
    mac.swapTotalBytes !== null ? `of ${size(mac.swapTotalBytes)}` : '',
    mac.swapInsPerSec || mac.swapOutsPerSec ? `${rate(mac.swapInsPerSec)} in · ${rate(mac.swapOutsPerSec)} out pages/s` : ''
  ]
    .filter(Boolean)
    .join(' · ')
  const level = mac.pressure
  const pressureValue = [
    level ? h('span', { class: 'fm-pressure-value', data: { health: level === 'critical' ? 'critical' : level === 'warning' ? 'strained' : 'ok' } }, PRESSURE_WORD[level]) : null,
    level && mac.availablePct !== null ? ' · ' : null,
    mac.availablePct !== null ? `${pct(mac.availablePct)}% available` : null
  ]
  const rows = [
    { k: 'App memory', v: size(mac.appBytes) },
    { k: 'Wired', v: size(mac.wiredBytes) },
    { k: 'Compressed', v: size(mac.compressedBytes) },
    { k: 'Cached files', v: size(mac.cachedBytes) },
    { k: 'Swap used', v: size(mac.swapUsedBytes), note: swapNote },
    { k: 'Memory pressure', v: level || mac.availablePct !== null ? pressureValue : '–' }
  ]
  return h('dl', { class: 'fm-facts fm-mem-facts', 'data-key': 'mem-facts' }, rows.map(factRow))
}

const PRESSURE_NOTES = {
  install: 'Installing Fleet Monitor on that machine adds real RAM usage, swap and pressure.',
  enable: 'Turning Fleet Monitor on there adds real RAM usage, swap and pressure.',
  quiet: 'Real RAM usage, swap and pressure show here once Fleet Monitor’s readings arrive from there.',
  update: 'Updating Fleet Monitor there to 1.1 or later adds real RAM usage, swap and pressure.',
  own: 'This Mac’s own memory reading is not available right now.'
}

function memorySection(m, suggest = null) {
  const value = m.mem.reliable ? m.mem.pct : null
  const used = m.mem.kind === 'used'
  // With the install row on screen, it says what installing adds; the note does not repeat it.
  const note =
    m.mem.kind === 'pressure' && m.mem.pressureNote ? (m.mem.pressureNote === 'install' && m.install ? '' : PRESSURE_NOTES[m.mem.pressureNote]) : null
  return h(
    'section',
    { class: 'fm-section', data: { tone: m.mem.tone }, 'aria-label': m.mem.label, 'data-key': 'memory' },
    h('div', { class: 'fm-section-head' }, h('h2', {}, m.mem.label), h('span', { class: 'fm-sub' }, memSub(m, true))),
    h('div', { class: 'fm-reading' }, big(value, true), used ? h('span', { class: 'fm-sub' }, 'used') : null, h('span', { class: 'fm-sub' }, statsText(m.mem.stats))),
    suggestLine(suggest),
    note !== null ? h('p', { class: 'fm-note', 'data-key': 'pressure-note' }, `Memory pressure as Orca reads it, not RAM in use.${note ? ` ${note}` : ''}`) : null,
    m.mem.kind === 'unavailable'
      ? h('p', { class: 'fm-note', 'data-key': 'unavailable-note' }, 'Memory unavailable: Orca reports only free memory for this machine right now, which is neither RAM in use nor memory pressure, so it is not shown or judged.')
      : null,
    used && m.mem.carriedSec !== null
      ? h('p', { class: 'fm-note', 'data-key': 'carried-note' }, `Some of these figures are ${m.mem.carriedSec} s old: reading them on that Mac failed.`)
      : null,
    chart(m.mem.history, m.mem.tone, chartLabel(used ? 'RAM used' : m.mem.label, value, m.mem.stats)),
    used && m.mem.mac ? macRows(m) : null
  )
}

function workspacesSection(m) {
  return h(
    'section',
    { class: 'fm-section', 'aria-label': 'Top workspaces', 'data-key': 'workspaces' },
    h('h2', {}, 'Top workspaces'),
    h('div', { class: 'fm-ws-head', 'aria-hidden': 'true' }, h('span', {}, 'Workspace'), h('span', {}, 'CPU'), h('span', {}, 'Memory')),
    h(
      'ol',
      { class: 'fm-ws-list' },
      m.workspaces.map((w) =>
        h(
          'li',
          { class: 'fm-ws', 'data-key': `ws:${w.id}`, 'aria-label': `${w.name}: CPU ${share(w.cpuPct)}, memory ${size(w.memBytes)}` },
          h('span', { class: 'fm-ws-name', title: w.repo ? `${w.name} (${w.repo})` : w.name }, w.name),
          h('span', { class: 'fm-ws-cpu' }, share(w.cpuPct)),
          h('span', { class: 'fm-ws-mem' }, size(w.memBytes)),
          h('span', { class: 'fm-ws-bar', 'aria-hidden': 'true' }, h('span', { style: { width: `${Math.min(100, Math.max(2, w.cpuPct))}%` } }))
        )
      )
    )
  )
}

const INSTALL_TEXT = {
  absent: 'Install Fleet Monitor on this machine for measured CPU, activity and processes',
  installed: 'Fleet Monitor is installed on this machine but not running',
  quiet: 'Fleet Monitor runs on this machine, but its readings are not arriving'
}
/** On a Mac, installing it also replaces Orca's memory pressure figure with RAM in use. */
const INSTALL_TEXT_MAC = {
  ...INSTALL_TEXT,
  absent: 'Install Fleet Monitor on this machine for real RAM usage, activity and processes'
}

/** The install row's body, drawn closed too (hidden) so the toggle's aria-controls names it. One
 *  install row is shown at a time, so its id is fixed: a machine id is remote text. */
const INSTALL_BODY_ID = 'fm-install-body'

function installBody(m, ui, open) {
  const hint = m.install
  const props = { class: 'fm-install-body', id: INSTALL_BODY_ID, hidden: !open }
  if (hint.reason === 'installed') {
    return h('div', props, h('p', {}, 'Turn it on in Orca’s plugin settings on that machine. Full detail appears here within about half a minute.'))
  }
  if (hint.reason === 'quiet') {
    return h(
      'div',
      props,
      h('p', {}, 'Its “Publish this machine’s readings” setting may be off. Turn it on in Fleet Monitor’s settings on that machine.')
    )
  }
  if (!hint.command) {
    // Neither its name nor its id can go into a command safely: say what to do instead.
    return h(
      'div',
      props,
      h(
        'p',
        {},
        `This machine’s name cannot be put in a command safely, so none is offered. On this computer, run ${hint.launcher ?? 'orca'} environment list to find its id, then ${hint.launcher ?? 'orca'} plugin install ${INSTALL_SOURCE} --environment=<that id>.`
      )
    )
  }
  const copied = (ui.copied.get(m.id) ?? 0) > Date.now()
  const failed = ui.copyFailed.has(m.id)
  return h(
    'div',
    props,
    h(
      'p',
      {},
      'Run this here, on this computer. Orca lists what Fleet Monitor would be allowed to do and prints the command that approves it; nothing is installed until you run that one.'
    ),
    h(
      'div',
      { class: 'fm-command' },
      // Short words stay whole when the command wraps (no break inside --environment); a word
      // too long for a narrow panel may still break.
      h(
        'code',
        { 'data-command': m.id },
        hint.command.split(' ').map((word, i) => [i > 0 ? ' ' : null, word.length <= 18 ? h('span', { class: 'fm-word' }, word) : word])
      ),
      h(
        'button',
        { type: 'button', class: 'fm-copy fm-ghost', 'data-action': 'copy', 'data-id': m.id, 'aria-label': copied ? 'Copied' : 'Copy the command' },
        copied ? 'Copied' : 'Copy'
      )
    ),
    failed ? h('p', { class: 'fm-note' }, 'Copying did not work here. The command is selected: press ⌘C or Ctrl+C.') : null,
    // Present before anything is copied, so the change is announced.
    h(
      'p',
      { class: 'fm-sr', role: 'status', 'aria-live': 'polite', 'data-key': 'copy-status' },
      copied ? 'Command copied' : failed ? 'Copying did not work. The command is selected.' : ''
    )
  )
}

function installRow(m, ui) {
  const open = ui.installOpen.has(m.id)
  return h(
    'div',
    { class: open ? 'fm-install is-open' : 'fm-install', 'data-key': 'install' },
    h(
      'button',
      {
        type: 'button',
        class: 'fm-install-toggle fm-ghost',
        'data-action': 'install',
        'data-id': m.id,
        'aria-expanded': open ? 'true' : 'false',
        'aria-controls': INSTALL_BODY_ID
      },
      iconDownload(),
      h('span', { class: 'fm-install-text' }, (m.install.mac ? INSTALL_TEXT_MAC : INSTALL_TEXT)[m.install.reason]),
      iconChevron()
    ),
    installBody(m, ui, open)
  )
}

function factRow(f) {
  return h('div', { class: 'fm-fact' }, h('dt', {}, f.k), h('dd', {}, f.v, f.note ? h('span', { class: 'fm-fact-note' }, f.note) : null))
}

function factsSection(title, facts) {
  return h(
    'section',
    { class: 'fm-section', 'aria-label': title, 'data-key': `facts:${title}` },
    h('h2', {}, title),
    h('dl', { class: 'fm-facts' }, facts.map(factRow))
  )
}

function chipLabel(m) {
  return m.platform === 'darwin' && /apple/i.test(m.chip ?? '') ? 'Chip' : 'CPU'
}

function systemFacts(m) {
  const facts = []
  if (m.tier === 'basic') {
    if (m.cores) facts.push({ k: 'Cores', v: String(m.cores) })
  } else if (m.chip) facts.push({ k: chipLabel(m), v: m.chip })
  if (m.load) {
    const full = m.load.five !== null && m.load.fifteen !== null
    facts.push({ k: 'Load avg', v: loads(m.load), note: full ? '1m · 5m · 15m' : '1m' })
  }
  if (m.uptimeSec !== null) facts.push({ k: 'Uptime', v: duration(m.uptimeSec) })
  if (m.orca) facts.push({ k: 'Orca itself', v: `${share(m.orca.cpuPct)} CPU · ${size(m.orca.memBytes)}` })
  return facts
}

function offlineSection(m, ui, now) {
  const retrying = ui.retrying.has(m.id)
  const seen = m.lastSeenAt !== null
  return h(
    'section',
    { class: 'fm-section fm-offline', 'data-key': 'offline' },
    h(
      'div',
      { class: 'fm-offline-row' },
      iconOffline(),
      h(
        'div',
        { class: 'fm-offline-text' },
        h('h2', {}, `${m.name} is offline`),
        seen
          ? since('p', {}, 'Last seen {ago}. Live charts come back as soon as it reconnects.', m.lastSeenAt, now)
          : h('p', {}, 'Orca has not reached it since Fleet Monitor started. Live charts start as soon as it answers.'),
        m.error ? h('p', { class: 'fm-error-text' }, m.error) : null
      )
    ),
    h(
      'button',
      // aria-disabled, not disabled: a disabled button drops keyboard focus to the page.
      { type: 'button', class: 'fm-btn fm-ghost', 'data-action': 'retry', 'data-id': m.id, 'aria-disabled': retrying ? 'true' : null },
      retrying ? 'Retrying…' : 'Retry connection'
    )
  )
}

function lastKnownFacts(m) {
  const facts = []
  if (m.lastKnown.cpuPct !== null) facts.push({ k: 'CPU', v: `${pct(m.lastKnown.cpuPct)}%` })
  if (m.lastKnown.memPct !== null) {
    const mem = memSub(m, true)
    facts.push({ k: m.mem.label, v: mem ? `${pct(m.lastKnown.memPct)}% · ${mem}` : `${pct(m.lastKnown.memPct)}%` })
  }
  if (m.chip) facts.push({ k: chipLabel(m), v: m.chip })
  return facts
}

/** The Activity tab: the tiles, then the Processes card. */
function activitySections(m, act, ui, now, list) {
  const sections = [tilesSection(act.tiles)]
  if (act.processes) {
    sections.push(
      processesSection(act.processes, {
        ...list,
        open: ui.openKey,
        machineName: m.name,
        announce: ui.announce,
        since: (tagName, props, template, at) => since(tagName, props, template, at, now)
      })
    )
  }
  return sections.filter(Boolean)
}

function detail(m, ui, now, act, list) {
  const sections = []
  const tab = act?.tabs ? ui.tab : 'overview'
  if (tab === 'activity') {
    sections.push(...activitySections(m, act, ui, now, list))
  } else if (m.status === 'connecting') {
    sections.push(h('section', { class: 'fm-section fm-skel', 'aria-label': 'Connecting', 'data-key': 'waiting' }, skeletonMetrics()))
  } else if (!m.online) {
    if (m.lost) sections.push(lostSection(m, now))
    sections.push(offlineSection(m, ui, now))
    const facts = lastKnownFacts(m)
    if (facts.length > 0) sections.push(factsSection('Last known', facts))
  } else {
    if (m.lost) sections.push(lostSection(m, now))
    sections.push(cpuSection(m), memorySection(m, act?.suggest ?? null))
    if (m.workspaces.length > 0) sections.push(workspacesSection(m))
    if (m.install) sections.push(installRow(m, ui))
    const facts = systemFacts(m)
    if (facts.length > 0) sections.push(factsSection('System', facts))
    if (act?.notice) sections.push(h('p', { class: 'fm-notice', 'data-key': 'activity-notice' }, act.notice))
  }
  const panel = act?.tabs ? { role: 'tabpanel', id: TAB_PANEL_ID, 'aria-labelledby': TAB_IDS[tab] } : {}
  return [detailHeader(m, now, act, tab), h('div', { class: 'fm-sections', 'data-key': `sections:${m.id}`, ...panel }, sections)]
}

// --- mounting ----------------------------------------------------------------------------------

/** A field, where a typed "/" is text rather than the search shortcut. */
function isField(node) {
  return node instanceof Element && (['INPUT', 'SELECT', 'TEXTAREA'].includes(node.tagName) || node.isContentEditable === true)
}

/** How long after typing stops the live region says how many processes match. */
const ANNOUNCE_MS = 500
const TAB_ORDER = ['overview', 'activity']

/**
 * Draws the panel into `root` and keeps it current. `binding` is createFleetBinding(...); a
 * machine's process list is watched through `binding.watchProcesses` only while that machine's
 * Activity tab is on screen.
 * Other options are test seams: `now`, `setInterval`, `clearInterval`, `setTimeout`.
 */
export function mountFleetView(
  root,
  {
    binding,
    now = () => Date.now(),
    setInterval: every = setInterval,
    clearInterval: stop = clearInterval,
    setTimeout: later = setTimeout,
    openExternal = null
  } = {}
) {
  const doc = root.ownerDocument
  const ui = {
    canOpenExternal: typeof openExternal === 'function',
    /** The binding can ask the worker to star; whether this computer can is the fleet's `canStar`. */
    canStar: typeof binding?.star === 'function',
    /** 'idle', then 'busy' while the worker tries, then 'done' or 'failed'. */
    star: 'idle',
    nav: { view: 'overview', id: null },
    pairOpen: false,
    installOpen: new Set(),
    copied: new Map(),
    copyFailed: new Set(),
    retrying: new Set(),
    overviewScroll: 0,
    // A machine's detail: its tab and its Processes card. All of it is forgotten when the machine
    // is left, so every machine opens on Overview with the list sorted by CPU.
    tab: 'overview',
    sort: 'cpu',
    sortShown: 'cpu',
    query: '',
    showAll: false,
    /** The open row's key; one at a time. */
    openKey: null,
    /** The row holding the list's one tab stop. */
    rowFocus: null,
    /** The list's last order, as keys: kept while a row is open or focus is inside the list. */
    held: null,
    matches: 0,
    announce: '',
    /** Machine id → the newest answer binding.watchProcesses gave for it. */
    lists: new Map(),
    /** The process list being watched: { id, stop }, or null. */
    watch: null
  }
  let announceToken = 0
  let view = binding.current()
  /** This frame's clock moved onto the worker's, which history and "last seen" times use. */
  const workerNow = () => now() + (Number.isFinite(view?.clockOffsetMs) ? view.clockOffsetMs : 0)
  let fleet = toFleet(view, workerNow())

  /** Opens the project's page. Called within a press, as Orca requires; Orca asks before opening
   *  a host the first time. */
  function openRepository() {
    if (typeof openExternal !== 'function') return
    try {
      void Promise.resolve(openExternal(REPOSITORY_URL)).catch(() => {})
    } catch {
      // Not offered after all: nothing to open.
    }
  }

  function resetActivity() {
    Object.assign(ui, { tab: 'overview', sort: 'cpu', sortShown: 'cpu', query: '', showAll: false, openKey: null, rowFocus: null, held: null, matches: 0, announce: '' })
    ui.lists = new Map()
    announceToken += 1
  }

  /** The order holds still while a row is open or focus is inside the list. */
  function listHeld() {
    if (ui.openKey !== null) return true
    const list = root.querySelector('.fm-procs')
    const active = doc.activeElement
    return Boolean(list && active && list.contains(active))
  }

  /** The rows to draw (ordered, searched, cut), how many matched, and which row is the tab stop. */
  function arrange(p) {
    if (p.state !== 'ready') return { shown: [], matches: 0, tabStop: null }
    const ordered = arrangeRows(p.rows, p.sort, ui.held && listHeld() ? ui.held : null)
    ui.held = ordered.map((r) => r.key)
    const matched = matchRows(ordered, p.query)
    const shown = ui.showAll ? matched : matched.slice(0, FIRST_ROWS)
    const keys = new Set(shown.map((r) => r.key))
    if (ui.openKey !== null && !keys.has(ui.openKey)) ui.openKey = null
    ui.matches = matched.length
    const tabStop = [ui.rowFocus, ui.openKey].find((k) => k !== null && keys.has(k)) ?? shown[0]?.key ?? null
    return { shown, matches: matched.length, tabStop }
  }

  let drawing = false
  let redraw = false
  function draw() {
    drawing = true
    try {
      drawOnce()
    } finally {
      drawing = false
    }
    if (redraw) {
      redraw = false
      draw()
    }
  }

  function drawOnce() {
    const t = workerNow()
    fleet = toFleet(view, t)
    if (ui.nav.view === 'detail' && fleet.state === 'live' && !fleet.machines.some((m) => m.id === ui.nav.id)) {
      ui.nav = { view: 'overview', id: null }
      resetActivity()
    }
    const machine = ui.nav.view === 'detail' ? fleet.machines.find((m) => m.id === ui.nav.id) : null
    let act = null
    let list = null
    if (machine) {
      act = toActivityModel({ machine, list: ui.lists.get(machine.id), ui: { sort: ui.sort, query: ui.query }, now: t })
      if (!act.tabs) ui.tab = 'overview'
      if (ui.tab === 'activity' && act.processes) {
        ui.sortShown = act.processes.sort
        list = arrange(act.processes)
      }
    }
    root.dataset.screen = machine ? 'detail' : 'overview'
    morphChildren(root, machine ? detail(machine, ui, t, act, list) : overview(fleet, ui, t))
    syncFields()
    watch(machine, act)
  }

  /** Morphing sets attributes only: the search text and the sort are properties of their fields. */
  function syncFields() {
    const input = root.querySelector('[data-input="search"]')
    if (input && input.value !== ui.query) input.value = ui.query
    const select = root.querySelector('[data-input="sort"]')
    if (select && select.value !== ui.sortShown) select.value = ui.sortShown
  }

  /** Watches the shown machine's process list while its Activity tab is on screen (the binding
   *  asks for it on its own beat, never while the panel is hidden); stops when the tab hides or
   *  the machine changes. */
  function watch(machine, act) {
    const id = machine && ui.tab === 'activity' && act?.processes && typeof binding.watchProcesses === 'function' ? machine.id : null
    if (ui.watch?.id === id) return
    if (ui.watch) {
      // A list from before is not shown as current when the tab comes back: it loads again.
      ui.watch.stop()
      ui.lists.delete(ui.watch.id)
    }
    ui.watch = null
    if (id === null) return
    const run = { id, stop: () => {} }
    ui.watch = run
    run.stop = binding.watchProcesses(id, (answer) => {
      if (ui.watch !== run) return
      ui.lists.set(id, answer)
      if (drawing) redraw = true
      else draw()
    })
  }

  function focusSoon(selector) {
    const node = root.querySelector(selector)
    if (node instanceof HTMLElement) node.focus({ preventScroll: true })
  }

  /** `moveFocus` is for a person's click or key: focus follows to the new screen's control. */
  function open(id, moveFocus = true) {
    ui.overviewScroll = window.scrollY
    ui.nav = { view: 'detail', id }
    resetActivity()
    draw()
    window.scrollTo(0, 0)
    if (moveFocus) focusSoon('[data-action="back"]')
  }

  function back(moveFocus = true) {
    const id = ui.nav.id
    ui.nav = { view: 'overview', id: null }
    resetActivity()
    draw()
    window.scrollTo(0, ui.overviewScroll)
    if (id && moveFocus) focusSoon(`[data-action="open"][data-id="${CSS.escape(id)}"]`)
  }

  /** Overview or Activity. Switching keeps the header, scrolls to the top and closes an open row. */
  function selectTab(tab, moveFocus = false) {
    if (ui.tab !== tab) {
      ui.tab = tab
      ui.openKey = null
      ui.rowFocus = null
      ui.held = null
      ui.announce = ''
      draw()
      window.scrollTo(0, 0)
    }
    if (moveFocus) focusSoon(`#${TAB_IDS[ui.tab]}`)
  }

  function clearSearch(focusField) {
    ui.query = ''
    ui.announce = ''
    announceToken += 1
    draw()
    if (focusField) focusSoon('[data-input="search"]')
  }

  function copy(id) {
    const m = fleet.machines.find((x) => x.id === id)
    const command = m?.install?.command
    if (!command) return
    if (copyText(command)) {
      ui.copyFailed.delete(id)
      ui.copied.set(id, Date.now() + COPIED_MS)
      draw()
      later(draw, COPIED_MS + 50)
    } else {
      ui.copyFailed.add(id)
      draw()
      const code = root.querySelector(`[data-command="${CSS.escape(id)}"]`)
      if (code) selectText(code)
    }
  }

  function retry(id) {
    if (ui.retrying.has(id)) return
    ui.retrying.add(id)
    draw()
    void binding.retry(id).finally(() =>
      later(() => {
        ui.retrying.delete(id)
        draw()
      }, RETRY_SETTLE_MS)
    )
  }

  root.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-action]') : null
    if (!target || !root.contains(target) || target.hasAttribute('disabled') || target.getAttribute('aria-disabled') === 'true') return
    const id = target.getAttribute('data-id') ?? ''
    switch (target.getAttribute('data-action')) {
      case 'open':
        open(id)
        break
      case 'back':
        back()
        break
      case 'tab':
        if (TAB_ORDER.includes(target.getAttribute('data-tab'))) selectTab(target.getAttribute('data-tab'))
        break
      case 'proc':
        ui.openKey = ui.openKey === id ? null : id
        ui.rowFocus = id
        draw()
        break
      case 'clear-search':
        clearSearch(true)
        break
      case 'show-all':
        ui.showAll = true
        draw()
        break
      case 'show-fewer':
        // Back to the first rows; a row open or focused further down goes with the rest (arrange).
        ui.showAll = false
        draw()
        break
      case 'pair':
        ui.pairOpen = !ui.pairOpen
        draw()
        break
      case 'install':
        if (ui.installOpen.has(id)) ui.installOpen.delete(id)
        else ui.installOpen.add(id)
        draw()
        break
      case 'copy':
        copy(id)
        break
      case 'retry':
        retry(id)
        break
      case 'reload':
        void binding.refresh()
        break
      case 'star':
        // With the GitHub CLI on this computer, the worker stars the project for the person.
        if (ui.canStar && ui.star === 'idle' && fleet.canStar === true) {
          ui.star = 'busy'
          draw()
          void Promise.resolve()
            .then(() => binding.star())
            .catch(() => false)
            .then((starred) => {
              ui.star = starred === true ? 'done' : 'failed'
              draw()
            })
          break
        }
        openRepository()
        break
      case 'star-open':
        openRepository()
        break
    }
  })

  // Search as typed; the live region says how many match once typing stops.
  root.addEventListener('input', (event) => {
    const target = event.target instanceof Element ? event.target : null
    if (target?.getAttribute('data-input') !== 'search') return
    ui.query = String(target.value ?? '')
    draw()
    const token = ++announceToken
    later(() => {
      if (token !== announceToken) return
      ui.announce = ui.query.trim() ? matchesSpoken(ui.matches, ui.query) : ''
      draw()
    }, ANNOUNCE_MS)
  })

  root.addEventListener('change', (event) => {
    const target = event.target instanceof Element ? event.target : null
    if (target?.getAttribute('data-input') !== 'sort') return
    const sort = String(target.value ?? '')
    if (!SORT_SPOKEN[sort]) return
    ui.sort = sort
    // A sort a person chose applies at once, held order or not.
    ui.held = null
    ui.announce = SORT_SPOKEN[sort]
    draw()
  })

  // The list's one tab stop follows focus (roving tabindex).
  root.addEventListener('focusin', (event) => {
    const row = event.target instanceof Element ? event.target.closest('.fm-proc-row') : null
    const key = row?.getAttribute('data-id') ?? null
    if (key !== null && key !== ui.rowFocus) {
      ui.rowFocus = key
      draw()
    }
  })

  function onTabKey(target, event) {
    const at = TAB_ORDER.indexOf(target.getAttribute('data-tab') ?? '')
    const next = { ArrowRight: TAB_ORDER[(at + 1) % 2], ArrowLeft: TAB_ORDER[(at + 1) % 2], Home: 'overview', End: 'activity' }[event.key]
    if (!next || at < 0) return
    event.preventDefault?.()
    selectTab(next, true)
  }

  function onRowKey(target, event) {
    const rows = [...root.querySelectorAll('.fm-procs .fm-proc-row')]
    const at = rows.indexOf(target)
    if (at < 0) return
    const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: rows.length - 1 }[event.key]
    if (to === undefined) return
    event.preventDefault?.()
    const row = rows[Math.max(0, Math.min(rows.length - 1, to))]
    ui.rowFocus = row.getAttribute('data-id')
    draw()
    row.focus({ preventScroll: false })
  }

  /** Esc, innermost first: clear the search, else close the open row, else go back. */
  function onEscape(event) {
    if (ui.nav.view === 'detail') {
      if (ui.tab === 'activity' && ui.query) {
        event.preventDefault?.()
        const active = doc.activeElement
        clearSearch(active instanceof Element && active.getAttribute('data-input') === 'search')
        return
      }
      if (ui.tab === 'activity' && ui.openKey !== null) {
        const key = ui.openKey
        ui.openKey = null
        draw()
        focusSoon(`.fm-proc-row[data-id="${CSS.escape(key)}"]`)
        return
      }
      back()
    } else if (ui.pairOpen) {
      ui.pairOpen = false
      draw()
      focusSoon('[data-action="pair"]')
    }
  }

  doc.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      onEscape(event)
      return
    }
    if (ui.nav.view !== 'detail') return
    const target = event.target instanceof Element && root.contains(event.target) ? event.target : null
    if (event.key === '/' && ui.tab === 'activity' && !isField(doc.activeElement) && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const field = root.querySelector('[data-input="search"]')
      if (field instanceof HTMLElement) {
        event.preventDefault?.()
        field.focus()
      }
      return
    }
    if (target?.getAttribute('role') === 'tab') onTabKey(target, event)
    else if (target?.matches('.fm-proc-row')) onRowKey(target, event)
  })

  // "Updated 4s ago" and friends move every second without redrawing the rest.
  const ticker = every(() => {
    if (doc.visibilityState === 'hidden') return
    const t = workerNow()
    for (const node of root.querySelectorAll('[data-since]')) {
      const at = Number(node.getAttribute('data-since'))
      const text = (node.getAttribute('data-template') ?? '{ago}').replace('{ago}', ago(at, t))
      if (node.textContent !== text) node.textContent = text
    }
  }, 1_000)

  const unsubscribe = binding.subscribe((next) => {
    view = next
    draw()
  })

  return {
    /** For tests and the preview: the model last drawn. */
    model: () => fleet,
    /** Shows one machine's detail, or the overview with no id, without moving focus. */
    show: (id) => (id ? open(id, false) : back(false)),
    /** For the preview: shows a tab of the machine on screen, without moving focus. */
    showTab: (tab) => selectTab(tab),
    dispose() {
      stop(ticker)
      ui.watch?.stop()
      ui.watch = null
      unsubscribe()
    }
  }
}
