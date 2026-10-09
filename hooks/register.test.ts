import { expect, test } from 'claude-code/testing'

import { formatDuration, formatPair } from './format'
import { paneColumns, paneLines, stripes, treePrefixes } from './pane'
import { buildSnapshot, capRows, procCpu, statusLine, treeOrder } from './register'
import type { Timed } from './register'
import {
  descendants,
  parseCmdline,
  parseMacFields,
  parsePowerShell,
  parseProcStat,
  parseProcStatus,
  parsePsTable,
  parsePsTime,
  powerShellSample,
  toRow,
  windowsProc,
} from './stats'
import type { Proc } from './stats'

const MB = 1024

const proc = (pid: number, ppid: number, extra: Partial<Proc> = {}): Proc => ({
  pid,
  ppid,
  command: `cmd${pid}`,
  rssKb: 10 * MB,
  cpuSeconds: 0,
  uptimeSeconds: 100,
  ...extra,
})

const engine = { rssKb: 484 * MB, peakKb: 530 * MB, cpuSeconds: 1, uptimeSeconds: 60 }

test('Linux: resident and peak memory from /proc/<pid>/status', () => {
  const status = 'Name:\tclaude\nVmHWM:\t  530000 kB\nVmRSS:\t  412000 kB\n'
  expect(parseProcStatus(status)).toEqual({ rssKb: 412000, peakKb: 530000 })
})

test('Linux: name, parent, CPU and runtime past a name with spaces', () => {
  const fields = Array.from({ length: 30 }, (_, i) => String(i + 3))
  fields[1] = '77' // ppid
  fields[11] = '300' // utime
  fields[12] = '200' // stime
  fields[19] = '1000' // starttime, in ticks
  const stat = `1234 (my (odd) name) ${fields.join(' ')}`
  expect(parseProcStat(stat, '110.50 400.00\n')).toEqual({
    name: 'my (odd) name',
    ppid: 77,
    cpuSeconds: 5,
    uptimeSeconds: 100.5,
  })
  expect(parseCmdline('python3\0-c\0print(1)\0')).toBe('python3 -c print(1)')
  expect(parseCmdline('')).toBe('')
})

test('macOS: ps times, and a command with spaces', () => {
  expect(parsePsTime('0:01.50')).toBe(1.5)
  expect(parsePsTime('125:03.00')).toBe(7503)
  expect(parsePsTime('01:02:03')).toBe(3723)
  expect(parsePsTime('2-01:00:00')).toBe(176400)
  const fields = '10 1 412000 1:23.45 02:10:05 /Applications/My App.app/run --flag'.split(' ')
  expect(parseMacFields(fields)).toEqual({
    pid: 10,
    ppid: 1,
    rssKb: 412000,
    cpuSeconds: 83.45,
    uptimeSeconds: 7805,
    command: '/Applications/My App.app/run --flag',
  })
})

test('the process table, with ps itself named first', () => {
  const { selfPid, rows } = parsePsTable('99\n  1     0\n 10     1\n 99    10\n')
  expect(selfPid).toBe(99)
  expect(rows.map(toRow)).toEqual([
    { pid: 1, ppid: 0 },
    { pid: 10, ppid: 1 },
    { pid: 99, ppid: 10 },
  ])
})

test('descendants: the whole tree below the engine, without the reader', () => {
  const rows = [
    { pid: 1, ppid: 0 },
    { pid: 10, ppid: 1 }, // engine
    { pid: 11, ppid: 10 }, // bash
    { pid: 12, ppid: 11 }, // its test runner
    { pid: 13, ppid: 12 }, // a worker
    { pid: 14, ppid: 10 }, // ps reading the table
    { pid: 15, ppid: 14 },
    { pid: 20, ppid: 1 }, // not ours
  ]
  expect(descendants(rows, 10, 14).sort()).toEqual([11, 12, 13])
})

test('Windows: PowerShell sample, a command with spaces', () => {
  const { engine, selfPid, rows } = parsePowerShell(
    '2097152 4194304 12.50 3600\r\n77\r\n10 1 1048576 25000000 42 C:\\Program Files\\node.exe vitest\r\n',
  )
  expect(engine).toEqual({ rssKb: 2048, peakKb: 4096, cpuSeconds: 12.5, uptimeSeconds: 3600 })
  expect(selfPid).toBe(77)
  expect(rows.map(windowsProc)).toEqual([
    {
      pid: 10,
      ppid: 1,
      rssKb: 1024,
      cpuSeconds: 2.5,
      uptimeSeconds: 42,
      command: 'C:\\Program Files\\node.exe vitest',
    },
  ])
  expect(powerShellSample(42)).toContain('Get-Process -Id 42')
})

