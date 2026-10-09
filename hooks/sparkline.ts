// The session's history as two lines of blocks: memory and CPU over the window.

import type { Point } from '../types'
import { formatBytes, formatPercent } from './format'
import { downsample } from './history'
import { fit } from './view'

export const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

// Memory never scales to less than this (or 10% of its highest point), so noise stays flat.
const MIN_MEM_SPAN_KB = 64 * 1024

// Memory's scale: its lowest to its highest point, or, when it moves less than the minimum span,
// that span centred on it (never below zero) — so a slow leak fills the height and a flat line sits mid-way.
export const memoryScale = (values: number[]): [number, number] => {
  const low = Math.min(...values)
  const high = Math.max(...values)
  const span = Math.max(MIN_MEM_SPAN_KB, high * 0.1)
  if (high - low >= span) return [low, high]
  const bottom = Math.max(0, (low + high) / 2 - span / 2)

  return [bottom, bottom + span]
}

// One block per value from `bottom` to `top`, at most `width` of them (bucket maxima when more).
export const sparkline = (values: number[], width: number, top: number, bottom = 0) => {
  if (width <= 0) return ''
  const span = top - bottom > 0 ? top - bottom : 1

  return downsample(values, width)
    .map(value => BLOCKS[Math.min(7, Math.max(0, Math.round(((value - bottom) / span) * 7)))]!)
    .join('')
}

// `mem <chart> <now> max <peak>` and the same for CPU, in `width` cells; null until there are two points.
// The chart is padded to its width, so the values stay in place while it fills.
export const sparkLines = (points: Point[], width: number): [string, string] | null => {
  const last = points[points.length - 1]
  if (points.length < 2 || !last) return null
  const memory = points.map(point => point.memKb)
  const cpu = points.map(point => point.cpuPct)
  const [memBottom, memTop] = memoryScale(memory)
  const now = [formatBytes(last.memKb), formatPercent(last.cpuPct)]
  const peak = [formatBytes(Math.max(...memory)), formatPercent(Math.max(...cpu))]
  const nowWidth = Math.max(...now.map(text => text.length))
  const peakWidth = Math.max(...peak.map(text => text.length))
  // `mem ` + chart + ` ` + now + ` max ` + peak.
  const chartWidth = Math.max(0, width - 4 - 1 - nowWidth - 5 - peakWidth)
  const line = (label: string, chart: string, index: number) =>
    `${label} ${fit(chart, chartWidth)} ${fit(now[index]!, nowWidth, true)} max ${fit(peak[index]!, peakWidth, true)}`

  return [
    line('mem', sparkline(memory, chartWidth, memTop, memBottom), 0),
    line('cpu', sparkline(cpu, chartWidth, Math.max(100, ...cpu)), 1),
  ]
}
