import { expect, test } from 'claude-code/testing'

import type { Snapshot } from '../types'
import { cpuAverage, EMPTY_ALERTS, levelFor, markerFor, sessionLevels, worse } from './alerts'
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
  expect(cpuAverage(cpuPoints(0, 10_000, 1000, 100), 10_000)).toBe(100)
  expect(cpuAverage(cpuPoints(5000, 10_000, 5000, 200), 10_000)).toBe(200)
  expect(cpuAverage(cpuPoints(9000, 10_000, 1000, 100), 10_000)).toBeNull()
  expect(cpuAverage([{ t: 10_000, memKb: 0, cpuPct: 500 }], 10_000)).toBeNull()
  expect(cpuAverage([], 10_000)).toBeNull()
  // Points older than the window do not count toward it.
  expect(cpuAverage([...cpuPoints(0, 2000, 1000, 900), ...cpuPoints(12_000, 13_000, 1000, 100)], 13_000)).toBeNull()
})

test('session levels: memory from the current total, CPU from the average', () => {
  const levels = sessionLevels(snapshot(1000, 1100), cpuPoints(0, 10_000, 1000, 350), 10_000, DEFAULTS, EMPTY_ALERTS.levels)
  expect(levels).toEqual({ mem: 'warn', cpu: 'alert' })
})

test('without a CPU average the CPU level stays where it was', () => {
  const previous = { mem: 'none' as const, cpu: 'warn' as const }
  expect(sessionLevels(snapshot(100, 0), [], 10_000, DEFAULTS, previous)).toEqual({ mem: 'none', cpu: 'warn' })
})

test('an unreadable process table: memory from Claude Code alone', () => {
  const unknown = snapshot(3000, 0, { children: null, childCpuPercent: null })
  expect(sessionLevels(unknown, [], 10_000, DEFAULTS, EMPTY_ALERTS.levels).mem).toBe('warn')
})
