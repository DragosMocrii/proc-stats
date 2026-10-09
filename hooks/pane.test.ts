import { expect, test } from 'claude-code/testing'

import type { PaneState } from '../types'
import { engine, MB, proc } from './fixtures'
import { commandCell, paneColumns } from './pane'
import { buildSnapshot } from './snapshot'
import type { Timed } from './snapshot'
import { EMPTY_PANE, viewRows } from './view'

const before: Timed = { engine, children: [proc(11, 10), proc(12, 11)], wallMs: 0 }
const now: Timed = {
  engine: { ...engine, cpuSeconds: 1.5 },
  children: [proc(11, 10, { cpuSeconds: 1 }), proc(12, 11, { command: 'python3 -c x', rssKb: 20 * MB })],
  wallMs: 5000,
}
const snapshot = buildSnapshot('linux', 10, now, before)
const state = (extra: Partial<PaneState> = {}): PaneState => ({ ...EMPTY_PANE, ...extra })

test('pane columns: TIME then PID give way, the command keeps the rest', () => {
  expect(paneColumns(80)).toEqual({ showPid: true, showTime: true, commandWidth: 48 })
  expect(paneColumns(40)).toEqual({ showPid: true, showTime: false, commandWidth: 16 })
  expect(paneColumns(30)).toEqual({ showPid: false, showTime: false, commandWidth: 14 })
})

test('command cells: tree lines and collapse marker; the parent after it when sorted', () => {
  const [parent, child] = viewRows(snapshot, state())
  expect(commandCell(parent!, 20).main).toBe('└ ▾ cmd11           ')
  expect(commandCell(child!, 20).main).toBe('  └ python3 -c x    ')
  const collapsed = viewRows(snapshot, state({ collapsed: [11] }))[0]!
  expect(commandCell(collapsed, 20).main).toBe('└ ▸ cmd11           ')
  const sorted = viewRows(snapshot, state({ sort: 'mem' }))[0]!
  expect(commandCell(sorted, 30)).toEqual({ main: 'python3 -c x          ', parent: ' ← cmd11' })
})

const PANE_PROPS = {
  title: 'Processes',
  isFocused: true,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

test('the pane draws before the first reading', async $ => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'proc-stats',
      surface,
      component: 'Pane',
      requestId: 'proc-stats',
      props: { ...PANE_PROPS, bodyColumns: 80 },
    })
    expect(await ui.find({ type: 'Text', text: /Reading/ })).toBeDefined()
    await ui.unmount()
  }
})

test('rows are buttons; a press selects and shows details; s cycles the sort', async ($, on) => {
  on('state.get', { plugin: 'proc-stats', key: 'reading' }, () => ({ value: { value: { snapshot }, version: 1 } }))
  for (const [surface, bodyColumns] of [['terminal', 80], ['terminal', 30], ['desktop', 80]] as const) {
    const ui = await $.ui.mount({
      plugin: 'proc-stats',
      surface,
      component: 'Pane',
      requestId: 'proc-stats',
      props: { ...PANE_PROPS, bodyColumns },
    })
    expect(await ui.find({ key: 'pid:12' })).toBeDefined()
    expect(await ui.find({ key: 'pid:10' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Total/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /pid 12 · parent 11/ })).toBeUndefined()
    await ui.press({ key: 'pid:12' })
    expect(await ui.find({ type: 'Text', text: /pid 12 · parent 11/ })).toBeDefined()
    expect((await ui.find({ key: 'sort' }))?.text).toContain('Sort: tree')
    await ui.press({ key: 'sort' })
    expect((await ui.find({ key: 'sort' }))?.text).toContain('Sort: cpu')
    await ui.press({ key: 'sort' })
    await ui.press({ key: 'sort' })
    await ui.press({ key: 'sort' })
    // Back to the engine row, whose details name no parent, for the next surface.
    await ui.press({ key: 'pid:10' })
    await ui.unmount()
  }
})

test('pressing a row with children collapses it, and again expands it', async ($, on) => {
  on('state.get', { plugin: 'proc-stats', key: 'reading' }, () => ({ value: { value: { snapshot }, version: 1 } }))
  const ui = await $.ui.mount({
    plugin: 'proc-stats',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'proc-stats',
    props: { ...PANE_PROPS, bodyColumns: 80 },
  })
  expect((await ui.find({ key: 'pid:11' }))?.text).toContain('▾')
  expect(await ui.find({ key: 'pid:12' })).toBeDefined()
  await ui.press({ key: 'pid:11' })
  expect((await ui.find({ key: 'pid:11' }))?.text).toContain('▸')
  expect(await ui.find({ key: 'pid:12' })).toBeUndefined()
  await ui.press({ key: 'pid:11' })
  expect((await ui.find({ key: 'pid:11' }))?.text).toContain('▾')
  expect(await ui.find({ key: 'pid:12' })).toBeDefined()
  await ui.unmount()
})

test('k asks before stopping; n cancels; Claude Code offers no stop', async ($, on) => {
  on('state.get', { plugin: 'proc-stats', key: 'reading' }, () => ({ value: { value: { snapshot }, version: 1 } }))
  const ui = await $.ui.mount({
    plugin: 'proc-stats',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'proc-stats',
    props: { ...PANE_PROPS, bodyColumns: 80 },
  })
  await ui.press({ key: 'pid:10' })
  expect(await ui.find({ key: 'stop' })).toBeUndefined()
  await ui.press({ key: 'pid:12' })
  await ui.press({ key: 'stop' })
  expect(await ui.find({ type: 'Text', text: 'Stop python3 -c x (pid 12)?' })).toBeDefined()
  expect(await ui.find({ key: 'confirm' })).toBeDefined()
  await ui.press({ key: 'cancel' })
  expect(await ui.find({ key: 'confirm' })).toBeUndefined()
  expect(await ui.find({ key: 'stop' })).toBeDefined()
  await ui.unmount()
})
