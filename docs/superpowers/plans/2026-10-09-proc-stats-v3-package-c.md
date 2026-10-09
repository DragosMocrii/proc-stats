# proc-stats v0.3, package C: pane interaction

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Processes pane a task manager you act in: select a row (arrows, Enter or a click), see its full command and details, sort by CPU, memory or runtime, see Bash commands as the command you ran and collapse them, and stop a process and what it started, with a confirmation and a force stop.

**Architecture:** Two new pure modules: `view.ts` (labels, cell fitting, tree or sorted rows with collapsing, selection, details, pruning) and `stop.ts` (stop targets with the reused-pid guard, kill commands, texts). The pane's own state (`sort`, `collapsed`, `selected`, `stop`) lives in `$.state` as `pane`. `pane.tsx` draws rows as plain keyed Buttons and takes press handlers as plain callbacks; `register.ts` builds those callbacks (every `$` call stays there), selects on `ui.focus`, and runs the kill.

**Tech Stack:** TypeScript Claude Code mod (hooks module, `claude-code` API), tests with `claude-code/testing` under `claude plugin test`, type-check with `tsc` 5.9.3.

**Spec:** `docs/superpowers/specs/2026-10-09-proc-stats-v3-design.md` (sections Constraints from the mod API, Pane: Layout, Rows, Selection, Keys, Command rows, Stopping, Detail area, Reopening; Errors). Origin labels (`· Bash`), the Detached group and sparklines are packages E and D, not this one.

## Global Constraints

- The repository is `/home/vscode/proc-stats`, on the branch the controller names. Commit after each task. Do not push. Do not touch `/home/vscode/.claude/dev-mods/`.
- `$` may not be passed into a function imported from another file. Callbacks that close over `$` may be built in `register.ts` and passed in (checked with `claude plugin validate` before planning); `view.ts`, `stop.ts` and `pane.tsx` never receive `$`.
- Every `$.state` value is declared in `types/index.d.ts` under `PluginState['proc-stats']`; a state reference is a `const` object literal `{ plugin: 'proc-stats', key: '<key>' } as const` used only for `$.state` calls and the state library.
- A hook on a gating event (`ui.focus`, `command.run`, `ui.close`) is registered with `.catch(...)` (the validator warns otherwise).
- A Button holds only strings and `Text` children (never `Box`, never `null`/`false`); a Button with such children needs a `key`. Rows are `plain` Buttons keyed `pid:<pid>`.
- Commands, run from the repository root: tests `claude plugin test .`; validate `claude plugin validate .` (ends `✔ Validation passed`, no warnings); type-check `npx -y -p typescript@5.9.3 tsc -p .`.
- Tests use only `toBe / toEqual / toBeNull / toBeDefined / toBeUndefined / toContain / toThrow / toBeGreaterThan`; assert exact values.
- From the spec, verbatim: Keys: ↑/↓ move between rows (the focus ring); Enter or a click selects, and on a command row also expands or collapses; `s` sorts tree → CPU → memory → runtime → tree; `k` stops the selected process; Esc cancels a confirmation, else returns to the prompt. Sorted views are flat, with the parent's command dim after each row. A Bash wrapper row shows its real command, `$ npm test`; it starts expanded; collapsed, it shows its subtree's total memory and CPU. `k` turns the footer into `Stop <command> (pid <pid>) and the <n> processes it started? [y] Stop  [n] Cancel`. `y` sends SIGTERM to the process's descendants (deepest first) and then to the process (Windows: `taskkill /T /PID`). After 3 s, if any are still listed, the footer offers `[f] Force stop` (SIGKILL; Windows `taskkill /F /T`). A pid is acted on only while the latest reading lists it with the same start time. The Claude Code row cannot be stopped. A toast reports the outcome. Detail area: the full command line wrapped, pid, parent, start time, memory and CPU of the selected row (origin arrives in package E).
- Ruling recorded in the plan: Esc is the engine's key (it returns the keyboard to the prompt and the plugin cannot see it), so a confirmation is also cancelled when the focus ring leaves the pane (`ui.focus` with no `element`), which is what Esc does.
- Ruling recorded in the plan: `/proc-stats` opens the pane with `focus: true` (the engine grants it only over an empty prompt), so the keys work at once; the reopen after a reload stays unfocused.

## Review Focus

- **A pid reused between selecting and pressing `y`** (the selected process ended and another took its pid): nothing is stopped and a toast says the process is no longer listed. Pinned in Task 3 (`stopTargets` start-time guard) and Task 5 (the handler re-checks at `y`).
- **Selection across readings**: a selected process keeps its selection while its computed start time jitters by up to a second between readings, and loses it when it ends. Pinned in Task 2 (`isSelected`, `pruneState`).
- **Collapsing a command whose processes come and go**: the collapsed totals always sum the subtree as it is now; a collapsed pid that ended leaves the collapsed list. Pinned in Task 2.
- **The Bash wrapper's quoting**: a command containing single quotes (`'"'"'`) or newlines is shown as typed, on one line. Pinned in Task 1.
- **The Claude Code row**: it can be selected and shows details, but `k` is not offered for it and `stopTargets` refuses it. Pinned in Tasks 3 and 4.

---

## File structure after this package

| File | Change |
|---|---|
| `types/index.d.ts` | `ProcRow.startMs`; `SortMode`, `Selected`, `StopState`, `PaneState`; state contract gains `pane` |
| `hooks/snapshot.ts` | rows carry `startMs` |
| `hooks/view.ts` | **new**: `unwrapCommand`, `labelOf`, `oneLine`, `fit`, `treePrefixes` (moved from pane.tsx), `viewRows`, `ViewRow`, `isSelected`, `cycleSort`, `toggleCollapsed`, `pruneState`, `detailLines`, `totalLines`, `EMPTY_PANE` |
| `hooks/stop.ts` | **new**: `stopTargets`, `stillListed`, `killArgv`, `confirmText`, `outcomeText`, `STOP_CHECK_MS` |
| `hooks/pane.tsx` | rewritten: rows as Buttons, detail area, footer; takes `PaneState` and `PaneHandlers` |
| `hooks/register.ts` | `pane` state, handlers, `ui.focus` selection, pruning per reading, stop flow, `/proc-stats` opens focused |
| `hooks/view.test.ts`, `hooks/stop.test.ts` | **new** |
| `hooks/pane.test.ts` | rewritten for the new drawing |
| `hooks/alerts.test.ts` | its `row()` helper gains `startMs` |
| `README.md`, `.claude-plugin/plugin.json` | Pane keys; version 0.2.3 |

---

### Task 1: Start times, command labels and cell fitting

