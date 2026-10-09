// The status-line marker and the toasts for busy or large child processes.

import type { AlertState, Level, Point, Snapshot } from '../types'
import { averageSince } from './history'
import type { Settings } from './settings'

// The CPU average the marker reads, and how much of it the points must cover.
export const CPU_WINDOW_MS = 10_000
const MIN_COVER_MS = 5_000
// A level, or a fired toast, clears only below this share of its limit.
export const FALL_BACK = 0.9
// How long a fired toast stays below FALL_BACK before it re-arms.
export const COOL_MS = 10_000

export const EMPTY_ALERTS: AlertState = { levels: { mem: 'none', cpu: 'none' }, tracks: {} }

const RANK: Record<Level, number> = { none: 0, warn: 1, alert: 2 }

// Above a limit rises at once; falling waits until 10% below the limit held.
export const levelFor = (value: number, warn: number, alert: number, previous: Level): Level => {
  const raw: Level = value > alert ? 'alert' : value > warn ? 'warn' : 'none'
  if (RANK[raw] >= RANK[previous]) return raw
  if (previous === 'alert' && value > alert * FALL_BACK) return 'alert'

  return value > warn * FALL_BACK ? 'warn' : 'none'
}

export const worse = (a: Level, b: Level): Level => (RANK[a] >= RANK[b] ? a : b)

export const markerFor = (level: Level) => (level === 'alert' ? '🔴 ' : level === 'warn' ? '🟡 ' : '')

// Null until the window holds two points at least MIN_COVER_MS apart, so one spike is no average.
export const cpuAverage = (points: Point[], now: number): number | null => {
  const recent = points.filter(point => point.t >= now - CPU_WINDOW_MS)
  const first = recent[0]
  const last = recent[recent.length - 1]
  if (!first || !last || recent.length < 2 || last.t - first.t < MIN_COVER_MS) return null

  return averageSince(recent, now, CPU_WINDOW_MS, point => point.cpuPct)
}

// Memory is the current total (Claude Code alone while the table is unreadable); CPU the average.
export const sessionLevels = (
  snapshot: Snapshot,
  points: Point[],
  now: number,
  settings: Settings,
  previous: AlertState['levels'],
): AlertState['levels'] => {
  const memMb = (snapshot.engine.rssKb + snapshot.childKb) / 1024
  const cpu = cpuAverage(points, now)

  return {
    mem: levelFor(memMb, settings.warnMemMb, settings.alertMemMb, previous.mem),
    cpu: cpu === null ? previous.cpu : levelFor(cpu, settings.warnCpuPct, settings.alertCpuPct, previous.cpu),
  }
}
