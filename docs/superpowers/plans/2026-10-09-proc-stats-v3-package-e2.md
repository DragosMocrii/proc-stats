# proc-stats v0.3, package E2: detached processes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Processes the session started that no longer run under Claude Code (`nohup … &`, `setsid`, daemons) are found, shown in the pane under a **Detached** heading with their own subtotal, counted in the totals, history, marker and toasts, stoppable, and listed in `/proc-stats report`.

**Architecture:** At session start the mod sets `PROC_STATS_SESSION=<random id>` in Claude Code's environment, so every command started afterwards carries it, also after it detaches. The mark is kept in `$.state` so a reload keeps it. Each reading, processes outside Claude Code's tree that started after the mark are candidates. Their environment is read once per pid and start (Linux `/proc/<pid>/environ`; macOS one `ps eww` at most every 10 s), and the ones holding the mark become rows marked `detached`, placed after the tree. Everything that already sums `children` (totals, status line, history, alerts, stop, origins) then includes them; the pane and the report show them as their own group.

**Tech Stack:** TypeScript Claude Code mod (hooks module, `claude-code` API), tests with `claude-code/testing` under `claude plugin test`, type-check with `tsc` 5.9.3.

**Spec:** `docs/superpowers/specs/2026-10-09-proc-stats-v3-design.md` (Detached processes; Report; Architecture). Packages A–F are merged on main.

## Global Constraints