**Files:**
- Modify: `types/index.d.ts` (`ProcRow`), `hooks/snapshot.ts` (`buildSnapshot`), `hooks/alerts.test.ts` (`row()` helper)
- Create: `hooks/view.ts`, `hooks/view.test.ts`

**Interfaces:**
- Produces: `ProcRow.startMs: number` (ms since the epoch, `Math.round(now.wallMs - uptimeSeconds * 1000)`); in `view.ts`: `oneLine(text: string): string`, `unwrapCommand(command: string): string | null`, `labelOf(command: string): string`, `fit(text: string, width: number, alignRight?: boolean): string`.

- [ ] **Step 1: Add `startMs` to `ProcRow`** in `types/index.d.ts`, after `uptimeSeconds`:

```ts
  // When it started, in ms since the epoch: the reading's time less its runtime, so it can move by a second between readings.
  startMs: number
```

In `hooks/snapshot.ts`, in `buildSnapshot`'s row mapping, add after `uptimeSeconds: proc.uptimeSeconds,`:

```ts
          startMs: Math.round(now.wallMs - proc.uptimeSeconds * 1000),
```

In `hooks/alerts.test.ts`, in the `row()` helper's object, add `startMs: 0,` after `uptimeSeconds: 100,`.

Run: `npx -y -p typescript@5.9.3 tsc -p .` → no output. Run: `claude plugin test .` → `66 pass`.

- [ ] **Step 2: Write the failing tests** in `hooks/view.test.ts`

```ts
import { expect, test } from 'claude-code/testing'

import { engine, proc } from './fixtures'
import { buildSnapshot } from './snapshot'
import { fit, labelOf, oneLine, unwrapCommand } from './view'

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
```

- [ ] **Step 3: Run to see them fail**

Run: `claude plugin test . 2>&1 | grep -E "view|^\(fail\)| pass| fail"`
Expected: the view test file fails to load (`./view` not found); 66 pass.

- [ ] **Step 4: Write `hooks/view.ts`**

```ts
// The pane's rows as text: labels, cells, tree or sorted order, collapsing, selection and details.

// Whitespace runs, newlines included, become one space.
export const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

const EVAL = " && eval '"

// Claude Code runs a Bash command as `bash -c source <…/shell-snapshots/…> … && eval '<command>' < /dev/null && …`,
// a `'` inside written `'"'"'`. The command, or null for any other process.
export const unwrapCommand = (command: string): string | null => {
  const start = command.indexOf(EVAL)
  if (start < 0 || !command.includes('shell-snapshots/')) return null
  let rest = command.slice(start + EVAL.length)
  let inner = ''
  for (;;) {
    const quote = rest.indexOf("'")
    if (quote < 0) return null
    inner += rest.slice(0, quote)
    rest = rest.slice(quote + 1)
    if (!rest.startsWith(`"'"'`)) return inner
    inner += "'"
    rest = rest.slice(4)
  }
}

// What a row is called: `$ <command>` for a Bash command Claude Code ran, else the command line.
export const labelOf = (command: string) => {
  const inner = unwrapCommand(command)

  return inner === null ? oneLine(command) : `$ ${oneLine(inner)}`
}

// Cut to `width` code points with … when cut, then padded to `width`.
export const fit = (text: string, width: number, alignRight = false) => {
  const chars = Array.from(text)
  const kept = chars.length > width ? [...chars.slice(0, Math.max(0, width - 1)), '…'] : chars
  const pad = ' '.repeat(Math.max(0, width - kept.length))

  return alignRight ? pad + kept.join('') : kept.join('') + pad
}
```

(`unwrapCommand(wrap('unterminated')…)` in the test cuts everything after the opening quote's content so no closing quote remains; the loop then finds no `'` and returns null.)

- [ ] **Step 5: Run the tests**

Run: `claude plugin test . 2>&1 | grep -E "^\(fail\)| pass| fail"` → `70 pass`, `0 fail`.
Run: `npx -y -p typescript@5.9.3 tsc -p .` → no output.

- [ ] **Step 6: Commit**

```bash
git add types/index.d.ts hooks/snapshot.ts hooks/alerts.test.ts hooks/view.ts hooks/view.test.ts
git commit -m "feat(view): start times, Bash command labels, cell fitting"
```

---

### Task 2: Rows, sorting, collapsing, selection and details

**Files:**
- Modify: `types/index.d.ts`, `hooks/view.ts`, `hooks/view.test.ts`, `hooks/pane.tsx` (only: import `treePrefixes` from `./view` instead of defining it), `hooks/pane.test.ts` (import `treePrefixes` from `./view`)

**Interfaces:**
- Consumes: Task 1's `labelOf`, `oneLine`; `formatBytes`, `formatDuration`, `formatPercent` from `format.ts`.
- Produces:
  - types: `export type SortMode = 'tree' | 'cpu' | 'mem' | 'time'`, `export type Selected = { pid: number; startMs: number }`, `export type StopState = Selected & { label: string; pids: number[]; phase: 'confirm' | 'sent' | 'stuck' | 'forced' }`, `export type PaneState = { sort: SortMode; collapsed: number[]; selected: Selected | null; stop: StopState | null }`
  - `view.ts`: `EMPTY_PANE: PaneState`, `START_TOLERANCE_MS = 2000`, `treePrefixes(rows: { depth: number }[]): string[]`, `export type ViewRow = { row: ProcRow; label: string; prefix: string; parent: string | null; rssKb: number; cpuPercent: number | null; hasChildren: boolean; isCollapsed: boolean }`, `viewRows(snapshot: Snapshot, state: PaneState): ViewRow[]`, `isSelected(row: { pid: number; startMs: number }, selected: Selected | null): boolean`, `cycleSort(sort: SortMode): SortMode`, `toggleCollapsed(collapsed: number[], pid: number): number[]`, `pruneState(state: PaneState, snapshot: Snapshot): PaneState`, `detailLines(snapshot: Snapshot, selected: Selected | null): string[] | null`, `export type TotalLine = { label: string; mem: string; cpu: string }`, `totalLines(snapshot: Snapshot): TotalLine[]`, `noteLine(snapshot: Snapshot): string | null`

- [ ] **Step 1: Declare the types** in `types/index.d.ts`, above `declare module`:

```ts
// How the pane orders its rows: the process tree, or flat by CPU, memory or runtime (highest first).
export type SortMode = 'tree' | 'cpu' | 'mem' | 'time'

// A chosen process: its pid and start, so a pid reused by another process is not it.
export type Selected = { pid: number; startMs: number }

// A stop in progress: confirm → sent → stuck (still listed after 3 s) → forced.
export type StopState = Selected & { label: string; pids: number[]; phase: 'confirm' | 'sent' | 'stuck' | 'forced' }

// The pane's own state, kept across reloads. `collapsed` holds the pids of collapsed rows.
export type PaneState = { sort: SortMode; collapsed: number[]; selected: Selected | null; stop: StopState | null }
```

