// Stopping a process and what it started: whom to stop, how, and what to say.

import type { Selected, Snapshot, StopState } from '../types'
import { parseProcStat, parsePsTime } from './stats'
import { fit, isSelected, START_TOLERANCE_MS } from './view'

// How long after a stop the pane checks what is still running.
export const STOP_CHECK_MS = 3000
// How many times a check with no reading (or no liveness) tries again before offering force stop.
export const STOP_CHECK_TRIES = 10

// The process and everything below it, deepest first (it last); null when it is not a listed child:
// Claude Code, ended, or a pid now used by another process.
export const stopTargets = (snapshot: Snapshot, selected: Selected): number[] | null => {
  const rows = snapshot.children ?? []
  const index = rows.findIndex(row => isSelected(row, selected))
  if (selected.pid === snapshot.pid || index < 0) return null
  const depth = rows[index]!.depth
  let end = index + 1
  while (end < rows.length && rows[end]!.depth > depth) end++

  return rows
    .slice(index, end)
    .sort((a, b) => b.depth - a.depth)
    .map(row => row.pid)
}

// Each pid's start in the reading, aligned with pids.
export const startsOf = (snapshot: Snapshot, pids: number[]) =>
  pids.map(pid => snapshot.children?.find(row => row.pid === pid)?.startMs ?? NaN)

// SIGTERM (or SIGKILL) to every pid in order. On Windows the first stop takes the tree from its root,
// the last pid; a force stop names each survivor, since one left outside the tree is not reached from the root.
export const killArgv = (platform: string, pids: number[], isForce: boolean) =>
  platform === 'windows'
    ? [
        'taskkill',
        '/T',
        ...(isForce
          ? ['/F', ...pids.flatMap(pid => ['/PID', String(pid)])]
          : ['/PID', String(pids[pids.length - 1])]),
      ]
    : ['kill', isForce ? '-KILL' : '-TERM', ...pids.map(String)]

// A failed signal whose every line says the process had already ended: no failure.
export const isAlreadyEnded = (stderr: string) => {
  const lines = stderr.split(/\r?\n/).filter(line => line.trim() !== '')

  return lines.length > 0 && lines.every(line => /No such process|not found/i.test(line))
}

// A process seen running: its pid and start (ms), placed as the readings place it.
export type Observed = { pid: number; startMs: number }

// The targets (in their order) still running: observed with a start within the tolerance of the
// recorded one. A pid with another start is a new process that reuses it.
export const aliveFrom = (targets: Observed[], observed: Observed[]) =>
  targets
    .filter(target => observed.some(seen => seen.pid === target.pid && Math.abs(seen.startMs - target.startMs) <= START_TOLERANCE_MS))
    .map(target => target.pid)

// Linux: /proc/<pid>/stat with /proc/uptime; a zombie has ended (and cannot be signalled), so it is null.
export const linuxObserved = (pid: number, stat: string, uptime: string, wallMs: number): Observed | null => {
  const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]
  if (state === 'Z') return null
  const { uptimeSeconds } = parseProcStat(stat, uptime)

  return Number.isFinite(uptimeSeconds) ? { pid, startMs: Math.round(wallMs - uptimeSeconds * 1000) } : null
}

const fieldLines = (text: string) =>
  text
    .split(/\r?\n/)
    .map(line => line.trim().split(/\s+/))
    .filter(fields => fields.length >= 2 && /^\d+$/.test(fields[0]!))

// macOS: ps lists the pids still running; it exits 1 when it lists none, so only its output counts.
export const macLivenessArgv = (pids: number[]) => ['ps', '-o', 'pid=,etime=', '-p', pids.join(',')]

export const parseMacLiveness = (stdout: string, wallMs: number): Observed[] =>
  fieldLines(stdout).map(([pid, etime]) => ({ pid: Number(pid), startMs: Math.round(wallMs - parsePsTime(etime!) * 1000) }))

// Windows: `<pid> <ageSeconds>` per process still running; ended ones are left out silently.
export const windowsLivenessScript = (pids: number[]) =>
  [
    `$c = [cultureinfo]::InvariantCulture`,
    `$now = Get-Date`,
    `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object {` +
      ` [string]::Format($c, '{0} {1:F0}', $_.Id, ($now - $_.StartTime).TotalSeconds) }`,
  ].join('; ')

export const parseWindowsLiveness = (stdout: string, wallMs: number): Observed[] =>
  fieldLines(stdout)
    .map(([pid, age]) => ({ pid: Number(pid), startMs: Math.round(wallMs - Number(age) * 1000) }))
    .filter(seen => Number.isFinite(seen.startMs))

const name = (stop: StopState) => fit(stop.label, 48).trimEnd()

export const confirmText = (stop: StopState) => {
  const started = stop.pids.length - 1
  const tail = started === 0 ? '' : ` and the ${started} process${started === 1 ? '' : 'es'} it started`

  return `Stop ${name(stop)} (pid ${stop.pid})${tail}?`
}

export const outcomeText = (stop: StopState, remaining: number[]) =>
  remaining.length === 0
    ? `Stopped ${name(stop)} (pid ${stop.pid}) · /proc-stats`
    : `${name(stop)} (pid ${stop.pid}): ${remaining.length} of ${stop.pids.length} processes still running · /proc-stats`
