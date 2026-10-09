// Which tool call, and which agent, started each of Claude Code's Bash and Monitor processes.

import type { Origin, OriginCall, Origins, ProcRow, Snapshot } from '../types'
import { START_TOLERANCE_MS, unwrapCommand } from './view'

export const EMPTY_ORIGINS: Origins = { calls: [], byPid: {} }

// A call still running and unmatched is forgotten after this long.
export const CALL_TTL_MS = 600_000

// A call starts its process while it runs: from when it was recorded (it may wait on a permission
// prompt first) until it settled, both within the start tolerance.
const isEligible = (call: OriginCall, startMs: number) =>
  call.at <= startMs + START_TOLERANCE_MS &&
  (typeof call.settledAt !== 'number' || startMs <= call.settledAt + START_TOLERANCE_MS)

// Each reading: keep origins whose process is still listed with the same start; give each unmatched
// wrapper row, oldest first, the oldest eligible recorded call with its exact command; drop calls
// matched, settled before this reading (beyond the tolerance, since the table was read just before
// `now`), or still running past the TTL. An unreadable table changes nothing.
// Identical commands started in the same instant by different agents cannot be told apart.
export const matchOrigins = (origins: Origins, snapshot: Snapshot, now: number): Origins => {
  const rows = snapshot.children
  if (rows === null) return origins
  const byPid: Origins['byPid'] = {}
  for (const row of rows) {
    const kept = origins.byPid[String(row.pid)]
    if (kept && Math.abs(kept.startMs - row.startMs) <= START_TOLERANCE_MS) byPid[String(row.pid)] = kept
  }
  let calls = origins.calls.filter(each => typeof each.settledAt === 'number' || now - each.at <= CALL_TTL_MS)
  const waiting = rows
    .filter(row => byPid[String(row.pid)] === undefined)
    .map(row => ({ row, inner: unwrapCommand(row.command) }))
    .filter((each): each is { row: ProcRow; inner: string } => each.inner !== null)
    .sort((a, b) => a.row.startMs - b.row.startMs)
  for (const { row, inner } of waiting) {
    let index = -1
    calls.forEach((each, at) => {
      const eligible = each.command === inner && isEligible(each, row.startMs)
      if (eligible && (index < 0 || each.at < calls[index]!.at)) index = at
    })
    if (index < 0) continue
    const { tool, agent } = calls[index]!
    byPid[String(row.pid)] = { tool, agent, startMs: row.startMs }
    calls = [...calls.slice(0, index), ...calls.slice(index + 1)]
  }

  // A settled call's process, if it had one, started before it settled: this reading had it.
  calls = calls.filter(each => typeof each.settledAt !== 'number' || each.settledAt + START_TOLERANCE_MS >= now)

  return { calls, byPid }
}

// The origin of a listed process, matched by pid and start; null when unknown.
export const originOf = (origins: Origins, row: { pid: number; startMs: number }): Origin | null => {
  const kept = origins.byPid[String(row.pid)]
  if (!kept || Math.abs(kept.startMs - row.startMs) > START_TOLERANCE_MS) return null

  return { tool: kept.tool, agent: kept.agent }
}

// The agent of a call whose agentId no listing names.
export const UNNAMED_AGENT = { type: 'agent', description: '' }

// Short, for the command cell: the tool, the subagent's type, or `agent` for an unnamed one.
export const originLabel = (origin: Origin) => {
  if (!origin.agent) return origin.tool

  return origin.agent.type === UNNAMED_AGENT.type ? 'agent' : `subagent: ${origin.agent.type}`
}

// Long, for the details.
export const originDetail = (origin: Origin) => {
  if (!origin.agent) return `started by ${origin.tool} in the main conversation`
  if (!origin.agent.description) return `started by ${origin.tool} in an agent`

  return `started by ${origin.tool} in subagent ${origin.agent.type}: ${origin.agent.description}`
}

// The command cell's origin text for a listed process; undefined when unknown.
export const originText = (origins: Origins, row: { pid: number; startMs: number }): string | undefined => {
  const origin = originOf(origins, row)

  return origin ? originLabel(origin) : undefined
}
