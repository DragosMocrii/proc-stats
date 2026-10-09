import { expect, test } from 'claude-code/testing'

import type { Snapshot, StopState } from '../types'
import { engine, proc } from './fixtures'
import { buildSnapshot } from './snapshot'
import { confirmText, killArgv, outcomeText, stillListed, stopTargets } from './stop'

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
  expect(killArgv('windows', [14, 12, 11], true)).toEqual(['taskkill', '/T', '/F', '/PID', '11'])
})

test('what is still listed', () => {
  expect(stillListed(snapshot(), [14, 99, 11])).toEqual([14, 11])
  expect(stillListed({ ...snapshot(), children: null }, [14])).toEqual([14])
})

const stop = (pids: number[], label = '$ npm test'): StopState => ({ pid: 11, startMs: 0, label, pids, phase: 'confirm' })

test('confirmation and outcome texts', () => {
  expect(confirmText(stop([14, 12, 13, 11]))).toBe('Stop $ npm test (pid 11) and the 3 processes it started?')
  expect(confirmText(stop([12, 11]))).toBe('Stop $ npm test (pid 11) and the 1 process it started?')
  expect(confirmText(stop([11], 'sleep 30'))).toBe('Stop sleep 30 (pid 11)?')
  expect(outcomeText(stop([12, 11]), [])).toBe('Stopped $ npm test (pid 11) · /proc-stats')
  expect(outcomeText(stop([14, 12, 13, 11]), [14, 11])).toBe('$ npm test (pid 11): 2 of 4 processes still running · /proc-stats')
  expect(confirmText(stop([11], 'x'.repeat(80)))).toBe(`Stop ${'x'.repeat(47)}… (pid 11)?`)
})