- [ ] **Step 2: Write the failing tests** — append to `hooks/view.test.ts` and extend its imports:

```ts
import type { PaneState, Snapshot } from '../types'
import {
  cycleSort,
  detailLines,
  EMPTY_PANE,
  isSelected,
  noteLine,
  pruneState,
  toggleCollapsed,
  totalLines,
  treePrefixes,
  viewRows,
} from './view'
import { MB } from './fixtures'
import type { Timed } from './snapshot'
```

```ts
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
```

- [ ] **Step 3: Run to see them fail**

Run: `claude plugin test . 2>&1 | grep -E "^\(fail\)| pass| fail"`
Expected: the view tests fail to load (missing exports).

- [ ] **Step 4: Implement** — extend `hooks/view.ts`. Add at the top, under the header comment:

```ts
import type { PaneState, ProcRow, Selected, Snapshot, SortMode } from '../types'
import { formatBytes, formatDuration, formatPercent } from './format'

export const EMPTY_PANE: PaneState = { sort: 'tree', collapsed: [], selected: null, stop: null }

// A process's start, taken from readings, can move by a second or so; further apart is another process.
export const START_TOLERANCE_MS = 2000

const SORTS: SortMode[] = ['tree', 'cpu', 'mem', 'time']
```

Append:

```ts
// Tree lines for rows in tree order: `├ ` or `└ ` before each, and `│ ` under
// every ancestor that has a sibling still to come.
export const treePrefixes = (rows: { depth: number }[]) => {
  const isLastAt: boolean[] = []

  return rows.map(({ depth }, index) => {
    const next = rows.slice(index + 1).find(row => row.depth <= depth)
    const isLast = next === undefined || next.depth < depth
    const prefix = isLastAt.slice(0, depth).map(last => (last ? '  ' : '│ ')).join('')
    isLastAt[depth] = isLast

    return `${prefix}${isLast ? '└' : '├'} `
  })
}

export type ViewRow = {
  row: ProcRow
  label: string
  // Tree lines in the tree view; empty when sorted.
  prefix: string
  // The parent's label in sorted views; null in the tree.
  parent: string | null
  // The row's own figures, or its subtree's while collapsed.
  rssKb: number
  cpuPercent: number | null
  hasChildren: boolean
  isCollapsed: boolean
}

// The index just past a row's subtree (rows are in tree order).
const subtreeEnd = (rows: ProcRow[], index: number) => {
  const depth = rows[index]!.depth
  let end = index + 1
  while (end < rows.length && rows[end]!.depth > depth) end++

  return end
}

const sumCpu = (rows: ProcRow[]) =>
  rows.some(row => row.cpuPercent === null) ? null : rows.reduce((sum, row) => sum + (row.cpuPercent ?? 0), 0)

const sortKey: Record<Exclude<SortMode, 'tree'>, (row: ProcRow) => number> = {
  cpu: row => row.cpuPercent ?? -1,
  mem: row => row.rssKb,
  time: row => row.uptimeSeconds,
}

export const viewRows = (snapshot: Snapshot, state: PaneState): ViewRow[] => {
  const rows = snapshot.children ?? []
  const labels = new Map(rows.map(row => [row.pid, labelOf(row.command)]))
  const label = (pid: number) => labels.get(pid) ?? `pid ${pid}`
  const sort = state.sort
  if (sort !== 'tree') {
    const key = sortKey[sort]

    return [...rows]
      .sort((a, b) => key(b) - key(a) || a.pid - b.pid)
      .map(row => ({
        row,
        label: label(row.pid),
        prefix: '',
        parent: row.ppid === snapshot.pid ? 'Claude Code' : label(row.ppid),
        rssKb: row.rssKb,
        cpuPercent: row.cpuPercent,
        hasChildren: false,
        isCollapsed: false,
      }))
  }
  const visible: ViewRow[] = []
  for (let index = 0; index < rows.length; ) {
    const row = rows[index]!
    const end = subtreeEnd(rows, index)
    const hasChildren = end > index + 1
    const isCollapsed = hasChildren && state.collapsed.includes(row.pid)
    const span = isCollapsed ? rows.slice(index, end) : [row]
    visible.push({
      row,
      label: label(row.pid),
      prefix: '',
      parent: null,
      rssKb: span.reduce((sum, each) => sum + each.rssKb, 0),
      cpuPercent: sumCpu(span),
      hasChildren,
      isCollapsed,
    })
    index = isCollapsed ? end : index + 1
  }
  const prefixes = treePrefixes(visible.map(view => view.row))

  return visible.map((view, index) => ({ ...view, prefix: prefixes[index] ?? '' }))
}

export const isSelected = (row: { pid: number; startMs: number }, selected: Selected | null) =>
  selected !== null && selected.pid === row.pid && Math.abs(selected.startMs - row.startMs) <= START_TOLERANCE_MS

export const cycleSort = (sort: SortMode): SortMode => SORTS[(SORTS.indexOf(sort) + 1) % SORTS.length]!

export const toggleCollapsed = (collapsed: number[], pid: number) =>
  collapsed.includes(pid) ? collapsed.filter(each => each !== pid) : [...collapsed, pid]

// Forgets what names an ended process. Claude Code's row stays selectable; a stop already sent
// is kept for its check; an unreadable table changes nothing.
export const pruneState = (state: PaneState, snapshot: Snapshot): PaneState => {
  const rows = snapshot.children
  if (rows === null) return state
  const isListed = (chosen: Selected) => rows.some(row => isSelected(row, chosen))
  const selected =
    state.selected && (state.selected.pid === snapshot.pid || isListed(state.selected)) ? state.selected : null
  const stop = state.stop && (state.stop.phase !== 'confirm' || isListed(state.stop)) ? state.stop : null
  const collapsed = state.collapsed.filter(pid => rows.some(row => row.pid === pid))

  return { ...state, selected, collapsed, stop }
}

const clockTime = (ms: number) => {
  const date = new Date(ms)

  return [date.getHours(), date.getMinutes(), date.getSeconds()].map(part => String(part).padStart(2, '0')).join(':')
}

// The selected row's full command, then its facts; null with nothing (listed) selected.
export const detailLines = (snapshot: Snapshot, selected: Selected | null): string[] | null => {
  if (selected === null) return null
  const { engine } = snapshot
  if (selected.pid === snapshot.pid) {
    return [
      `Claude Code · pid ${snapshot.pid} · ${formatBytes(engine.rssKb)} · ${formatPercent(engine.cpuPercent)} · up ${formatDuration(engine.uptimeSeconds)}`,
    ]
  }
  const rows = snapshot.children ?? []
  const row = rows.find(each => isSelected(each, selected))
  if (!row) return null
  const parentRow = rows.find(each => each.pid === row.ppid)
  const parent = row.ppid === snapshot.pid ? 'Claude Code' : parentRow ? labelOf(parentRow.command) : 'ended'

  return [
    oneLine(row.command),
    `pid ${row.pid} · parent ${row.ppid} (${parent}) · started ${clockTime(row.startMs)} · ${formatBytes(row.rssKb)} · ${formatPercent(row.cpuPercent)} · up ${formatDuration(row.uptimeSeconds)}`,
  ]
}

export type TotalLine = { label: string; mem: string; cpu: string }

// The children's subtotal and the session total, when there are children.
export const totalLines = (snapshot: Snapshot): TotalLine[] => {
  const { engine, children, childCount, childKb, childCpuPercent } = snapshot
  if (children === null || childCount === 0) return []
  const both = engine.cpuPercent !== null && childCpuPercent !== null ? engine.cpuPercent + childCpuPercent : null

  return [
    { label: `Child processes (${childCount})`, mem: formatBytes(childKb), cpu: formatPercent(childCpuPercent) },
    { label: 'Total', mem: formatBytes(engine.rssKb + childKb), cpu: formatPercent(both) },
  ]
}

// One dim line under the rows: why there are none, or how many are left out.
export const noteLine = (snapshot: Snapshot) => {
  if (snapshot.children === null) return 'Child process list unavailable'
  if (snapshot.childCount === 0) return 'No child processes'
  const hidden = snapshot.childCount - snapshot.children.length

  return hidden > 0 ? `… ${hidden} more` : null
}
```

