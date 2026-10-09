import { expect, test } from 'claude-code/testing'

import { engine, MB, proc } from './fixtures'
import { buildSnapshot, procCpu, treeOrder } from './snapshot'
import type { Timed } from './snapshot'

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
