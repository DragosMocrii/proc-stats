// The Subagents section: the session's agents, each with the processes it started.

import type { AgentEntry, AgentRow, Origins, Snapshot } from '../types'
import { originOf } from './origin'

export const ACTIVE_STATUSES: readonly string[] = ['pending', 'running', 'waiting', 'idle']

// The status of an agent with processes that the listing no longer names.
export const ENDED = 'ended'

// What `$.agent.list()` answers, as far as the section reads it.
export type ListedAgent = {
  id: string
  type: string
  description: string
  status: string
  parentId?: string
  name?: string
  teammateId?: string
}

// The listing trimmed to what the section draws: a name only for a teammate (a background
// subagent's engine-given name is not one to show).
export const toEntries = (listed: readonly ListedAgent[]): AgentEntry[] =>
  listed.map(({ id, type, description, status, parentId, name, teammateId }) => ({
    id,
    type,
    description,
    status,
    ...(parentId !== undefined ? { parentId } : {}),
    ...(teammateId !== undefined && name !== undefined ? { name } : {}),
  }))

export type Tally = { type: string; description: string; count: number; kb: number; cpuPercent: number | null }

// Each agent's processes, by agent id: every row counts toward the nearest row at or above it, within
// its group (the tree, then the detached group), whose origin names an agent by id.
export const tallyByAgent = (snapshot: Snapshot, origins: Origins): Map<string, Tally> => {
  const tallies = new Map<string, Tally>()
  // The owning agent at each depth of the current branch.
  let owners: (string | null)[] = []
  let isDetached = false
  for (const row of snapshot.children ?? []) {
    if ((row.detached ?? false) !== isDetached) {
      owners = []
      isDetached = row.detached ?? false
    }
    const agent = originOf(origins, row)?.agent
    const owner = agent?.id ?? (row.depth > 0 ? (owners[row.depth - 1] ?? null) : null)
    owners = owners.slice(0, row.depth)
    owners[row.depth] = owner
    if (owner === null) continue
    const kept = tallies.get(owner)
    const type = kept?.type ?? agent?.type ?? 'agent'
    const description = kept?.description ?? agent?.description ?? ''
    // Null once any of its processes has no CPU yet.
    const cpuPercent = !kept
      ? row.cpuPercent
      : kept.cpuPercent === null || row.cpuPercent === null
        ? null
        : kept.cpuPercent + row.cpuPercent
    tallies.set(owner, { type, description, count: (kept?.count ?? 0) + 1, kb: (kept?.kb ?? 0) + row.rssKb, cpuPercent })
  }

  return tallies
}

const labelOf = (agent: AgentEntry) => {
  const who = agent.name ?? agent.type

  return agent.description ? `${who}: ${agent.description}` : who
}

// The section's rows: listed agents that are active or have processes, then agents with processes the
// listing no longer names; each agent's children under it, in order. A parent not shown, or a cycle,
// makes a root.
export const agentRows = (agents: AgentEntry[], snapshot: Snapshot, origins: Origins): AgentRow[] => {
  const tallies = tallyByAgent(snapshot, origins)
  const listed = new Set(agents.map(agent => agent.id))
  const kept: AgentEntry[] = [
    ...agents.filter(agent => ACTIVE_STATUSES.includes(agent.status) || tallies.has(agent.id)),
    ...[...tallies]
      .filter(([id]) => !listed.has(id))
      .map(([id, tally]) => ({ id, type: tally.type, description: tally.description, status: ENDED })),
  ]
  const shown = new Set(kept.map(agent => agent.id))
  // An agent whose parent chain leaves the shown agents or loops is a root.
  const parentOf = (agent: AgentEntry): string | undefined => {
    const seen = new Set([agent.id])
    let parent = agent.parentId
    while (parent !== undefined && shown.has(parent)) {
      if (seen.has(parent)) return undefined
      seen.add(parent)
      parent = kept.find(each => each.id === parent)?.parentId
    }

    return agent.parentId !== undefined && shown.has(agent.parentId) ? agent.parentId : undefined
  }
  const parents = new Map(kept.map(agent => [agent.id, parentOf(agent)]))
  const rows: AgentRow[] = []
  const visit = (parent: string | undefined, depth: number) => {
    for (const agent of kept.filter(each => parents.get(each.id) === parent)) {
      const tally = tallies.get(agent.id)
      rows.push({
        id: agent.id,
        label: labelOf(agent),
        status: agent.status,
        isEnded: !ACTIVE_STATUSES.includes(agent.status),
        depth,
        processCount: tally?.count ?? 0,
        rssKb: tally?.kb ?? 0,
        cpuPercent: tally ? tally.cpuPercent : null,
      })
      visit(agent.id, depth + 1)
    }
  }
  visit(undefined, 0)

  return rows
}
