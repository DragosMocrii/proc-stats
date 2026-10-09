import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]

// `/proc-stats <args>` typed at the prompt.
const run = (args: string) => ({
  command: 'proc-stats',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 80 },
})

// Whether the pane was opened; the kit has no pane of its own.
const watchOpen = (on: On) => {
  let opened = false
  on('ui.open', () => {
    opened = true
    return { value: { isPlaced: true as const } }
  })

  return () => opened
}

const SNAPSHOT = {
  platform: 'linux',
  pid: 10,
  engine: { rssKb: 484 * 1024, peakKb: 530 * 1024, cpuPercent: 2, uptimeSeconds: 60 },
  children: [],
  childCount: 0,
  childKb: 0,
  childCpuPercent: 0,
}

test('/proc-stats report answers with the report from current state, and opens nothing', async ($, on) => {
  on('clock.now', () => ({ value: 100_000 }))
  on('state.get', { plugin: 'proc-stats', key: 'reading' } as const, () => ({ value: { value: { snapshot: SNAPSHOT }, version: 1 } }))
  on('state.get', { plugin: 'proc-stats', key: 'history' } as const, () => ({
    value: { value: { points: [{ t: 70_000, memKb: 600 * 1024, cpuPct: 40 }] }, version: 1 },
  }))
  on('state.get', { plugin: 'proc-stats', key: 'alerts' } as const, () => ({
    value: {
      value: { levels: { mem: 'none', cpu: 'warn' }, tracks: {}, recent: [{ t: 40_000, text: 'cmd6 grew past 1.00GB · pid 6 · /proc-stats' }] },
      version: 1,
    },
  }))
  const opened = watchOpen(on)
  const { text } = await $.command.run(run(' Report '))
  expect(text).toBe(
    [
      'proc-stats report · Linux · Claude Code pid 10 · up 1m 0s',
      'Now: Claude Code 484MB, 2.0% CPU · no child processes',
      'Peaks in the last 10 min: memory 600MB 30s ago · CPU 40.0% 30s ago',
      'Marker: 🟡 warn (memory none, CPU warn)',
      'Recent alerts:',
      '  1m 0s ago · cmd6 grew past 1.00GB · pid 6 · /proc-stats',
    ].join('\n'),
  )
  expect(opened()).toBe(false)
})

test('/proc-stats report before the first reading says so', async ($, on) => {
  on('clock.now', () => ({ value: 100_000 }))
  const { text } = await $.command.run(run('report'))
  expect(text).toBe('proc-stats report: no reading yet')
})

test('/proc-stats with another argument says how to use it, and opens nothing', async ($, on) => {
  const opened = watchOpen(on)
  const { text } = await $.command.run(run('nope'))
  expect(text).toBe('proc-stats: unknown argument "nope". /proc-stats opens the Processes pane; /proc-stats report summarizes the session here.')
  expect(opened()).toBe(false)
})

test('/proc-stats alone still opens the pane', async ($, on) => {
  const opened = watchOpen(on)
  const { text } = await $.command.run(run(''))
  expect(text).toBe('Processes pane opened.')
  expect(opened()).toBe(true)
})
