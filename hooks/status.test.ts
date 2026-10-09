import { expect, test } from 'claude-code/testing'

import { engine, MB, proc } from './fixtures'
import { buildSnapshot } from './snapshot'
import type { Timed } from './snapshot'
import { statusLine } from './status'

test('status line: the + part only while processes run', () => {
  const before: Timed = { engine, children: [proc(5, 10, { rssKb: 15 * MB, cpuSeconds: 1 })], wallMs: 0 }
  const now: Timed = {
    engine: { ...engine, cpuSeconds: 1.5, uptimeSeconds: 65 },
    children: [proc(5, 10, { rssKb: 15 * MB, cpuSeconds: 3.5, uptimeSeconds: 105 })],
    wallMs: 5000,
  }
  expect(statusLine(buildSnapshot('linux', 10, now, before))).toBe(
    'mem (484 + 15)MB · peak 530MB · cpu (10.0 + 50.0)% · up 1m 5s',
  )
  expect(statusLine(buildSnapshot('linux', 10, { ...now, children: [] }, before))).toBe(
    'mem 484MB · peak 530MB · cpu 10.0% · up 1m 5s',
  )
  expect(statusLine(buildSnapshot('linux', 10, { ...now, children: undefined }, before))).toContain(
    'mem (484 + ?)MB',
  )
  expect(statusLine(buildSnapshot('linux', 10, { ...now, children: undefined }, before))).toContain(
    'cpu (10.0 + ?)%',
  )
  expect(statusLine(buildSnapshot('linux', 10, now, undefined))).toContain('cpu …')
})

test('status line without the children: Claude Code alone', () => {
  const before: Timed = { engine, children: [proc(5, 10, { rssKb: 15 * MB, cpuSeconds: 1 })], wallMs: 0 }
  const now: Timed = {
    engine: { ...engine, cpuSeconds: 1.5, uptimeSeconds: 65 },
    children: [proc(5, 10, { rssKb: 15 * MB, cpuSeconds: 3.5, uptimeSeconds: 105 })],
    wallMs: 5000,
  }
  expect(statusLine(buildSnapshot('linux', 10, now, before), false)).toBe(
    'mem 484MB · peak 530MB · cpu 10.0% · up 1m 5s',
  )
})