In `hooks/pane.tsx`, delete its own `treePrefixes` function and add `import { treePrefixes } from './view'`. In `hooks/pane.test.ts`, change the `treePrefixes` import to come from `./view`, and delete its `tree lines: …` test (it moved to `view.test.ts` unchanged).

(Check of the collapse test: CPU per process is `cpuSeconds` over 5 s since the reading before had 0, so with 50% for 12 and 10% for 11 and 13 the collapsed sum is 10 + 50 + 10 = 70; memory 4 + 200 + 50 = 254 MB.)

- [ ] **Step 5: Run the tests**

Run: `claude plugin test . 2>&1 | grep -E "^\(fail\)| pass| fail"` → `78 pass`, `0 fail`.
Run: `npx -y -p typescript@5.9.3 tsc -p .` → no output.

- [ ] **Step 6: Commit**

```bash
git add types/index.d.ts hooks/view.ts hooks/view.test.ts hooks/pane.tsx hooks/pane.test.ts
git commit -m "feat(view): tree and sorted rows, collapsing, selection, details"
```

---

### Task 3: Stop targets and texts

**Files:**
- Create: `hooks/stop.ts`, `hooks/stop.test.ts`

**Interfaces:**
- Consumes: `isSelected`, `labelOf` from `view.ts`; `Snapshot`, `Selected`, `StopState` types.
- Produces: `STOP_CHECK_MS = 3000`, `stopTargets(snapshot: Snapshot, selected: Selected): number[] | null`, `stillListed(snapshot: Snapshot, pids: number[]): number[]`, `killArgv(platform: string, pids: number[], isForce: boolean): string[]`, `confirmText(stop: StopState): string`, `outcomeText(stop: StopState, remaining: number[]): string`.

- [ ] **Step 1: Write the failing tests** in `hooks/stop.test.ts`

```ts
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
```

(`stillListed` with an unreadable table keeps every pid: nothing is known to have ended.)

- [ ] **Step 2: Run to see them fail**

Run: `claude plugin test . 2>&1 | grep -E "stop|^\(fail\)| pass| fail"`
Expected: the stop test file fails to load (`./stop` not found).

- [ ] **Step 3: Write `hooks/stop.ts`**

```ts
// Stopping a process and what it started: whom to stop, how, and what to say.

import type { Selected, Snapshot, StopState } from '../types'
import { fit, isSelected } from './view'

// How long after a stop the pane checks what is still running.
export const STOP_CHECK_MS = 3000

// The process and everything below it, deepest first (it last); null when it is not a listed child:
// Claude Code, ended, or a pid now used by another process.
export const stopTargets = (snapshot: Snapshot, selected: Selected): number[] | null => {
  const rows = snapshot.children ?? []
  const index = rows.findIndex(row => isSelected(row, selected))
  if (selected.pid === snapshot.pid || index < 0) return null
  const depth = rows[index]!.depth
  let end = index + 1
  while (end < rows.length && rows[end]!.depth > depth) end++

  return rows
    .slice(index, end)
    .sort((a, b) => b.depth - a.depth)
    .map(row => row.pid)
}

// The pids a reading still lists; with the table unreadable, all of them.
export const stillListed = (snapshot: Snapshot, pids: number[]) =>
  snapshot.children === null ? pids : pids.filter(pid => snapshot.children!.some(row => row.pid === pid))

// SIGTERM (or SIGKILL) to every pid in order; on Windows taskkill takes the tree from its root, the last pid.
export const killArgv = (platform: string, pids: number[], isForce: boolean) =>
  platform === 'windows'
    ? ['taskkill', '/T', ...(isForce ? ['/F'] : []), '/PID', String(pids[pids.length - 1])]
    : ['kill', isForce ? '-KILL' : '-TERM', ...pids.map(String)]

const name = (stop: StopState) => fit(stop.label, 48).trimEnd()

export const confirmText = (stop: StopState) => {
  const started = stop.pids.length - 1
  const tail = started === 0 ? '' : ` and the ${started} process${started === 1 ? '' : 'es'} it started`

  return `Stop ${name(stop)} (pid ${stop.pid})${tail}?`
}

export const outcomeText = (stop: StopState, remaining: number[]) =>
  remaining.length === 0
    ? `Stopped ${name(stop)} (pid ${stop.pid}) · /proc-stats`
    : `${name(stop)} (pid ${stop.pid}): ${remaining.length} of ${stop.pids.length} processes still running · /proc-stats`
```

(`fit(…, 48).trimEnd()` keeps short labels unpadded and cuts long ones to 47 code points and `…`, as the last test expects.)

- [ ] **Step 4: Run the tests**

Run: `claude plugin test . 2>&1 | grep -E "^\(fail\)| pass| fail"` → `83 pass`, `0 fail`.
Run: `npx -y -p typescript@5.9.3 tsc -p .` → no output.

- [ ] **Step 5: Commit**

```bash
git add hooks/stop.ts hooks/stop.test.ts
git commit -m "feat(stop): stop targets with the reused-pid guard, kill commands, texts"
```

---

### Task 4: Rows as Buttons, selection, sort, collapse, details

