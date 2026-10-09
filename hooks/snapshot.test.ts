import { expect, test } from 'claude-code/testing'

import { engine, MB, proc } from './fixtures'
import { buildSnapshot, forestOrder, procCpu, treeOrder } from './snapshot'
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

test('children unreadable now: their CPU is unknown, not zero', () => {
  const before: Timed = { engine, children: [proc(11, 10, { cpuSeconds: 1 })], wallMs: 0 }
  const now: Timed = { engine: { ...engine, cpuSeconds: 1.5 }, children: undefined, wallMs: 5000 }
  expect(buildSnapshot('linux', 10, now, before).childCpuPercent).toBeNull()
})

test('process CPU: first seen late, its average over its life, and the share in this window', () => {
  expect(procCpu(proc(7, 1, { cpuSeconds: 12, uptimeSeconds: 12 }), undefined, 2)).toEqual({ delta: 2, percent: 100 })
})

test('snapshot: a detached process found late is not charged its whole life in one reading', () => {
  const before: Timed = { engine, children: [], detached: [], wallMs: 0 }
  const now: Timed = { engine, children: [], detached: [proc(41, 1, { cpuSeconds: 12, uptimeSeconds: 12 })], wallMs: 2000 }
  const snapshot = buildSnapshot('linux', 10, now, before)
  expect(snapshot.children?.map(row => [row.pid, row.cpuPercent])).toEqual([[41, 100]])
  expect(snapshot.detachedCpuPercent).toBe(100)
})

test('forest order: each process whose parent is not among them is a root', () => {
  const ordered = forestOrder([proc(42, 40), proc(41, 1), proc(43, 1), proc(44, 41)])
  expect(ordered.map(({ proc, depth }) => [proc.pid, proc.ppid, depth])).toEqual([
    [41, 1, 0],
    [44, 41, 1],
    [42, 40, 0],
    [43, 1, 0],
  ])
})

test('snapshot: detached processes follow the tree, marked, with their own subtotal inside the totals', () => {
  const before: Timed = { engine, children: [proc(11, 10)], detached: [proc(41, 1, { cpuSeconds: 1 })], wallMs: 0 }
  const now: Timed = {
    engine,
    children: [proc(11, 10)],
    detached: [proc(41, 1, { cpuSeconds: 2, uptimeSeconds: 105 }), proc(44, 41, { rssKb: 5 * MB, uptimeSeconds: 3 })],
    wallMs: 5000,
  }
  const snapshot = buildSnapshot('linux', 10, now, before)
  expect(snapshot.children?.map(row => [row.pid, row.depth, row.detached ?? false, row.cpuPercent])).toEqual([
    [11, 0, false, 0],
    [41, 0, true, 20],
    [44, 1, true, 0],
  ])
  expect([snapshot.childCount, snapshot.childKb, snapshot.childCpuPercent]).toEqual([3, 25 * MB, 20])
  expect([snapshot.detachedCount, snapshot.detachedKb, snapshot.detachedCpuPercent]).toEqual([2, 15 * MB, 20])
})

test('snapshot: none detached, or the table unreadable: an empty subtotal', () => {
  const now: Timed = { engine, children: [proc(11, 10)], wallMs: 5000 }
  const quiet = buildSnapshot('linux', 10, now, { engine, children: [proc(11, 10)], wallMs: 0 })
  expect([quiet.detachedCount, quiet.detachedKb, quiet.detachedCpuPercent]).toEqual([0, 0, 0])
  const unread = buildSnapshot('linux', 10, { engine, children: undefined, detached: [proc(41, 1)], wallMs: 5000 }, undefined)
  expect([unread.children, unread.detachedCount, unread.detachedCpuPercent]).toEqual([null, 0, null])
})
