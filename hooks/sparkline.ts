// The session's history as two lines of blocks: memory and CPU over the window.

import type { Point } from '../types'
import { formatBytes, formatPercent } from './format'
import { downsample } from './history'
import { fit } from './view'

export const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

// One block per value from 0 to `top`, at most `width` of them (bucket maxima when more).
export const sparkline = (values: number[], width: number, top: number) => {
  if (width <= 0) return ''
  const top_ = top > 0 ? top : 1

  return downsample(values, width)
    .map(value => BLOCKS[Math.min(7, Math.max(0, Math.round((value / top_) * 7)))]!)
    .join('')
}

// `mem <chart> <now>` and `cpu <chart> <now>` in `width` cells; null until there are two points.
export const sparkLines = (points: Point[], width: number): [string, string] | null => {
  const last = points[points.length - 1]
  if (points.length < 2 || !last) return null
  const memory = points.map(point => point.memKb)
  const cpu = points.map(point => point.cpuPct)
  const memNow = formatBytes(last.memKb)
  const cpuNow = formatPercent(last.cpuPct)
  const valueWidth = Math.max(memNow.length, cpuNow.length)
  // `mem ` + chart + ` ` + value.
  const chartWidth = Math.max(0, width - 4 - 1 - valueWidth)

  return [
    `mem ${sparkline(memory, chartWidth, Math.max(...memory))} ${fit(memNow, valueWidth, true)}`,
    `cpu ${sparkline(cpu, chartWidth, Math.max(100, ...cpu))} ${fit(cpuNow, valueWidth, true)}`,
  ]
}