**Files:**
- Modify: `types/index.d.ts` (state contract), `hooks/pane.tsx` (rewrite), `hooks/pane.test.ts` (rewrite), `hooks/register.ts`

**Interfaces:**
- Consumes: Task 2's `viewRows`, `ViewRow`, `isSelected`, `detailLines`, `totalLines`, `noteLine`, `cycleSort`, `toggleCollapsed`, `pruneState`, `EMPTY_PANE`, `fit`; Task 3's `confirmText`.
- Produces: `pane.tsx`: `paneColumns(bodyColumns)` (unchanged), `export type RowTarget = { pid: number; startMs: number; hasChildren: boolean }`, `export type PaneHandlers = { onRow: (target: RowTarget) => void; onSort: () => void; onStop?: () => void; onConfirm?: () => void; onCancel?: () => void; onForce?: () => void }`, `commandCell(view: ViewRow, width: number): { main: string; parent: string }`, `drawPane(elements, reading, state, bodyColumns, handlers)`; the `pane` state value.

- [ ] **Step 1: Add `pane` to the state contract** in `types/index.d.ts`:

```ts
    // pane: the Processes pane's sort, collapsed rows, selection and stop in progress.
    'proc-stats': { reading: Reading; isOpen: boolean; history: History; alerts: AlertState; pane: PaneState }
```

- [ ] **Step 2: Rewrite `hooks/pane.tsx`**

```tsx
import type { Elements, RenderSurface } from 'claude-code'

import type { PaneState, Reading } from '../types'
import { formatBytes, formatDuration, formatPercent } from './format'
import { confirmText } from './stop'
import { detailLines, fit, isSelected, noteLine, totalLines, viewRows } from './view'
import type { ViewRow } from './view'

const PID_WIDTH = 7
const NUMBER_WIDTH = 7
const TIME_WIDTH = 7
const MIN_COMMAND = 12
// Space around the pane's contents, in cells: each side, and below. Rows pad
// their own sides too, so a stripe reaches past the text it holds.
const PADDING_X = 1
const ROW_PADDING_X = 1
const PADDING_BOTTOM = 1
// Theme keys, so both follow the person's light or dark theme.
const HEADER_COLOR = 'claude'
const HEADER_TEXT = 'inverseText'
const STRIPE_COLOR = 'subtle'

// The columns that fit: TIME goes first, then PID, the command keeping the rest.
export const paneColumns = (bodyColumns: number) => {
  const fixed = (showPid: boolean, showTime: boolean) =>
    (showPid ? PID_WIDTH + 1 : 0) + (NUMBER_WIDTH + 1) * 2 + (showTime ? TIME_WIDTH + 1 : 0)
  const showTime = bodyColumns - fixed(true, true) >= MIN_COMMAND
  const showPid = bodyColumns - fixed(true, false) >= MIN_COMMAND || showTime

  return {
    showPid,
    showTime,
    commandWidth: Math.max(MIN_COMMAND, bodyColumns - fixed(showPid, showTime)),
  }
}

export type RowTarget = { pid: number; startMs: number; hasChildren: boolean }

// What the pane's presses do; register.ts builds them. Stop handlers are optional: without them no stop is offered.
export type PaneHandlers = {
  onRow: (target: RowTarget) => void
  onSort: () => void
  onStop?: () => void
  onConfirm?: () => void
  onCancel?: () => void
  onForce?: () => void
}

const marker = (view: ViewRow) => (view.hasChildren ? (view.isCollapsed ? '▸ ' : '▾ ') : '')

// The command cell: tree lines, the collapse marker and the label; in sorted views the parent after it.
export const commandCell = (view: ViewRow, width: number) => {
  const main = `${view.prefix}${marker(view)}${view.label}`
  if (view.parent === null) return { main: fit(main, width), parent: '' }
  const tail = ` ← ${view.parent}`
  const tailWidth = Math.min(Array.from(tail).length, Math.floor(width / 3))

  return { main: fit(main, width - tailWidth), parent: fit(tail, tailWidth) }
}

export const drawPane = (
  { Box, Text, Button }: Elements[RenderSurface],
  { snapshot, error }: Reading,
  state: PaneState,
  bodyColumns: number,
  handlers: PaneHandlers,
) => {
  if (!snapshot) {
    return (
      <Box paddingX={PADDING_X} paddingBottom={PADDING_BOTTOM}>
        <Text dimColor>{error ?? 'Reading…'}</Text>
      </Box>
    )
  }
  const { showPid, showTime, commandWidth } = paneColumns(bodyColumns - (PADDING_X + ROW_PADDING_X) * 2)
  const views = viewRows(snapshot, state)
  const numbers = (mem: string, cpu: string, time: string) =>
    ` ${fit(mem, NUMBER_WIDTH, true)} ${fit(cpu, NUMBER_WIDTH, true)}${showTime ? ` ${fit(time, TIME_WIDTH, true)}` : ''}`
  const pidCell = (pid: string) => (showPid ? `${fit(pid, PID_WIDTH)} ` : '')

  // One row: a plain keyed Button of Text cells, striped by its Box; the selected row underlined.
  const row = (
    key: string,
    target: RowTarget,
    command: { main: string; parent: string },
    figures: string,
    pid: string,
    isStriped: boolean,
    isBold: boolean,
  ) => {
    const background = isStriped ? STRIPE_COLOR : undefined
    const underline = isSelected(target, state.selected) || (target.pid === snapshot.pid && state.selected?.pid === snapshot.pid)
    const cells =
      command.parent === ''
        ? [
            <Text backgroundColor={background} bold={isBold} underline={underline}>{`${pidCell(pid)}${command.main}`}</Text>,
            <Text backgroundColor={background} bold={isBold}>{figures}</Text>,
          ]
        : [
            <Text backgroundColor={background} bold={isBold} underline={underline}>{`${pidCell(pid)}${command.main}`}</Text>,
            <Text backgroundColor={background} dimColor>{command.parent}</Text>,
            <Text backgroundColor={background} bold={isBold}>{figures}</Text>,
          ]

    return (
      <Box paddingX={ROW_PADDING_X} backgroundColor={background}>
        <Button key={key} plain onPress={() => handlers.onRow(target)}>
          {cells}
        </Button>
      </Box>
    )
  }

  const { engine } = snapshot
  const engineRow = row(
    `pid:${snapshot.pid}`,
    { pid: snapshot.pid, startMs: 0, hasChildren: false },
    { main: fit('Claude Code', commandWidth), parent: '' },
    numbers(formatBytes(engine.rssKb), formatPercent(engine.cpuPercent), formatDuration(engine.uptimeSeconds)),
    String(snapshot.pid),
    false,
    true,
  )
  // Zebra rows count Claude Code's own as the first.
  const childRows = views.map((view, index) =>
    row(
      `pid:${view.row.pid}`,
      { pid: view.row.pid, startMs: view.row.startMs, hasChildren: view.hasChildren && state.sort === 'tree' },
      commandCell(view, commandWidth),
      numbers(formatBytes(view.rssKb), formatPercent(view.cpuPercent), formatDuration(view.row.uptimeSeconds)),
      String(view.row.pid),
      index % 2 === 0,
      false,
    ),
  )
  const note = noteLine(snapshot)
  const totals = totalLines(snapshot)
  const details = detailLines(snapshot, state.selected)
  const stop = state.stop
  const canStop =
    handlers.onStop !== undefined &&
    state.selected !== null &&
    state.selected.pid !== snapshot.pid &&
    views.some(view => isSelected(view.row, state.selected))

  return (
    <Box flexDirection="column" paddingX={PADDING_X} paddingBottom={PADDING_BOTTOM}>
      <Box marginBottom={1} paddingX={ROW_PADDING_X}>
        <Text dimColor>
          peak {formatBytes(engine.peakKb)} · {snapshot.platform}
          {snapshot.platform === 'mac' ? ' (peak is the highest seen)' : ''}
        </Text>
      </Box>
      <Box paddingX={ROW_PADDING_X} backgroundColor={HEADER_COLOR}>
        <Text color={HEADER_TEXT} bold>
          {`${pidCell('PID')}${fit(state.sort === 'tree' ? 'COMMAND' : `COMMAND (by ${state.sort})`, commandWidth)}${numbers('MEM', 'CPU', 'TIME')}`}
        </Text>
      </Box>
      {engineRow}
      {childRows}
      {note !== null && (
        <Box paddingX={ROW_PADDING_X}>
          <Text dimColor>{`${pidCell('')}${note}`}</Text>
        </Box>
      )}
      {totals.length > 0 && (
        <Box flexDirection="column" marginTop={1} paddingX={ROW_PADDING_X}>
          {totals.map(total => (
            <Text bold>{`${pidCell('')}${fit(total.label, commandWidth)}${numbers(total.mem, total.cpu, '')}`}</Text>
          ))}
        </Box>
      )}
      {details !== null && (
        <Box flexDirection="column" marginTop={1} paddingX={ROW_PADDING_X}>
          {details.map((line, index) => (
            <Text dimColor={index > 0}>{line}</Text>
          ))}
        </Box>
      )}
      <Box flexDirection="row" columnGap={2} marginTop={1} paddingX={ROW_PADDING_X}>
        {stop === null && (
          <Button key="sort" plain hotkey="s" onPress={handlers.onSort}>
            {`Sort: ${state.sort}`}
          </Button>
        )}
        {stop === null && canStop && handlers.onStop && (
          <Button key="stop" plain hotkey="k" onPress={handlers.onStop}>
            Stop process
          </Button>
        )}
        {stop?.phase === 'confirm' && <Text>{confirmText(stop)}</Text>}
        {stop?.phase === 'confirm' && handlers.onConfirm && (
          <Button key="confirm" plain hotkey="y" onPress={handlers.onConfirm}>
            Stop
          </Button>
        )}
        {(stop?.phase === 'confirm' || stop?.phase === 'stuck') && handlers.onCancel && (
          <Button key="cancel" plain hotkey="n" onPress={handlers.onCancel}>
            {stop.phase === 'confirm' ? 'Cancel' : 'Dismiss'}
          </Button>
        )}
        {(stop?.phase === 'sent' || stop?.phase === 'forced') && <Text dimColor>Stopping…</Text>}
        {stop?.phase === 'stuck' && <Text>Still running after 3 s.</Text>}
        {stop?.phase === 'stuck' && handlers.onForce && (
          <Button key="force" plain hotkey="f" onPress={handlers.onForce}>
            Force stop
          </Button>
        )}
      </Box>
    </Box>
  )
}
```