- The repository is `/home/vscode/proc-stats`, on the branch the controller names. Commit after each task. Do not push. Do not touch `/home/vscode/.claude/dev-mods/`.
- `$` may not be passed into a function imported from another file. `detached.ts`, `snapshot.ts`, `view.ts`, `pane.tsx` and `report.ts` take plain data; every `$` call stays in `register.ts`.
- Every `$.state` value is declared in `types/index.d.ts`; refs are `const` literals `{ plugin: 'proc-stats', key: '<key>' } as const`. Every value has a safe empty default, so a reading saved by an earlier version (without the detached fields) still draws.
- `$.env.set` and `$.env.get` take a string literal name (`claude plugin validate` lists them).
- Commands: tests `claude plugin test .`; validate `claude plugin validate .` (ends `✔ Validation passed`, no warnings); type-check `npx -y -p typescript@5.9.3 tsc -p .`.
- From the spec, verbatim: "At session start, `$.env.set('PROC_STATS_SESSION', <random id>)`. Every command started afterwards carries it, including ones that detach. A process is detached when it is not under Claude Code, started after the session, and its environment holds the id. Linux: read `/proc/<pid>/environ` once per new process, cached by pid and start time. macOS: `ps eww -o pid=,command=` every 10 s, cached the same way. Windows: not detected (documented). Detached processes form a **Detached** group with its own subtotal; they count toward totals, the marker and toasts, and can be stopped. An unreadable environment counts as not ours. If `$.env.set` fails, detection is off and the detail area says so."
- From the spec: the report lists "current totals for Claude Code, children and detached … up to 10 detached processes".
- Verified before planning: on Linux a process started with `setsid nohup …` from a Bash call keeps an exported variable in `/proc/<pid>/environ`. The kit runs `session.start` with `mock.clock`, `mock.env` and hooks on `process.run`, `fs.read`, `env.set`, `command.register`, `ui.status` and `state.set` (Task 3's tests use exactly this).
- Ruling recorded in the plan: the mark (id and creation time) lives in `$.state` under `session`, so a reload sets the same id again and keeps finding processes started before it. A failed `$.env.set` turns detection off for this load.
- Ruling recorded in the plan: "the detail area says so" is a dim line under the rows (`Detached processes are not tracked: the session mark could not be set.`), shown whether or not a row is selected, and repeated in the report. On Windows nothing is said; the README documents it.
- Ruling recorded in the plan: `childCount`, `childKb` and `childCpuPercent` stay the session's totals over every process it started, detached ones included, so the status line's `+` part, the history, the marker and the toasts include detached processes with no change of their own. `detachedCount`, `detachedKb` and `detachedCpuPercent` are the detached part of them.
- Ruling recorded in the plan: macOS processes not yet read show at the next scan, at most 10 s later. The Linux table gains an `etime` column to place each process's start.
- Ruling recorded in the plan: the version becomes `0.3.0`, since this package completes the v0.3 spec.

## Review Focus

- **A busy machine:** every process started after the session outside Claude Code's tree is a candidate. Each environment must be read once, not every reading. Pinned in Task 1 (the cache) and Task 3 (four environments read once over two readings).
- **A pid reused by an unrelated process:** a cached "ours" must not carry over to a later process under the same pid. Pinned in Task 1.
- **A reload:** the same mark is set again, so processes detached before the reload are still found. Pinned in Task 3.
- **`$.env.set` refused:** no environment reads, no detached rows, and the pane and report say why. Pinned in Task 3, Task 4 and Task 5.
- **A reading saved before this package** (no detached fields), drawn right after a reload: the pane's totals draw as before. Pinned in Task 4.

---

### Task 1: Finding marked processes (pure)

**Files:**
- Create: `hooks/detached.ts`
- Test: `hooks/detached.test.ts`

**Interfaces:**
- Consumes: `parsePsTime` from `./stats`; `START_TOLERANCE_MS` (2000) from `./view`.
- Produces (`hooks/detached.ts`):
  - `markOf(id: string): string`, which is `PROC_STATS_SESSION=<id>`
  - `type Started = { pid: number; startMs: number }`
  - `type MarkCache = Map<number, { startMs: number; isOurs: boolean }>`
  - `environHasMark(environ: string, id: string): boolean`
  - `macMarkedPids(stdout: string, id: string): Set<number>`
  - `candidatesOf(started: Started[], excluded: Set<number>, sessionStartMs: number): Started[]`
  - `unreadOf(cache: MarkCache, candidates: Started[]): Started[]`
  - `rememberMarks(cache: MarkCache, candidates: Started[], read: (Started & { isOurs: boolean })[]): MarkCache`
  - `oursOf(cache: MarkCache, candidates: Started[]): number[]`
  - `startedFrom(rows: string[][], etimeColumn: number, wallMs: number): Started[]`

- [ ] **Step 1: Write the failing tests** in `hooks/detached.test.ts`:

```ts
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
```

- [ ] **Step 2: Run them to see them fail.**

Run: `cd /home/vscode/proc-stats && claude plugin test .`
Expected: `hooks/detached.test.ts` fails to load (`./detached` does not exist); every other test passes.

- [ ] **Step 3: Implement** `hooks/detached.ts`:

```ts
// Detached processes: ones this session started that no longer run under Claude Code. Each command
// the session starts carries PROC_STATS_SESSION=<id> in its environment, and keeps it when it detaches.

import { parsePsTime } from './stats'
import { START_TOLERANCE_MS } from './view'

// What the environment holds for this session's processes.
export const markOf = (id: string) => `PROC_STATS_SESSION=${id}`

// A process seen in the table: its pid and when it started (ms since the epoch).
export type Started = { pid: number; startMs: number }

// What is known of a pid: its start, and whether its environment holds the mark.
export type MarkCache = Map<number, { startMs: number; isOurs: boolean }>

// Linux: /proc/<pid>/environ is NUL-separated `NAME=value` entries.
export const environHasMark = (environ: string, id: string) => environ.split('\0').includes(markOf(id))

// macOS: `ps eww -o pid=,command= -p …` prints each pid, its command and then its environment, space-separated.
export const macMarkedPids = (stdout: string, id: string) => {
  const mark = markOf(id)
  const pids = new Set<number>()
  for (const line of stdout.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/)
    if (fields.slice(1).includes(mark)) pids.add(Number(fields[0]))
  }

  return pids
}

// The processes that could be ours: started since the session began (with two seconds' slack) and not
// excluded (Claude Code, what runs under it, and the reader itself).
export const candidatesOf = (started: Started[], excluded: Set<number>, sessionStartMs: number) =>
  started.filter(each => !excluded.has(each.pid) && each.startMs >= sessionStartMs - START_TOLERANCE_MS)

const isKnown = (cache: MarkCache, each: Started) => {
  const known = cache.get(each.pid)

  return known !== undefined && Math.abs(known.startMs - each.startMs) <= START_TOLERANCE_MS
}

// The candidates whose environment has not been read yet (a reused pid counts as unread).
export const unreadOf = (cache: MarkCache, candidates: Started[]) => candidates.filter(each => !isKnown(cache, each))

// The cache after a reading: what was just read, plus what is still known of the candidates; ended
// processes and reused pids leave it.
export const rememberMarks = (cache: MarkCache, candidates: Started[], read: (Started & { isOurs: boolean })[]): MarkCache => {
  const next: MarkCache = new Map()
  for (const each of candidates) if (isKnown(cache, each)) next.set(each.pid, cache.get(each.pid)!)
  for (const each of read) next.set(each.pid, { startMs: each.startMs, isOurs: each.isOurs })

  return next
}

// The candidates known to be ours.
export const oursOf = (cache: MarkCache, candidates: Started[]) =>
  candidates.filter(each => isKnown(cache, each) && cache.get(each.pid)!.isOurs).map(each => each.pid)

// Each table row's pid and start, its elapsed time (`[[dd-]hh:]mm:ss`) in column `etimeColumn`, read at `wallMs`.
export const startedFrom = (rows: string[][], etimeColumn: number, wallMs: number): Started[] =>
  rows.map(fields => ({ pid: Number(fields[0]), startMs: wallMs - parsePsTime(fields[etimeColumn] ?? '') * 1000 }))
```

- [ ] **Step 4: Run the checks.**

Run: `cd /home/vscode/proc-stats && claude plugin test . && npx -y -p typescript@5.9.3 tsc -p . && claude plugin validate .`
Expected: every test passes, the five new ones included; tsc prints nothing; `✔ Validation passed`.

- [ ] **Step 5: Commit.**

```bash
cd /home/vscode/proc-stats && git add hooks/detached.ts hooks/detached.test.ts && git commit -m "feat(detached): find this session's processes by the mark in their environment"
```

---

### Task 2: Detached rows in the snapshot

**Files:**
- Modify: `types/index.d.ts` (`ProcRow`, `Snapshot`)
- Modify: `hooks/snapshot.ts` (`Timed`, a new `forestOrder`, `buildSnapshot`)
- Modify: `hooks/alerts.test.ts`, `hooks/report.test.ts` (their `Snapshot` fixtures gain the new fields)
- Test: `hooks/snapshot.test.ts`

**Interfaces:**
- Consumes: `treeOrder`, `procCpu` (existing, `hooks/snapshot.ts`); `Proc` from `./stats`.
- Produces:
  - `ProcRow.detached?: true`, set only on detached rows.
  - `Snapshot` gains `detachedCount: number`, `detachedKb: number`, `detachedCpuPercent: number | null` and `detachedOff?: string`. `childCount`, `childKb` and `childCpuPercent` now cover the tree and the detached rows together.
  - `Timed` gains `detached?: Proc[]`.
  - `forestOrder(procs: Proc[]): { proc: Proc; depth: number }[]`.
  - `buildSnapshot` puts the detached rows after the tree (each marked `detached: true`, in forest order). They appear only when `now.children` is defined.

- [ ] **Step 1: Declare the types.** In `types/index.d.ts`, in `ProcRow`, after `startMs: number`, add:

```ts
  // Set on a process this session started that no longer runs under Claude Code.
  detached?: true
```

and in `Snapshot` replace

```ts
  // Over every process found, capped rows included.
  childCount: number
  childKb: number
  childCpuPercent: number | null
}
```

with

```ts
  // Over every process found, capped rows included: those under Claude Code and the detached ones.
  childCount: number
  childKb: number
  childCpuPercent: number | null
  // The detached processes alone (rows marked detached, after the tree).
  detachedCount: number
  detachedKb: number
  detachedCpuPercent: number | null
  // Why detached processes are not tracked, when they are not (Windows says nothing).
  detachedOff?: string
}
```

- [ ] **Step 2: Give the existing fixtures the new fields.** In `hooks/alerts.test.ts`, the `snapshot` helper's object gains these lines after `childCpuPercent: 0,`:

```ts
  detachedCount: 0,
  detachedKb: 0,
  detachedCpuPercent: 0,
```

In `hooks/report.test.ts`, the `snapshot` helper's object gains the same three lines after its `childCpuPercent: …` line.

- [ ] **Step 3: Write the failing tests.** In `hooks/snapshot.test.ts`, change the import to

```ts
import { buildSnapshot, forestOrder, procCpu, treeOrder } from './snapshot'
```

and append:

```ts
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
```

- [ ] **Step 4: Run them to see them fail.**

Run: `cd /home/vscode/proc-stats && claude plugin test .`
Expected: `hooks/snapshot.test.ts` fails to load (`forestOrder` is not exported), or its three new tests fail; every other test passes.

- [ ] **Step 5: Implement** in `hooks/snapshot.ts`. Replace

```ts
// The engine, and the processes it started (undefined when the table cannot be read).
export type Timed = { engine: Sample; children?: Proc[]; wallMs: number }
```

with

```ts
// The engine, the processes under it (undefined when the table cannot be read), and the detached
// processes this session started (left out where they are not tracked).
export type Timed = { engine: Sample; children?: Proc[]; detached?: Proc[]; wallMs: number }
```

Above `export const buildSnapshot = (`, add:

```ts
// A parent no process has, for forestOrder's roots.
const FOREST_ROOT = -1

// Processes as a forest: each whose parent is not among them is a root, roots by pid.
export const forestOrder = (procs: Proc[]) => {
  const pids = new Set(procs.map(proc => proc.pid))
  const byPid = new Map(procs.map(proc => [proc.pid, proc]))
  const rooted = procs.map(proc => (pids.has(proc.ppid) ? proc : { ...proc, ppid: FOREST_ROOT }))

  return treeOrder(rooted, FOREST_ROOT).map(({ proc, depth }) => ({ proc: byPid.get(proc.pid)!, depth }))
}

```

In `buildSnapshot`, replace

```ts
  const was = new Map((before?.children ?? []).map(proc => [proc.pid, proc]))
  const canCompare = isMeasured && before?.children !== undefined && now.children !== undefined
  let childDelta = 0
  const rows = now.children
    ? treeOrder(now.children, pid).map(({ proc, depth }): ProcRow => {
        const cpu = canCompare ? procCpu(proc, was.get(proc.pid), elapsed) : undefined
        childDelta += cpu?.delta ?? 0

        return {
          pid: proc.pid,
          ppid: proc.ppid,
          depth,
          command: proc.command,
          rssKb: proc.rssKb,
          cpuPercent: cpu ? cpu.percent : null,
          uptimeSeconds: proc.uptimeSeconds,
          startMs: Math.round(now.wallMs - proc.uptimeSeconds * 1000),
        }
      })
    : null
```

with

```ts
  const was = new Map([...(before?.children ?? []), ...(before?.detached ?? [])].map(proc => [proc.pid, proc]))
  const canCompare = isMeasured && before?.children !== undefined && now.children !== undefined
  let childDelta = 0
  let detachedDelta = 0
  const toRow = ({ proc, depth }: { proc: Proc; depth: number }, isDetached: boolean): ProcRow => {
    const cpu = canCompare ? procCpu(proc, was.get(proc.pid), elapsed) : undefined
    childDelta += cpu?.delta ?? 0
    if (isDetached) detachedDelta += cpu?.delta ?? 0

    return {
      pid: proc.pid,
      ppid: proc.ppid,
      depth,
      command: proc.command,
      rssKb: proc.rssKb,
      cpuPercent: cpu ? cpu.percent : null,
      uptimeSeconds: proc.uptimeSeconds,
      startMs: Math.round(now.wallMs - proc.uptimeSeconds * 1000),
      ...(isDetached ? { detached: true as const } : {}),
    }
  }
  // The tree under Claude Code, then the detached processes; the detached ones only with the tree.
  const detachedRows = now.children ? forestOrder(now.detached ?? []).map(each => toRow(each, true)) : []
  const rows = now.children ? [...treeOrder(now.children, pid).map(each => toRow(each, false)), ...detachedRows] : null
```

and at the end of the returned object, after `childCpuPercent: canCompare ? (childDelta / elapsed) * 100 : null,`, add:

```ts
    detachedCount: detachedRows.length,
    detachedKb: detachedRows.reduce((sum, row) => sum + row.rssKb, 0),
    detachedCpuPercent: canCompare ? (detachedDelta / elapsed) * 100 : null,
```

- [ ] **Step 6: Run the checks.**

Run: `cd /home/vscode/proc-stats && claude plugin test . && npx -y -p typescript@5.9.3 tsc -p . && claude plugin validate .`
Expected: every test passes; tsc prints nothing; `✔ Validation passed`.

- [ ] **Step 7: Commit.**

```bash
cd /home/vscode/proc-stats && git add types/index.d.ts hooks/snapshot.ts hooks/snapshot.test.ts hooks/alerts.test.ts hooks/report.test.ts && git commit -m "feat(snapshot): detached rows after the tree, with their own subtotal inside the totals"
```

---

### Task 3: Marking the session and reading detached processes

**Files:**
- Modify: `types/index.d.ts` (a `SessionMark` type; `session` in `PluginState`)
- Modify: `hooks/sampler.ts` (`Gathered` gains `detached`)
- Modify: `hooks/register.ts` (the session mark, Linux and macOS detached reads, the readings)
- Test: `hooks/sampling.test.ts` (new)

**Interfaces:**
- Consumes: Task 1's `candidatesOf`, `environHasMark`, `macMarkedPids`, `oursOf`, `rememberMarks`, `startedFrom`, `unreadOf`, `MarkCache`; Task 2's `Timed.detached`, `Snapshot.detachedOff`; `parseMacFields` from `./stats`.
- Produces: `type SessionMark = { id: string; startMs: number }` and state `{ plugin: 'proc-stats', key: 'session' }`. Each reading on Linux and macOS carries the detached processes. A reading taken while the mark could not be set carries `detachedOff: 'Detached processes are not tracked: the session mark could not be set.'`.

- [ ] **Step 1: Declare the types.** In `types/index.d.ts`, above `// Who started a process:`, add:

```ts
// This session's mark: the id its commands carry in PROC_STATS_SESSION, and when it was made (ms since the epoch).
export type SessionMark = { id: string; startMs: number }

```

and replace the `PluginState` body's last comment line and declaration

```ts
    // origins: recorded Bash/Monitor calls and the origins of listed processes.
    'proc-stats': { reading: Reading; isOpen: boolean; history: History; alerts: AlertState; pane: PaneState; origins: Origins }
```

with

```ts
    // origins: recorded Bash/Monitor calls and the origins of listed processes.
    // session: the mark detached processes are found by, kept across reloads.
    'proc-stats': {
      reading: Reading
      isOpen: boolean
      history: History
      alerts: AlertState
      pane: PaneState
      origins: Origins
      session: SessionMark
    }
```

In `hooks/sampler.ts`, replace `export type Gathered = { engine: Sample; children?: Proc[] }` with:

```ts
// Claude Code, the processes under it, and the detached processes this session started (where tracked).
export type Gathered = { engine: Sample; children?: Proc[]; detached?: Proc[] }
```

- [ ] **Step 2: Write the failing tests** in `hooks/sampling.test.ts`:

```ts
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import type { Reading } from '../types'

type On = Parameters<TestBody>[1]

const NOW = 100_000_000
const START = { cwd: '/', surface: null, isInteractive: true }
const ran = (stdout: string) => ({ value: { stdout, stderr: '', exitCode: 0, isStdoutTruncated: false, isStderrTruncated: false } })

// A session on `os` under a mocked clock at NOW: the mark it sets (or the refusal), and each reading it
// writes. `answer` gives the output of each other command, by its argv joined with spaces.
const startSession = (on: On, os: 'Linux' | 'Darwin', answer: (argv: string, marks: string[]) => string, isEnvRefused = false) => {
  const clock = mock.clock(on, { now: NOW })
  on('session.start', () => ({ cwd: '/' }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.status', () => ({ value: undefined }))
  mock.env(on, {})
  const marks: string[] = []
  on('env.set', (_$, e) => {
    if (isEnvRefused) throw new Error('refused')
    marks.push(`${e.name}=${e.value}`)
    return { value: undefined }
  })
  const readings: Reading[] = []
  on('state.set', { plugin: 'proc-stats', key: 'reading' } as const, (_$, e, next) => {
    readings.push(e.value as Reading)
    return next(e)
  })
  on('process.run', (_$, e) => {
    const argv = e.argv.join(' ')
    if (argv === 'uname -s') return ran(`${os}\n`)
    if (argv === 'sh -c echo $PPID') return ran('10\n')
    return ran(answer(argv, marks))
  })

  return { clock, marks, readings }
}

// Linux /proc files: each pid with its parent, 1 MB, started 10 s ago; `environs` by pid (others unreadable).
const procFiles = (on: On, parents: Record<number, number>, environs: Record<number, (mark: string) => string>, marks: string[], reads: string[]) =>
  on('fs.read', (_$, e) => {
    reads.push(e.path)
    const [, , pidText, file] = e.path.split('/')
    const pid = Number(pidText)
    if (e.path === '/proc/uptime') return { value: '1000.00 0' }
    if (file === 'status') return { value: 'VmRSS:\t1024 kB\nVmHWM:\t2048 kB\n' }
    if (file === 'stat') return { value: `${pid} (x) S ${parents[pid] ?? 1} 0 0 0 0 0 0 0 0 0 50 50 0 0 0 0 0 0 99000 0 0` }
    if (file === 'cmdline') return { value: `cmd${pid}\0` }
    const environ = environs[pid]
    if (file === 'environ' && environ) return { value: environ(marks[0] ?? '') }
    throw new Error(`ENOENT: ${e.path}`)
  })

test('Linux: the session is marked, and a process carrying the mark outside Claude Code is detached', async ($, on) => {
  // 11 runs under Claude Code (10); 40 and its child 42 carry the mark; 41 does not; 50 cannot be read;
  // 1 started before the session.
  const { clock, marks, readings } = startSession(on, 'Linux', () =>
    '99\n  1 0 1-00:00:00\n 10 1 05:00\n 11 10 00:00\n 40 1 00:00\n 41 1 00:00\n 42 40 00:00\n 50 1 00:00\n 99 10 00:00\n',
  )
  const reads: string[] = []
  procFiles(on, { 10: 1, 11: 10, 40: 1, 41: 1, 42: 40 }, { 40: mark => `A=1\0${mark}\0`, 41: () => 'A=1\0', 42: mark => `${mark}\0` }, marks, reads)
  await $.session.start(START)
  await clock.settle()
  await clock.advance(1000)
  expect(marks.length).toBe(1)
  expect(marks[0]).toMatch(/^PROC_STATS_SESSION=[0-9a-f-]{36}$/)
  const snapshot = readings.at(-1)?.snapshot
  expect(snapshot?.children?.map(row => [row.pid, row.depth, row.detached ?? false])).toEqual([
    [11, 0, false],
    [40, 0, true],
    [42, 1, true],
  ])
  expect([snapshot?.childCount, snapshot?.detachedCount, snapshot?.detachedOff]).toEqual([3, 2, undefined])
  // Two readings, and each environment read once.
  expect(readings.length).toBe(2)
  expect(reads.filter(path => path.endsWith('/environ')).sort()).toEqual([
    '/proc/40/environ',
    '/proc/41/environ',
    '/proc/42/environ',
    '/proc/50/environ',
  ])
})

test('a reload keeps the session mark it made', async ($, on) => {
  const { clock, marks } = startSession(on, 'Linux', () => '99\n 10 1 05:00\n')
  procFiles(on, { 10: 1 }, {}, [], [])
  await $.session.start(START)
  await $.session.start(START)
  await clock.settle()
  expect(marks.length).toBe(2)
  expect(marks[1]).toBe(marks[0])
})

test('the session mark could not be set: no detached processes, and the reading says why', async ($, on) => {
  const { clock, readings } = startSession(on, 'Linux', () => '99\n 10 1 05:00\n 40 1 00:00\n', true)
  const reads: string[] = []
  procFiles(on, { 10: 1, 40: 1 }, {}, [], reads)
  await $.session.start(START)
  await clock.settle()
  const snapshot = readings.at(-1)?.snapshot
  expect(snapshot?.detachedOff).toBe('Detached processes are not tracked: the session mark could not be set.')
  expect(snapshot?.detachedCount).toBe(0)
  expect(reads.some(path => path.endsWith('/environ'))).toBe(false)
})

test('macOS: one ps eww over the new processes finds the marked ones', async ($, on) => {
  const scans: string[] = []
  const { clock, readings } = startSession(on, 'Darwin', (argv, marks) => {
    if (!argv.startsWith('ps eww')) {
      return '99\n 10 1 1024 0:01.00 05:00 claude\n 40 1 2048 0:00.50 00:00 node server.js\n 41 1 512 0:00.00 00:00 sleep 60\n 99 10 100 0:00.00 00:00 ps\n'
    }
    scans.push(argv)
    return ` 40 node server.js HOME=/Users/me ${marks[0]}\n 41 sleep 60 HOME=/Users/me\n`
  })
  await $.session.start(START)
  await clock.settle()
  await clock.advance(2000)
  const snapshot = readings.at(-1)?.snapshot
  expect(snapshot?.children?.map(row => [row.pid, row.detached ?? false, row.command])).toEqual([[40, true, 'node server.js']])
  expect(readings.length).toBe(2)
  expect(scans).toEqual(['ps eww -o pid=,command= -p 40,41'])
})
```

- [ ] **Step 3: Run them to see them fail.**

Run: `cd /home/vscode/proc-stats && claude plugin test .`
Expected: the four `hooks/sampling.test.ts` tests fail (no mark is set; no row is detached); every other test passes.

- [ ] **Step 4: Implement** in `hooks/register.ts`.

Imports: the `../types` import gains `SessionMark`:

```ts
import type { AlertState, History, Origin, OriginCall, Origins, PaneState, Point, Reading, SessionMark, StopState } from '../types'
```

below `import { EMPTY_ALERTS, markerFor, stepAlerts, worse } from './alerts'` add

```ts
import { candidatesOf, environHasMark, macMarkedPids, oursOf, rememberMarks, startedFrom, unreadOf } from './detached'
import type { MarkCache } from './detached'
```

and the `./stats` import becomes

```ts
import { isComplete, parseMacFields, parsePsTable, powerShellSample } from './stats'
```

Below `const origins = atom(ORIGINS, EMPTY_ORIGINS as Origins)`:

```ts
const SESSION = { plugin: 'proc-stats', key: 'session' } as const
const session = atom(SESSION, { id: '', startMs: 0 } as SessionMark)
// macOS reads environments with one `ps eww` at most this often.
const MAC_SCAN_MS = 10_000
const DETACHED_OFF = 'Detached processes are not tracked: the session mark could not be set.'
```

Above `const readLinuxChild = async`:

```ts
// What finding detached processes keeps between readings: the session's mark, what is known of
// each pid's environment, and when macOS last read environments.
type Finder = { mark: SessionMark; cache: MarkCache; scannedAt: number }

// Linux: the environment of each candidate not read before, once; one that cannot be read is not ours.
const linuxDetached = async ($: EngineInterface, finder: Finder, rows: string[][], excluded: Set<number>, wallMs: number) => {
  const candidates = candidatesOf(startedFrom(rows, 2, wallMs), excluded, finder.mark.startMs)
  const read = await Promise.all(
    unreadOf(finder.cache, candidates).map(async each => {
      try {
        return { ...each, isOurs: environHasMark(await $.fs.read(`/proc/${each.pid}/environ`), finder.mark.id) }
      } catch {
        return { ...each, isOurs: false }
      }
    }),
  )
  finder.cache = rememberMarks(finder.cache, candidates, read)

  return oursOf(finder.cache, candidates)
}

// macOS: one `ps eww` over the candidates not read before, at most every MAC_SCAN_MS; until it runs they are not shown.
const macDetached = async ($: EngineInterface, finder: Finder, rows: string[][], excluded: Set<number>, wallMs: number) => {
  const candidates = candidatesOf(startedFrom(rows, 4, wallMs), excluded, finder.mark.startMs)
  const unread = unreadOf(finder.cache, candidates)
  let read: { pid: number; startMs: number; isOurs: boolean }[] = []
  if (unread.length > 0 && wallMs - finder.scannedAt >= MAC_SCAN_MS) {
    finder.scannedAt = wallMs
    try {
      const { stdout } = await $.process.run(['ps', 'eww', '-o', 'pid=,command=', '-p', unread.map(each => each.pid).join(',')])
      const marked = macMarkedPids(stdout, finder.mark.id)
      read = unread.map(each => ({ ...each, isOurs: marked.has(each.pid) }))
    } catch {
      // Read again at the next scan.
    }
  }
  finder.cache = rememberMarks(finder.cache, candidates, read)

  return oursOf(finder.cache, candidates)
}

```

Replace `readLinux` and `readMac`

```ts
const readLinux = async ($: EngineInterface, pid: number): Promise<Gathered> => {
  const [status, stat, uptime] = await Promise.all([
    $.fs.read(`/proc/${pid}/status`),
    $.fs.read(`/proc/${pid}/stat`),
    $.fs.read('/proc/uptime'),
  ])
  const engine = linuxEngine(status, stat, uptime)
  try {
    const pids = childPids(await psTable($, 'pid=,ppid='), pid)
    const procs = await Promise.all(pids.map(child => readLinuxChild($, child, uptime)))

    return { engine, children: procs.filter(proc => proc !== undefined) }
  } catch {
    return { engine }
  }
}

const readMac = async ($: EngineInterface, pid: number, peakSeenKb: number) =>
  macReading(await psTable($, 'pid=,ppid=,rss=,time=,etime=,command='), pid, peakSeenKb)
```

with

```ts
const readLinux = async ($: EngineInterface, pid: number, finder: Finder | null): Promise<Gathered> => {
  const [status, stat, uptime] = await Promise.all([
    $.fs.read(`/proc/${pid}/status`),
    $.fs.read(`/proc/${pid}/stat`),
    $.fs.read('/proc/uptime'),
  ])
  const engine = linuxEngine(status, stat, uptime)
  try {
    const table = await psTable($, 'pid=,ppid=,etime=')
    const pids = childPids(table, pid)
    const excluded = new Set([pid, table.selfPid, ...pids])
    const ours = finder ? await linuxDetached($, finder, table.rows, excluded, await $.clock.now()) : []
    const [procs, detached] = await Promise.all([
      Promise.all(pids.map(child => readLinuxChild($, child, uptime))),
      Promise.all(ours.map(each => readLinuxChild($, each, uptime))),
    ])

    return { engine, children: procs.filter(proc => proc !== undefined), detached: detached.filter(proc => proc !== undefined) }
  } catch {
    return { engine }
  }
}

const readMac = async ($: EngineInterface, pid: number, peakSeenKb: number, finder: Finder | null): Promise<Gathered> => {
  const table = await psTable($, 'pid=,ppid=,rss=,time=,etime=,command=')
  const gathered = macReading(table, pid, peakSeenKb)
  if (!finder) return gathered
  const excluded = new Set([pid, table.selfPid, ...(gathered.children ?? []).map(child => child.pid)])
  const ours = new Set(await macDetached($, finder, table.rows, excluded, await $.clock.now()))

  return { ...gathered, detached: table.rows.filter(fields => ours.has(Number(fields[0]))).map(parseMacFields) }
}
```

`readProcesses` takes the finder and passes it on: its parameters gain `finder: Finder | null` after `peakSeenKb: number`, and its two cases become `return readLinux($, pid, finder)` and `return readMac($, pid, peakSeenKb, finder)` (Windows unchanged).

Replace

```ts
// One loop feeds both views: the status line, and the reading the pane draws.
const startSampling = async ($: EngineInterface, settings: Settings) => {
```

with

```ts
// This session's mark: made once and kept across reloads, then set for every command started from now
// on. Null when it could not be set: detached processes are then not tracked.
const markSession = async ($: EngineInterface): Promise<SessionMark | null> => {
  try {
    const fresh = { id: crypto.randomUUID(), startMs: await $.clock.now() }
    let mark = fresh
    await update($, session, kept => (mark = kept.id ? kept : fresh))
    await $.env.set('PROC_STATS_SESSION', mark.id)

    return mark
  } catch {
    return null
  }
}

// One loop feeds both views: the status line, and the reading the pane draws.
const startSampling = async ($: EngineInterface, settings: Settings, mark: SessionMark | null) => {
```

In `startSampling`, after `let isBusy = false`, add:

```ts
    // Windows finds no detached processes (documented); elsewhere only with the session marked.
    const finder: Finder | null = mark && platform !== 'windows' ? { mark, cache: new Map(), scannedAt: -Infinity } : null
    const detachedOff = mark === null && platform !== 'windows' ? { detachedOff: DETACHED_OFF } : {}
```

and in `sample`, replace

```ts
        const sample = await readProcesses($, platform, pid, before?.engine.peakKb ?? 0)
        if (!isComplete(sample.engine)) throw new Error('unreadable sample')
        const now = { ...sample, wallMs: await $.clock.now() }
        const snapshot = buildSnapshot(platform, pid, now, before)
```

with

```ts
        const sample = await readProcesses($, platform, pid, before?.engine.peakKb ?? 0, finder)
        if (!isComplete(sample.engine)) throw new Error('unreadable sample')
        const now = { ...sample, wallMs: await $.clock.now() }
        const snapshot = { ...buildSnapshot(platform, pid, now, before), ...detachedOff }
```

In the `session.start` hook, replace `void startSampling($, settings)` with:

```ts
    void startSampling($, settings, await markSession($))
```

- [ ] **Step 5: Run the checks.**

Run: `cd /home/vscode/proc-stats && claude plugin test . && npx -y -p typescript@5.9.3 tsc -p . && claude plugin validate .`
Expected: every test passes, the four `hooks/sampling.test.ts` tests included; tsc prints nothing; `✔ Validation passed`. Its list of state reads names `proc-stats.session`.

- [ ] **Step 6: Commit.**

```bash
cd /home/vscode/proc-stats && git add types/index.d.ts hooks/sampler.ts hooks/register.ts hooks/sampling.test.ts && git commit -m "feat(sampling): mark the session and read detached processes on Linux and macOS"
```

---

### Task 4: The Detached group in the pane

**Files:**
- Modify: `hooks/view.ts` (`viewRows`, `detailLines`, a new `subtotals`, `totalLines`)
- Modify: `hooks/pane.tsx` (a heading before the detached rows; the `detachedOff` line)
- Test: `hooks/view.test.ts`, `hooks/pane.test.ts`

**Interfaces:**
- Consumes: Task 2's `ProcRow.detached`, `Snapshot.detachedCount | detachedKb | detachedCpuPercent | detachedOff`, and `Timed.detached`.
- Produces:
  - `export type Subtotal = { count: number; kb: number; cpuPercent: number | null }`
  - `export const subtotals = (snapshot: Snapshot): { under: Subtotal; detached: Subtotal }`, which Task 5's report uses. A reading without the detached fields counts none detached.
  - `totalLines` returns, in order: `Child processes (n)` while there are any under Claude Code, `Detached (n)` while there are any detached, then `Total`.

- [ ] **Step 1: Write the failing tests.** Append to `hooks/view.test.ts`:

```ts
// Claude Code 10 → 11 (sleep); detached: 40 (a server) → 41 (its worker), started by this session.
const withDetached = () => {
  const before: Timed = { engine, children: [proc(11, 10)], detached: [proc(40, 1), proc(41, 40)], wallMs: 0 }
  const now: Timed = {
    engine: { ...engine, cpuSeconds: 1.5 },
    children: [proc(11, 10, { command: 'sleep 30', rssKb: 1 * MB, uptimeSeconds: 105 })],
    detached: [
      proc(40, 1, { command: 'node server.js', rssKb: 30 * MB, cpuSeconds: 0.5, uptimeSeconds: 105 }),
      proc(41, 40, { command: 'node worker', rssKb: 20 * MB, uptimeSeconds: 105 }),
    ],
    wallMs: 5000,
  }
  return buildSnapshot('linux', 10, now, before)
}

test('detached processes: their own tree lines after the tree; named detached when sorted', () => {
  const snapshot = withDetached()
  expect(viewRows(snapshot, state()).map(view => [view.row.pid, view.prefix + view.label])).toEqual([
    [11, '└ sleep 30'],
    [40, '└ node server.js'],
    [41, '  └ node worker'],
  ])
  expect(viewRows(snapshot, state({ sort: 'mem' })).map(view => [view.row.pid, view.parent])).toEqual([
    [40, 'detached'],
    [41, 'node server.js'],
    [11, 'Claude Code'],
  ])
})

test('detached processes: a subtotal of their own, inside the total; details say so', () => {
  const snapshot = withDetached()
  expect(totalLines(snapshot)).toEqual([
    { label: 'Child processes (1)', mem: '1MB', cpu: '0.0%' },
    { label: 'Detached (2)', mem: '50MB', cpu: '10.0%' },
    { label: 'Total', mem: '535MB', cpu: '20.0%' },
  ])
  const server = snapshot.children!.find(row => row.pid === 40)!
  expect(detailLines(snapshot, { pid: 40, startMs: server.startMs })?.slice(1)).toEqual([
    expect.stringContaining('pid 40 · parent 1 (pid 1)'),
    'detached: started in this session, no longer under Claude Code',
  ])
  // Only detached processes: no subtotal for an empty tree.
  const alone: Snapshot = { ...snapshot, children: snapshot.children!.filter(row => row.detached), childCount: 2, childKb: 50 * MB, childCpuPercent: 10 }
  expect(totalLines(alone).map(line => line.label)).toEqual(['Detached (2)', 'Total'])
})

test('a reading saved before detached processes were tracked draws as before', () => {
  const snapshot = tree()
  const { detachedCount, detachedKb, detachedCpuPercent, ...older } = snapshot
  expect(totalLines(older as Snapshot).map(line => line.label)).toEqual(['Child processes (4)', 'Total'])
})
```

Append to `hooks/pane.test.ts`:

```ts
test('detached processes: a heading of their own in the tree, none when sorted; why they are not tracked', async ($, on) => {
  const detached = buildSnapshot(
    'linux',
    10,
    { ...now, detached: [proc(40, 1, { command: 'node server.js' })] },
    { ...before, detached: [proc(40, 1)] },
  )
  let reading: { snapshot: typeof detached } = { snapshot: detached }
  on('state.get', { plugin: 'proc-stats', key: 'reading' }, () => ({ value: { value: reading, version: 1 } }))
  const ui = await $.ui.mount({
    plugin: 'proc-stats',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'proc-stats',
    props: { ...PANE_PROPS, bodyColumns: 80 },
  })
  expect(await ui.find({ type: 'Text', text: /^\s*Detached$/ })).toBeDefined()
  expect(await ui.find({ key: 'pid:40' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Detached \(1\)/ })).toBeDefined()
  await ui.press({ key: 'sort' })
  expect(await ui.find({ type: 'Text', text: /^\s*Detached$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /not tracked/ })).toBeUndefined()
  reading = { snapshot: { ...snapshot, detachedOff: 'Detached processes are not tracked: the session mark could not be set.' } }
  await ui.press({ key: 'sort' })
  expect(await ui.find({ type: 'Text', text: /Detached processes are not tracked/ })).toBeDefined()
  await ui.unmount()
})
```

- [ ] **Step 2: Run them to see them fail.**

Run: `cd /home/vscode/proc-stats && claude plugin test .`
Expected: the four new tests fail:
- the last tree row reads `├`;
- the sorted parent reads `pid 1`;
- the totals have no `Detached` line;
- the pane has no heading.

Every other test passes.

- [ ] **Step 3: Implement** in `hooks/view.ts`.

In `viewRows`, the sorted view's `parent:` line becomes:

```ts
        parent: row.ppid === snapshot.pid ? 'Claude Code' : row.detached && !labels.has(row.ppid) ? 'detached' : label(row.ppid),
```

and its end

```ts
  const prefixes = treePrefixes(visible.map(view => view.row))

  return visible.map((view, index) => ({ ...view, prefix: prefixes[index] ?? '' }))
```

becomes

```ts
  // The tree and the detached group (which follows it) each draw their own lines.
  const prefixes = [
    ...treePrefixes(visible.filter(view => !view.row.detached).map(view => view.row)),
    ...treePrefixes(visible.filter(view => view.row.detached).map(view => view.row)),
  ]

  return visible.map((view, index) => ({ ...view, prefix: prefixes[index] ?? '' }))
```

In `detailLines`, insert before `const origin = origins ? originOf(origins, row) : null`:

```ts
  if (row.detached) lines.push('detached: started in this session, no longer under Claude Code')
```

Replace `totalLines` and its comment

```ts
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
```

with

```ts
export type Subtotal = { count: number; kb: number; cpuPercent: number | null }

// The processes under Claude Code and the detached ones, apart. A reading saved before detached
// processes were tracked has none detached.
export const subtotals = (snapshot: Snapshot): { under: Subtotal; detached: Subtotal } => {
  const { childCount, childKb, childCpuPercent } = snapshot
  const { detachedCount = 0, detachedKb = 0, detachedCpuPercent = 0 } = snapshot
  const underCpu = childCpuPercent === null || detachedCpuPercent === null ? null : Math.max(0, childCpuPercent - detachedCpuPercent)

  return {
    under: { count: childCount - detachedCount, kb: childKb - detachedKb, cpuPercent: underCpu },
    detached: { count: detachedCount, kb: detachedKb, cpuPercent: detachedCpuPercent },
  }
}

// Each subtotal while it has processes, then the session total, when there are any.
export const totalLines = (snapshot: Snapshot): TotalLine[] => {
  const { engine, children, childCount, childKb, childCpuPercent } = snapshot
  if (children === null || childCount === 0) return []
  const both = engine.cpuPercent !== null && childCpuPercent !== null ? engine.cpuPercent + childCpuPercent : null
  const { under, detached } = subtotals(snapshot)
  const line = (label: string, subtotal: Subtotal) => ({
    label: `${label} (${subtotal.count})`,
    mem: formatBytes(subtotal.kb),
    cpu: formatPercent(subtotal.cpuPercent),
  })

  return [
    ...(under.count > 0 ? [line('Child processes', under)] : []),
    ...(detached.count > 0 ? [line('Detached', detached)] : []),
    { label: 'Total', mem: formatBytes(engine.rssKb + childKb), cpu: formatPercent(both) },
  ]
}
```

In `hooks/pane.tsx`, replace

```tsx
  // Zebra rows count Claude Code's own as the first.
  const childRows = views.map((view, index) =>
    row(
      `pid:${view.row.pid}`,
      { pid: view.row.pid, startMs: view.row.startMs, hasChildren: view.hasChildren && state.sort === 'tree' },
      commandCell(view, commandWidth, originText(origins, view.row)),
      numbers(formatBytes(view.rssKb), formatPercent(view.cpuPercent), formatDuration(view.row.uptimeSeconds)),
      String(view.row.pid),
      index % 2 === 0,
      false,
    ),
  )
```

with

```tsx
  // In the tree, the detached group follows a heading of its own.
  const firstDetached = state.sort === 'tree' ? views.findIndex(view => view.row.detached) : -1
  const detachedHeading = (
    <Box paddingX={ROW_PADDING_X}>
      <Text bold dimColor>{`${pidCell('')}Detached`}</Text>
    </Box>
  )
  // Zebra rows count Claude Code's own as the first.
  const childRows = views.flatMap((view, index) => [
    ...(index === firstDetached ? [detachedHeading] : []),
    row(
      `pid:${view.row.pid}`,
      { pid: view.row.pid, startMs: view.row.startMs, hasChildren: view.hasChildren && state.sort === 'tree' },
      commandCell(view, commandWidth, originText(origins, view.row)),
      numbers(formatBytes(view.rssKb), formatPercent(view.cpuPercent), formatDuration(view.row.uptimeSeconds)),
      String(view.row.pid),
      index % 2 === 0,
      false,
    ),
  ])
```

and after the `{note !== null && ( … )}` block, add:

```tsx
      {snapshot.detachedOff !== undefined && (
        <Box paddingX={ROW_PADDING_X}>
          <Text dimColor>{`${pidCell('')}${snapshot.detachedOff}`}</Text>
        </Box>
      )}
```

- [ ] **Step 4: Run the checks.**

Run: `cd /home/vscode/proc-stats && claude plugin test . && npx -y -p typescript@5.9.3 tsc -p . && claude plugin validate .`
Expected: every test passes; tsc prints nothing; `✔ Validation passed`.

- [ ] **Step 5: Commit.**

```bash
cd /home/vscode/proc-stats && git add hooks/view.ts hooks/pane.tsx hooks/view.test.ts hooks/pane.test.ts && git commit -m "feat(pane): a Detached group with its own subtotal, details, and why it is off"
```

---

### Task 5: Detached processes in the report; docs and version

**Files:**
- Modify: `hooks/report.ts`
- Test: `hooks/report.test.ts`
- Modify: `README.md`, `.claude-plugin/plugin.json` (version `0.2.7` → `0.3.0`)

**Interfaces:**
- Consumes: Task 4's `subtotals` from `./view`; Task 2's `ProcRow.detached` and `Snapshot.detachedOff`.
- Produces: `export const DETACHED_LISTED = 10`. The `Now:` line gives the subtotal under Claude Code, then the detached subtotal (while there are any), then the total. The `detachedOff` reason follows it. Heaviest rows that are detached end in ` · detached`. A `Detached processes:` list follows the heaviest list (`Detached processes (10 of n):` past 10).

- [ ] **Step 1: Write the failing tests.** Append to `hooks/report.test.ts`:

```ts
test('report: detached processes, their subtotal and their own list', () => {
  const server = { ...row(40, 300, 12, 'node server.js'), ppid: 1, detached: true as const }
  const worker = { ...row(41, 30, 2, 'node worker'), ppid: 40, depth: 1, detached: true as const }
  const detached: Snapshot = {
    ...snapshot([row(11, 20, 1), server, worker]),
    detachedCount: 2,
    detachedKb: 330 * MB,
    detachedCpuPercent: 14,
  }
  expect(reportText(input({ reading: { snapshot: detached } }))).toBe(
    [
      'report · Linux · Claude Code pid 10 · up 1h 2m',
      'Now: Claude Code 484MB, 2.0% CPU · 1 child process 20MB, 1.0% CPU · 2 detached 330MB, 14.0% CPU · total 834MB, 17.0% CPU',
      'Peaks in the last 10 min: no history yet',
      'Heaviest processes:',
      '  1. 300MB · 12.0% CPU · pid 40 · node server.js · detached',
      '  2. 30MB · 2.0% CPU · pid 41 · node worker · detached',
      '  3. 20MB · 1.0% CPU · pid 11 · cmd11',
      'Detached processes:',
      '  1. 300MB · 12.0% CPU · pid 40 · node server.js',
      '  2. 30MB · 2.0% CPU · pid 41 · node worker',
      'Marker: none',
      'Recent alerts: none',
    ].join('\n'),
  )
})

test('report: only detached processes, more than it lists', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ ...row(40 + i, 12 - i, 0), ppid: 1, detached: true as const }))
  const alone: Snapshot = { ...snapshot(many), detachedCount: 12, detachedKb: 78 * MB, detachedCpuPercent: 0 }
  const lines = reportText(input({ reading: { snapshot: alone } })).split('\n')
  expect(lines[1]).toBe('Now: Claude Code 484MB, 2.0% CPU · no child processes · 12 detached 78MB, 0.0% CPU · total 562MB, 2.0% CPU')
  expect(lines[9]).toBe('Detached processes (10 of 12):')
  expect(lines[19]).toBe('  10. 3MB · 0.0% CPU · pid 49 · cmd49')
  expect(lines[20]).toBe('Marker: none')
})

test('report: says when detached processes are not tracked', () => {
  const off: Snapshot = { ...snapshot([]), detachedOff: 'Detached processes are not tracked: the session mark could not be set.' }
  expect(reportText(input({ reading: { snapshot: off } })).split('\n').slice(1, 3)).toEqual([
    'Now: Claude Code 484MB, 2.0% CPU · no child processes',
    'Detached processes are not tracked: the session mark could not be set.',
  ])
})
```

- [ ] **Step 2: Run them to see them fail.**

Run: `cd /home/vscode/proc-stats && claude plugin test .`
Expected: the three new `report:` tests fail (no detached subtotal, list or reason); every other test passes.

- [ ] **Step 3: Implement** in `hooks/report.ts`.

The `./view` import becomes `import { labelOf, subtotals } from './view'`. Below `export const HEAVIEST = 5` add:

```ts
// How many detached processes the report lists, heaviest first.
export const DETACHED_LISTED = 10
```

Replace

```ts
const heaviest = (rows: ProcRow[]) =>
  [...rows]
    .sort((a, b) => b.rssKb - a.rssKb || (b.cpuPercent ?? 0) - (a.cpuPercent ?? 0) || a.pid - b.pid)
    .slice(0, HEAVIEST)
```

with

```ts
// Most memory first, then most CPU, then the lower pid.
const byWeight = (rows: ProcRow[]) =>
  [...rows].sort((a, b) => b.rssKb - a.rssKb || (b.cpuPercent ?? 0) - (a.cpuPercent ?? 0) || a.pid - b.pid)

// One listed process: its figures, command and origin, and (where asked) whether it is detached.
const processLine = (row: ProcRow, index: number, origins: Origins, isDetachedShown: boolean) => {
  const origin = originOf(origins, row)
  const from = origin ? ` · ${originLabel(origin)}` : ''
  const detached = isDetachedShown && row.detached ? ' · detached' : ''

  return `  ${index + 1}. ${formatBytes(row.rssKb)} · ${formatPercent(row.cpuPercent)} CPU · pid ${row.pid} · ${cut(labelOf(row.command))}${from}${detached}`
}

// A subtotal in words: `2 child processes 20MB, 1.0% CPU`.
const subtotalText = (count: number, noun: string, kb: number, cpuPercent: number | null) =>
  `${count} ${noun} ${formatBytes(kb)}, ${formatPercent(cpuPercent)} CPU`
```

In `reportText`, replace the `Now:` block

```ts
  const own = `Claude Code ${formatBytes(engine.rssKb)}, ${formatPercent(engine.cpuPercent)} CPU`
  if (children === null) lines.push(`Now: ${own} · child processes unknown (the process table could not be read)`)
  else if (childCount === 0) lines.push(`Now: ${own} · no child processes`)
  else {
    const noun = childCount === 1 ? 'child process' : 'child processes'
    lines.push(
      `Now: ${own} · ${childCount} ${noun} ${formatBytes(childKb)}, ${formatPercent(childCpuPercent)} CPU · total ${formatBytes(engine.rssKb + childKb)}, ${formatPercent(sum(engine.cpuPercent, childCpuPercent))} CPU`,
    )
  }
```

with

```ts
  const own = `Claude Code ${formatBytes(engine.rssKb)}, ${formatPercent(engine.cpuPercent)} CPU`
  const { under, detached } = subtotals(snapshot)
  if (children === null) lines.push(`Now: ${own} · child processes unknown (the process table could not be read)`)
  else if (childCount === 0) lines.push(`Now: ${own} · no child processes`)
  else {
    const parts = [
      under.count === 0
        ? 'no child processes'
        : subtotalText(under.count, under.count === 1 ? 'child process' : 'child processes', under.kb, under.cpuPercent),
      ...(detached.count > 0 ? [subtotalText(detached.count, 'detached', detached.kb, detached.cpuPercent)] : []),
      `total ${formatBytes(engine.rssKb + childKb)}, ${formatPercent(sum(engine.cpuPercent, childCpuPercent))} CPU`,
    ]
    lines.push(`Now: ${own} · ${parts.join(' · ')}`)
  }
  if (snapshot.detachedOff !== undefined) lines.push(snapshot.detachedOff)
```

and the heaviest block

```ts
    lines.push('Heaviest processes:')
    heaviest(children).forEach((row, index) => {
      const origin = originOf(origins, row)
      const from = origin ? ` · ${originLabel(origin)}` : ''
      lines.push(`  ${index + 1}. ${formatBytes(row.rssKb)} · ${formatPercent(row.cpuPercent)} CPU · pid ${row.pid} · ${cut(labelOf(row.command))}${from}`)
    })
```

with

```ts
    lines.push('Heaviest processes:')
    byWeight(children).slice(0, HEAVIEST).forEach((row, index) => lines.push(processLine(row, index, origins, true)))
    const detachedRows = children.filter(row => row.detached)
    if (detachedRows.length > 0) {
      lines.push(
        detached.count > DETACHED_LISTED ? `Detached processes (${DETACHED_LISTED} of ${detached.count}):` : 'Detached processes:',
      )
      byWeight(detachedRows).slice(0, DETACHED_LISTED).forEach((row, index) => lines.push(processLine(row, index, origins, false)))
    }
```

- [ ] **Step 4: Document it.** In `README.md`:

1. Replace the intro sentence `While the session has processes running under it (Bash commands, watchers, test runs, local MCP servers), their share is added after a `+`:` with:

```markdown
While the session has processes running under it (Bash commands, watchers, test runs, local MCP servers), or ones it started that have since detached, their share is added after a `+`:
```

2. Replace the `- **mem**: resident memory of Claude Code, plus every process below it.` bullet with:

```markdown
- **mem**: resident memory of Claude Code, plus every process below it and every detached process it started.
```

3. In **Processes pane**, after the `- **Rows:** …` bullet, add:

```markdown
- **Detached:** processes the session started that no longer run under Claude Code (`nohup … &`, `setsid`, daemons) follow the tree under a **Detached** heading, with their own subtotal. They count toward the totals, the history, the status-line marker and the toasts, and can be stopped like any other row. In a sorted view their parent reads `detached`. The mod finds them by a variable, `PROC_STATS_SESSION`, that it sets for every command the session starts; if it cannot set it, a line under the rows says detached processes are not tracked.
```

4. In **Report**, replace `the five processes using the most memory, with what started them;` with `the five processes using the most memory, with what started them; up to ten detached processes;`.

5. In **Platforms**, append this sentence to its paragraph:

```markdown
Detached processes are found on Linux (`/proc/<pid>/environ`, read once per process) and macOS (`ps eww`, at most every 10 seconds, so a new one can take that long to show), and not on Windows.
```

6. In **Settings**, delete the line `(Detached processes arrive in a later package; the settings exist now so the config menu does not change shape again.)` and the blank line before it.

7. In **Limits**, replace `- A process that detaches from Claude Code (`nohup`, daemons) is no longer counted.` with:

```markdown
- A detached process is found only if it keeps the environment it started with (a program that clears it, such as `env -i`, is not found), and only on Linux and macOS.
```

In `.claude-plugin/plugin.json`, change `"version": "0.2.7"` to `"version": "0.3.0"`.

- [ ] **Step 5: Run the checks.**

Run: `cd /home/vscode/proc-stats && claude plugin test . && npx -y -p typescript@5.9.3 tsc -p . && claude plugin validate .`
Expected: every test passes; tsc prints nothing; `✔ Validation passed`.

- [ ] **Step 6: Commit.**

```bash
cd /home/vscode/proc-stats && git add hooks/report.ts hooks/report.test.ts README.md .claude-plugin/plugin.json && git commit -m "feat(report): detached processes in the report; docs; 0.3.0"
```

- [ ] **Step 7 (controller, with the person): live check on Linux.** After `/reload-plugins`, the controller starts `setsid nohup sleep 120 >/dev/null 2>&1 &` from a Bash call. The person opens `/proc-stats` and checks four things:
  - `sleep 120` shows under a **Detached** heading with a `Detached (1)` subtotal;
  - its details say `detached: started in this session, no longer under Claude Code`;
  - **k** then **y** stops it;
  - `/proc-stats report` lists it under `Detached processes:`.
