import { expect, test } from 'claude-code/testing'

import { childCpuSeconds, formatDuration, formatLine, formatPair } from './register'
import {
  descendants,
  parseMacFields,
  parsePowerShell,
  parseProcStat,
  parseProcStatus,
  parsePsTable,
  parsePsTime,
  powerShellSample,
  toRow,
  windowsUsage,
} from './stats'

test('Linux: resident and peak memory from /proc/<pid>/status', () => {
  const status = 'Name:\tclaude\nVmHWM:\t  530000 kB\nVmRSS:\t  412000 kB\n'
  expect(parseProcStatus(status)).toEqual({ rssKb: 412000, peakKb: 530000 })
})

test('Linux: CPU and uptime past a command name with spaces', () => {
  const fields = Array.from({ length: 30 }, (_, i) => String(i + 3))
  fields[11] = '300' // utime
  fields[12] = '200' // stime
  fields[19] = '1000' // starttime, in ticks
  const stat = `1234 (my (odd) name) ${fields.join(' ')}`
  expect(parseProcStat(stat, '110.50 400.00\n')).toEqual({ cpuSeconds: 5, uptimeSeconds: 100.5 })
})

test('macOS: ps time and elapsed formats', () => {
  expect(parsePsTime('0:01.50')).toBe(1.5)
  expect(parsePsTime('125:03.00')).toBe(7503)
  expect(parsePsTime('01:02:03')).toBe(3723)
  expect(parsePsTime('2-01:00:00')).toBe(176400)
  expect(parseMacFields(['10', '1', '412000', '1:23.45', '02:10:05'])).toEqual({
    rssKb: 412000,
    cpuSeconds: 83.45,
    uptimeSeconds: 7805,
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

test('Windows: PowerShell sample', () => {
  const { engine, selfPid, rows } = parsePowerShell(
    '2097152 4194304 12.50 3600\r\n77\r\n10 1 1048576 25000000\r\n',
  )
  expect(engine).toEqual({ rssKb: 2048, peakKb: 4096, cpuSeconds: 12.5, uptimeSeconds: 3600 })
  expect(selfPid).toBe(77)
  expect(rows.map(windowsUsage)).toEqual([{ pid: 10, rssKb: 1024, cpuSeconds: 2.5 }])
  expect(powerShellSample(42)).toContain('Get-Process -Id 42')
})

test('child CPU counts new processes whole and ended ones not at all', () => {
  const before = [
    { pid: 1, rssKb: 0, cpuSeconds: 2 },
    { pid: 2, rssKb: 0, cpuSeconds: 9 }, // ends
  ]
  const now = [
    { pid: 1, rssKb: 0, cpuSeconds: 3 },
    { pid: 3, rssKb: 0, cpuSeconds: 0.5 }, // new
  ]
  expect(childCpuSeconds(now, before)).toBe(1.5)
})

test('memory pair shares one unit', () => {
  expect(formatPair(484 * 1024, 15 * 1024)).toBe('(484 + 15)MB')
  expect(formatPair(1.5 * 1024 * 1024, 512 * 1024)).toBe('(1.50 + 0.50)GB')
  expect(formatPair(484 * 1024, undefined)).toBe('(484 + ?)MB')
  expect(formatPair(484 * 1024, 0)).toBe('484MB')
})

test('status line', () => {
  const engine = { rssKb: 484 * 1024, peakKb: 530 * 1024, cpuSeconds: 1, uptimeSeconds: 60 }
  const before = { engine, children: [{ pid: 5, rssKb: 15 * 1024, cpuSeconds: 1 }], wallMs: 0 }
  const now = {
    engine: { ...engine, cpuSeconds: 1.5, uptimeSeconds: 65 },
    children: [{ pid: 5, rssKb: 15 * 1024, cpuSeconds: 3.5 }],
    wallMs: 5000,
  }
  expect(formatLine(now, before)).toBe('mem (484 + 15)MB · peak 530MB · cpu (10.0 + 50.0)% · up 1m 5s')
  expect(formatLine(now, undefined)).toContain('cpu …')
  expect(formatLine({ ...now, children: undefined }, before)).toContain('cpu (10.0 + ?)%')
  expect(formatLine({ ...now, children: [] }, before)).toBe('mem 484MB · peak 530MB · cpu 10.0% · up 1m 5s')
})

test('durations', () => {
  expect(formatDuration(42)).toBe('42s')
  expect(formatDuration(3725)).toBe('1h 2m')
  expect(formatDuration(90000)).toBe('1d 1h')
})