- [ ] **Step 3: Wire `register.ts`**

Imports: add `import type { PaneHandlers } from './pane'`, `import { cycleSort, EMPTY_PANE, pruneState, toggleCollapsed } from './view'`, and `PaneState` to the `../types` type import.

References and atoms (replace the `reading` atom line; keep the others):

```ts
const READING = { plugin: 'proc-stats', key: 'reading' } as const
const PANE_STATE = { plugin: 'proc-stats', key: 'pane' } as const
const reading = atom(READING, {} as Reading)
const pane = atom(PANE_STATE, EMPTY_PANE as PaneState)
```

Handlers (a function in `register.ts`, above `register`; each writes through `update`):

```ts
// What the pane's presses do. Built here because they call $, which pane.tsx never receives.
const paneHandlers = ($: EngineInterface): PaneHandlers => ({
  onRow: target =>
    void update($, pane, state => ({
      ...state,
      selected: { pid: target.pid, startMs: target.startMs },
      collapsed: target.hasChildren ? toggleCollapsed(state.collapsed, target.pid) : state.collapsed,
    })),
  onSort: () => void update($, pane, state => ({ ...state, sort: cycleSort(state.sort) })),
})
```

In `sample()`, right after `await set({ snapshot: capRows(snapshot) })`, prune the pane state against this reading, writing only on a change:

```ts
        try {
          const kept = (await $.state.get(PANE_STATE)).value ?? EMPTY_PANE
          const pruned = pruneState(kept, snapshot)
          if (JSON.stringify(pruned) !== JSON.stringify(kept)) await update($, pane, () => pruned)
        } catch {
          // The pane keeps its state this reading.
        }
```

In `register`:
- `command.run`: open with focus — `const opened = await $.ui.open({ ...OPEN, focus: true })` (the reopen in `session.start` stays `$.ui.open(OPEN)`).
- `ui.render`: `drawPane($.ui.resolve(e), await read($, reading), await read($, pane), e.props.bodyColumns, paneHandlers($))`.
- New hook, selecting the row the focus ring moves onto:

```ts
  // Arrow keys move the focus ring over the rows; the row it lands on is the selection.
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const moved = await next(e)
    const pid = e.element?.startsWith('pid:') ? Number(e.element.slice(4)) : null
    if (pid !== null && !('deny' in moved)) {
      const snapshot = (await $.state.get(READING)).value?.snapshot
      const row = snapshot?.children?.find(each => each.pid === pid)
      await update($, pane, state => ({ ...state, selected: { pid, startMs: row?.startMs ?? 0 } }))
    }

    return moved
  }).catch(($, e, next) => next(e))
```

Run: `npx -y -p typescript@5.9.3 tsc -p .` → only `pane.test.ts` errors remain (its tests use the old `paneLines`/`stripes`); `claude plugin validate . 2>&1 | grep -E "gating|state|✔|✘"` → `gating hook with .catch: ui.focus{requestId=proc-stats}`, state lists `proc-stats.pane`, `✔ Validation passed`.

