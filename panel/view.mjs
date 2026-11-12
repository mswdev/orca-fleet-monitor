// The Fleet Monitor panel: an overview card per machine and a detail screen per machine, after
// the visual design (Main.dc.html in the design project). It draws toFleet() from
// fleet-binding.mjs and nothing else. Untrusted text (machine, workspace and error text) only
// ever becomes text nodes or attribute values; see dom.mjs.
import { seriesPaths } from './charts.mjs'
import { copyText, h, morphChildren, s, selectText } from './dom.mjs'
import { INSTALL_SOURCE, MAX_CORES_DRAWN, toFleet } from './fleet-binding.mjs'
import { ago, duration, gb, loads, pct, share, size } from './format.mjs'

/** Where Orca pairs another machine. There is no host call that opens it, so the panel says where. */
export const PAIR_PATH = 'Settings → Remote Orca servers → Add server'
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

/** `now` is the worker's clock, as the card's own "Last seen" text uses. */
function cardAria(m, now) {
  if (m.status === 'connecting') return `${m.name}, connecting. Open details.`
  if (!m.online) return `${m.name}, offline.${m.lastSeenAt === null ? '' : ` Last seen ${ago(m.lastSeenAt, now)}.`} Open details.`
  const cpu = m.cpu.estimated
    ? m.cpu.pct === null
      ? 'no CPU estimate'
      : `CPU about ${pct(m.cpu.pct)}% (estimated, not counted in health)`
    : m.cpu.pct === null
      ? 'CPU unknown'
      : `CPU ${pct(m.cpu.pct)}%`
  const mem = m.mem.pct === null || !m.mem.reliable ? 'memory unknown' : `memory ${pct(m.mem.pct)}%`
  const why = m.reasons.length > 0 ? ` (${m.reasons.join('; ')})` : ''
  return `${m.name}${m.tag ? ` (${m.tag})` : ''}, ${m.healthLabel}${why}. ${cpu}, ${mem}. Open details.`
}

