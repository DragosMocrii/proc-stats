import { expect, test } from 'claude-code/testing'

import type { ProcRow, ProcTrack, Snapshot } from '../types'
import { cpuAverage, EMPTY_ALERTS, levelFor, markerFor, sessionLevels, stepAlerts, toastText, trackProcesses, worse } from './alerts'
import { MB } from './fixtures'
import { DEFAULTS } from './settings'

const snapshot = (engineMb: number, childMb: number, extra: Partial<Snapshot> = {}): Snapshot => ({
  platform: 'linux',
  pid: 10,
  engine: { rssKb: engineMb * MB, peakKb: engineMb * MB, cpuPercent: 1, uptimeSeconds: 60 },
  children: [],
  childCount: 0,
  childKb: childMb * MB,
  childCpuPercent: 0,
  ...extra,
})

const cpuPoints = (from: number, to: number, stepMs: number, cpuPct: number) =>
  Array.from({ length: Math.floor((to - from) / stepMs) + 1 }, (_, i) => ({ t: from + i * stepMs, memKb: 0, cpuPct }))

test('levels rise above each limit, never at it', () => {
  expect(levelFor(2048, 2048, 4096, 'none')).toBe('none')
  expect(levelFor(2100, 2048, 4096, 'none')).toBe('warn')
  expect(levelFor(4100, 2048, 4096, 'none')).toBe('alert')
  expect(levelFor(4100, 2048, 4096, 'warn')).toBe('alert')
})

test('a level falls only 10% below its limit', () => {
  expect(levelFor(3900, 2048, 4096, 'alert')).toBe('alert')
  expect(levelFor(3600, 2048, 4096, 'alert')).toBe('warn')
  expect(levelFor(1900, 2048, 4096, 'warn')).toBe('warn')
  expect(levelFor(1800, 2048, 4096, 'warn')).toBe('none')
  expect(levelFor(1800, 2048, 4096, 'alert')).toBe('none')
})

test('the worse level, and its marker', () => {
  expect(worse('warn', 'alert')).toBe('alert')
  expect(worse('none', 'warn')).toBe('warn')
  expect(worse('none', 'none')).toBe('none')
  expect(markerFor('none')).toBe('')
  expect(markerFor('warn')).toBe('🟡 ')
  expect(markerFor('alert')).toBe('🔴 ')
})

test('a CPU average needs two points spanning half the window', () => {
  expect(cpuAverage(cpuPoints(0, 10_000, 1000, 100), 10_000, 1000)).toBe(100)
  expect(cpuAverage(cpuPoints(5000, 10_000, 5000, 200), 10_000, 1000)).toBe(200)
  expect(cpuAverage(cpuPoints(9000, 10_000, 1000, 100), 10_000, 1000)).toBeNull()
  expect(cpuAverage([{ t: 10_000, memKb: 0, cpuPct: 500 }], 10_000, 1000)).toBeNull()
  expect(cpuAverage([], 10_000, 1000)).toBeNull()
  // Points older than the window do not count toward it.
  // A slower refresh widens the window to two refreshes.
  expect(cpuAverage(cpuPoints(0, 30_000, 15_000, 120), 30_000, 15_000)).toBe(120)
  expect(cpuAverage([{ t: 20_000, memKb: 0, cpuPct: 1 }, { t: 30_000, memKb: 0, cpuPct: 1 }], 30_000, 15_000)).toBeNull()
  expect(cpuAverage(cpuPoints(0, 30_000, 15_000, 120), 30_000, 1000)).toBeNull()
  expect(cpuAverage([...cpuPoints(0, 2000, 1000, 900), ...cpuPoints(12_000, 13_000, 1000, 100)], 13_000, 1000)).toBeNull()
})

test('session levels: memory from the current total, CPU from the average', () => {
  const levels = sessionLevels(snapshot(1000, 1100), cpuPoints(0, 10_000, 1000, 350), 10_000, DEFAULTS, EMPTY_ALERTS.levels, 1000)
  expect(levels).toEqual({ mem: 'warn', cpu: 'alert' })
})

test('without a CPU average the CPU level stays where it was', () => {
  const previous = { mem: 'none' as const, cpu: 'warn' as const }
  expect(sessionLevels(snapshot(100, 0), [], 10_000, DEFAULTS, previous, 1000)).toEqual({ mem: 'none', cpu: 'warn' })
})

test('an unreadable process table: memory from Claude Code alone', () => {
  const unknown = snapshot(3000, 0, { children: null, childCpuPercent: null })
  expect(sessionLevels(unknown, [], 10_000, DEFAULTS, EMPTY_ALERTS.levels, 1000).mem).toBe('warn')
})