- [ ] **Step 4: Rewrite `hooks/pane.test.ts`**

```ts
import { expect, test } from 'claude-code/testing'

import type { PaneState } from '../types'
import { engine, MB, proc } from './fixtures'
import { commandCell, paneColumns } from './pane'
import { buildSnapshot } from './snapshot'
import type { Timed } from './snapshot'
import { EMPTY_PANE, viewRows } from './view'

const before: Timed = { engine, children: [proc(11, 10), proc(12, 11)], wallMs: 0 }
const now: Timed = {
  engine: { ...engine, cpuSeconds: 1.5 },
  children: [proc(11, 10, { cpuSeconds: 1 }), proc(12, 11, { command: 'python3 -c x', rssKb: 20 * MB })],
  wallMs: 5000,
}
const snapshot = buildSnapshot('linux', 10, now, before)
const state = (extra: Partial<PaneState> = {}): PaneState => ({ ...EMPTY_PANE, ...extra })

test('pane columns: TIME then PID give way, the command keeps the rest', () => {
  expect(paneColumns(80)).toEqual({ showPid: true, showTime: true, commandWidth: 48 })
  expect(paneColumns(40)).toEqual({ showPid: true, showTime: false, commandWidth: 16 })
  expect(paneColumns(30)).toEqual({ showPid: false, showTime: false, commandWidth: 14 })
})

test('command cells: tree lines and collapse marker; the parent after it when sorted', () => {
  const [parent, child] = viewRows(snapshot, state())
  expect(commandCell(parent!, 20).main).toBe('└ ▾ cmd11           ')
  expect(commandCell(child!, 20).main).toBe('  └ python3 -c x    ')
  const collapsed = viewRows(snapshot, state({ collapsed: [11] }))[0]!
  expect(commandCell(collapsed, 20).main).toBe('└ ▸ cmd11           ')
  const sorted = viewRows(snapshot, state({ sort: 'mem' }))[0]!
  expect(commandCell(sorted, 30)).toEqual({ main: 'python3 -c x          ', parent: ' ← cmd11' })
})

const PANE_PROPS = {
  title: 'Processes',
  isFocused: true,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

test('the pane draws before the first reading', async $ => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'proc-stats',
      surface,
      component: 'Pane',
      requestId: 'proc-stats',
      props: { ...PANE_PROPS, bodyColumns: 80 },
    })
    expect(await ui.find({ type: 'Text', text: /Reading/ })).toBeDefined()
    await ui.unmount()
  }
})

test('rows are buttons; a press selects and shows details; s cycles the sort', async ($, on) => {
  on('state.get', { plugin: 'proc-stats', key: 'reading' }, () => ({ value: { value: { snapshot }, version: 1 } }))
  for (const [surface, bodyColumns] of [['terminal', 80], ['terminal', 30], ['desktop', 80]] as const) {
    const ui = await $.ui.mount({
      plugin: 'proc-stats',
      surface,
      component: 'Pane',
      requestId: 'proc-stats',
      props: { ...PANE_PROPS, bodyColumns },
    })
    expect(await ui.find({ key: 'pid:12' })).toBeDefined()
    expect(await ui.find({ key: 'pid:10' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Total' })).toBeUndefined()
    await ui.press({ key: 'pid:12' })
    expect(await ui.find({ type: 'Text', text: 'python3 -c x' })).toBeDefined()
    expect((await ui.find({ key: 'sort' }))?.text).toContain('Sort: tree')
    await ui.press({ key: 'sort' })
    expect((await ui.find({ key: 'sort' }))?.text).toContain('Sort: cpu')
    await ui.press({ key: 'sort' })
    await ui.press({ key: 'sort' })
    await ui.press({ key: 'sort' })
    await ui.unmount()
  }
})
```

(`Total` is not its own Text in the new drawing — the totals are padded lines — so the old exact-text check becomes the `toBeUndefined` above; the details' first line is the full command as its own Text. The four sort presses leave the sort at `tree` for the next surface, since the kit's state carries across mounts in one test.)

- [ ] **Step 5: Run everything**

Run: `claude plugin test . 2>&1 | grep -E "^\(fail\)| pass| fail"` → `81 pass`, `0 fail` (83, less the six pane tests this rewrite replaces, plus its four).
Run: `npx -y -p typescript@5.9.3 tsc -p .` → no output.
Run: `claude plugin validate .` → `✔ Validation passed`, no warnings.

- [ ] **Step 6: Commit**

```bash
git add types/index.d.ts hooks/pane.tsx hooks/pane.test.ts hooks/register.ts
git commit -m "feat(pane): rows as buttons with selection, details, sort and collapsing"
```

---

### Task 5: Stopping a process

**Files:**
- Modify: `hooks/register.ts`, `hooks/pane.test.ts`

**Interfaces:**
- Consumes: Task 3's `stopTargets`, `stillListed`, `killArgv`, `outcomeText`, `STOP_CHECK_MS`; Task 2's `isSelected`, `labelOf`, `EMPTY_PANE`; the `PaneHandlers` stop callbacks drawn by Task 4.
- Produces: `paneHandlers` gains `onStop`, `onConfirm`, `onCancel`, `onForce`; the `ui.focus` hook cancels a confirmation when the ring leaves the pane.

- [ ] **Step 1: Write the failing test** — append to `hooks/pane.test.ts`:

```ts
test('k asks before stopping; n cancels; Claude Code offers no stop', async ($, on) => {
  on('state.get', { plugin: 'proc-stats', key: 'reading' }, () => ({ value: { value: { snapshot }, version: 1 } }))
  const ui = await $.ui.mount({
    plugin: 'proc-stats',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'proc-stats',
    props: { ...PANE_PROPS, bodyColumns: 80 },
  })
  await ui.press({ key: 'pid:10' })
  expect(await ui.find({ key: 'stop' })).toBeUndefined()
  await ui.press({ key: 'pid:12' })
  await ui.press({ key: 'stop' })
  expect(await ui.find({ type: 'Text', text: 'Stop python3 -c x (pid 12)?' })).toBeDefined()
  expect(await ui.find({ key: 'confirm' })).toBeDefined()
  await ui.press({ key: 'cancel' })
  expect(await ui.find({ key: 'confirm' })).toBeUndefined()
  expect(await ui.find({ key: 'stop' })).toBeDefined()
  await ui.unmount()
})
```

(The test never presses `confirm`, so no process is signalled.)

- [ ] **Step 2: Run to see it fail**

Run: `claude plugin test . 2>&1 | grep -E "^\(fail\)| pass| fail"` → this test fails (no `stop` button: `onStop` not provided yet).

