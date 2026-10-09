// The status-line marker and the toasts for busy or large child processes.

import type { AlertState, Level, Point, ProcRow, ProcTrack, Snapshot } from '../types'
import { formatBytes, formatDuration } from './format'
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

export type Fired = { kind: 'cpu' | 'mem'; pid: number; command: string; cpuPercent: number; seconds: number; limitKb: number }

const fresh = (uptimeSeconds: number): ProcTrack => ({
  uptimeSeconds,
  cpuSince: null,
  cpuFired: false,
  cpuCoolSince: null,
  memFired: false,
  memCoolSince: null,
})

// A fired toast re-arms after COOL_MS spent below FALL_BACK of its limit.
const cool = (isFired: boolean, isBelow: boolean, since: number | null, now: number) => {
  if (!isFired || !isBelow) return { isFired, since: null }
  const start = since ?? now

  return now - start >= COOL_MS ? { isFired: false, since: null } : { isFired, since: start }
}

// One reading of the child processes: the trackers after it, and the toasts it fires.
export const trackProcesses = (tracks: Record<string, ProcTrack>, rows: ProcRow[], now: number, settings: Settings) => {
  const next: Record<string, ProcTrack> = {}
  const fired: Fired[] = []
  const cpuLimit = settings.toastCpuPct
  const memLimitKb = settings.toastMemMb * 1024
  for (const row of rows) {
    const was = tracks[String(row.pid)]
    // A younger process under a known pid is another process.
    const track: ProcTrack =
      was && row.uptimeSeconds >= was.uptimeSeconds - 1 ? { ...was, uptimeSeconds: row.uptimeSeconds } : fresh(row.uptimeSeconds)

    if (row.cpuPercent !== null) {
      const cpu = row.cpuPercent
      const cooled = cool(track.cpuFired, cpu < cpuLimit * FALL_BACK, track.cpuCoolSince, now)
      track.cpuFired = cooled.isFired
      track.cpuCoolSince = cooled.since
      track.cpuSince = cpu > cpuLimit ? (track.cpuSince ?? now) : cpu < cpuLimit * FALL_BACK ? null : track.cpuSince
      if (!track.cpuFired && track.cpuSince !== null && now - track.cpuSince >= settings.toastCpuSeconds * 1000) {
        track.cpuFired = true
        fired.push({ kind: 'cpu', pid: row.pid, command: row.command, cpuPercent: cpu, seconds: (now - track.cpuSince) / 1000, limitKb: 0 })
      }
    }

    const cooled = cool(track.memFired, row.rssKb < memLimitKb * FALL_BACK, track.memCoolSince, now)
    track.memFired = cooled.isFired
    track.memCoolSince = cooled.since
    if (!track.memFired && row.rssKb > memLimitKb) {
      track.memFired = true
      fired.push({ kind: 'mem', pid: row.pid, command: row.command, cpuPercent: 0, seconds: 0, limitKb: memLimitKb })
    }

    next[String(row.pid)] = track
  }

  return { tracks: next, fired }
}

const short = (command: string) => (command.length > 40 ? `${command.slice(0, 39)}…` : command)

const describe = (fired: Fired) =>
  fired.kind === 'cpu'
    ? `${short(fired.command)} has used ~${Math.round(fired.cpuPercent)}% CPU for ${formatDuration(fired.seconds)} · pid ${fired.pid}`
    : `${short(fired.command)} grew past ${formatBytes(fired.limitKb)} · pid ${fired.pid}`

// One toast per reading: each process's lines, or a count once several processes fire together.
export const toastText = (fired: Fired[]) => {
  if (fired.length === 0) return null
  const pids = [...new Set(fired.map(entry => entry.pid))]
  if (pids.length === 1) return `${fired.map(describe).join(' · ')} · /proc-stats`
  const names = pids.map(pid => short(fired.find(entry => entry.pid === pid)!.command))

  return `${pids.length} processes over limits: ${names.join(', ')} · /proc-stats`
}

// One reading: the next alert state and the toast, if any. The first reading (no CPU yet)
// and an unreadable table move the levels only.
export const stepAlerts = (state: AlertState, snapshot: Snapshot, points: Point[], now: number, settings: Settings) => {
  const levels = sessionLevels(snapshot, points, now, settings, state.levels)
  if (snapshot.engine.cpuPercent === null || snapshot.children === null) {
    return { state: { levels, tracks: state.tracks }, toast: null }
  }
  const { tracks, fired } = trackProcesses(state.tracks, snapshot.children, now, settings)

  return { state: { levels, tracks }, toast: toastText(fired) }
}
