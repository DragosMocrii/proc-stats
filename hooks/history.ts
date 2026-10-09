// Session totals over time: what the alerts average and the sparklines draw.

import type { History, Point, Snapshot } from '../types'

export const historyCapacity = (minutes: number, intervalMs: number) =>
  Math.max(2, Math.ceil((minutes * 60_000) / intervalMs))

// The newest `capacity` points, so a smaller capacity trims the oldest.
export const pushPoint = (history: History, point: Point, capacity: number): History => ({
  points: [...history.points, point].slice(-capacity),
})

// One value per bucket, its maximum, so a spike is never averaged away.
export const downsample = (values: number[], width: number) => {
  if (values.length <= width) return values
  const size = values.length / width

  return Array.from({ length: width }, (_, i) =>
    Math.max(...values.slice(Math.floor(i * size), Math.floor((i + 1) * size))),
  )
}

// The mean of the points in the last `windowMs`, its start included; null with none to average.
export const averageSince = (points: Point[], now: number, windowMs: number, pick: (point: Point) => number) => {
  const recent = points.filter(point => point.t >= now - windowMs)

  return recent.length === 0 ? null : recent.reduce((sum, point) => sum + pick(point), 0) / recent.length
}

// Null until CPU can be measured, so the history holds whole points only.
export const pointOf = (snapshot: Snapshot, t: number): Point | null => {
  const { engine, childKb, childCpuPercent } = snapshot
  if (engine.cpuPercent === null) return null

  return { t, memKb: engine.rssKb + childKb, cpuPct: engine.cpuPercent + (childCpuPercent ?? 0) }
}