- [ ] **Step 3: Implement the stop flow** in `hooks/register.ts`

Imports: add `import { killArgv, outcomeText, STOP_CHECK_MS, stillListed, stopTargets } from './stop'`; add `isSelected, labelOf` to the `./view` import; `StopState` to the `../types` type import.

Above `paneHandlers`:

```ts
// Sends the signal; a failure is the first line of what the command said, else null.
const signal = async ($: EngineInterface, platform: string, pids: number[], isForce: boolean) => {
  const { exitCode, stderr } = await $.process.run(killArgv(platform, pids, isForce))

  return exitCode === 0 ? null : (stderr.trim().split('\n')[0] ?? `exit ${exitCode}`)
}

const setStop = ($: EngineInterface, stop: StopState | null) => update($, pane, state => ({ ...state, stop }))

// STOP_CHECK_MS after a signal: done when nothing is listed; else offer a force stop, or, after one, report.
const checkStop = async ($: EngineInterface) => {
  const stop = (await $.state.get(PANE_STATE)).value?.stop
  const snapshot = (await $.state.get(READING)).value?.snapshot
  if (!stop || !snapshot || (stop.phase !== 'sent' && stop.phase !== 'forced')) return
  const remaining = stillListed(snapshot, stop.pids)
  if (remaining.length > 0 && stop.phase === 'sent') {
    await setStop($, { ...stop, phase: 'stuck' })
    return
  }
  $.ui.toast(outcomeText(stop, remaining))
  await setStop($, null)
}
```

Extend `paneHandlers` with:

```ts
  // k: ask first. The targets are checked again at y, so a process that ended meanwhile is left alone.
  onStop: () =>
    void (async () => {
      const state = (await $.state.get(PANE_STATE)).value ?? EMPTY_PANE
      const snapshot = (await $.state.get(READING)).value?.snapshot
      const pids = snapshot && state.selected ? stopTargets(snapshot, state.selected) : null
      const row = snapshot?.children?.find(each => isSelected(each, state.selected))
      if (!pids || !row) {
        $.ui.toast('proc-stats: that process is no longer listed')
        return
      }
      await setStop($, { pid: row.pid, startMs: row.startMs, label: labelOf(row.command), pids, phase: 'confirm' })
    })(),
  onConfirm: () =>
    void (async () => {
      const stop = (await $.state.get(PANE_STATE)).value?.stop
      const snapshot = (await $.state.get(READING)).value?.snapshot
      if (!stop || stop.phase !== 'confirm' || !snapshot) return
      const pids = stopTargets(snapshot, stop)
      if (!pids) {
        $.ui.toast('proc-stats: that process is no longer listed')
        await setStop($, null)
        return
      }
      const failure = await signal($, snapshot.platform, pids, false)
      if (failure) $.ui.toast(`proc-stats: ${failure}`)
      await setStop($, { ...stop, pids, phase: 'sent' })
      $.clock.after(STOP_CHECK_MS, () => void checkStop($))
    })(),
  onForce: () =>
    void (async () => {
      const stop = (await $.state.get(PANE_STATE)).value?.stop
      const snapshot = (await $.state.get(READING)).value?.snapshot
      if (!stop || stop.phase !== 'stuck' || !snapshot) return
      const failure = await signal($, snapshot.platform, stillListed(snapshot, stop.pids), true)
      if (failure) $.ui.toast(`proc-stats: ${failure}`)
      await setStop($, { ...stop, phase: 'forced' })
      $.clock.after(STOP_CHECK_MS, () => void checkStop($))
    })(),
  onCancel: () => void setStop($, null),
```

In the `ui.focus` hook, after `const moved = await next(e)`, cancel a pending confirmation when the ring leaves the pane (Esc returns the keys to the prompt):

```ts
    if (e.element === undefined) {
      const stop = (await $.state.get(PANE_STATE)).value?.stop
      if (stop?.phase === 'confirm') await setStop($, null)
    }
```

- [ ] **Step 4: Run everything**

Run: `claude plugin test . 2>&1 | grep -E "^\(fail\)| pass| fail"` → `82 pass`, `0 fail`.
Run: `npx -y -p typescript@5.9.3 tsc -p .` → no output.
Run: `claude plugin validate . 2>&1 | grep -E "calls|✔|✘"` → the calls line includes `$.process.run` and `$.clock.after`; `✔ Validation passed`, no warnings.

- [ ] **Step 5: Commit**

```bash
git add hooks/register.ts hooks/pane.test.ts
git commit -m "feat(pane): stop a process and what it started, with confirmation and force stop"
```

---

### Task 6: README, version, live check

**Files:**
- Modify: `README.md`, `.claude-plugin/plugin.json`

- [ ] **Step 1: README** — replace the "## Processes pane" section's body (keep its heading) with:

```markdown
`/proc-stats` opens a task-manager pane and gives it the keyboard (Esc hands it back to the prompt; click the pane or press ctrl+x then tab to return):

- **Rows:** Claude Code's own row, then every process below it as a tree. A Bash command Claude ran shows as `$ <command>`; ▾/▸ marks a row with processes under it.
- **↑ / ↓** move between rows; the row you land on is selected and its full command, pid, parent, start time, memory and CPU show under the table.
- **Enter or a click** selects a row, and on a row with processes under it collapses or expands it (collapsed, it shows its subtree's totals).
- **s** sorts by CPU, memory or runtime (highest first, each row followed by its parent), then back to the tree.
- **k** stops the selected process and everything it started: it asks first (**y** Stop, **n** Cancel), sends SIGTERM (Windows: `taskkill /T`), and after 3 seconds offers **f** Force stop (SIGKILL) if anything is still running. Claude Code's own row cannot be stopped.

TIME, then PID, give way on a narrow pane.
```

- [ ] **Step 2: Version** — in `.claude-plugin/plugin.json` set `"version": "0.2.3"`.

Run: `claude plugin validate .` → `✔ Validation passed`. Run: `claude plugin test .` → all pass.

- [ ] **Step 3: Commit**

```bash
git add README.md .claude-plugin/plugin.json
git commit -m "docs: pane keys; version 0.2.3"
```

- [ ] **Step 4: Live check (the person, after the final review)**

With a few dummy processes running (some nested under one Bash command):
1. `/proc-stats` opens the pane with the keyboard; ↑/↓ move the highlight and the details follow.
2. Enter on the `$ …` row collapses it to one row with summed figures; Enter expands it.
3. `s` cycles the sort; each sorted row shows its parent dim.
4. `k` on a dummy shows the confirmation; `n` cancels; `k` then `y` stops it (a toast says so, and it leaves the list); Esc during a confirmation cancels it.
