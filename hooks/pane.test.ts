import { expect, test } from 'claude-code/testing'

import { engine, MB, proc } from './fixtures'
import { paneColumns, paneLines, stripes } from './pane'
import { buildSnapshot, capRows } from './snapshot'
import type { Timed } from './snapshot'

test('pane: Claude Code, its processes as a tree, then the totals', () => {
  const before: Timed = { engine, children: [proc(11, 10)], wallMs: 0 }
  const now: Timed = {
    engine: { ...engine, cpuSeconds: 1.5 },
    children: [proc(11, 10, { cpuSeconds: 1 }), proc(12, 11, { command: 'python3 -c x', cpuSeconds: 0 })],
    wallMs: 5000,
  }
  const lines = paneLines(buildSnapshot('linux', 10, now, before))
  expect(lines.map(line => [line.style, line.pid, line.command.trimStart(), line.mem, line.cpu])).toEqual([
    ['header', 'PID', 'COMMAND', 'MEM', 'CPU'],
    ['own', '10', 'Claude Code', '484MB', '10.0%'],
    ['child', '11', '└ cmd11', '10MB', '20.0%'],
    ['child', '12', '└ python3 -c x', '10MB', '0.0%'],
    ['total', '', 'Child processes (2)', '20MB', '20.0%'],
    ['total', '', 'Total', '504MB', '30.0%'],
  ])
  expect(lines[2]!.command).toBe('└ cmd11')
  expect(lines[3]!.command).toBe('  └ python3 -c x')
})

test('zebra rows: every other process row, never the header or totals', () => {
  const now: Timed = { engine, children: [proc(11, 10), proc(12, 11), proc(13, 10)], wallMs: 0 }
  const lines = paneLines(buildSnapshot('linux', 10, now, undefined))
  expect(lines.map(line => line.style)).toEqual(['header', 'own', 'child', 'child', 'child', 'total', 'total'])
  expect(stripes(lines)).toEqual([false, false, true, false, true, false, false])
})

test('pane: no processes, an unreadable table, and capped rows', () => {
  const now: Timed = { engine, children: [], wallMs: 0 }
  expect(
    paneLines(buildSnapshot('linux', 10, now, undefined))
      .at(-1)?.command,
  ).toBe('No child processes')
  expect(
    paneLines(buildSnapshot('linux', 10, { ...now, children: undefined }, undefined))
      .at(-1)?.command,
  ).toBe('Child process list unavailable')
  const many = Array.from({ length: 502 }, (_, i) => proc(100 + i, 10))
  const capped = capRows(buildSnapshot('linux', 10, { ...now, children: many }, undefined))
  expect(capped.children?.length).toBe(500)
  expect(capped.childCount).toBe(502)
  expect(paneLines(capped).some(line => line.command.trim() === '… 2 more')).toBe(true)
})

test('pane columns: TIME then PID give way, the command keeps the rest', () => {
  expect(paneColumns(80)).toEqual({ showPid: true, showTime: true, commandWidth: 48 })
  expect(paneColumns(40)).toEqual({ showPid: true, showTime: false, commandWidth: 16 })
  expect(paneColumns(30)).toEqual({ showPid: false, showTime: false, commandWidth: 14 })
})

test('the pane draws a valid tree before the first reading', async $ => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'proc-stats',
      surface,
      component: 'Pane',
      requestId: 'proc-stats',
      props: {
        title: 'Processes',
        isFocused: false,
        bodyColumns: 80,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 20 },
        view: {},
      },
    })
    expect(await ui.find({ type: 'Text', text: /Reading/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the pane draws a valid table, wide and narrow', async ($, on) => {
  const before: Timed = { engine, children: [proc(11, 10)], wallMs: 0 }
  const now: Timed = {
    engine: { ...engine, cpuSeconds: 1.5 },
    children: [proc(11, 10, { cpuSeconds: 1 }), proc(12, 11, { command: 'python3 -c x' })],
    wallMs: 5000,
  }
  const snapshot = buildSnapshot('linux', 10, now, before)
  // Stands in for the sampler's write: the reading the pane reads.
  on('state.get', { plugin: 'proc-stats', key: 'reading' }, () => ({
    value: { value: { snapshot }, version: 1 },
  }))
  for (const [surface, bodyColumns] of [
    ['terminal', 80],
    ['terminal', 30],
    ['desktop', 80],
  ] as const) {
    const ui = await $.ui.mount({
      plugin: 'proc-stats',
      surface,
      component: 'Pane',
      requestId: 'proc-stats',
      props: {
        title: 'Processes',
        isFocused: false,
        bodyColumns,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 20 },
        view: {},
      },
    })
    expect(await ui.find({ type: 'Text', text: /python3 -c x/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Total' })).toBeDefined()
    await ui.unmount()
  }
})
