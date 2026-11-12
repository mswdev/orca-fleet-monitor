// Text for numbers, sizes and times, as the design writes them.

const GIB = 2 ** 30
const MIB = 2 ** 20
const finite = (value) => typeof value === 'number' && Number.isFinite(value)

/** 18 (no % sign; the view sets it smaller). A dash when unknown. */
export function pct(value) {
  return finite(value) ? String(Math.round(value)) : '–'
}

/** One decimal, without a trailing .0: 34.6, 64. Gigabytes as the OS reports them (2^30). */
export function gb(bytes) {
  return finite(bytes) ? (bytes / GIB).toFixed(1).replace(/\.0$/, '') : '–'
}

/** "6.4 GB", or "512 MB" below a gigabyte. */
export function size(bytes) {
  if (!finite(bytes)) return '–'
  return bytes >= GIB ? `${gb(bytes)} GB` : `${Math.max(0, Math.round(bytes / MIB))} MB`
}

/** "38%", "<1%" for a little above nothing. */
export function share(value) {
  if (!finite(value)) return '–'
  if (value > 0 && value < 0.5) return '<1%'
  return `${Math.round(value)}%`
}

/** "2.31 · 2.64 · 2.90", or the one value known. */
export function loads(load) {
  if (!load) return '–'
  const parts = [load.one, load.five, load.fifteen].filter(finite)
  return parts.map((v) => v.toFixed(2)).join(' · ')
}

/** "23d 7h", "5h 12m", "12m". */
export function duration(seconds) {
  if (!finite(seconds) || seconds < 0) return '–'
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  return `${Math.max(0, minutes)}m`
}

/** "just now", "2s ago", "4m ago", "2h 14m ago", "3d 5h ago". */
export function ago(at, now = Date.now()) {
  if (!finite(at)) return ''
  const seconds = Math.max(0, Math.floor((now - at) / 1000))
  if (seconds < 1) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`
  return `${Math.floor(hours / 24)}d ${hours % 24}h ago`
}
