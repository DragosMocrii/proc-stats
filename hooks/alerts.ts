// The status-line marker and the toasts for busy or large child processes.

import type { AlertState, Level, Point, ProcRow, ProcTrack, Snapshot } from '../types'
import { formatBytes, formatDuration } from './format'
import { averageSince } from './history'
import type { Settings } from './settings'

// The CPU average the marker reads: the last 10 s, or two refreshes when the refresh is slower.
// The points must cover half of it.
export const CPU_WINDOW_MS = 10_000
// A level, or a fired toast, clears only below this share of its limit.
export const FALL_BACK = 0.9
// How long a fired toast stays below FALL_BACK before it re-arms.
export const COOL_MS = 10_000

// How many sent toasts the alerts keep for the report.
export const RECENT_TOASTS = 5

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

// Null until the window holds two points spanning half of it, so one spike is no average.
export const cpuAverage = (points: Point[], now: number, intervalMs: number): number | null => {
  const window = Math.max(CPU_WINDOW_MS, 2 * intervalMs)
  const recent = points.filter(point => point.t >= now - window)
  const first = recent[0]
  const last = recent[recent.length - 1]
  if (!first || !last || recent.length < 2 || last.t - first.t < window / 2) return null

  return averageSince(recent, now, window, point => point.cpuPct)
}

// Memory is the current total (Claude Code alone while the table is unreadable, which holds the level); CPU the average.
export const sessionLevels = (
  snapshot: Snapshot,
  points: Point[],
  now: number,
  settings: Settings,
  previous: AlertState['levels'],
  intervalMs: number,
): AlertState['levels'] => {
  const memMb = (snapshot.engine.rssKb + snapshot.childKb) / 1024
  const cpu = cpuAverage(points, now, intervalMs)
  const mem = levelFor(memMb, settings.warnMemMb, settings.alertMemMb, previous.mem)

  return {
    // Without the process table the total is Claude Code alone: it may raise the level, never lower it.
    mem: snapshot.children === null ? worse(previous.mem, mem) : mem,
    cpu: cpu === null ? previous.cpu : levelFor(cpu, settings.warnCpuPct, settings.alertCpuPct, previous.cpu),
  }
}

export type Fired = { kind: 'cpu' | 'mem'; pid: number; command: string; cpuPercent: number; seconds: number; limitKb: number; limitPct: number }

const fresh = (startMs: number): ProcTrack => ({
  startMs,
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

// One reading of the listed processes (under Claude Code and detached): the trackers after it, and the toasts it fires.
export const trackProcesses = (tracks: Record<string, ProcTrack>, rows: ProcRow[], now: number, settings: Settings) => {
  const next: Record<string, ProcTrack> = {}
  const fired: Fired[] = []
  const cpuLimit = settings.toastCpuPct
  const memLimitKb = settings.toastMemMb * 1024
  for (const row of rows) {
    const was = tracks[String(row.pid)]
    const startMs = now - row.uptimeSeconds * 1000
    // A start more than 2 s later than the tracked one is another process under a reused pid;
    // a tracker without a start (an older shape) counts as another too. The tracked start stays.
    const track: ProcTrack = was && typeof was.startMs === 'number' && startMs <= was.startMs + 2000 ? { ...was } : fresh(startMs)

    if (row.cpuPercent !== null) {
      const cpu = row.cpuPercent
      const cooled = cool(track.cpuFired, cpu < cpuLimit * FALL_BACK, track.cpuCoolSince, now)
      track.cpuFired = cooled.isFired
      track.cpuCoolSince = cooled.since
      track.cpuSince = cpu > cpuLimit ? (track.cpuSince ?? now) : cpu < cpuLimit * FALL_BACK ? null : track.cpuSince
      if (!track.cpuFired && track.cpuSince !== null && now - track.cpuSince >= settings.toastCpuSeconds * 1000) {
        track.cpuFired = true
        fired.push({ kind: 'cpu', pid: row.pid, command: row.command, cpuPercent: cpu, seconds: (now - track.cpuSince) / 1000, limitKb: 0, limitPct: cpuLimit })
      }
    }

    const cooled = cool(track.memFired, row.rssKb < memLimitKb * FALL_BACK, track.memCoolSince, now)
    track.memFired = cooled.isFired
    track.memCoolSince = cooled.since
    if (!track.memFired && row.rssKb > memLimitKb) {
      track.memFired = true
      fired.push({ kind: 'mem', pid: row.pid, command: row.command, cpuPercent: 0, seconds: 0, limitKb: memLimitKb, limitPct: 0 })
    }

    next[String(row.pid)] = track
  }

  return { tracks: next, fired }
}

// One line, at most 40 code points.
const short = (command: string) => {
  const chars = Array.from(command.replace(/\s+/g, ' ').trim())

  return chars.length > 40 ? `${chars.slice(0, 39).join('')}…` : chars.join('')
}

const describe = (fired: Fired) =>
  fired.kind === 'cpu'
    ? `${short(fired.command)} has used ~${Math.round(Math.max(fired.cpuPercent, fired.limitPct))}% CPU for ${formatDuration(fired.seconds)} · pid ${fired.pid}`
    : `${short(fired.command)} grew past ${formatBytes(fired.limitKb)} · pid ${fired.pid}`

// One toast per reading: each process's lines, or a count once several processes fire together.
export const toastText = (fired: Fired[]) => {
  if (fired.length === 0) return null
  const pids = [...new Set(fired.map(entry => entry.pid))]
  if (pids.length === 1) return `${fired.map(describe).join(' · ')} · /proc-stats`
  const names = pids.map(pid => short(fired.find(entry => entry.pid === pid)!.command))

  return `${pids.length} processes over limits: ${names.join(', ')} · /proc-stats`
}

// One reading: the next alert state and the toast, if any, which joins the recent toasts. The first
// reading (no CPU yet) and an unreadable table move the levels only.
export const stepAlerts = (state: AlertState, snapshot: Snapshot, points: Point[], now: number, settings: Settings, intervalMs: number) => {
  const levels = sessionLevels(snapshot, points, now, settings, state.levels, intervalMs)
  if (snapshot.engine.cpuPercent === null || snapshot.children === null) {
    return { state: { ...state, levels }, toast: null }
  }
  const { tracks, fired } = trackProcesses(state.tracks, snapshot.children, now, settings)
  const toast = toastText(fired)
  // A toast sent joins the recent ones; without one they stay as they were (absent until the first).
  const recent = toast ? { recent: [...(state.recent ?? []), { t: now, text: toast }].slice(-RECENT_TOASTS) } : {}

  return { state: { ...state, levels, tracks, ...recent }, toast }
}
