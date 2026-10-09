import { expect, test } from 'claude-code/testing'

import { engine, MB, proc } from './fixtures'
import { averageSince, downsample, historyCapacity, pointOf, pushPoint } from './history'
import { buildSnapshot } from './snapshot'
import type { Timed } from './snapshot'

const point = (t: number, memKb = 0, cpuPct = 0) => ({ t, memKb, cpuPct })

test('capacity covers the window at the interval', () => {
  expect(historyCapacity(10, 1000)).toBe(600)
  expect(historyCapacity(10, 2000)).toBe(300)
  expect(historyCapacity(1, 60_000)).toBe(2)
})

test('push appends to the empty default and keeps the newest past capacity', () => {
  let history = { points: [] as ReturnType<typeof point>[] }
  for (let t = 1; t <= 5; t++) history = pushPoint(history, point(t), 3)
  expect(history.points.map(p => p.t)).toEqual([3, 4, 5])
})

test('a smaller capacity after an interval change trims the oldest', () => {
  const history = { points: [point(1), point(2), point(3), point(4)] }
  expect(pushPoint(history, point(5), 2).points.map(p => p.t)).toEqual([4, 5])
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
