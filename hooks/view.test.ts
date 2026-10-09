import { expect, test } from 'claude-code/testing'

import type { PaneState, Snapshot } from '../types'
import { engine, MB, proc } from './fixtures'
import { buildSnapshot } from './snapshot'
import type { Timed } from './snapshot'
import {
  cycleSort,
  detailLines,
  EMPTY_PANE,
  fit,
  isSelected,
  labelOf,
  noteLine,
  oneLine,
  pruneState,
  toggleCollapsed,
  totalLines,
  treePrefixes,
  unwrapCommand,
  viewRows,
} from './view'

const wrap = (inner: string) =>
  `/bin/bash -c source /home/u/.claude/shell-snapshots/snapshot-bash-1-abc.sh 2>/dev/null || true && shopt -u extglob 2>/dev/null || true && eval '${inner}' < /dev/null && pwd -P >| /tmp/claude-1-cwd`

test('rows carry their start time', () => {
  const snapshot = buildSnapshot('linux', 10, { engine, children: [proc(11, 10, { uptimeSeconds: 100 })], wallMs: 500_000 }, undefined)
  expect(snapshot.children?.[0]?.startMs).toBe(400_000)
})

test('the command inside Claude Code\'s Bash wrapper', () => {
  expect(unwrapCommand(wrap('npm test'))).toBe('npm test')
  expect(unwrapCommand(wrap(`echo '"'"'hi'"'"'`))).toBe("echo 'hi'")
  expect(unwrapCommand('python3 -c x')).toBeNull()
  expect(unwrapCommand("bash -c eval 'x'")).toBeNull()
  expect(unwrapCommand(wrap('unterminated').replace(/' < \/dev\/null.*$/, ''))).toBeNull()
})

test('labels: the command you ran, on one line', () => {
  expect(labelOf(wrap('npm   test\n  --watch'))).toBe('$ npm test --watch')
  expect(labelOf('python3  -c\nx')).toBe('python3 -c x')
  expect(oneLine('  a\t b \n')).toBe('a b')
})

test('cells are cut with … and padded, by code points', () => {
  expect(fit('abc', 5)).toBe('abc  ')
  expect(fit('abc', 5, true)).toBe('  abc')
  expect(fit('abcdef', 4)).toBe('abc…')
  expect(fit('ab😀cd', 4)).toBe('ab😀…')
  expect(fit('abc', 3)).toBe('abc')
})

// Claude Code 10 → 11 (a Bash wrapper) → 12 (python) and 13; 10 → 20 (sleep).
const tree = (cpu: (pid: number) => number = () => 0) => {
  const before: Timed = {
    engine,
    children: [proc(11, 10), proc(12, 11), proc(13, 11), proc(20, 10)],
    wallMs: 0,
  }
  const now: Timed = {
    engine: { ...engine, cpuSeconds: 1.5 },
    children: [
      proc(11, 10, { command: wrap('npm test'), rssKb: 4 * MB, cpuSeconds: cpu(11) * 5 / 100, uptimeSeconds: 105 }),
      proc(12, 11, { command: 'python3 -c x', rssKb: 200 * MB, cpuSeconds: cpu(12) * 5 / 100, uptimeSeconds: 105 }),
      proc(13, 11, { command: 'node worker', rssKb: 50 * MB, cpuSeconds: cpu(13) * 5 / 100, uptimeSeconds: 103 }),
      proc(20, 10, { command: 'sleep 30', rssKb: 1 * MB, cpuSeconds: cpu(20) * 5 / 100, uptimeSeconds: 10 }),
    ],
    wallMs: 5000,
  }
  return buildSnapshot('linux', 10, now, before)
}

const state = (extra: Partial<PaneState> = {}): PaneState => ({ ...EMPTY_PANE, ...extra })

test('tree view: labels, tree lines, children', () => {
  const rows = viewRows(tree(), state())
  expect(rows.map(view => [view.row.pid, view.prefix + view.label, view.hasChildren])).toEqual([
    [11, '├ $ npm test', true],
    [12, '│ ├ python3 -c x', false],
    [13, '│ └ node worker', false],
    [20, '└ sleep 30', false],
  ])
})

test('a collapsed command hides its processes and sums them', () => {
  const rows = viewRows(tree(pid => (pid === 12 ? 50 : 10)), state({ collapsed: [11] }))
  expect(rows.map(view => view.row.pid)).toEqual([11, 20])
  expect(rows[0]?.isCollapsed).toBe(true)
  expect(rows[0]?.rssKb).toBe(254 * MB)
  expect(rows[0]?.cpuPercent).toBe(70)
  expect(rows[1]?.prefix).toBe('└ ')
})

test('sorted views are flat, highest first, with the parent named', () => {
  const byCpu = viewRows(tree(pid => ({ 11: 1, 12: 90, 13: 30, 20: 0 })[pid] ?? 0), state({ sort: 'cpu' }))
  expect(byCpu.map(view => [view.row.pid, view.prefix, view.parent])).toEqual([
    [12, '', '$ npm test'],
    [13, '', '$ npm test'],
    [11, '', 'Claude Code'],
    [20, '', 'Claude Code'],
  ])
  expect(viewRows(tree(), state({ sort: 'mem' })).map(view => view.row.pid)).toEqual([12, 13, 11, 20])
  expect(viewRows(tree(), state({ sort: 'time' })).map(view => view.row.pid)).toEqual([11, 12, 13, 20])
  // A collapse does not apply to a sorted view.
  expect(viewRows(tree(), state({ sort: 'mem', collapsed: [11] })).length).toBe(4)
})

test('sort cycles tree → cpu → mem → time → tree; collapse toggles', () => {
  expect(['tree', 'cpu', 'mem', 'time'].map(sort => cycleSort(sort as PaneState['sort']))).toEqual(['cpu', 'mem', 'time', 'tree'])
  expect(toggleCollapsed([11], 20)).toEqual([11, 20])
  expect(toggleCollapsed([11, 20], 11)).toEqual([20])
})

test('selection holds through a second of start-time jitter, not a reused pid', () => {
  expect(isSelected({ pid: 12, startMs: 1000 }, { pid: 12, startMs: 1800 })).toBe(true)
  expect(isSelected({ pid: 12, startMs: 5000 }, { pid: 12, startMs: 1000 })).toBe(false)
  expect(isSelected({ pid: 13, startMs: 1000 }, { pid: 12, startMs: 1000 })).toBe(false)
  expect(isSelected({ pid: 12, startMs: 1000 }, null)).toBe(false)
})

test('pruning forgets ended processes, keeps Claude Code and stops in flight', () => {
  const snapshot = tree()
  const python = snapshot.children!.find(row => row.pid === 12)!
  const kept = state({ selected: { pid: 12, startMs: python.startMs }, collapsed: [11, 99] })
  expect(pruneState(kept, snapshot)).toEqual({ ...kept, collapsed: [11] })
  expect(pruneState(state({ selected: { pid: 99, startMs: 0 } }), snapshot).selected).toBeNull()
  expect(pruneState(state({ selected: { pid: 10, startMs: 0 } }), snapshot).selected).toEqual({ pid: 10, startMs: 0 })
  const sent = { pid: 99, startMs: 0, label: 'gone', pids: [99], phase: 'sent' as const }
  expect(pruneState(state({ stop: sent }), snapshot).stop).toEqual(sent)
  expect(pruneState(state({ stop: { ...sent, phase: 'confirm' } }), snapshot).stop).toBeNull()
  const unknown: Snapshot = { ...snapshot, children: null }
  expect(pruneState(kept, unknown)).toEqual(kept)
})

test('details of the selected row: the full command, then its facts', () => {
  const snapshot = tree()
  const python = snapshot.children!.find(row => row.pid === 12)!
  const lines = detailLines(snapshot, { pid: 12, startMs: python.startMs })
  expect(lines?.[0]).toBe('python3 -c x')
  expect(lines?.[1]).toContain('pid 12 · parent 11 ($ npm test)')
  expect(lines?.[1]).toContain('200MB')
  expect(lines?.[1]).toContain('up 1m 45s')
  expect(/started \d\d:\d\d:\d\d/.test(lines?.[1] ?? '')).toBe(true)
  expect(detailLines(snapshot, { pid: 10, startMs: 0 })?.[0]).toContain('Claude Code · pid 10')
  expect(detailLines(snapshot, null)).toBeNull()
  expect(detailLines(snapshot, { pid: 99, startMs: 0 })).toBeNull()
})

test('totals and notes', () => {
  const snapshot = tree()
  expect(totalLines(snapshot).map(line => line.label)).toEqual(['Child processes (4)', 'Total'])
  expect(noteLine(snapshot)).toBeNull()
  expect(noteLine({ ...snapshot, children: [], childCount: 0 })).toBe('No child processes')
  expect(totalLines({ ...snapshot, children: [], childCount: 0 })).toEqual([])
  expect(noteLine({ ...snapshot, children: null })).toBe('Child process list unavailable')
  expect(noteLine({ ...snapshot, childCount: 6 })).toBe('… 2 more')
})

test('tree lines: a branch per sibling, a rail under ancestors with more to come', () => {
  expect(treePrefixes([0, 1, 2, 1, 0, 1].map(depth => ({ depth })))).toEqual(['├ ', '│ ├ ', '│ │ └ ', '│ └ ', '└ ', '  └ '])
})

test('a stuck stop clears when none of its processes is listed; sent and forced stay', () => {
  const snapshot = tree()
  const stop = { pid: 99, startMs: 0, label: 'gone', pids: [99, 98], phase: 'stuck' as const }
  expect(pruneState(state({ stop }), snapshot).stop).toBeNull()
  expect(pruneState(state({ stop: { ...stop, pids: [99, 12] } }), snapshot).stop).toEqual({ ...stop, pids: [99, 12] })
  const forced = { ...stop, phase: 'forced' as const }
  expect(pruneState(state({ stop: forced }), snapshot).stop).toEqual(forced)
})

test('a parent missing from the rows is named by its pid, in details and sorted views', () => {
  const snapshot = tree()
  const orphaned: Snapshot = { ...snapshot, children: snapshot.children!.filter(row => row.pid !== 11) }
  const python = orphaned.children!.find(row => row.pid === 12)!
  expect(detailLines(orphaned, { pid: 12, startMs: python.startMs })?.[1]).toContain('parent 11 (pid 11)')
  const sorted = viewRows(orphaned, state({ sort: 'mem' }))
  expect(sorted.find(view => view.row.pid === 12)?.parent).toBe('pid 11')
})

test('a collapsed row whose subtree runs to the end of the list', () => {
  const snapshot = tree(pid => (pid === 12 ? 50 : 10))
  const byPid = (pid: number) => snapshot.children!.find(row => row.pid === pid)!
  const reordered: Snapshot = { ...snapshot, children: [byPid(20), byPid(11), byPid(12), byPid(13)] }
  const rows = viewRows(reordered, state({ collapsed: [11] }))
  expect(rows.map(view => view.row.pid)).toEqual([20, 11])
  expect(rows[1]?.isCollapsed).toBe(true)
  expect(rows[1]?.rssKb).toBe(254 * MB)
  expect(rows[1]?.cpuPercent).toBe(70)
})
