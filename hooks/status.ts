// The status line under the prompt.

import type { Snapshot } from '../types'
import { formatBytes, formatDuration, formatPair, formatPercent } from './format'

// The children's share shows only while there are any; `?` when the table could not be read.
export const statusLine = (snapshot: Snapshot) => {
  const { engine, children, childCpuPercent } = snapshot
  const hasChildren = children === null || snapshot.childCount > 0
  let cpu = '…'
  if (engine.cpuPercent !== null) {
    const own = engine.cpuPercent.toFixed(1)
    cpu = hasChildren
      ? `(${own} + ${childCpuPercent === null ? '?' : childCpuPercent.toFixed(1)})%`
      : formatPercent(engine.cpuPercent)
  }
  const childKb = children === null ? undefined : snapshot.childKb

  return `mem ${formatPair(engine.rssKb, hasChildren ? childKb : 0)} · peak ${formatBytes(engine.peakKb)} · cpu ${cpu} · up ${formatDuration(engine.uptimeSeconds)}`
}
