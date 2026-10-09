import { expect, test } from 'claude-code/testing'

import type { AlertState, Origins, ProcRow, Snapshot } from '../types'
import { EMPTY_ALERTS } from './alerts'
import { MB } from './fixtures'
import { EMPTY_ORIGINS } from './origin'
import { reportText } from './report'
import type { ReportInput } from './report'

const NOW = 1_000_000

const row = (pid: number, rssMb: number, cpuPercent: number | null, command = `cmd${pid}`): ProcRow => ({
  pid,
  ppid: 10,
  depth: 0,
  command,
  rssKb: rssMb * MB,
  cpuPercent,
  uptimeSeconds: 30,
  startMs: NOW - 30_000,
})

const snapshot = (children: ProcRow[] | null): Snapshot => ({
  platform: 'linux',
  pid: 10,
  engine: { rssKb: 484 * MB, peakKb: 530 * MB, cpuPercent: 2, uptimeSeconds: 3725 },
  children,
  childCount: children?.length ?? 0,
  childKb: (children ?? []).reduce((total, each) => total + each.rssKb, 0),
  childCpuPercent: children === null ? null : children.reduce((total, each) => total + (each.cpuPercent ?? 0), 0),
  detachedCount: 0,
  detachedKb: 0,
  detachedCpuPercent: 0,
})

const input = (over: Partial<ReportInput> = {}): ReportInput => ({
  reading: { snapshot: snapshot([]) },
  points: [],
  alerts: EMPTY_ALERTS,
  origins: EMPTY_ORIGINS,
  now: NOW,
  historyMinutes: 10,
  ...over,
})

const WRAPPED = "/bin/bash -c source /home/u/.claude/shell-snapshots/s.sh && eval 'npm test' < /dev/null && pwd -P >| /tmp/cwd"

test('report: a busy session, every section', () => {
  const children = [row(11, 20, 1), row(12, 812, 95, WRAPPED), row(13, 20, 3), row(14, 5, 0), row(15, 1, 0), row(16, 2, 0)]
  const origins: Origins = { calls: [], byPid: { 12: { tool: 'Bash', agent: null, startMs: NOW - 30_000 } } }
  const alerts: AlertState = {
    levels: { mem: 'warn', cpu: 'none' },
    tracks: {},
    recent: [
      { t: NOW - 242_000, text: 'npm test grew past 1.00GB · pid 12 · /proc-stats' },
      { t: NOW - 60_000, text: 'cmd13 has used ~95% CPU for 1m 0s · pid 13 · /proc-stats' },
    ],
  }
  // Memory peaks twice at 1300 MB: the first time is when it was reached.
  const points = [
    { t: NOW - 300_000, memKb: 900 * MB, cpuPct: 20 },
    { t: NOW - 120_000, memKb: 1300 * MB, cpuPct: 50 },
    { t: NOW - 30_000, memKb: 1300 * MB, cpuPct: 145 },
  ]
  expect(reportText(input({ reading: { snapshot: snapshot(children) }, points, alerts, origins }))).toBe(
    [
      'report · Linux · Claude Code pid 10 · up 1h 2m',
      'Now: Claude Code 484MB, 2.0% CPU · 6 child processes 860MB, 99.0% CPU · total 1.31GB, 101.0% CPU',
      'Peaks in the last 10 min: memory 1.27GB 2m 0s ago · CPU 145.0% 30s ago',
      'Heaviest processes:',
      '  1. 812MB · 95.0% CPU · pid 12 · $ npm test · Bash',
      '  2. 20MB · 3.0% CPU · pid 13 · cmd13',
      '  3. 20MB · 1.0% CPU · pid 11 · cmd11',
      '  4. 5MB · 0.0% CPU · pid 14 · cmd14',
      '  5. 2MB · 0.0% CPU · pid 16 · cmd16',
      'Marker: 🟡 warn (memory warn, CPU none)',
      'Recent alerts:',
      '  1m 0s ago · cmd13 has used ~95% CPU for 1m 0s · pid 13 · /proc-stats',
      '  4m 2s ago · npm test grew past 1.00GB · pid 12 · /proc-stats',
    ].join('\n'),
  )
})

test('report: no reading yet, or a failed one, is one line', () => {
  expect(reportText(input({ reading: {} }))).toBe('report: no reading yet')
  expect(reportText(input({ reading: { error: 'cannot read process 10 on linux' } }))).toBe(
    'report: cannot read process 10 on linux',
  )
})

