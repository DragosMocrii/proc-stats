import { expect, test } from 'claude-code/testing'
import type { Engine, TestBody } from 'claude-code/testing'

import type { OriginCall } from '../types'

const ORIGINS = { plugin: 'proc-stats', key: 'origins' } as const

type On = Parameters<TestBody>[1]

// The calls of the last origins write the plugin made.
const watchCalls = (on: On) => {
  let calls: OriginCall[] = []
  on('state.set', ORIGINS, (_$, e, next) => {
    calls = (e.value as { calls: OriginCall[] }).calls
    return next(e)
  })

  return () => calls
}

test('a Bash call is recorded before it runs and passes on unchanged', async ($, on) => {
  const writes: unknown[] = []
  on('state.set', ORIGINS, ($, e, next) => {
    writes.push(e.value)
    return next(e)
  })
  on('clock.now', () => ({ value: 1_000 }))
  const seen: unknown[] = []
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    seen.push(e.command)
    return { result: 'ok' }
  })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(seen).toEqual(['npm test'])
  const last = writes[writes.length - 1] as { calls: { command: string; tool: string; agent: unknown }[] }
  expect(last.calls.map(each => [each.command, each.tool, each.agent])).toEqual([['npm test', 'Bash', null]])
})

test('the record is written before the tool runs, and settled after it', async ($, on) => {
  let now = 1_000
  const log: unknown[] = []
  on('clock.now', () => ({ value: now }))
  on('state.set', ORIGINS, (_$, e, next) => {
    const calls = (e.value as { calls: OriginCall[] }).calls
    log.push(['set', calls.map(each => [each.id, each.at, each.settledAt])])
    return next(e)
  })
  on('tool.call', { tool: 'Bash' }, () => {
    log.push(['tool'])
    now = 4_000
    return { result: 'ok' }
  })
  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'toolu_1' })
  expect(log).toEqual([['set', [['toolu_1', 1_000, null]]], ['tool'], ['set', [['toolu_1', 1_000, 4_000]]]])
})

test('a PreToolUse rewrite: the recorded command is the one the check saw', async ($, on) => {
  on('clock.now', () => ({ value: 1_000 }))
  const recorded = watchCalls(on)
  on('classic.PreToolUse', () => ({ updatedInput: { command: 'rtk npm test' } }))
  on('tool.check', () => ({ decision: 'allow' }))
  const seen: string[] = []
  // Core: the engine decides on the call as PreToolUse left it, then runs it.
  on('tool.call', { tool: 'Bash' }, async (_h, e) => {
    const command = (e as { command: string }).command
    seen.push(command)
    await $.tool.check({ tool: 'Bash', input: { command }, tool_use_id: e.tool_use_id })
    return { result: 'ok' }
  })
  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'toolu_1' })
  expect(seen).toEqual(['rtk npm test'])
  expect(recorded().map(each => [each.id, each.command])).toEqual([['toolu_1', 'rtk npm test']])
})

test('a check passes on unchanged, and a check of another call changes nothing', async ($, on) => {
  on('clock.now', () => ({ value: 1_000 }))
  const recorded = watchCalls(on)
  on('tool.check', () => ({ decision: 'ask', reason: 'core' }))
  const answers: unknown[] = []
  on('tool.call', { tool: 'Monitor' }, async (_h, e) => {
    answers.push(await $.tool.check({ tool: 'Monitor', input: { command: 'other' }, tool_use_id: 'toolu_x' }))
    answers.push(await $.tool.check({ tool: 'Monitor', input: { command: 'query' } }))
    answers.push(await $.tool.check({ tool: 'Monitor', input: { command: 7 }, tool_use_id: e.tool_use_id }))
    return { result: 'ok' }
  })
  await $.tool.call({ tool: 'Monitor', command: 'tail -f log', tool_use_id: 'toolu_1' } as never)
  expect(answers).toEqual([{ decision: 'ask', reason: 'core' }, { decision: 'ask', reason: 'core' }, { decision: 'ask', reason: 'core' }])
  expect(recorded().map(each => [each.id, each.command])).toEqual([['toolu_1', 'tail -f log']])
})

test('a Monitor call is recorded with tool Monitor', async ($, on) => {
  on('clock.now', () => ({ value: 1_000 }))
  const recorded = watchCalls(on)
  on('tool.call', { tool: 'Monitor' }, () => ({ result: 'ok' }))
  await $.tool.call({ tool: 'Monitor', command: 'tail -f log' } as never)
  expect(recorded().map(each => [each.tool, each.command, each.agent])).toEqual([['Monitor', 'tail -f log', null]])
})