test('an unreadable process table: memory may rise, never fall', () => {
  const unknown = (engineMb: number) => snapshot(engineMb, 0, { children: null, childCpuPercent: null })
  const held = sessionLevels(unknown(1000), [], 10_000, DEFAULTS, { mem: 'alert', cpu: 'none' }, 1000)
  expect(held.mem).toBe('alert')
  expect(sessionLevels(unknown(3000), [], 10_000, DEFAULTS, EMPTY_ALERTS.levels, 1000).mem).toBe('warn')
})

const row = (pid: number, extra: Partial<ProcRow> = {}): ProcRow => ({
  pid,
  ppid: 10,
  depth: 0,
  command: `cmd${pid}`,
  rssKb: 10 * MB,
  cpuPercent: 0,
  uptimeSeconds: 100,
  ...extra,
})

// Readings of one process at the given times (ms) and CPU percents; the toasts fired at each.
const runCpu = (readings: [number, number][], start: Record<string, ProcTrack> = {}) => {
  let tracks = start
  return readings.map(([t, cpuPercent]) => {
    const step = trackProcesses(tracks, [row(5, { cpuPercent, uptimeSeconds: 100 + t / 1000 })], t, DEFAULTS)
    tracks = step.tracks
    return step.fired.map(fired => fired.kind)
  })
}

test('CPU: a toast after 60 s above the limit, not before', () => {
  expect(runCpu([[0, 100], [59_000, 100], [60_000, 100]])).toEqual([[], [], ['cpu']])
})

test('CPU: a dip above 90% of the limit keeps the timer; below it, restarts it', () => {
  expect(runCpu([[0, 100], [30_000, 85], [60_000, 100]])).toEqual([[], [], ['cpu']])
  expect(runCpu([[0, 100], [30_000, 80], [60_000, 100]])).toEqual([[], [], []])
})

test('CPU: once per process, again only after 10 s below 90% of the limit', () => {
  expect(
    runCpu([
      [0, 100],
      [60_000, 100],
      [61_000, 100],
      [70_000, 50],
      [80_000, 50],
      [81_000, 100],
      [141_000, 100],
    ]),
  ).toEqual([[], ['cpu'], [], [], [], [], ['cpu']])
})

const track = (extra: Partial<ProcTrack> = {}): ProcTrack => ({
  startMs: 0,
  cpuSince: 0,
  cpuFired: true,
  cpuCoolSince: null,
  memFired: true,
  memCoolSince: null,
  ...extra,
})

test('a reused pid is a new process: fresh tracker', () => {
  // Tracked start 0; this row started at 5000 - 2000 = 3000, more than 2 s later.
  const { tracks, fired } = trackProcesses({ 5: track() }, [row(5, { uptimeSeconds: 2, cpuPercent: 100 })], 5000, DEFAULTS)
  expect(fired).toEqual([])
  expect(tracks['5']).toEqual({ startMs: 3000, cpuSince: 5000, cpuFired: false, cpuCoolSince: null, memFired: false, memCoolSince: null })
})

test('a start within 2 s of the tracked one is the same process, start unchanged', () => {
  // uptime 4 s at now 5000 is a start of 1000; the tracked start stays 0.
  const { tracks } = trackProcesses({ 5: track() }, [row(5, { uptimeSeconds: 4, cpuPercent: 0 })], 5000, DEFAULTS)
  expect(tracks['5']?.startMs).toBe(0)
  expect(tracks['5']?.cpuFired).toBe(true)
})

test('an idle process has identical trackers between readings', () => {
  const first = trackProcesses({}, [row(5, { uptimeSeconds: 100 })], 100_000, DEFAULTS)
  const second = trackProcesses(first.tracks, [row(5, { uptimeSeconds: 101 })], 101_000, DEFAULTS)
  expect(second.tracks).toEqual(first.tracks)
})

test('a tracker from the older shape (no startMs) is replaced by a fresh one', () => {
  const old = { uptimeSeconds: 500, cpuSince: 0, cpuFired: true, cpuCoolSince: null, memFired: true, memCoolSince: null } as unknown as ProcTrack
  const { tracks } = trackProcesses({ 5: old }, [row(5, { uptimeSeconds: 600 })], 1000, DEFAULTS)
  expect(tracks['5']).toEqual({ startMs: -599_000, cpuSince: null, cpuFired: false, cpuCoolSince: null, memFired: false, memCoolSince: null })
})

test('a CPU reading that is null still checks memory and leaves the CPU timer', () => {
  const timer = track({ cpuSince: 500, cpuFired: false, memFired: false })
  const { tracks, fired } = trackProcesses({ 6: timer }, [row(6, { cpuPercent: null, rssKb: 2000 * MB, uptimeSeconds: 1 })], 1000, DEFAULTS)
  expect(fired.map(entry => entry.kind)).toEqual(['mem'])
  expect(tracks['6']?.cpuSince).toBe(500)
})

