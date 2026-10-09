import { expect, test } from 'claude-code/testing'

import type { OriginCall, Origins } from '../types'
import { engine, proc } from './fixtures'
import { CALL_TTL_MS, EMPTY_ORIGINS, matchOrigins, originDetail, originLabel, originOf } from './origin'
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
  tool: 'Bash',
  agent: null,
  command,
  at,
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
