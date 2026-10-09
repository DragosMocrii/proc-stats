// Session totals over time: what the alerts average and the sparklines draw.

import type { History, Point, Snapshot } from '../types'

// No more points than this, however long the window or short the interval.
export const MAX_POINTS = 2400

export const historyCapacity = (minutes: number, intervalMs: number) =>
  Math.min(MAX_POINTS, Math.max(2, Math.ceil((minutes * 60_000) / intervalMs)))

// How far apart points are kept so the window fits MAX_POINTS.
export const pointSpacingMs = (minutes: number) => (minutes * 60_000) / MAX_POINTS

// A point is kept when the history is empty or the spacing has passed since the last.
export const shouldRecord = (history: History, point: Point, spacingMs: number) => {
  const last = history.points.at(-1)

  return last === undefined || point.t - last.t >= spacingMs
}

// Points within the window, the newest `capacity` of them (so a smaller capacity trims the oldest).
export const pushPoint = (history: History, point: Point, capacity: number, windowMs: number): History => ({
  points: [...history.points, point].filter(kept => kept.t >= point.t - windowMs).slice(-capacity),
})

// One value per bucket, its maximum, so a spike is never averaged away.
export const downsample = (values: number[], width: number) => {
  if (values.length <= width) return values
  const n = values.length

  return Array.from({ length: width }, (_, i) =>
    Math.max(...values.slice(Math.floor((i * n) / width), Math.floor(((i + 1) * n) / width))),
  )
}

// The mean of the points in the last `windowMs`, its start included; null with none to average.
export const averageSince = (points: Point[], now: number, windowMs: number, pick: (point: Point) => number) => {
  const recent = points.filter(point => point.t >= now - windowMs)

  return recent.length === 0 ? null : recent.reduce((sum, point) => sum + pick(point), 0) / recent.length
}

// Null until CPU and the children can be measured, so the history holds whole points only.
export const pointOf = (snapshot: Snapshot, t: number): Point | null => {
  const { engine, childKb, childCpuPercent, children } = snapshot
  if (engine.cpuPercent === null || children === null || childCpuPercent === null) return null

  return { t, memKb: engine.rssKb + childKb, cpuPct: Math.round((engine.cpuPercent + childCpuPercent) * 10) / 10 }
}