test('memory: once on passing the limit, again after 10 s below 90% of it', () => {
  let tracks: Record<string, ProcTrack> = {}
  const at = (t: number, mb: number) => {
    const step = trackProcesses(tracks, [row(6, { rssKb: mb * MB, uptimeSeconds: 100 + t / 1000 })], t, DEFAULTS)
    tracks = step.tracks
    return step.fired.map(fired => fired.kind)
  }
  expect([at(0, 1000), at(1000, 1025), at(2000, 1100), at(3000, 900), at(13_000, 900), at(14_000, 1100)]).toEqual([
    [],
    ['mem'],
    [],
    [],
    [],
    ['mem'],
  ])
})

test('ended processes leave the tracker', () => {
  const first = trackProcesses({}, [row(5), row(6)], 0, DEFAULTS)
  expect(Object.keys(trackProcesses(first.tracks, [row(6)], 1000, DEFAULTS).tracks)).toEqual(['6'])
})

test('toast text: one, several, and a long command', () => {
  const cpu = { kind: 'cpu' as const, pid: 5, command: 'cmd5', cpuPercent: 99.6, seconds: 60, limitKb: 0, limitPct: 90 }
  const mem = { kind: 'mem' as const, pid: 6, command: 'cmd6', cpuPercent: 0, seconds: 0, limitKb: 1024 * MB, limitPct: 0 }
  expect(toastText([])).toBeNull()
  expect(toastText([cpu])).toBe('cmd5 has used ~100% CPU for 1m 0s · pid 5 · /proc-stats')
  expect(toastText([mem])).toBe('cmd6 grew past 1.00GB · pid 6 · /proc-stats')
  expect(toastText([cpu, mem])).toBe('2 processes over limits: cmd5, cmd6 · /proc-stats')
  expect(toastText([cpu, { ...mem, pid: 5, command: 'cmd5' }])).toBe(
    'cmd5 has used ~100% CPU for 1m 0s · pid 5 · cmd5 grew past 1.00GB · pid 5 · /proc-stats',
  )
  const long = 'x'.repeat(60)
  expect(toastText([{ ...cpu, command: long }])).toBe(`${'x'.repeat(39)}… has used ~100% CPU for 1m 0s · pid 5 · /proc-stats`)
})

test('toast text: one line, whole code points, and a CPU figure never below the limit', () => {
  const cpu = { kind: 'cpu' as const, pid: 5, command: 'cmd5', cpuPercent: 85, seconds: 60, limitKb: 0, limitPct: 90 }
  expect(toastText([cpu])).toContain('~90%')
  expect(toastText([{ ...cpu, command: 'node  a\n  b' }])).toBe('node a b has used ~90% CPU for 1m 0s · pid 5 · /proc-stats')
  const emoji = `${'x'.repeat(38)}😀😀tail`
  const text = toastText([{ ...cpu, command: emoji }]) ?? ''
  expect(text.includes('\uFFFD')).toBe(false)
  expect(text.startsWith(`${'x'.repeat(38)}😀… has`)).toBe(true)
})

test('stepAlerts: the first reading and an unreadable table never toast, and keep the trackers', () => {
  const fired: ProcTrack = { startMs: 0, cpuSince: null, cpuFired: false, cpuCoolSince: null, memFired: false, memCoolSince: null }
  const state = { levels: EMPTY_ALERTS.levels, tracks: { 6: fired } }
  const big = [row(6, { rssKb: 2000 * MB })]
  // childKb 0 keeps the memory level at none, so the assertion is about toasts and trackers.
  const first = snapshot(100, 0, { children: big, childCount: 1, engine: { rssKb: 100 * MB, peakKb: 100 * MB, cpuPercent: null, uptimeSeconds: 1 } })
  expect(stepAlerts(state, first, [], 1000, DEFAULTS, 1000)).toEqual({ state, toast: null })
  const unknown = snapshot(100, 0, { children: null, childCpuPercent: null })
  expect(stepAlerts(state, unknown, [], 1000, DEFAULTS, 1000).toast).toBeNull()
  expect(stepAlerts(state, unknown, [], 1000, DEFAULTS, 1000).state.tracks).toEqual(state.tracks)
})

test('stepAlerts: a toast once, and not again after a reload restores the state', () => {
  const big = snapshot(100, 2000, { children: [row(6, { rssKb: 2000 * MB })], childCount: 1 })
  const once = stepAlerts(EMPTY_ALERTS, big, [], 1000, DEFAULTS, 1000)
  expect(once.toast).toBe('cmd6 grew past 1.00GB · pid 6 · /proc-stats')
  // The state round-trips through $.state as plain data.
  const restored = JSON.parse(JSON.stringify(once.state))
  expect(stepAlerts(restored, big, [], 2000, DEFAULTS, 1000).toast).toBeNull()
  expect(once.state.levels.mem).toBe('warn')
})
