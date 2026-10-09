import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { PaneState, StopState } from '../types'
import { engine, MB, proc, statLine } from './fixtures'
import { commandCell, paneColumns } from './pane'
import { buildSnapshot } from './snapshot'
import type { Timed } from './snapshot'
import { EMPTY_PANE, fit, viewRows } from './view'

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

test('y signals once, even pressed twice', async ($, on) => {
  // Holds the check, which would otherwise read this machine's /proc.
  mock.clock(on)
  const calls: (readonly string[])[] = []
  on('state.get', { plugin: 'proc-stats', key: 'reading' }, () => ({ value: { value: { snapshot }, version: 1 } }))
  // Answers without calling next: nothing real runs.
  on('process.run', (_$, e) => {
    calls.push(e.argv)

    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const ui = await $.ui.mount({
    plugin: 'proc-stats',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'proc-stats',
    props: { ...PANE_PROPS, bodyColumns: 80 },
  })
  await ui.press({ key: 'pid:12' })
  await ui.press({ key: 'stop' })
  await ui.press({ key: 'confirm' })
  expect(calls).toEqual([['kill', '-TERM', '12']])
  expect(await ui.find({ type: 'Text', text: /Stopping/ })).toBeDefined()
  if (await ui.find({ key: 'confirm' })) await ui.press({ key: 'confirm' })
  expect(calls).toHaveLength(1)
  await ui.unmount()
})

test('a pid reused between k and y stops nothing and clears the stop', async ($, on) => {
  mock.clock(on)
  const calls: (readonly string[])[] = []
  let current = snapshot
  on('state.get', { plugin: 'proc-stats', key: 'reading' }, () => ({ value: { value: { snapshot: current }, version: 1 } }))
  on('process.run', (_$, e) => {
    calls.push(e.argv)

    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const ui = await $.ui.mount({
    plugin: 'proc-stats',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'proc-stats',
    props: { ...PANE_PROPS, bodyColumns: 80 },
  })
  await ui.press({ key: 'pid:12' })
  await ui.press({ key: 'stop' })
  expect(await ui.find({ key: 'confirm' })).toBeDefined()
  current = buildSnapshot('linux', 10, { ...now, wallMs: now.wallMs + 60_000 }, before)
  await ui.press({ key: 'confirm' })
  expect(calls).toEqual([])
  expect(await ui.find({ key: 'confirm' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Stopping/ })).toBeUndefined()
  await ui.unmount()
})

// What a command answers; nothing real runs.
const answer = (exitCode = 0, stderr = '') => ({
  value: { exitCode, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false },
})
const READING_KEY = { plugin: 'proc-stats', key: 'reading' } as const
const startOf = (pid: number) => snapshot.children!.find(row => row.pid === pid)!.startMs
const UPTIME = '100000.00 0.00'

// The session around a mounted pane: a mocked clock, a reading the test swaps, every command
// recorded and answered, toasts recorded, and /proc/<pid>/stat answering for the pids in `running`
// (pid → start ms); any other stat is missing, as for an ended process.
const session = async ($: Engine, on: On) => {
  const clock = mock.clock(on, { now: now.wallMs })
  const world = {
    clock,
    reading: { snapshot } as { snapshot?: typeof snapshot; error?: string },
    calls: [] as (readonly string[])[],
    toasts: [] as string[],
    running: new Map<number, number>(),
    exit: (_argv: readonly string[]) => answer(),
    // The stop as the pane last read it.
    stop: null as StopState | null,
  }
  on('state.get', { plugin: 'proc-stats', key: 'pane' }, async (_$, e, next) => {
    const read = await next(e)
    // The answer wraps the read: { value: { value, version } }.
    world.stop = (read as { value?: { value?: PaneState } }).value?.value?.stop ?? null

    return read
  })
  on('state.get', READING_KEY, () => ({ value: { value: world.reading, version: 1 } }))
  on('process.run', (_$, e) => {
    world.calls.push(e.argv)

    return world.exit(e.argv)
  })
  on('fs.read', (_$, e) => {
    if (e.path === '/proc/uptime') return { value: UPTIME }
    const pid = Number(/^\/proc\/(\d+)\/stat$/.exec(e.path)?.[1])
    const start = world.running.get(pid)
    if (start === undefined) throw new Error(`ENOENT: ${e.path}`)
    // Ticks since boot that place the start where the reading placed it.
    const bootMs = clock.now() - Number(UPTIME.split(' ')[0]) * 1000

    return { value: statLine(pid, 'S', Math.round(((start - bootMs) / 1000) * 100)) }
  })
  on('ui.toast', (_$, e) => {
    world.toasts.push(e.text)

    return { value: undefined }
  })
  // The ring moves wherever the pane asks.
  on('ui.focus', () => ({}))
  const ui = await $.ui.mount({
    plugin: 'proc-stats',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'proc-stats',
    props: { ...PANE_PROPS, bodyColumns: 80 },
  })
  // The stop's phase as the footer shows it; null with no stop.
  const phase = async () =>
    (await ui.find({ key: 'force' }))
      ? 'stuck'
      : (await ui.find({ type: 'Text', text: /Stopping/ }))
        ? 'sent'
        : (await ui.find({ key: 'confirm' }))
          ? 'confirm'
          : (await ui.find({ key: 'cancel' }))
            ? 'other'
            : null

  return { world, ui, phase }
}

test('a process left running outside the tree: stuck at the check; f kills only the live ones', async ($, on) => {
  const { world, ui, phase } = await session($, on)
  await ui.press({ key: 'pid:11' })
  await ui.press({ key: 'stop' })
  await ui.press({ key: 'confirm' })
  expect(world.calls).toEqual([['kill', '-TERM', '12', '11']])
  // 11 ended; 12 runs on outside the tree, which the reading no longer lists.
  world.running.set(12, startOf(12))
  world.reading = { snapshot: { ...snapshot, children: [], childCount: 0 } }
  await world.clock.advance(3000)
  expect(await phase()).toBe('stuck')
  expect(await ui.find({ key: 'force' })).toBeDefined()
  // 11's pid now belongs to another process, started later: never signalled.
  world.running.set(11, startOf(11) + 60_000)
  await ui.press({ key: 'force' })
  expect(world.calls).toEqual([['kill', '-TERM', '12', '11'], ['kill', '-KILL', '12']])
  world.running.delete(12)
  await world.clock.advance(3000)
  expect(await phase()).toBeNull()
  expect(world.toasts.some(text => text.startsWith('Stopped cmd11 (pid 11)'))).toBe(true)
  await ui.unmount()
})

test('stuck when a target still runs; f with none left alive signals nothing', async ($, on) => {
  const { world, ui, phase } = await session($, on)
  await ui.press({ key: 'pid:12' })
  await ui.press({ key: 'stop' })
  await ui.press({ key: 'confirm' })
  world.running.set(12, startOf(12))
  await world.clock.advance(3000)
  expect(await phase()).toBe('stuck')
  world.running.delete(12)
  await ui.press({ key: 'force' })
  expect(world.calls).toEqual([['kill', '-TERM', '12']])
  expect(await phase()).toBeNull()
  expect(world.toasts.some(text => text.startsWith('Stopped python3 -c x (pid 12)'))).toBe(true)
  await ui.unmount()
})

test('with no reading the check tries again, ten times, then offers force stop', async ($, on) => {
  const { world, ui, phase } = await session($, on)
  await ui.press({ key: 'pid:12' })
  await ui.press({ key: 'stop' })
  await ui.press({ key: 'confirm' })
  world.reading = { error: 'cannot read' }
  for (let check = 1; check <= 10; check++) {
    await world.clock.advance(3000)
    await ui.redraw()
    expect(world.stop).toMatchObject({ phase: 'sent', checks: check })
  }
  await world.clock.advance(3000)
  await ui.redraw()
  expect(world.stop?.phase).toBe('stuck')
  world.reading = { snapshot }
  await ui.redraw()
  expect(await ui.find({ key: 'force' })).toBeDefined()
  expect(await ui.find({ key: 'cancel' })).toBeDefined()
  await ui.unmount()
})

test('n dismisses a stop in every phase after the confirmation', async ($, on) => {
  const { world, ui, phase } = await session($, on)
  await ui.press({ key: 'pid:12' })
  await ui.press({ key: 'stop' })
  await ui.press({ key: 'confirm' })
  expect(await ui.find({ type: 'Text', text: /Stopping/ })).toBeDefined()
  expect((await ui.find({ key: 'cancel' }))?.text).toContain('Dismiss')
  await ui.press({ key: 'cancel' })
  expect(await phase()).toBeNull()
  // The check already scheduled finds nothing to do and brings nothing back.
  world.running.set(12, startOf(12))
  await world.clock.advance(3000)
  expect(await phase()).toBeNull()
  expect(await ui.find({ key: 'stop' })).toBeDefined()
  await ui.unmount()
})

test('y and f pressed twice at once signal once each', async ($, on) => {
  const { world, ui, phase } = await session($, on)
  await ui.press({ key: 'pid:12' })
  await ui.press({ key: 'stop' })
  await Promise.allSettled([ui.press({ key: 'confirm' }), ui.press({ key: 'confirm' })])
  expect(world.calls).toEqual([['kill', '-TERM', '12']])
  world.running.set(12, startOf(12))
  await world.clock.advance(3000)
  expect(await phase()).toBe('stuck')
  await Promise.allSettled([ui.press({ key: 'force' }), ui.press({ key: 'force' })])
  expect(world.calls).toEqual([['kill', '-TERM', '12'], ['kill', '-KILL', '12']])
  await ui.unmount()
})

test('a signal that finds the process already ended is no failure; another error is shown', async ($, on) => {
  const { world, ui } = await session($, on)
  world.exit = () => answer(1, 'kill: (12): No such process\n')
  await ui.press({ key: 'pid:12' })
  await ui.press({ key: 'stop' })
  await ui.press({ key: 'confirm' })
  expect(world.toasts).toEqual([])
  await ui.press({ key: 'cancel' })
  world.exit = () => answer(1, 'kill: (12): Operation not permitted\n')
  await ui.press({ key: 'stop' })
  await ui.press({ key: 'confirm' })
  expect(world.toasts).toEqual(['proc-stats: kill: (12): Operation not permitted'])
  await ui.unmount()
})

test('the focus ring on a row selects it; leaving the pane cancels a confirmation', async ($, on) => {
  const { ui, phase } = await session($, on)
  const focus = (element?: string) =>
    $.ui.focus({ component: 'Pane', requestId: 'proc-stats', origin: { kind: 'person' }, ...(element ? { element, plugin: 'proc-stats' } : {}) })
  expect(await ui.find({ type: 'Text', text: /pid 12 · parent 11/ })).toBeUndefined()
  expect(await focus('pid:12')).toEqual({})
  expect(await ui.find({ type: 'Text', text: /pid 12 · parent 11/ })).toBeDefined()
  await ui.press({ key: 'stop' })
  expect(await phase()).toBe('confirm')
  await focus()
  expect(await phase()).toBeNull()
  expect(await ui.find({ key: 'confirm' })).toBeUndefined()
  await ui.unmount()
})

test('macOS: liveness from one ps call outside the tree; f kills the survivor', async ($, on) => {
  const { world, ui, phase } = await session($, on)
  world.reading = { snapshot: { ...snapshot, platform: 'mac' } }
  await ui.redraw()
  // ps lists 12, started where the reading placed it: 100 s before 5000, so 01:43 old at 8000.
  world.exit = argv => (argv[0] === 'ps' ? { value: { ...answer().value, stdout: '   12      01:43\n' } } : answer())
  await ui.press({ key: 'pid:12' })
  await ui.press({ key: 'stop' })
  await ui.press({ key: 'confirm' })
  await world.clock.advance(3000)
  expect(await phase()).toBe('stuck')
  await ui.press({ key: 'force' })
  expect(world.calls).toEqual([
    ['kill', '-TERM', '12'],
    ['ps', '-o', 'pid=,etime=', '-p', '12'],
    ['ps', '-o', 'pid=,etime=', '-p', '12'],
    ['kill', '-KILL', '12'],
  ])
  await ui.unmount()
})

test('the pane draws the memory and CPU history above the table, once there is some', async ($, on) => {
  on('state.get', { plugin: 'proc-stats', key: 'reading' }, () => ({ value: { value: { snapshot }, version: 1 } }))
  let points: { t: number; memKb: number; cpuPct: number }[] = []
  on('state.get', { plugin: 'proc-stats', key: 'history' }, () => ({ value: { value: { points }, version: 1 } }))
  const mount = () =>
    $.ui.mount({
      plugin: 'proc-stats',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'proc-stats',
      props: { ...PANE_PROPS, bodyColumns: 80 },
    })
  const empty = await mount()
  expect(await empty.find({ type: 'Text', text: /^cpu / })).toBeUndefined()
  await empty.unmount()
  points = [
    { t: 0, memKb: 512 * MB, cpuPct: 50 },
    { t: 1000, memKb: 1024 * MB, cpuPct: 200 },
  ]
  const drawn = await mount()
  expect(await drawn.find({ type: 'Text', text: /^mem ▁█ +1\.00GB max +1\.00GB$/ })).toBeDefined()
  expect(await drawn.find({ type: 'Text', text: /^cpu ▃█ +200\.0% max +200\.0%$/ })).toBeDefined()
  await drawn.unmount()
})

test('a command row names its origin; sorted views add the parent after it', () => {
  const view = viewRows(snapshot, state())[0]!
  expect(commandCell(view, 30, 'Bash')).toEqual({ main: fit('└ ▾ cmd11', 23), parent: ' · Bash' })
  const sorted = viewRows(snapshot, state({ sort: 'mem' }))[0]!
  expect(commandCell(sorted, 30, 'Monitor').parent).toBe(fit(' · Monitor ← cmd11', 10))
})

test('detached processes: a heading of their own in the tree, none when sorted; why they are not tracked', async ($, on) => {
  const detached = buildSnapshot(
    'linux',
    10,
    { ...now, detached: [proc(40, 1, { command: 'node server.js' })] },
    { ...before, detached: [proc(40, 1)] },
  )
  let reading: { snapshot: typeof detached } = { snapshot: detached }
  on('state.get', { plugin: 'proc-stats', key: 'reading' }, () => ({ value: { value: reading, version: 1 } }))
  const ui = await $.ui.mount({
    plugin: 'proc-stats',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'proc-stats',
    props: { ...PANE_PROPS, bodyColumns: 80 },
  })
  expect(await ui.find({ type: 'Text', text: /^\s*Detached$/ })).toBeDefined()
  expect(await ui.find({ key: 'pid:40' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Detached \(1\)/ })).toBeDefined()
  await ui.press({ key: 'sort' })
  expect(await ui.find({ type: 'Text', text: /^\s*Detached$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /not tracked/ })).toBeUndefined()
  reading = { snapshot: { ...snapshot, detachedOff: 'Detached processes are not tracked: the session mark could not be set.' } }
  await ui.press({ key: 'sort' })
  expect(await ui.find({ type: 'Text', text: /Detached processes are not tracked/ })).toBeDefined()
  await ui.unmount()
})
