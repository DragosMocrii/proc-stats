// Two readings into what both views draw: per-process CPU, the tree, the totals.

import type { ProcRow, Snapshot } from '../types'
import type { Platform, Proc, Sample } from './stats'

// A build can start hundreds of workers; the pane needs no more than this.
export const MAX_ROWS = 500

// The engine, the processes under it (undefined when the table cannot be read), and the detached
// processes this session started (left out where they are not tracked).
export type Timed = { engine: Sample; children?: Proc[]; detached?: Proc[]; wallMs: number }

// CPU a process spent since the last reading, and as a share of one core. A pid
// whose process is younger than the one seen before was reused: a new process.
// One first seen (new, reused, or found late by a slow scan) shows its average over its
// life; only the share of its CPU that falls in this reading's window counts as delta.
export const procCpu = (now: Proc, was: Proc | undefined, elapsed: number) => {
  const isSame = was !== undefined && now.uptimeSeconds >= was.uptimeSeconds - 1
  if (isSame) {
    const delta = Math.max(0, now.cpuSeconds - was.cpuSeconds)

    return { delta, percent: (delta / elapsed) * 100 }
  }
  const window = Math.max(1, now.uptimeSeconds)

  return { delta: now.cpuSeconds * Math.min(1, elapsed / window), percent: (now.cpuSeconds / window) * 100 }
}

// Depth-first from the engine, each level by pid.
export const treeOrder = (procs: Proc[], root: number) => {
  const byParent = new Map<number, Proc[]>()
  for (const proc of procs) byParent.set(proc.ppid, [...(byParent.get(proc.ppid) ?? []), proc])
  for (const list of byParent.values()) list.sort((a, b) => a.pid - b.pid)
  const ordered: { proc: Proc; depth: number }[] = []
  const seen = new Set<number>()
  const visit = (pid: number, depth: number) => {
    for (const proc of byParent.get(pid) ?? []) {
      if (seen.has(proc.pid)) continue
      seen.add(proc.pid)
      ordered.push({ proc, depth })
      visit(proc.pid, depth + 1)
    }
  }
  visit(root, 0)
  // A process whose parent ended between reads is kept, at the top level.
  for (const proc of procs) if (!seen.has(proc.pid)) ordered.push({ proc, depth: 0 })

  return ordered
}

// A parent no process has, for forestOrder's roots.
const FOREST_ROOT = -1

// Processes as a forest: each whose parent is not among them is a root, roots by pid.
export const forestOrder = (procs: Proc[]) => {
  const pids = new Set(procs.map(proc => proc.pid))
  const byPid = new Map(procs.map(proc => [proc.pid, proc]))
  const rooted = procs.map(proc => (pids.has(proc.ppid) ? proc : { ...proc, ppid: FOREST_ROOT }))

  return treeOrder(rooted, FOREST_ROOT).map(({ proc, depth }) => ({ proc: byPid.get(proc.pid)!, depth }))
}

export const buildSnapshot = (
  platform: Platform,
  pid: number,
  now: Timed,
  before: Timed | undefined,
): Snapshot => {
  const elapsed = before ? (now.wallMs - before.wallMs) / 1000 : 0
  const isMeasured = before !== undefined && elapsed > 0
  const was = new Map([...(before?.children ?? []), ...(before?.detached ?? [])].map(proc => [proc.pid, proc]))
  const canCompare = isMeasured && before?.children !== undefined && now.children !== undefined
  let childDelta = 0
  let detachedDelta = 0
  const toRow = ({ proc, depth }: { proc: Proc; depth: number }, isDetached: boolean): ProcRow => {
    const cpu = canCompare ? procCpu(proc, was.get(proc.pid), elapsed) : undefined
    childDelta += cpu?.delta ?? 0
    if (isDetached) detachedDelta += cpu?.delta ?? 0

    return {
      pid: proc.pid,
      ppid: proc.ppid,
      depth,
      command: proc.command,
      rssKb: proc.rssKb,
      cpuPercent: cpu ? cpu.percent : null,
      uptimeSeconds: proc.uptimeSeconds,
      startMs: Math.round(now.wallMs - proc.uptimeSeconds * 1000),
      ...(isDetached ? { detached: true as const } : {}),
    }
  }
  // The tree under Claude Code, then the detached processes; the detached ones only with the tree.
  const detachedRows = now.children ? forestOrder(now.detached ?? []).map(each => toRow(each, true)) : []
  const rows = now.children ? [...treeOrder(now.children, pid).map(each => toRow(each, false)), ...detachedRows] : null

  return {
    platform,
    pid,
    engine: {
      rssKb: now.engine.rssKb,
      peakKb: now.engine.peakKb,
      cpuPercent:
        isMeasured && before
          ? (Math.max(0, now.engine.cpuSeconds - before.engine.cpuSeconds) / elapsed) * 100
          : null,
      uptimeSeconds: now.engine.uptimeSeconds,
    },
    children: rows,
    childCount: rows?.length ?? 0,
    childKb: rows?.reduce((sum, row) => sum + row.rssKb, 0) ?? 0,
    childCpuPercent: canCompare ? (childDelta / elapsed) * 100 : null,
    detachedCount: detachedRows.length,
    detachedKb: detachedRows.reduce((sum, row) => sum + row.rssKb, 0),
    detachedCpuPercent: canCompare ? (detachedDelta / elapsed) * 100 : null,
  }
}

// What the pane is handed: the totals over every process, the rows capped.
export const capRows = (snapshot: Snapshot): Snapshot => ({
  ...snapshot,
  children: snapshot.children?.slice(0, MAX_ROWS) ?? null,
})
