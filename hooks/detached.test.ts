import { expect, test } from 'claude-code/testing'

import { candidatesOf, environHasMark, macMarkedPids, oursOf, rememberMarks, startedFrom, unreadOf } from './detached'
import type { MarkCache } from './detached'

const ID = 'abc-123'

test('Linux: the mark is one whole environment entry', () => {
  expect(environHasMark(`HOME=/root\0PROC_STATS_SESSION=${ID}\0PATH=/bin\0`, ID)).toBe(true)
  expect(environHasMark(`PROC_STATS_SESSION=other\0`, ID)).toBe(false)
  expect(environHasMark(`X=PROC_STATS_SESSION=${ID}\0`, ID)).toBe(false)
  expect(environHasMark('', ID)).toBe(false)
})

test('macOS: the pids whose ps eww line holds the mark as a word', () => {
  const stdout = [
    `  501 node server.js HOME=/Users/me PROC_STATS_SESSION=${ID} PATH=/bin`,
    `  502 sleep 60 PROC_STATS_SESSION=other`,
    `  503 grep PROC_STATS_SESSION=${ID}x`,
    '',
  ].join('\n')
  expect([...macMarkedPids(stdout, ID)]).toEqual([501])
})

test('candidates: started since the session (two seconds of slack), not excluded', () => {
  const started = [
    { pid: 1, startMs: 0 },
    { pid: 10, startMs: 9_000 },
    { pid: 11, startMs: 12_000 },
    { pid: 12, startMs: 12_000 },
    { pid: 13, startMs: 7_000 },
  ]
  expect(candidatesOf(started, new Set([12]), 10_000).map(each => each.pid)).toEqual([10, 11])
})

test('the cache: read once per process, a reused pid read again, ended ones dropped', () => {
  let cache: MarkCache = new Map()
  const first = [
    { pid: 20, startMs: 50_000 },
    { pid: 21, startMs: 50_000 },
  ]
  expect(unreadOf(cache, first).map(each => each.pid)).toEqual([20, 21])
  cache = rememberMarks(cache, first, [
    { pid: 20, startMs: 50_000, isOurs: true },
    { pid: 21, startMs: 50_000, isOurs: false },
  ])
  expect(oursOf(cache, first)).toEqual([20])
  // The start moves by a second between readings: still the same processes, nothing to read.
  const again = [
    { pid: 20, startMs: 51_000 },
    { pid: 21, startMs: 49_000 },
  ]
  expect(unreadOf(cache, again)).toEqual([])
  expect(oursOf(cache, again)).toEqual([20])
  // 21 ended; 20 now names a process started later.
  const later = [{ pid: 20, startMs: 90_000 }]
  expect(unreadOf(cache, later)).toEqual(later)
  expect(oursOf(cache, later)).toEqual([])
  cache = rememberMarks(cache, later, [])
  expect([...cache.keys()]).toEqual([])
})

test('started: each row placed by its elapsed time', () => {
  const rows = [
    ['10', '1', '01:05'],
    ['11', '10', '1-00:00:00'],
  ]
  expect(startedFrom(rows, 2, 100_000_000)).toEqual([
    { pid: 10, startMs: 100_000_000 - 65_000 },
    { pid: 11, startMs: 100_000_000 - 86_400_000 },
  ])
})
