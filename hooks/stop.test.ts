import { expect, test } from 'claude-code/testing'

import type { Snapshot, StopState } from '../types'
import { engine, proc, statLine } from './fixtures'
import { buildSnapshot } from './snapshot'
import {
  aliveFrom,
  confirmText,
  isAlreadyEnded,
  killArgv,
  linuxObserved,
  macLivenessArgv,
  outcomeText,
  parseMacLiveness,
  parseWindowsLiveness,
  stopTargets,
  windowsLivenessScript,
} from './stop'

// Claude Code 10 → 11 → 12 → 14, 11 → 13; 10 → 20.
const snapshot = (): Snapshot =>
  buildSnapshot(
    'linux',
    10,
    {
      engine,
      children: [proc(11, 10), proc(12, 11), proc(14, 12), proc(13, 11), proc(20, 10, { command: 'sleep 30' })],
      wallMs: 100_000,
    },
    undefined,
  )

const at = (pid: number) => {
  const row = snapshot().children!.find(each => each.pid === pid)!

  return { pid, startMs: row.startMs }
}

test('a process and what it started, deepest first', () => {
  expect(stopTargets(snapshot(), at(11))).toEqual([14, 12, 13, 11])
  expect(stopTargets(snapshot(), at(20))).toEqual([20])
})

test('never Claude Code, an ended process, or a reused pid', () => {
  expect(stopTargets(snapshot(), { pid: 10, startMs: 0 })).toBeNull()
  expect(stopTargets(snapshot(), { pid: 99, startMs: 0 })).toBeNull()
  expect(stopTargets(snapshot(), { pid: 20, startMs: at(20).startMs - 10_000 })).toBeNull()
})

test('kill commands per platform', () => {
  expect(killArgv('linux', [14, 12, 11], false)).toEqual(['kill', '-TERM', '14', '12', '11'])
  expect(killArgv('mac', [11], true)).toEqual(['kill', '-KILL', '11'])
  expect(killArgv('windows', [14, 12, 11], false)).toEqual(['taskkill', '/T', '/PID', '11'])
  // Forcing names each survivor: one left outside the tree is not reached from the root.
  expect(killArgv('windows', [14, 11], true)).toEqual(['taskkill', '/T', '/F', '/PID', '14', '/PID', '11'])
})


const stop = (pids: number[], label = '$ npm test'): StopState => ({ pid: 11, startMs: 0, label, pids, starts: pids.map(() => 0), checks: 0, phase: 'confirm' })

test('confirmation and outcome texts', () => {
  expect(confirmText(stop([14, 12, 13, 11]))).toBe('Stop $ npm test (pid 11) and the 3 processes it started?')
  expect(confirmText(stop([12, 11]))).toBe('Stop $ npm test (pid 11) and the 1 process it started?')
  expect(confirmText(stop([11], 'sleep 30'))).toBe('Stop sleep 30 (pid 11)?')
  expect(outcomeText(stop([12, 11]), [])).toBe('Stopped $ npm test (pid 11) · /proc-stats')
  expect(outcomeText(stop([14, 12, 13, 11]), [14, 11])).toBe('$ npm test (pid 11): 2 of 4 processes still running · /proc-stats')
  expect(confirmText(stop([11], 'x'.repeat(80)))).toBe(`Stop ${'x'.repeat(47)}… (pid 11)?`)
})

test('alive: observed with the start recorded, within the tolerance; a reused pid is not', () => {
  const targets = [
    { pid: 14, startMs: 50_000 },
    { pid: 12, startMs: 40_000 },
    { pid: 11, startMs: 30_000 },
  ]
  expect(aliveFrom(targets, [{ pid: 11, startMs: 31_500 }, { pid: 14, startMs: 50_000 }])).toEqual([14, 11])
  expect(aliveFrom(targets, [{ pid: 12, startMs: 90_000 }])).toEqual([])
  expect(aliveFrom(targets, [])).toEqual([])
})


test('Linux liveness: the start from stat and uptime, as the readings place it; a zombie is gone', () => {
  // Booted 1000 s before wall 2_000_000; started 900 s after boot → 1_900_000.
  expect(linuxObserved(12, statLine(12, 'S', 90_000), '1000.00 5.00', 2_000_000)).toEqual({ pid: 12, startMs: 1_900_000 })
  expect(linuxObserved(12, statLine(12, 'Z', 90_000), '1000.00 5.00', 2_000_000)).toBeNull()
})

test('macOS liveness: ps pid and etime per line; nothing for pids it does not list', () => {
  expect(macLivenessArgv([14, 11])).toEqual(['ps', '-o', 'pid=,etime=', '-p', '14,11'])
  expect(parseMacLiveness('   14      01:40\n   11 1-00:00:10\n', 100_000_000)).toEqual([
    { pid: 14, startMs: 99_900_000 },
    { pid: 11, startMs: 100_000_000 - 86_410_000 },
  ])
  expect(parseMacLiveness('', 1000)).toEqual([])
})

test('Windows liveness: one pid and age per line, invariant culture', () => {
  const script = windowsLivenessScript([14, 11])
  expect(script).toContain('Get-Process -Id 14,11 -ErrorAction SilentlyContinue')
  expect(script).toContain('InvariantCulture')
  expect(parseWindowsLiveness('14 100\r\n11 5\r\n', 1_000_000)).toEqual([
    { pid: 14, startMs: 900_000 },
    { pid: 11, startMs: 995_000 },
  ])
  expect(parseWindowsLiveness('garbage\n', 1000)).toEqual([])
})

test('a failure that only says the process already ended is none', () => {
  expect(isAlreadyEnded('kill: (12): No such process\nkill: (11): No such process\n')).toBe(true)
  expect(isAlreadyEnded('ERROR: The process "12" not found.\r\n')).toBe(true)
  expect(isAlreadyEnded('kill: (12): No such process\nkill: (11): Operation not permitted')).toBe(false)
  expect(isAlreadyEnded('')).toBe(false)
})
