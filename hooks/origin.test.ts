import { expect, test } from 'claude-code/testing'

import type { OriginCall, Origins } from '../types'
import { engine, proc } from './fixtures'
import { CALL_TTL_MS, EMPTY_ORIGINS, matchOrigins, originDetail, originLabel, originOf, originText } from './origin'
import { buildSnapshot } from './snapshot'

const wrap = (inner: string) =>
  `/bin/bash -c source /home/u/.claude/shell-snapshots/snapshot-bash-1-abc.sh 2>/dev/null || true && eval '${inner}' < /dev/null && pwd -P >| /tmp/claude-1-cwd`

// A reading at `wallMs` of wrapper processes: [pid, command, uptime seconds].
const reading = (wallMs: number, rows: [number, string, number][]) =>
  buildSnapshot(
    'linux',
    10,
    { engine, children: rows.map(([pid, inner, uptimeSeconds]) => proc(pid, 10, { command: wrap(inner), uptimeSeconds })), wallMs },
    undefined,
  )

const call = (command: string, at: number, extra: Partial<OriginCall> = {}): OriginCall => ({
  id: `toolu_${command}_${at}`,
  tool: 'Bash',
  agent: null,
  command,
  at,
  settledAt: null,
  ...extra,
})

const origins = (calls: OriginCall[]): Origins => ({ calls, byPid: {} })

test('a wrapper row takes the call with its exact command, which then leaves the calls', () => {
  const snapshot = reading(100_000, [[11, 'npm test', 5]])
  const next = matchOrigins(origins([call('npm test', 94_000), call('ls', 94_500)]), snapshot, 100_000)
  expect(next.byPid['11']).toEqual({ tool: 'Bash', agent: null, startMs: 95_000 })
  expect(next.calls.map(each => each.command)).toEqual(['ls'])
})

test('two calls with the same command go to two processes, in start order', () => {
  const snapshot = reading(100_000, [[12, 'npm test', 3], [11, 'npm test', 5]])
  const first = call('npm test', 94_000, { tool: 'Monitor' })
  const second = call('npm test', 96_000)
  const next = matchOrigins(origins([first, second]), snapshot, 100_000)
  expect(next.byPid['11']?.tool).toBe('Monitor')
  expect(next.byPid['12']?.tool).toBe('Bash')
  expect(next.calls).toEqual([])
})

test('a call recorded after the process started is not its origin', () => {
  const snapshot = reading(100_000, [[11, 'npm test', 60]])
  const next = matchOrigins(origins([call('npm test', 90_000)]), snapshot, 100_000)
  expect(next.byPid).toEqual({})
  expect(next.calls.length).toBe(1)
})

test('ended processes and reused pids lose their origin; old calls expire', () => {
  const snapshot = reading(100_000, [[11, 'npm test', 5]])
  const kept: Origins = {
    calls: [call('old', 100_000 - CALL_TTL_MS - 1), call('fresh', 99_000)],
    byPid: {
      11: { tool: 'Bash', agent: null, startMs: 95_000 },
      12: { tool: 'Bash', agent: null, startMs: 50_000 },
    },
  }
  const next = matchOrigins(kept, snapshot, 100_000)
  expect(Object.keys(next.byPid)).toEqual(['11'])
  expect(next.calls.map(each => each.command)).toEqual(['fresh'])
  const reused = matchOrigins({ calls: [], byPid: { 11: { tool: 'Bash', agent: null, startMs: 10_000 } } }, snapshot, 100_000)
  expect(reused.byPid).toEqual({})
})

test('an unreadable table changes nothing; non-wrapper rows never match', () => {
  const kept = origins([call('python3 -c x', 94_000)])
  expect(matchOrigins(kept, { ...reading(100_000, []), children: null }, 100_000)).toEqual(kept)
  const plain = buildSnapshot('linux', 10, { engine, children: [proc(11, 10, { command: 'python3 -c x', uptimeSeconds: 5 })], wallMs: 100_000 }, undefined)
  expect(matchOrigins(kept, plain, 100_000).byPid).toEqual({})
})

