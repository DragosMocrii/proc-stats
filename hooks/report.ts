// The `/proc-stats report` text: what the person and the model read about the session, from current state.

import type { AlertState, Origins, Point, ProcRow, Reading } from '../types'
import { worse } from './alerts'
import { formatBytes, formatDuration, formatPercent } from './format'
import { originLabel, originOf } from './origin'
import { labelOf, subtotals } from './view'

// How many processes the report names, heaviest (most memory) first.
export const HEAVIEST = 5
// How many detached processes the report lists, heaviest first.
export const DETACHED_LISTED = 10
// A command is cut to this many code points.
const COMMAND_MAX = 80

export type ReportInput = {
  reading: Reading
  points: Point[]
  alerts: AlertState
  origins: Origins
  // ms since the epoch
  now: number
  historyMinutes: number
}

const PLATFORMS: Record<string, string> = { linux: 'Linux', mac: 'macOS', windows: 'Windows' }

const cut = (text: string) => {
  const chars = Array.from(text)

  return chars.length > COMMAND_MAX ? `${chars.slice(0, COMMAND_MAX - 1).join('')}…` : text
}

const ago = (now: number, t: number) => `${formatDuration((now - t) / 1000)} ago`

const sum = (a: number | null, b: number | null) => (a === null || b === null ? null : a + b)

// The first point holding the highest value: when the peak was reached.
const peakOf = (points: Point[], pick: (point: Point) => number) =>
  points.reduce<Point | null>((best, point) => (best === null || pick(point) > pick(best) ? point : best), null)

// Most memory first, then most CPU, then the lower pid.
const byWeight = (rows: ProcRow[]) =>
  [...rows].sort((a, b) => b.rssKb - a.rssKb || (b.cpuPercent ?? 0) - (a.cpuPercent ?? 0) || a.pid - b.pid)

// One listed process: its figures, command and origin, and (where asked) whether it is detached.
const processLine = (row: ProcRow, index: number, origins: Origins, isDetachedShown: boolean) => {
  const origin = originOf(origins, row)
  const from = origin ? ` · ${originLabel(origin)}` : ''
  const detached = isDetachedShown && row.detached ? ' · detached' : ''

  return `  ${index + 1}. ${formatBytes(row.rssKb)} · ${formatPercent(row.cpuPercent)} CPU · pid ${row.pid} · ${cut(labelOf(row.command))}${from}${detached}`
}

// A subtotal in words: `2 child processes 20MB, 1.0% CPU`.
const subtotalText = (count: number, noun: string, kb: number, cpuPercent: number | null) =>
  `${count} ${noun} ${formatBytes(kb)}, ${formatPercent(cpuPercent)} CPU`

export const reportText = ({ reading, points, alerts, origins, now, historyMinutes }: ReportInput) => {
  const snapshot = reading.snapshot
  if (!snapshot) return `report: ${reading.error ?? 'no reading yet'}`
  const { engine, children, childCount, childKb, childCpuPercent } = snapshot
  const lines = [
    `report · ${PLATFORMS[snapshot.platform] ?? snapshot.platform} · Claude Code pid ${snapshot.pid} · up ${formatDuration(engine.uptimeSeconds)}`,
  ]

  const own = `Claude Code ${formatBytes(engine.rssKb)}, ${formatPercent(engine.cpuPercent)} CPU`
  const { under, detached } = subtotals(snapshot)
  if (children === null) lines.push(`Now: ${own} · child processes unknown (the process table could not be read)`)
  else if (childCount === 0) lines.push(`Now: ${own} · no child processes`)
  else {
    const parts = [
      under.count === 0
        ? 'no child processes'
        : subtotalText(under.count, under.count === 1 ? 'child process' : 'child processes', under.kb, under.cpuPercent),
      ...(detached.count > 0 ? [subtotalText(detached.count, 'detached', detached.kb, detached.cpuPercent)] : []),
      `total ${formatBytes(engine.rssKb + childKb)}, ${formatPercent(sum(engine.cpuPercent, childCpuPercent))} CPU`,
    ]
    lines.push(`Now: ${own} · ${parts.join(' · ')}`)
  }
  if (snapshot.detachedOff !== undefined) lines.push(snapshot.detachedOff)

  const memPeak = peakOf(points, point => point.memKb)
  const cpuPeak = peakOf(points, point => point.cpuPct)
  lines.push(
    memPeak && cpuPeak
      ? `Peaks in the last ${historyMinutes} min: memory ${formatBytes(memPeak.memKb)} ${ago(now, memPeak.t)} · CPU ${formatPercent(cpuPeak.cpuPct)} ${ago(now, cpuPeak.t)}`
      : `Peaks in the last ${historyMinutes} min: no history yet`,
  )

  if (children && children.length > 0) {
    lines.push('Heaviest processes:')
    byWeight(children).slice(0, HEAVIEST).forEach((row, index) => lines.push(processLine(row, index, origins, true)))
    const detachedRows = children.filter(row => row.detached)
    if (detachedRows.length > 0) {
      lines.push(
        detached.count > DETACHED_LISTED ? `Detached processes (${DETACHED_LISTED} of ${detached.count}):` : 'Detached processes:',
      )
      byWeight(detachedRows).slice(0, DETACHED_LISTED).forEach((row, index) => lines.push(processLine(row, index, origins, false)))
    }
  }

  const { mem, cpu } = alerts.levels
  const level = worse(mem, cpu)
  lines.push(level === 'none' ? 'Marker: none' : `Marker: ${level === 'alert' ? '🔴' : '🟡'} ${level} (memory ${mem}, CPU ${cpu})`)

  const recent = alerts.recent ?? []
  if (recent.length === 0) lines.push('Recent alerts: none')
  else {
    lines.push('Recent alerts:')
    for (const toast of [...recent].reverse()) lines.push(`  ${ago(now, toast.t)} · ${toast.text}`)
  }

  return lines.join('\n')
}
