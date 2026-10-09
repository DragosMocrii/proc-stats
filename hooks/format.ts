// Text for numbers, shared by the status line and the pane.

export const formatBytes = (kb: number) =>
  kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(2)}GB` : `${Math.round(kb / 1024)}MB`

// With children, both numbers in the larger one's unit: `(484 + 15)MB`.
export const formatPair = (kb: number, childKb: number | undefined) => {
  if (childKb === 0) return formatBytes(kb)
  const isGb = Math.max(kb, childKb ?? 0) >= 1024 * 1024
  const one = (n: number) => (isGb ? (n / 1024 / 1024).toFixed(2) : String(Math.round(n / 1024)))

  return `(${one(kb)} + ${childKb === undefined ? '?' : one(childKb)})${isGb ? 'GB' : 'MB'}`
}

export const formatPercent = (percent: number | null) =>
  percent === null ? '…' : `${percent.toFixed(1)}%`

export const formatDuration = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s % 60}s`

  return `${s}s`
}