test('looking up, labelling and describing an origin', () => {
  const kept: Origins = { calls: [], byPid: { 11: { tool: 'Bash', agent: null, startMs: 95_000 } } }
  expect(originOf(kept, { pid: 11, startMs: 95_800 })).toEqual({ tool: 'Bash', agent: null })
  expect(originOf(kept, { pid: 11, startMs: 99_000 })).toBeNull()
  expect(originOf(EMPTY_ORIGINS, { pid: 11, startMs: 0 })).toBeNull()
  const sub = { tool: 'Bash', agent: { type: 'code-reviewer', description: 'Review the diff' } }
  expect(originLabel({ tool: 'Monitor', agent: null })).toBe('Monitor')
  expect(originLabel(sub)).toBe('subagent: code-reviewer')
  expect(originDetail({ tool: 'Bash', agent: null })).toBe('started by Bash in the main conversation')
  expect(originDetail(sub)).toBe('started by Bash in subagent code-reviewer: Review the diff')
})

test('a call still running matches a process started long after it (a permission prompt)', () => {
  const snapshot = reading(105_000, [[11, 'ls', 5]])
  const next = matchOrigins(origins([call('ls', 40_000)]), snapshot, 105_000)
  expect(next.byPid['11']?.tool).toBe('Bash')
  expect(next.calls).toEqual([])
})

test('a settled call never matches a process started after it settled, beyond the tolerance', () => {
  const snapshot = reading(100_000, [[11, 'ls', 5]])
  expect(matchOrigins(origins([call('ls', 90_000, { settledAt: 93_000 })]), snapshot, 100_000).byPid['11']).toBeDefined()
  const late = matchOrigins(origins([call('ls', 90_000, { settledAt: 92_999 })]), snapshot, 100_000)
  expect(late.byPid).toEqual({})
  expect(late.calls).toEqual([])
})

test('a settled unmatched call is gone after one reading; one settled within the tolerance waits a reading', () => {
  const snapshot = reading(100_000, [])
  const settled = call('ls', 90_000, { settledAt: 97_999 })
  expect(matchOrigins(origins([settled]), snapshot, 100_000).calls).toEqual([])
  const fresh = call('ls', 90_000, { settledAt: 98_000 })
  expect(matchOrigins(origins([fresh]), snapshot, 100_000).calls).toEqual([fresh])
  const running = call('ls', 90_000)
  expect(matchOrigins(origins([running]), snapshot, 100_000).calls).toEqual([running])
})

test('settled parallel calls with the same command still go in start order', () => {
  const snapshot = reading(100_000, [[12, 'npm test', 3], [11, 'npm test', 5]])
  const first = call('npm test', 94_000, { tool: 'Monitor', settledAt: 99_000 })
  const second = call('npm test', 96_000, { settledAt: 99_500 })
  const next = matchOrigins(origins([second, first]), snapshot, 100_000)
  expect(next.byPid['11']?.tool).toBe('Monitor')
  expect(next.byPid['12']?.tool).toBe('Bash')
  expect(next.calls).toEqual([])
})

test('an agent no listing names: labelled agent, never the main conversation', () => {
  const unnamed = { tool: 'Bash', agent: { type: 'agent', description: '' } }
  expect(originLabel(unnamed)).toBe('agent')
  expect(originDetail(unnamed)).toBe('started by Bash in an agent')
  expect(originDetail({ tool: 'Monitor', agent: { type: 'Explore', description: '' } })).toBe('started by Monitor in an agent')
})

test('the command cell text of a row: its label, or nothing when unknown', () => {
  const kept: Origins = {
    calls: [],
    byPid: { 11: { tool: 'Bash', agent: { type: 'Explore', description: 'Look' }, startMs: 95_000 } },
  }
  expect(originText(kept, { pid: 11, startMs: 95_000 })).toBe('subagent: Explore')
  expect(originText(kept, { pid: 12, startMs: 95_000 })).toBeUndefined()
})

test('a call recorded up to 2 s after the start is matched, not 2_001 ms', () => {
  const snapshot = reading(100_000, [[11, 'ls', 5]])
  expect(matchOrigins(origins([call('ls', 96_000)]), snapshot, 100_000).byPid['11']).toBeDefined()
  expect(matchOrigins(origins([call('ls', 97_000)]), snapshot, 100_000).byPid['11']).toBeDefined()
  expect(matchOrigins(origins([call('ls', 97_001)]), snapshot, 100_000).byPid).toEqual({})
})

test('calls out of time order: the earliest eligible one goes first', () => {
  const snapshot = reading(100_000, [[11, 'ls', 5], [12, 'ls', 3]])
  const late = call('ls', 96_000, { tool: 'Monitor' })
  const early = call('ls', 94_000)
  const next = matchOrigins(origins([late, early]), snapshot, 100_000)
  expect(next.byPid['11']?.tool).toBe('Bash')
  expect(next.byPid['12']?.tool).toBe('Monitor')
})
