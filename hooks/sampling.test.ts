import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import type { Reading } from '../types'

type On = Parameters<TestBody>[1]

const NOW = 100_000_000
const START = { cwd: '/', surface: null, isInteractive: true }
const ran = (stdout: string) => ({ value: { stdout, stderr: '', exitCode: 0, isStdoutTruncated: false, isStderrTruncated: false } })

// A session on `os` under a mocked clock at NOW: the mark it sets (or the refusal), and each reading it
// writes. `answer` gives the output of each other command, by its argv joined with spaces.
const startSession = (on: On, os: 'Linux' | 'Darwin', answer: (argv: string, marks: string[]) => string, isEnvRefused = false) => {
  const clock = mock.clock(on, { now: NOW })
  on('session.start', () => ({ cwd: '/' }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.status', () => ({ value: undefined }))
  mock.env(on, {})
  const marks: string[] = []
  on('env.set', (_$, e) => {
    if (isEnvRefused) throw new Error('refused')
    marks.push(`${e.name}=${e.value}`)
    return { value: undefined }
  })
  const readings: Reading[] = []
  on('state.set', { plugin: 'proc-stats', key: 'reading' } as const, (_$, e, next) => {
    readings.push(e.value as Reading)
    return next(e)
  })
  on('process.run', (_$, e) => {
    const argv = e.argv.join(' ')
    if (argv === 'uname -s') return ran(`${os}\n`)
    if (argv === 'sh -c echo $PPID') return ran('10\n')
    return ran(answer(argv, marks))
  })

  return { clock, marks, readings }
}

// Linux /proc files: each pid with its parent, 1 MB, started 10 s ago; `environs` by pid (others unreadable).
const procFiles = (on: On, parents: Record<number, number>, environs: Record<number, (mark: string) => string>, marks: string[], reads: string[]) =>
  on('fs.read', (_$, e) => {
    reads.push(e.path)
    const [, , pidText, file] = e.path.split('/')
    const pid = Number(pidText)
    if (e.path === '/proc/uptime') return { value: '1000.00 0' }
    if (file === 'status') return { value: 'VmRSS:\t1024 kB\nVmHWM:\t2048 kB\n' }
    if (file === 'stat') return { value: `${pid} (x) S ${parents[pid] ?? 1} 0 0 0 0 0 0 0 0 0 50 50 0 0 0 0 0 0 99000 0 0` }
    if (file === 'cmdline') return { value: `cmd${pid}\0` }
    const environ = environs[pid]
    if (file === 'environ' && environ) return { value: environ(marks[0] ?? '') }
    throw new Error(`ENOENT: ${e.path}`)
  })

test('Linux: the session is marked, and a process carrying the mark outside Claude Code is detached', async ($, on) => {
  // 11 runs under Claude Code (10); 40 and its child 42 carry the mark; 41 does not; 50 cannot be read;
  // 1 started before the session.
  const { clock, marks, readings } = startSession(on, 'Linux', () =>
    '99\n  1 0 1-00:00:00\n 10 1 05:00\n 11 10 00:00\n 40 1 00:00\n 41 1 00:00\n 42 40 00:00\n 50 1 00:00\n 99 10 00:00\n',
  )
  const reads: string[] = []
  procFiles(on, { 10: 1, 11: 10, 40: 1, 41: 1, 42: 40 }, { 40: mark => `A=1\0${mark}\0`, 41: () => 'A=1\0', 42: mark => `${mark}\0` }, marks, reads)
  await $.session.start(START)
  await clock.settle()
  await clock.advance(1000)
  expect(marks.length).toBe(1)
  expect(marks[0]).toMatch(/^PROC_STATS_SESSION=[0-9a-f-]{36}$/)
  const snapshot = readings.at(-1)?.snapshot
  expect(snapshot?.children?.map(row => [row.pid, row.depth, row.detached ?? false])).toEqual([
    [11, 0, false],
    [40, 0, true],
    [42, 1, true],
  ])
  expect([snapshot?.childCount, snapshot?.detachedCount, snapshot?.detachedOff]).toEqual([3, 2, undefined])
  // Two readings, and each environment read once.
  expect(readings.length).toBe(2)
  expect(reads.filter(path => path.endsWith('/environ')).sort()).toEqual([
    '/proc/40/environ',
    '/proc/41/environ',
    '/proc/42/environ',
    '/proc/50/environ',
  ])
})

test('a reload keeps the session mark it made', async ($, on) => {
  const { clock, marks } = startSession(on, 'Linux', () => '99\n 10 1 05:00\n')
  procFiles(on, { 10: 1 }, {}, [], [])
  await $.session.start(START)
  await $.session.start(START)
  await clock.settle()
  expect(marks.length).toBe(2)
  expect(marks[1]).toBe(marks[0])
})

test('the session mark could not be set: no detached processes, and the reading says why', async ($, on) => {
  const { clock, readings } = startSession(on, 'Linux', () => '99\n 10 1 05:00\n 40 1 00:00\n', true)
  const reads: string[] = []
  procFiles(on, { 10: 1, 40: 1 }, {}, [], reads)
  await $.session.start(START)
  await clock.settle()
  const snapshot = readings.at(-1)?.snapshot
  expect(snapshot?.detachedOff).toBe('Detached processes are not tracked: the session mark could not be set.')
  expect(snapshot?.detachedCount).toBe(0)
  expect(reads.some(path => path.endsWith('/environ'))).toBe(false)
})

test('macOS: one ps eww over the new processes finds the marked ones', async ($, on) => {
  const scans: string[] = []
  const { clock, readings } = startSession(on, 'Darwin', (argv, marks) => {
    if (!argv.startsWith('ps eww')) {
      return '99\n 10 1 1024 0:01.00 05:00 claude\n 40 1 2048 0:00.50 00:00 node server.js\n 41 1 512 0:00.00 00:00 sleep 60\n 99 10 100 0:00.00 00:00 ps\n'
    }
    scans.push(argv)
    return ` 40 node server.js HOME=/Users/me ${marks[0]}\n 41 sleep 60 HOME=/Users/me\n`
  })
  await $.session.start(START)
  await clock.settle()
  await clock.advance(2000)
  const snapshot = readings.at(-1)?.snapshot
  expect(snapshot?.children?.map(row => [row.pid, row.detached ?? false, row.command])).toEqual([[40, true, 'node server.js']])
  expect(readings.length).toBe(2)
  expect(scans).toEqual(['ps eww -o pid=,command= -p 40,41'])
})
