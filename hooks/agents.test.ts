import { expect, test } from 'claude-code/testing'

import type { AgentEntry, Origins, ProcRow, Snapshot } from '../types'
import { agentRows, tallyByAgent, toEntries } from './agents'

const MB = 1024

const row = (pid: number, ppid: number, depth: number, extra: Partial<ProcRow> = {}): ProcRow => ({
  pid,
  ppid,
  depth,
  command: `cmd${pid}`,
  rssKb: 10 * MB,
  cpuPercent: 1,
  uptimeSeconds: 10,
  startMs: pid * 1000,
  ...extra,
})

const snapshotOf = (children: ProcRow[] | null): Snapshot => ({
  platform: 'linux',
  pid: 10,
  engine: { rssKb: 400 * MB, peakKb: 400 * MB, cpuPercent: 1, uptimeSeconds: 60 },
  children,
  childCount: children?.length ?? 0,
  childKb: 0,
  childCpuPercent: 0,
  detachedCount: 0,
  detachedKb: 0,
  detachedCpuPercent: 0,
})

// Origins naming each pid's agent id (null: the main conversation), at the row's start.
const originsOf = (byAgent: Record<number, string | null>, rows: ProcRow[]): Origins => ({
  calls: [],
  byPid: Object.fromEntries(
    Object.entries(byAgent).map(([pid, id]) => [
      pid,
      {
        tool: 'Bash',
        agent: id === null ? null : { id, type: `type-${id}`, description: `task ${id}` },
        startMs: rows.find(each => each.pid === Number(pid))!.startMs,
      },
    ]),
  ),
})

const entry = (id: string, status: string, extra: Partial<AgentEntry> = {}): AgentEntry => ({
  id,
  type: `type-${id}`,
  description: `task ${id}`,
  status,
  ...extra,
})

test('toEntries keeps what the section draws; a name only for a teammate', () => {
  expect(
    toEntries([
      { id: 'a1', type: 'Explore', description: 'Find', status: 'running', name: 'bg-1' },
      { id: 'a2', type: 'teammate', description: 'Review', status: 'idle', name: 'rev', teammateId: 'rev@team', parentId: 'a1' },
    ]),
  ).toEqual([
    { id: 'a1', type: 'Explore', description: 'Find', status: 'running' },
    { id: 'a2', type: 'teammate', description: 'Review', status: 'idle', parentId: 'a1', name: 'rev' },
  ])
})

test('a subagent process and everything under it count once toward it', () => {
  // 11 (a1's bash) → 12 → 13; 14 is the main conversation's.
  const rows = [row(11, 10, 0), row(12, 11, 1), row(13, 12, 2, { cpuPercent: 100 }), row(14, 10, 0)]
  const tallies = tallyByAgent(snapshotOf(rows), originsOf({ 11: 'a1', 14: null }, rows))
  expect([...tallies.keys()]).toEqual(['a1'])
  expect(tallies.get('a1')).toEqual({ type: 'type-a1', description: 'task a1', count: 3, kb: 30 * MB, cpuPercent: 102 })
})

test('the nearest attributed process wins', () => {
  // a1's 11 has a2's 12 under it, and 13 under that.
  const rows = [row(11, 10, 0), row(12, 11, 1), row(13, 12, 2)]
  const tallies = tallyByAgent(snapshotOf(rows), originsOf({ 11: 'a1', 12: 'a2' }, rows))
  expect(tallies.get('a1')?.count).toBe(1)
  expect(tallies.get('a2')?.count).toBe(2)
})

test('detached processes with an origin count; the tree does not leak into the detached group', () => {
  const rows = [row(11, 10, 0), row(12, 11, 1), row(40, 1, 0, { detached: true }), row(41, 40, 1, { detached: true })]
  const tallies = tallyByAgent(snapshotOf(rows), originsOf({ 11: 'a1', 40: 'a2' }, rows))
  expect(tallies.get('a1')?.count).toBe(2)
  expect(tallies.get('a2')?.count).toBe(2)
})

test('origins without an id, unknown processes and an unreadable table count toward no agent', () => {
  const rows = [row(11, 10, 0), row(12, 10, 0)]
  const old: Origins = { calls: [], byPid: { 11: { tool: 'Bash', agent: { type: 'Explore', description: 'x' }, startMs: 11_000 } } }
  expect(tallyByAgent(snapshotOf(rows), old).size).toBe(0)
  expect(tallyByAgent(snapshotOf(null), originsOf({ 11: 'a1' }, rows)).size).toBe(0)
})

test('a null CPU among an agent processes makes its CPU null', () => {
  const rows = [row(11, 10, 0, { cpuPercent: null }), row(12, 11, 1)]
  expect(tallyByAgent(snapshotOf(rows), originsOf({ 11: 'a1' }, rows)).get('a1')?.cpuPercent).toBeNull()
})

test('rows: active agents and ended ones with processes, in listing order; ended ones without dropped', () => {
  const rows = [row(11, 10, 0)]
  const agents = [entry('a1', 'running'), entry('a2', 'completed'), entry('a3', 'idle'), entry('a4', 'killed')]
  const shown = agentRows(agents, snapshotOf(rows), originsOf({ 11: 'a4' }, rows))
  expect(shown.map(each => [each.id, each.status, each.isEnded, each.processCount])).toEqual([
    ['a1', 'running', false, 0],
    ['a3', 'idle', false, 0],
    ['a4', 'killed', true, 1],
  ])
  expect(shown[0]).toEqual({ id: 'a1', label: 'type-a1: task a1', status: 'running', isEnded: false, depth: 0, processCount: 0, rssKb: 0, cpuPercent: null })
})

test('an agent the listing no longer names, with processes, is a row with status ended', () => {
  const rows = [row(11, 10, 0)]
  const shown = agentRows([entry('a1', 'running')], snapshotOf(rows), originsOf({ 11: 'gone' }, rows))
  expect(shown.map(each => [each.id, each.label, each.status, each.isEnded])).toEqual([
    ['a1', 'type-a1: task a1', 'running', false],
    ['gone', 'type-gone: task gone', 'ended', true],
  ])
})

test('labels: a teammate by name; no description, the bare type', () => {
  const shown = agentRows(
    [entry('t1', 'idle', { type: 'teammate', name: 'rev' }), entry('a1', 'running', { description: '' })],
    snapshotOf([]),
    { calls: [], byPid: {} },
  )
  expect(shown.map(each => each.label)).toEqual(['rev: task t1', 'type-a1'])
})

test('nesting under parentId; a parent not shown makes a root', () => {
  const agents = [
    entry('a1', 'running'),
    entry('a2', 'completed'),
    entry('a3', 'running', { parentId: 'a2' }),
    entry('a4', 'idle', { parentId: 'a1' }),
  ]
  const shown = agentRows(agents, snapshotOf([]), { calls: [], byPid: {} })
  expect(shown.map(each => [each.id, each.depth])).toEqual([
    ['a1', 0],
    ['a4', 1],
    ['a3', 0],
  ])
})

test('a parentId cycle or a self-parent neither hangs nor drops the agents', () => {
  const agents = [entry('a1', 'running', { parentId: 'a2' }), entry('a2', 'running', { parentId: 'a1' }), entry('a3', 'running', { parentId: 'a3' })]
  const shown = agentRows(agents, snapshotOf([]), { calls: [], byPid: {} })
  expect(shown.map(each => each.id).sort()).toEqual(['a1', 'a2', 'a3'])
})