function metric(label, value, sub, tone, history) {
  return h(
    'span',
    { class: 'fm-metric', data: { tone } },
    h('span', { class: 'fm-metric-label' }, label),
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
    h(
      'span',
      { class: 'fm-metrics' },
      metric('CPU', m.cpu.pct, m.cpu.estimated ? (m.cpu.pct === null ? 'no estimate' : 'estimate') : coresText(m), m.cpu.tone, m.cpu.history),
      metric('Memory', m.mem.reliable ? m.mem.pct : null, memText(m, false), m.mem.tone, m.mem.history)
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
  return nodes
}

// --- detail ------------------------------------------------------------------------------------

function detailHeader(m, now) {
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
    m.online ? level(m.health, m.healthLabel) : h('span', { class: 'fm-state' }, m.status === 'connecting' ? 'Connecting…' : 'Offline')
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

function memorySection(m) {
  const value = m.mem.reliable ? m.mem.pct : null
  return h(
    'section',
    { class: 'fm-section', data: { tone: m.mem.tone }, 'aria-label': 'Memory', 'data-key': 'memory' },
    h('div', { class: 'fm-section-head' }, h('h2', {}, 'Memory'), h('span', { class: 'fm-sub' }, memText(m, true))),
    h('div', { class: 'fm-reading' }, big(value, true), h('span', { class: 'fm-sub' }, statsText(m.mem.stats))),
    chart(m.mem.history, m.mem.tone, chartLabel('Memory', value, m.mem.stats))
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
  absent: 'Install Fleet Monitor on this machine for full detail',
  installed: 'Fleet Monitor is installed on this machine but not running',
  quiet: 'Fleet Monitor runs on this machine, but its readings are not arriving'
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
      h('span', { class: 'fm-install-text' }, INSTALL_TEXT[m.install.reason]),
      iconChevron()
    ),
    installBody(m, ui, open)
  )
}

function factsSection(title, facts) {
  return h(
    'section',
    { class: 'fm-section', 'aria-label': title, 'data-key': `facts:${title}` },
    h('h2', {}, title),
    h(
      'dl',
      { class: 'fm-facts' },
      facts.map((f) =>
        h('div', { class: 'fm-fact' }, h('dt', {}, f.k), h('dd', {}, f.v, f.note ? h('span', { class: 'fm-fact-note' }, f.note) : null))
      )
    )
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
    const mem = memText(m, true)
    facts.push({ k: 'Memory', v: mem ? `${pct(m.lastKnown.memPct)}% · ${mem}` : `${pct(m.lastKnown.memPct)}%` })
  }
  if (m.chip) facts.push({ k: chipLabel(m), v: m.chip })
  return facts
}

function detail(m, ui, now) {
  const sections = []
  if (m.status === 'connecting') {
    sections.push(h('section', { class: 'fm-section fm-skel', 'aria-label': 'Connecting', 'data-key': 'waiting' }, skeletonMetrics()))
  } else if (!m.online) {
    sections.push(offlineSection(m, ui, now))
    const facts = lastKnownFacts(m)
    if (facts.length > 0) sections.push(factsSection('Last known', facts))
  } else {
    sections.push(cpuSection(m), memorySection(m))
    if (m.workspaces.length > 0) sections.push(workspacesSection(m))
    if (m.install) sections.push(installRow(m, ui))
    const facts = systemFacts(m)
    if (facts.length > 0) sections.push(factsSection('System', facts))
  }
  return [detailHeader(m, now), h('div', { class: 'fm-sections', 'data-key': `sections:${m.id}` }, sections)]
}

// --- mounting ----------------------------------------------------------------------------------

/**
 * Draws the panel into `root` and keeps it current. `binding` is createFleetBinding(...).
 * Options are test seams: `now`, `setInterval`, `clearInterval`, `setTimeout`.
 */
export function mountFleetView(
  root,
  { binding, now = () => Date.now(), setInterval: every = setInterval, clearInterval: stop = clearInterval, setTimeout: later = setTimeout } = {}
) {
  const ui = {
    nav: { view: 'overview', id: null },
    pairOpen: false,
    installOpen: new Set(),
    copied: new Map(),
    copyFailed: new Set(),
    retrying: new Set(),
    overviewScroll: 0
  }
  let view = binding.current()
  /** This frame's clock moved onto the worker's, which history and "last seen" times use. */
  const workerNow = () => now() + (Number.isFinite(view?.clockOffsetMs) ? view.clockOffsetMs : 0)
  let fleet = toFleet(view, workerNow())

  function draw() {
    const t = workerNow()
    fleet = toFleet(view, t)
    if (ui.nav.view === 'detail' && fleet.state === 'live' && !fleet.machines.some((m) => m.id === ui.nav.id)) {
      ui.nav = { view: 'overview', id: null }
    }
    const machine = ui.nav.view === 'detail' ? fleet.machines.find((m) => m.id === ui.nav.id) : null
    root.dataset.screen = machine ? 'detail' : 'overview'
    morphChildren(root, machine ? detail(machine, ui, t) : overview(fleet, ui, t))
  }

  function focusSoon(selector) {
    const node = root.querySelector(selector)
    if (node instanceof HTMLElement) node.focus({ preventScroll: true })
  }

  /** `moveFocus` is for a person's click or key: focus follows to the new screen's control. */
  function open(id, moveFocus = true) {
    ui.overviewScroll = window.scrollY
    ui.nav = { view: 'detail', id }
    draw()
    window.scrollTo(0, 0)
    if (moveFocus) focusSoon('[data-action="back"]')
  }

  function back(moveFocus = true) {
    const id = ui.nav.id
    ui.nav = { view: 'overview', id: null }
    draw()
    window.scrollTo(0, ui.overviewScroll)
    if (id && moveFocus) focusSoon(`[data-action="open"][data-id="${CSS.escape(id)}"]`)
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
    }
  })

  root.ownerDocument.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    if (ui.nav.view === 'detail') back()
    else if (ui.pairOpen) {
      ui.pairOpen = false
      draw()
      focusSoon('[data-action="pair"]')
    }
  })

  // "Updated 4s ago" and friends move every second without redrawing the rest.
  const ticker = every(() => {
    if (root.ownerDocument.visibilityState === 'hidden') return
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
    dispose() {
      stop(ticker)
      unsubscribe()
    }
  }
}