test('tree order: depth first, each level by pid', () => {
  const ordered = treeOrder([proc(30, 10), proc(12, 11), proc(11, 10), proc(13, 11)], 10)
  expect(ordered.map(({ proc, depth }) => [proc.pid, depth])).toEqual([
    [11, 0],
    [12, 1],
    [13, 1],
    [30, 0],
  ])
})

test('process CPU: kept, new, and a reused pid', () => {
  const was = proc(5, 1, { cpuSeconds: 2, uptimeSeconds: 100 })
  expect(procCpu(proc(5, 1, { cpuSeconds: 3, uptimeSeconds: 105 }), was, 5)).toEqual({
    delta: 1,
    percent: 20,
  })
  // New, 2 s old: its whole time over the 2 s it ran.
  expect(procCpu(proc(6, 1, { cpuSeconds: 1, uptimeSeconds: 2 }), undefined, 5)).toEqual({
    delta: 1,
    percent: 50,
  })
  // Same pid, younger process: not credited with the old one's time.
  expect(procCpu(proc(5, 1, { cpuSeconds: 0.5, uptimeSeconds: 1 }), was, 5)).toEqual({
    delta: 0.5,
    percent: 50,
  })
})

test('snapshot: own and started CPU, totals over every process', () => {
  const before: Timed = { engine, children: [proc(11, 10, { cpuSeconds: 1 })], wallMs: 0 }
  const now: Timed = {
    engine: { ...engine, cpuSeconds: 1.5, uptimeSeconds: 65 },
    children: [
      proc(11, 10, { cpuSeconds: 3.5, uptimeSeconds: 105 }),
      proc(12, 11, { rssKb: 5 * MB, uptimeSeconds: 3 }),
    ],
    wallMs: 5000,
  }
  const snapshot = buildSnapshot('linux', 10, now, before)
  expect(snapshot.engine.cpuPercent).toBe(10)
  expect(snapshot.childCpuPercent).toBe(50)
  expect(snapshot.childCount).toBe(2)
  expect(snapshot.childKb).toBe(15 * MB)
  expect(snapshot.children?.map(row => [row.pid, row.depth, row.cpuPercent])).toEqual([
    [11, 0, 50],
    [12, 1, 0],
  ])
  expect(buildSnapshot('linux', 10, now, undefined).engine.cpuPercent).toBeNull()
})

test('status line: the + part only while processes run', () => {
  const before: Timed = { engine, children: [proc(5, 10, { rssKb: 15 * MB, cpuSeconds: 1 })], wallMs: 0 }
  const now: Timed = {
    engine: { ...engine, cpuSeconds: 1.5, uptimeSeconds: 65 },
    children: [proc(5, 10, { rssKb: 15 * MB, cpuSeconds: 3.5, uptimeSeconds: 105 })],
    wallMs: 5000,
  }
  expect(statusLine(buildSnapshot('linux', 10, now, before))).toBe(
    'mem (484 + 15)MB · peak 530MB · cpu (10.0 + 50.0)% · up 1m 5s',
  )
  expect(statusLine(buildSnapshot('linux', 10, { ...now, children: [] }, before))).toBe(
    'mem 484MB · peak 530MB · cpu 10.0% · up 1m 5s',
  )
  expect(statusLine(buildSnapshot('linux', 10, { ...now, children: undefined }, before))).toContain(
    'mem (484 + ?)MB',
  )
  expect(statusLine(buildSnapshot('linux', 10, now, undefined))).toContain('cpu …')
})

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

test('tree lines: a branch per sibling, a rail under ancestors with more to come', () => {
  const depths = [0, 1, 2, 1, 0, 1]
  expect(treePrefixes(depths.map(depth => ({ depth })))).toEqual([
    '├ ',
    '│ ├ ',
    '│ │ └ ',
    '│ └ ',
    '└ ',
    '  └ ',
  ])
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

test('memory pair shares one unit', () => {
  expect(formatPair(484 * MB, 15 * MB)).toBe('(484 + 15)MB')
  expect(formatPair(1.5 * 1024 * MB, 512 * MB)).toBe('(1.50 + 0.50)GB')
  expect(formatPair(484 * MB, undefined)).toBe('(484 + ?)MB')
  expect(formatPair(484 * MB, 0)).toBe('484MB')
})

test('durations', () => {
  expect(formatDuration(42)).toBe('42s')
  expect(formatDuration(3725)).toBe('1h 2m')
  expect(formatDuration(90000)).toBe('1d 1h')
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