test('report: an unreadable process table is unknown, not zero', () => {
  expect(reportText(input({ reading: { snapshot: snapshot(null) } }))).toBe(
    [
      'report · Linux · Claude Code pid 10 · up 1h 2m',
      'Now: Claude Code 484MB, 2.0% CPU · child processes unknown (the process table could not be read)',
      'Peaks in the last 10 min: no history yet',
      'Marker: none',
      'Recent alerts: none',
    ].join('\n'),
  )
})

test('report: a quiet session, with an alert state saved before toasts were kept', () => {
  expect(reportText(input())).toBe(
    [
      'report · Linux · Claude Code pid 10 · up 1h 2m',
      'Now: Claude Code 484MB, 2.0% CPU · no child processes',
      'Peaks in the last 10 min: no history yet',
      'Marker: none',
      'Recent alerts: none',
    ].join('\n'),
  )
})

test('report: the first reading has no CPU yet; one child; the alert level and window as given', () => {
  const quiet = snapshot([row(11, 20, null)])
  const first = { ...quiet, engine: { ...quiet.engine, cpuPercent: null }, childCpuPercent: null }
  const alerts: AlertState = { levels: { mem: 'none', cpu: 'alert' }, tracks: {} }
  expect(reportText(input({ reading: { snapshot: first }, historyMinutes: 30, alerts }))).toBe(
    [
      'report · Linux · Claude Code pid 10 · up 1h 2m',
      'Now: Claude Code 484MB, … CPU · 1 child process 20MB, … CPU · total 504MB, … CPU',
      'Peaks in the last 30 min: no history yet',
      'Heaviest processes:',
      '  1. 20MB · … CPU · pid 11 · cmd11',
      'Marker: 🔴 alert (memory none, CPU alert)',
      'Recent alerts: none',
    ].join('\n'),
  )
})

test('report: a long command is cut to 80 code points', () => {
  const long = row(11, 20, 1, `node ${'x'.repeat(100)}`)
  const line = reportText(input({ reading: { snapshot: snapshot([long]) } })).split('\n')[4]
  expect(line).toBe(`  1. 20MB · 1.0% CPU · pid 11 · node ${'x'.repeat(74)}…`)
})

test('report: detached processes, their subtotal and their own list', () => {
  const server = { ...row(40, 300, 12, 'node server.js'), ppid: 1, detached: true as const }
  const worker = { ...row(41, 30, 2, 'node worker'), ppid: 40, depth: 1, detached: true as const }
  const detached: Snapshot = {
    ...snapshot([row(11, 20, 1), server, worker]),
    detachedCount: 2,
    detachedKb: 330 * MB,
    detachedCpuPercent: 14,
  }
  expect(reportText(input({ reading: { snapshot: detached } }))).toBe(
    [
      'report · Linux · Claude Code pid 10 · up 1h 2m',
      'Now: Claude Code 484MB, 2.0% CPU · 1 child process 20MB, 1.0% CPU · 2 detached 330MB, 14.0% CPU · total 834MB, 17.0% CPU',
      'Peaks in the last 10 min: no history yet',
      'Heaviest processes:',
      '  1. 300MB · 12.0% CPU · pid 40 · node server.js · detached',
      '  2. 30MB · 2.0% CPU · pid 41 · node worker · detached',
      '  3. 20MB · 1.0% CPU · pid 11 · cmd11',
      'Detached processes:',
      '  1. 300MB · 12.0% CPU · pid 40 · node server.js',
      '  2. 30MB · 2.0% CPU · pid 41 · node worker',
      'Marker: none',
      'Recent alerts: none',
    ].join('\n'),
  )
})

test('report: only detached processes, more than it lists', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ ...row(40 + i, 12 - i, 0), ppid: 1, detached: true as const }))
  const alone: Snapshot = { ...snapshot(many), detachedCount: 12, detachedKb: 78 * MB, detachedCpuPercent: 0 }
  const lines = reportText(input({ reading: { snapshot: alone } })).split('\n')
  expect(lines[1]).toBe('Now: Claude Code 484MB, 2.0% CPU · no child processes · 12 detached 78MB, 0.0% CPU · total 562MB, 2.0% CPU')
  expect(lines[9]).toBe('Detached processes (10 of 12):')
  expect(lines[19]).toBe('  10. 3MB · 0.0% CPU · pid 49 · cmd49')
  expect(lines[20]).toBe('Marker: none')
})

test('report: says when detached processes are not tracked', () => {
  const off: Snapshot = { ...snapshot([]), detachedOff: 'Detached processes are not tracked: the session mark could not be set.' }
  expect(reportText(input({ reading: { snapshot: off } })).split('\n').slice(1, 3)).toEqual([
    'Now: Claude Code 484MB, 2.0% CPU · no child processes',
    'Detached processes are not tracked: the session mark could not be set.',
  ])
})
