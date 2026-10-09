import { expect, test } from 'claude-code/testing'

import { childPids, linuxEngine, linuxProc, macReading, windowsReading } from './sampler'

const stat = (pid: number, name: string, ppid: number, utime: number, stime: number, start: number) => {
  const fields = Array.from({ length: 30 }, () => '0')
  fields[1] = String(ppid)
  fields[11] = String(utime)
  fields[12] = String(stime)
  fields[19] = String(start)

  return `${pid} (${name}) ${fields.join(' ')}`
}

test('Linux: the engine from its status, stat and the system uptime', () => {
  const status = 'VmHWM:\t  530000 kB\nVmRSS:\t  412000 kB\n'
  expect(linuxEngine(status, stat(10, 'claude', 1, 300, 200, 1000), '110.00 0.00')).toEqual({
    rssKb: 412000,
    peakKb: 530000,
    cpuSeconds: 5,
    uptimeSeconds: 100,
  })
})

test('Linux: a child, and a zombie with no memory and no command line', () => {
  const status = 'VmRSS:\t  2048 kB\n'
  expect(linuxProc(11, status, stat(11, 'python3', 10, 100, 0, 5000), 'python3\0-c\0x\0', '100.00 0.00')).toEqual({
    pid: 11,
    ppid: 10,
    command: 'python3 -c x',
    rssKb: 2048,
    cpuSeconds: 1,
    uptimeSeconds: 50,
  })
  expect(linuxProc(12, 'State:\tZ (zombie)\n', stat(12, 'sh', 10, 0, 0, 5000), '', '100.00 0.00')).toEqual({
    pid: 12,
    ppid: 10,
    command: 'sh',
    rssKb: 0,
    cpuSeconds: 0,
    uptimeSeconds: 50,
  })
})

test('child pids leave out the reader', () => {
  const table = { selfPid: 14, rows: [['11', '10'], ['12', '11'], ['14', '10'], ['20', '1']] }
  expect(childPids(table, 10).sort()).toEqual([11, 12])
})

test('macOS: the engine row, its children, and the highest memory seen as peak', () => {
  const table = {
    selfPid: 99,
    rows: [
      '10 1 400000 1:00.00 05:00 /usr/local/bin/claude'.split(' '),
      '11 10 2048 0:01.00 00:10 python3 -c x'.split(' '),
      '99 10 900 0:00.01 00:00 ps -A'.split(' '),
    ],
  }
  const { engine, children } = macReading(table, 10, 450000)
  expect(engine).toEqual({ rssKb: 400000, peakKb: 450000, cpuSeconds: 60, uptimeSeconds: 300 })
  expect(children?.map(child => child.pid)).toEqual([11])
  expect(macReading(table, 10, 0).engine.peakKb).toBe(400000)
})

test('macOS: a table without the engine fails by name', () => {
  expect(() => macReading({ selfPid: 99, rows: [['11', '10']] }, 10, 0)).toThrow('process 10 not listed')
})

test('Windows: the engine and its children, without PowerShell itself', () => {
  const stdout = [
    '2097152 4194304 12.50 3600',
    '77',
    '11 10 1048576 25000000 42 node vitest',
    '77 10 1048576 0 1 powershell',
    '20 1 1048576 0 1 other',
  ].join('\r\n')
  const { engine, children } = windowsReading(stdout, 10)
  expect(engine.rssKb).toBe(2048)
  expect(children?.map(child => [child.pid, child.command])).toEqual([[11, 'node vitest']])
})
