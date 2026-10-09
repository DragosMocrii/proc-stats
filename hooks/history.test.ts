import { expect, test } from 'claude-code/testing'

import { engine, MB, proc } from './fixtures'
import { averageSince, downsample, historyCapacity, MAX_POINTS, pointOf, pointSpacingMs, pushPoint, shouldRecord } from './history'
import { buildSnapshot } from './snapshot'
import type { Timed } from './snapshot'

const point = (t: number, memKb = 0, cpuPct = 0) => ({ t, memKb, cpuPct })

test('capacity covers the window at the interval', () => {
  expect(historyCapacity(10, 1000)).toBe(600)
  expect(historyCapacity(10, 2000)).toBe(300)
  expect(historyCapacity(1, 60_000)).toBe(2)
  expect(historyCapacity(120, 250)).toBe(2400)
  expect(MAX_POINTS).toBe(2400)
})

test('points are spaced to fit the capacity over the window', () => {
  expect(pointSpacingMs(10)).toBe(250)
  expect(pointSpacingMs(120)).toBe(3000)
})

test('record when empty, and only once the spacing has passed', () => {
  expect(shouldRecord({ points: [] }, point(5), 250)).toBe(true)
  expect(shouldRecord({ points: [point(1000)] }, point(1249), 250)).toBe(false)
  expect(shouldRecord({ points: [point(1000)] }, point(1250), 250)).toBe(true)
})

test('push appends to the empty default and keeps the newest past capacity', () => {
  let history = { points: [] as ReturnType<typeof point>[] }
  for (let t = 1; t <= 5; t++) history = pushPoint(history, point(t), 3, 1000)
  expect(history.points.map(p => p.t)).toEqual([3, 4, 5])
})

test('a smaller capacity after an interval change trims the oldest', () => {
  const history = { points: [point(1), point(2), point(3), point(4)] }
  expect(pushPoint(history, point(5), 2, 1000).points.map(p => p.t)).toEqual([4, 5])
})

test('points older than the window are dropped, the boundary kept', () => {
  const history = { points: [point(0), point(5000), point(10_000)] }
  expect(pushPoint(history, point(20_000), 10, 10_000).points.map(p => p.t)).toEqual([10_000, 20_000])
  expect(pushPoint({ points: [point(0), point(5000)] }, point(20_000), 10, 10_000).points.map(p => p.t)).toEqual([20_000])
})

test('the newest value survives when the bucket size is fractional', () => {
  const values = Array.from({ length: 15 }, (_, i) => (i === 14 ? 99 : i))
  const out = downsample(values, 11)
  expect(out).toHaveLength(11)
  expect(out[10]).toBe(99)
})

test('downsampling keeps each bucket maximum, so spikes survive', () => {
  expect(downsample([1, 9, 2, 3, 4, 1], 3)).toEqual([9, 3, 4])
  expect(downsample([1, 2], 5)).toEqual([1, 2])
  expect(downsample([], 5)).toEqual([])
  expect(downsample([5, 1, 1, 1, 1], 2)).toEqual([5, 1])
})

test('average over the window, and none from too little', () => {
  const points = [point(0, 0, 100), point(5000, 0, 200), point(10_000, 0, 300), point(15_000, 0, 400)]
  expect(averageSince(points, 15_000, 10_000, p => p.cpuPct)).toBe(300)
  expect(averageSince([], 15_000, 10_000, p => p.cpuPct)).toBeNull()
  expect(averageSince([point(15_000, 0, 50), point(15_000, 0, 150)], 15_000, 10_000, p => p.cpuPct)).toBe(100)
})

test('a point totals Claude Code and its children; none before CPU is measured', () => {
  const before: Timed = { engine, children: [proc(11, 10, { cpuSeconds: 1 })], wallMs: 0 }
  const now: Timed = {
    engine: { ...engine, cpuSeconds: 1.5 },
    children: [proc(11, 10, { rssKb: 16 * MB, cpuSeconds: 3.5, uptimeSeconds: 105 })],
    wallMs: 5000,
  }
  expect(pointOf(buildSnapshot('linux', 10, now, before), 5000)).toEqual({ t: 5000, memKb: 500 * MB, cpuPct: 60 })
  expect(pointOf(buildSnapshot('linux', 10, now, undefined), 5000)).toBeNull()
})

test('no point while the children are unknown, or their CPU is', () => {
  const before: Timed = { engine, children: [proc(11, 10, { cpuSeconds: 1 })], wallMs: 0 }
  const now: Timed = { engine: { ...engine, cpuSeconds: 1.5 }, children: undefined, wallMs: 5000 }
  expect(pointOf(buildSnapshot('linux', 10, now, before), 5000)).toBeNull()
  const first: Timed = { engine: { ...engine, cpuSeconds: 1.5 }, children: [], wallMs: 5000 }
  const firstWithTable = buildSnapshot('linux', 10, first, { engine, children: undefined, wallMs: 0 })
  expect(firstWithTable.childCpuPercent).toBeNull()
  expect(pointOf(firstWithTable, 5000)).toBeNull()
})

test('CPU is rounded to one decimal', () => {
  const snapshot = { ...buildSnapshot('linux', 10, { engine, children: [], wallMs: 0 }, undefined) }
  const measured = { ...snapshot, engine: { ...snapshot.engine, cpuPercent: 12.3456 }, childCpuPercent: 0.1 }
  expect(pointOf(measured, 1)?.cpuPct).toBe(12.4)
})
