import { expect, test } from 'claude-code/testing'

test('a Bash call is recorded before it runs and passes on unchanged', async ($, on) => {
  const writes: unknown[] = []
  on('state.set', { plugin: 'proc-stats', key: 'origins' }, ($, e, next) => {
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
