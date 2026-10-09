// Stopping a process and what it started: whom to stop, how, and what to say.

import type { Selected, Snapshot, StopState } from '../types'
import { fit, isSelected } from './view'

// How long after a stop the pane checks what is still running.
export const STOP_CHECK_MS = 3000

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

// The pids a reading still lists; with the table unreadable, all of them.
export const stillListed = (snapshot: Snapshot, pids: number[]) =>
  snapshot.children === null ? pids : pids.filter(pid => snapshot.children!.some(row => row.pid === pid))

// SIGTERM (or SIGKILL) to every pid in order; on Windows taskkill takes the tree from its root, the last pid.
export const killArgv = (platform: string, pids: number[], isForce: boolean) =>
  platform === 'windows'
    ? ['taskkill', '/T', ...(isForce ? ['/F'] : []), '/PID', String(pids[pids.length - 1])]
    : ['kill', isForce ? '-KILL' : '-TERM', ...pids.map(String)]

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
