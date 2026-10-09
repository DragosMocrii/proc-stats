import { expect, test } from 'claude-code/testing'

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
