// Detached processes: ones this session started that no longer run under Claude Code. Each command
// the session starts carries PROC_STATS_SESSION=<id> in its environment, and keeps it when it detaches.

import { parsePsTime } from './stats'
import { START_TOLERANCE_MS } from './view'

// What the environment holds for this session's processes.
export const markOf = (id: string) => `PROC_STATS_SESSION=${id}`

// A process seen in the table: its pid and when it started (ms since the epoch).
export type Started = { pid: number; startMs: number }

// What is known of a pid: its start, and whether its environment holds the mark.
export type MarkCache = Map<number, { startMs: number; isOurs: boolean }>

// Linux: /proc/<pid>/environ is NUL-separated `NAME=value` entries.
export const environHasMark = (environ: string, id: string) => environ.split('\0').includes(markOf(id))

// macOS: `ps eww -o pid=,command= -p …` prints each pid, its command and then its environment, space-separated.
export const macMarkedPids = (stdout: string, id: string) => {
  const mark = markOf(id)
  const pids = new Set<number>()
  for (const line of stdout.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/)
    if (fields.slice(1).includes(mark)) pids.add(Number(fields[0]))
  }

  return pids
}

// The processes that could be ours: started since the session began (with two seconds' slack) and not
// excluded (Claude Code, what runs under it, and the reader itself).
export const candidatesOf = (started: Started[], excluded: Set<number>, sessionStartMs: number) =>
  started.filter(each => !excluded.has(each.pid) && each.startMs >= sessionStartMs - START_TOLERANCE_MS)

const isKnown = (cache: MarkCache, each: Started) => {
  const known = cache.get(each.pid)

  return known !== undefined && Math.abs(known.startMs - each.startMs) <= START_TOLERANCE_MS
}

// The candidates whose environment has not been read yet (a reused pid counts as unread).
export const unreadOf = (cache: MarkCache, candidates: Started[]) => candidates.filter(each => !isKnown(cache, each))

// The cache after a reading: what was just read, plus what is still known of the candidates; ended
// processes and reused pids leave it.
export const rememberMarks = (cache: MarkCache, candidates: Started[], read: (Started & { isOurs: boolean })[]): MarkCache => {
  const next: MarkCache = new Map()
  for (const each of candidates) if (isKnown(cache, each)) next.set(each.pid, cache.get(each.pid)!)
  for (const each of read) next.set(each.pid, { startMs: each.startMs, isOurs: each.isOurs })

  return next
}

// The candidates known to be ours.
export const oursOf = (cache: MarkCache, candidates: Started[]) =>
  candidates.filter(each => isKnown(cache, each) && cache.get(each.pid)!.isOurs).map(each => each.pid)

// Each table row's pid and start, its elapsed time (`[[dd-]hh:]mm:ss`) in column `etimeColumn`, read at `wallMs`.
export const startedFrom = (rows: string[][], etimeColumn: number, wallMs: number): Started[] =>
  rows.map(fields => ({ pid: Number(fields[0]), startMs: wallMs - parsePsTime(fields[etimeColumn] ?? '') * 1000 }))
