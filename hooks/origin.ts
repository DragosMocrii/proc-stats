// Which tool call, and which agent, started each of Claude Code's Bash and Monitor processes.

import type { Origin, Origins, ProcRow, Snapshot } from '../types'
import { START_TOLERANCE_MS, unwrapCommand } from './view'

export const EMPTY_ORIGINS: Origins = { calls: [], byPid: {} }

// An unmatched call is forgotten after this long.
export const CALL_TTL_MS = 600_000

// Each reading: keep origins whose process is still listed with the same start; give each unmatched
// wrapper row, oldest first, the oldest recorded call with its exact command that was recorded no
// later than the process started (within the start tolerance); drop calls matched or expired.
// An unreadable table changes nothing.
export const matchOrigins = (origins: Origins, snapshot: Snapshot, now: number): Origins => {
  const rows = snapshot.children
  if (rows === null) return origins
  const byPid: Origins['byPid'] = {}
  for (const row of rows) {
    const kept = origins.byPid[String(row.pid)]
    if (kept && Math.abs(kept.startMs - row.startMs) <= START_TOLERANCE_MS) byPid[String(row.pid)] = kept
  }
  let calls = origins.calls.filter(each => now - each.at <= CALL_TTL_MS)
  const waiting = rows
    .filter(row => byPid[String(row.pid)] === undefined)
    .map(row => ({ row, inner: unwrapCommand(row.command) }))
    .filter((each): each is { row: ProcRow; inner: string } => each.inner !== null)
    .sort((a, b) => a.row.startMs - b.row.startMs)
  for (const { row, inner } of waiting) {
    const index = calls.findIndex(each => each.command === inner && each.at <= row.startMs + START_TOLERANCE_MS)
    if (index < 0) continue
    const { tool, agent } = calls[index]!
    byPid[String(row.pid)] = { tool, agent, startMs: row.startMs }
    calls = [...calls.slice(0, index), ...calls.slice(index + 1)]
  }

  return { calls, byPid }
}

// The origin of a listed process, matched by pid and start; null when unknown.
export const originOf = (origins: Origins, row: { pid: number; startMs: number }): Origin | null => {
  const kept = origins.byPid[String(row.pid)]
  if (!kept || Math.abs(kept.startMs - row.startMs) > START_TOLERANCE_MS) return null

  return { tool: kept.tool, agent: kept.agent }
}

// Short, for the command cell: the tool, or the subagent's type.
export const originLabel = (origin: Origin) => (origin.agent ? `subagent: ${origin.agent.type}` : origin.tool)

// Long, for the details.
export const originDetail = (origin: Origin) =>
  origin.agent
    ? `started by ${origin.tool} in subagent ${origin.agent.type}: ${origin.agent.description}`
    : `started by ${origin.tool} in the main conversation`