test('a subagent call is recorded with its type and task; an unlisted agent as agent', async ($, on) => {
  on('clock.now', () => ({ value: 1_000 }))
  const recorded = watchCalls(on)
  on('agent.list', () => ({ value: [{ id: 'a1', type: 'Explore', description: 'Find the tests', status: 'running' as const }] }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'ok' }))
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' } as never)
  await $.tool.call({ tool: 'Bash', command: 'pwd', agentId: 'gone' } as never)
  expect(recorded().map(each => [each.command, each.agent])).toEqual([
    ['ls', { id: 'a1', type: 'Explore', description: 'Find the tests' }],
    ['pwd', { id: 'gone', type: 'agent', description: '' }],
  ])
})

test('a call whose agent listing fails is still an agent, never the main conversation', async ($, on) => {
  on('clock.now', () => ({ value: 1_000 }))
  const recorded = watchCalls(on)
  on('agent.list', () => {
    throw new Error('unavailable')
  })
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'ok' }))
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' } as never)
  expect(recorded().map(each => each.agent)).toEqual([{ id: 'a1', type: 'agent', description: '' }])
})

test('recording drops calls past the TTL', async ($, on) => {
  let now = 1_000
  on('clock.now', () => ({ value: now }))
  const recorded = watchCalls(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'ok' }))
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(recorded().map(each => each.command)).toEqual(['ls'])
  now = 1_000 + 600_001
  await $.tool.call({ tool: 'Bash', command: 'pwd' })
  expect(recorded().map(each => each.command)).toEqual(['pwd'])
})

test('a recording failure still lets the call reach the tool, unchanged', async ($, on) => {
  on('clock.now', () => ({ value: 1_000 }))
  let attempts = 0
  // Every write of the origins misses: the record cannot be made.
  on('state.set', ORIGINS, () => {
    attempts += 1
    return { deny: 'disk full' }
  })
  const seen: string[] = []
  on('tool.call', { tool: 'Bash' }, (_h, e) => {
    seen.push((e as { command: string }).command)
    return { result: 'ran' }
  })
  const answer = await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(seen).toEqual(['npm test'])
  expect(answer.result).toBe('ran')
  expect(attempts > 0).toBe(true)
})

const MODELS = { plugin: 'proc-stats', key: 'models' } as const

// What the model's response to a step is, from the bottom of the chain.
const RESPONSE = { turnId: 't1', index: 0, answer: 'hi', toolUses: [], stopReason: 'end_turn', usage: null } as never

// Runs one step through the plugin's hook, over a bottom that streams one chunk: what came out and what was written.
const step = async ($: Engine, input: { model: string; effort?: 'high'; agentId?: string }) => {
  const chunks: unknown[] = []
  const stream = $.turn.step({ turnId: 't1', index: 0, messageCount: 1, ...input } as never)
  let next = await stream.next()
  while (!next.done) {
    chunks.push(next.value)
    next = await stream.next()
  }

  return { chunks, result: next.value }
}

test('a model request is recorded by its agent, written only on a change, and passes through unchanged', async ($, on) => {
  const writes: unknown[] = []
  on('state.set', MODELS, (_$, e, next) => {
    writes.push(e.value)
    return next(e)
  })
  const seen: unknown[] = []
  on('turn.step', async function* (_$, e) {
    seen.push(e)
    yield { kind: 'text', index: 0, text: 'hi' }

    return RESPONSE
  })
  const main = await step($, { model: 'claude-opus-5-5', effort: 'high' })
  expect(main.chunks).toEqual([{ kind: 'text', index: 0, text: 'hi' }])
  expect(main.result).toEqual(RESPONSE)
  expect(seen).toEqual([{ turnId: 't1', index: 0, messageCount: 1, model: 'claude-opus-5-5', effort: 'high' }])
  expect(writes).toEqual([{ '': { model: 'claude-opus-5-5', effort: 'high' } }])
  await step($, { model: 'claude-opus-5-5', effort: 'high' })
  expect(writes).toHaveLength(1)
  await step($, { model: 'claude-haiku-5-5', agentId: 'a1' })
  expect(writes).toHaveLength(2)
  expect(writes[1]).toEqual({ '': { model: 'claude-opus-5-5', effort: 'high' }, a1: { model: 'claude-haiku-5-5' } })
})

test('a failing record still lets the request through', async ($, on) => {
  on('state.set', MODELS, () => ({ deny: 'disk full' }))
  on('turn.step', async function* () {
    yield { kind: 'text', index: 0, text: 'hi' }

    return RESPONSE
  })
  const out = await step($, { model: 'claude-opus-5-5' })
  expect(out.chunks).toEqual([{ kind: 'text', index: 0, text: 'hi' }])
  expect(out.result).toEqual(RESPONSE)
})
