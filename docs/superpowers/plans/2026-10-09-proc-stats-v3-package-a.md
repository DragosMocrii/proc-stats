# proc-stats v0.3, package A: restructure, settings, history

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the mod into focused modules with no visible change, then add the settings (`userConfig`) and the session history buffer that packages B–F build on.

**Architecture:** `register.ts` keeps every `$` call (the engine refuses `$` passed across an import); everything else becomes pure modules over plain data: `snapshot.ts`, `status.ts`, `sampler.ts`, `settings.ts`, `history.ts`. The history is a ring buffer of session totals in `$.state`, so it survives reloads.

**Tech Stack:** TypeScript Claude Code mod (hooks module, `claude-code` API), tests with `claude-code/testing` under `claude plugin test`, type-check with `tsc` 5.9.3.

**Spec:** `docs/superpowers/specs/2026-10-09-proc-stats-v3-design.md` (sections Architecture, Settings, Data and history, Pane › Reopening, Work packages › A).

## Global Constraints

- The repository is `/home/vscode/proc-stats`; all paths below are relative to it. Commit there after each task. Do not push.
- `$` may not be passed into a function imported from another file; functions in other files take plain data or element tables only.
- Every value in `$.state` is declared in `types/index.d.ts` under `PluginState['proc-stats']`, read through an `atom(ref, default)` with a safe default.
- Commands, run from the repository root:
  - tests: `claude plugin test .`
  - validate: `claude plugin validate .` (must end `✔ Validation passed` with no warnings)
  - type-check: `npx -y -p typescript@5.9.3 tsc -p .`
- Tests use only `expect(...).toBe / toEqual / toBeNull / toBeDefined / toContain / toThrow / toBeGreaterThan`; the kit has no `toBeCloseTo`, so assert exact values.
- Settings defaults (verbatim from the spec): `intervalLinuxMs` 1000, `intervalMacMs` 2000, `intervalWindowsMs` 5000, `warnMemMb` 2048, `alertMemMb` 4096, `warnCpuPct` 150, `alertCpuPct` 300, `toastCpuPct` 90, `toastCpuSeconds` 60, `toastMemMb` 1024, `historyMinutes` 10, `statusShowChildren` true. Invalid or missing values fall back to the defaults. A warning limit above its alert limit is lowered to the alert limit.
- Package A changes nothing a person sees, except the settings rows in Claude Code's config menu and the pane coming back after a reload.

## Review Focus

- **Contradictory limits** (`warnMemMb` above `alertMemMb`, or `warnCpuPct` above `alertCpuPct`): the alert limit is kept and the warn limit is lowered to it, rather than leaving a warn that can never show. Pinned in Task 4.
- **Interval changed mid-session**: the history keeps its newest points and trims to the new capacity, never growing past it or losing the newest point. Pinned in Task 5.
- **Reload mid-session**: the module's variables reset but `$.state` does not; a history read before anything was written is the empty default and appending to it works. Pinned in Task 5.
- **Points with the same timestamp, or too few points**: averages return `null` rather than dividing by zero. Pinned in Task 5.
- **A process table without Claude Code's own row** (macOS, Windows): the reading fails with a named error and nothing is appended to the history. Pinned in Task 3 (the error) and Task 5 (only successful snapshots are recorded).

---

## File structure after this package

| File | Responsibility |
|---|---|
| `hooks/register.ts` | timer, hooks, commands, every `$` call |
| `hooks/stats.ts` | per-platform text parsers (unchanged) |
| `hooks/sampler.ts` | **new**: assembling a reading from parsed text (no `$`) |
| `hooks/snapshot.ts` | **new**: `Timed`, `procCpu`, `treeOrder`, `buildSnapshot`, `capRows` (moved) |
| `hooks/status.ts` | **new**: `statusLine` (moved, gains `showChildren`) |
| `hooks/settings.ts` | **new**: `Settings`, `DEFAULTS`, `readSettings` |
| `hooks/history.ts` | **new**: `Point`, `History`, `historyCapacity`, `pushPoint`, `downsample`, `averageSince`, `pointOf` |
| `hooks/format.ts`, `hooks/pane.tsx` | unchanged |
| `hooks/fixtures.ts` | **new**: shared test fixtures (`MB`, `proc`, `engine`) |
| `hooks/*.test.ts` | one test file per module |
| `types/index.d.ts` | state contract, gains `history` |
| `.claude-plugin/plugin.json` | gains `userConfig`, version 0.2.1 |

---

### Task 1: Pane reopening without the diagnostic log

**Files:**
- Modify: `hooks/register.ts` (the `command.run` and `ui.close` hooks at the end of `register`)

**Interfaces:**
- Consumes: the existing `isOpen` atom and `OPEN` constant in `register.ts`.
- Produces: no new names.

- [ ] **Step 1: See the current warnings**

Run: `claude plugin validate . 2>&1 | grep -E "gating hook without|ui.log"`
Expected: two `gating hook without .catch` lines (`command.run`, `ui.close`) and `$.ui.log` in the calls line.

- [ ] **Step 2: Replace the two hooks**

In `hooks/register.ts`, replace the `command.run` hook and the `ui.close` hook (from `on('command.run'` through the end of the `ui.close` hook) with:

```ts
  on('command.run', { command: COMMAND }, async $ => {
    const opened = await $.ui.open(OPEN)
    await update($, isOpen, () => true)

    return { text: opened.isPlaced ? 'Processes pane opened.' : 'Processes pane could not be placed.' }
  }).catch(($, e, next) =>
    next.called ? next(e) : { text: 'proc-stats: the Processes pane could not be opened.' },
  )

  // A close the person or the engine makes. A reload is no close: the pane comes back.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    await update($, isOpen, () => false)

    return closed
  }).catch(($, e, next) => next(e))
```

- [ ] **Step 3: Validate, test, type-check**

Run: `claude plugin validate . 2>&1 | grep -E "gating hook|ui.log|✔|✘"`
Expected: two `gating hook with .catch` lines, no `$.ui.log`, `✔ Validation passed`.
Run: `claude plugin test .` → `19 pass`, `0 fail`.
Run: `npx -y -p typescript@5.9.3 tsc -p .` → no output.

- [ ] **Step 4: Commit**

```bash
git add hooks/register.ts
git commit -m "fix: pane reopening hooks catch their failures; no close log"
```

---

### Task 2: Move the snapshot and status line into their own modules

**Files:**
- Create: `hooks/snapshot.ts`, `hooks/status.ts`, `hooks/fixtures.ts`, `hooks/stats.test.ts`, `hooks/snapshot.test.ts`, `hooks/status.test.ts`, `hooks/format.test.ts`
- Rename: `hooks/register.test.ts` → `hooks/pane.test.ts`
- Modify: `hooks/register.ts`

**Interfaces:**
- Produces (unchanged signatures, new homes):
  - `snapshot.ts`: `export type Timed = { engine: Sample; children?: Proc[]; wallMs: number }`, `procCpu(now: Proc, was: Proc | undefined, elapsed: number): { delta: number; percent: number }`, `treeOrder(procs: Proc[], root: number): { proc: Proc; depth: number }[]`, `buildSnapshot(platform: Platform, pid: number, now: Timed, before: Timed | undefined): Snapshot`, `capRows(snapshot: Snapshot): Snapshot`, `MAX_ROWS = 500`.
  - `status.ts`: `statusLine(snapshot: Snapshot): string` (Task 4 adds a parameter).
  - `fixtures.ts`: `MB = 1024`, `proc(pid, ppid, extra?): Proc`, `engine: Sample`.

- [ ] **Step 1: Create `hooks/snapshot.ts`**

Move, unchanged, from `hooks/register.ts` into a new `hooks/snapshot.ts`: the `MAX_ROWS` constant and its comment, `Timed`, `procCpu`, `treeOrder`, `buildSnapshot` and `capRows`, each with its comment. Head the file with:

```ts
// Two readings into what both views draw: per-process CPU, the tree, the totals.

import type { ProcRow, Snapshot } from '../types'
import type { Platform, Proc, Sample } from './stats'

// A build can start hundreds of workers; the pane needs no more than this.
export const MAX_ROWS = 500
```

- [ ] **Step 2: Create `hooks/status.ts`**

Move `statusLine` with its comment from `hooks/register.ts` into `hooks/status.ts`, headed:

```ts
// The status line under the prompt.

import type { Snapshot } from '../types'
import { formatBytes, formatDuration, formatPair, formatPercent } from './format'
```

- [ ] **Step 3: Point `register.ts` at the new modules**

In `hooks/register.ts`: delete the moved code and the `MAX_ROWS` constant; remove `formatBytes, formatDuration, formatPair, formatPercent` and the `ProcRow`/`Snapshot` type imports if nothing left uses them; add:

```ts
import { buildSnapshot, capRows } from './snapshot'
import type { Timed } from './snapshot'
import { statusLine } from './status'
```

Run: `npx -y -p typescript@5.9.3 tsc -p .`
Expected: errors only in `hooks/register.test.ts` (its imports moved). `register.ts` itself type-checks; if it reports unused-import or missing-name errors, fix the imports.

- [ ] **Step 4: Create `hooks/fixtures.ts`**

```ts
// Shared test data: a process, and Claude Code's own figures.

import type { Proc } from './stats'

export const MB = 1024

export const proc = (pid: number, ppid: number, extra: Partial<Proc> = {}): Proc => ({
  pid,
  ppid,
  command: `cmd${pid}`,
  rssKb: 10 * MB,
  cpuSeconds: 0,
  uptimeSeconds: 100,
  ...extra,
})

export const engine = { rssKb: 484 * MB, peakKb: 530 * MB, cpuSeconds: 1, uptimeSeconds: 60 }
```

- [ ] **Step 5: Split the tests**

Run: `git mv hooks/register.test.ts hooks/pane.test.ts`

Move each test, unchanged, from `hooks/pane.test.ts` into the file named here, and delete the `MB`, `proc` and `engine` definitions from `pane.test.ts`:

| Test name | Destination |
|---|---|
| `Linux: resident and peak memory from /proc/<pid>/status` | `hooks/stats.test.ts` |
| `Linux: name, parent, CPU and runtime past a name with spaces` | `hooks/stats.test.ts` |
| `macOS: ps times, and a command with spaces` | `hooks/stats.test.ts` |
| `the process table, with ps itself named first` | `hooks/stats.test.ts` |
| `descendants: the whole tree below the engine, without the reader` | `hooks/stats.test.ts` |
| `Windows: PowerShell sample, a command with spaces` | `hooks/stats.test.ts` |
| `tree order: depth first, each level by pid` | `hooks/snapshot.test.ts` |
| `process CPU: kept, new, and a reused pid` | `hooks/snapshot.test.ts` |
| `snapshot: own and started CPU, totals over every process` | `hooks/snapshot.test.ts` |
| `status line: the + part only while processes run` | `hooks/status.test.ts` |
| `memory pair shares one unit` | `hooks/format.test.ts` |
| `durations` | `hooks/format.test.ts` |
| every other test | stays in `hooks/pane.test.ts` |

Headers for the files:

`hooks/stats.test.ts`:
```ts
import { expect, test } from 'claude-code/testing'

import {
  descendants,
  parseCmdline,
  parseMacFields,
  parsePowerShell,
  parseProcStat,
  parseProcStatus,
  parsePsTable,
  parsePsTime,
  powerShellSample,
  toRow,
  windowsProc,
} from './stats'
```

`hooks/snapshot.test.ts`:
```ts
import { expect, test } from 'claude-code/testing'

import { engine, MB, proc } from './fixtures'
import { buildSnapshot, procCpu, treeOrder } from './snapshot'
import type { Timed } from './snapshot'
```

`hooks/status.test.ts`:
```ts
import { expect, test } from 'claude-code/testing'

import { engine, MB, proc } from './fixtures'
import { buildSnapshot } from './snapshot'
import type { Timed } from './snapshot'
import { statusLine } from './status'
```

`hooks/format.test.ts`:
```ts
import { expect, test } from 'claude-code/testing'

import { MB } from './fixtures'
import { formatDuration, formatPair } from './format'
```

`hooks/pane.test.ts` (replace its import block):
```ts
import { expect, test } from 'claude-code/testing'

import { engine, MB, proc } from './fixtures'
import { paneColumns, paneLines, stripes, treePrefixes } from './pane'
import { buildSnapshot, capRows } from './snapshot'
import type { Timed } from './snapshot'
```

Remove any import a file does not use (the type-check reports them only if `noUnusedLocals` is on; read each file's tests to be sure).

- [ ] **Step 6: Run everything**

Run: `claude plugin test .`
Expected: the same 19 tests, now across `format`, `pane`, `snapshot`, `stats`, `status` test files; `19 pass`, `0 fail`.
Run: `npx -y -p typescript@5.9.3 tsc -p .` → no output.
Run: `claude plugin validate .` → `✔ Validation passed`.

- [ ] **Step 7: Commit**

```bash
git add -A hooks
git commit -m "refactor: snapshot and status line in their own modules; tests per module"
```

---

### Task 3: Move reading assembly into `sampler.ts`

**Files:**
- Create: `hooks/sampler.ts`, `hooks/sampler.test.ts`
- Modify: `hooks/register.ts` (`linuxProc`, `readLinux`, `readMac`, `readWindows`)

**Interfaces:**
- Consumes: `stats.ts` parsers; `Proc`, `Sample` types.
- Produces:
  - `export type Gathered = { engine: Sample; children?: Proc[] }`
  - `linuxEngine(status: string, stat: string, uptime: string): Sample`
  - `linuxProc(pid: number, status: string, stat: string, cmdline: string, uptime: string): Proc`
  - `childPids(table: { selfPid: number; rows: string[][] }, pid: number): number[]`
  - `macReading(table: { selfPid: number; rows: string[][] }, pid: number, peakSeenKb: number): Gathered` (throws `Error('process <pid> not listed')`)
  - `windowsReading(stdout: string, pid: number): Gathered`

- [ ] **Step 1: Write the failing tests** in `hooks/sampler.test.ts`

```ts
import { expect, test } from 'claude-code/testing'

import { childPids, linuxEngine, linuxProc, macReading, windowsReading } from './sampler'

const stat = (pid: number, name: string, ppid: number, utime: number, stime: number, start: number) => {
  const fields = Array.from({ length: 30 }, () => '0')
  fields[1] = String(ppid)
  fields[11] = String(utime)
  fields[12] = String(stime)
  fields[19] = String(start)

  return `${pid} (${name}) ${fields.join(' ')}`
}

test('Linux: the engine from its status, stat and the system uptime', () => {
  const status = 'VmHWM:\t  530000 kB\nVmRSS:\t  412000 kB\n'
  expect(linuxEngine(status, stat(10, 'claude', 1, 300, 200, 1000), '110.00 0.00')).toEqual({
    rssKb: 412000,
    peakKb: 530000,
    cpuSeconds: 5,
    uptimeSeconds: 100,
  })
})

test('Linux: a child, and a zombie with no memory and no command line', () => {
  const status = 'VmRSS:\t  2048 kB\n'
  expect(linuxProc(11, status, stat(11, 'python3', 10, 100, 0, 5000), 'python3\0-c\0x\0', '100.00 0.00')).toEqual({
    pid: 11,
    ppid: 10,
    command: 'python3 -c x',
    rssKb: 2048,
    cpuSeconds: 1,
    uptimeSeconds: 50,
  })
  expect(linuxProc(12, 'State:\tZ (zombie)\n', stat(12, 'sh', 10, 0, 0, 5000), '', '100.00 0.00')).toEqual({
    pid: 12,
    ppid: 10,
    command: 'sh',
    rssKb: 0,
    cpuSeconds: 0,
    uptimeSeconds: 50,
  })
})

test('child pids leave out the reader', () => {
  const table = { selfPid: 14, rows: [['11', '10'], ['12', '11'], ['14', '10'], ['20', '1']] }
  expect(childPids(table, 10).sort()).toEqual([11, 12])
})

test('macOS: the engine row, its children, and the highest memory seen as peak', () => {
  const table = {
    selfPid: 99,
    rows: [
      '10 1 400000 1:00.00 05:00 /usr/local/bin/claude'.split(' '),
      '11 10 2048 0:01.00 00:10 python3 -c x'.split(' '),
      '99 10 900 0:00.01 00:00 ps -A'.split(' '),
    ],
  }
  const { engine, children } = macReading(table, 10, 450000)
  expect(engine).toEqual({ rssKb: 400000, peakKb: 450000, cpuSeconds: 60, uptimeSeconds: 300 })
  expect(children?.map(child => child.pid)).toEqual([11])
  expect(macReading(table, 10, 0).engine.peakKb).toBe(400000)
})

test('macOS: a table without the engine fails by name', () => {
  expect(() => macReading({ selfPid: 99, rows: [['11', '10']] }, 10, 0)).toThrow('process 10 not listed')
})

test('Windows: the engine and its children, without PowerShell itself', () => {
  const stdout = [
    '2097152 4194304 12.50 3600',
    '77',
    '11 10 1048576 25000000 42 node vitest',
    '77 10 1048576 0 1 powershell',
    '20 1 1048576 0 1 other',
  ].join('\r\n')
  const { engine, children } = windowsReading(stdout, 10)
  expect(engine.rssKb).toBe(2048)
  expect(children?.map(child => [child.pid, child.command])).toEqual([[11, 'node vitest']])
})
```

- [ ] **Step 2: Run to see them fail**

Run: `claude plugin test . 2>&1 | grep -E "sampler|fail"`
Expected: FAIL, `sampler` module not found.

- [ ] **Step 3: Write `hooks/sampler.ts`**

```ts
// A reading assembled from what the platform printed: Claude Code's own
// figures and its descendants. The reads themselves stay in register.ts.

import {
  descendants,
  parseCmdline,
  parseMacFields,
  parseProcStat,
  parseProcStatus,
  parsePowerShell,
  toRow,
  windowsProc,
} from './stats'
import type { Proc, Sample } from './stats'

export type Gathered = { engine: Sample; children?: Proc[] }

type Table = { selfPid: number; rows: string[][] }

export const linuxEngine = (status: string, stat: string, uptime: string): Sample => {
  const { rssKb, peakKb } = parseProcStatus(status)
  const { cpuSeconds, uptimeSeconds } = parseProcStat(stat, uptime)

  return { rssKb, peakKb, cpuSeconds, uptimeSeconds }
}

// A zombie has no VmRSS and no command line: no memory, and its name stands in.
export const linuxProc = (pid: number, status: string, stat: string, cmdline: string, uptime: string): Proc => {
  const { rssKb } = parseProcStatus(status)
  const { name, ...rest } = parseProcStat(stat, uptime)

  return { pid, ...rest, rssKb: Number.isFinite(rssKb) ? rssKb : 0, command: parseCmdline(cmdline) || name }
}

export const childPids = ({ selfPid, rows }: Table, pid: number) => descendants(rows.map(toRow), pid, selfPid)

// ps has no peak, so the highest resident size seen stands in for it.
export const macReading = (table: Table, pid: number, peakSeenKb: number): Gathered => {
  const own = table.rows.find(fields => Number(fields[0]) === pid)
  if (!own) throw new Error(`process ${pid} not listed`)
  const { rssKb, cpuSeconds, uptimeSeconds } = parseMacFields(own)
  const pids = new Set(childPids(table, pid))
  const children = table.rows.filter(fields => pids.has(Number(fields[0]))).map(parseMacFields)

  return { engine: { rssKb, cpuSeconds, uptimeSeconds, peakKb: Math.max(peakSeenKb, rssKb) }, children }
}

export const windowsReading = (stdout: string, pid: number): Gathered => {
  const { engine, selfPid, rows } = parsePowerShell(stdout)
  const pids = new Set(descendants(rows.map(toRow), pid, selfPid))

  return { engine, children: rows.filter(fields => pids.has(Number(fields[0]))).map(windowsProc) }
}
```

- [ ] **Step 4: Run the sampler tests**

Run: `claude plugin test . 2>&1 | grep -E "^\(fail\)| pass| fail"`
Expected: `25 pass`, `0 fail`.

- [ ] **Step 5: Make `register.ts` use it**

In `hooks/register.ts` replace `linuxProc`, `readLinux`, `readMac` and `readWindows` with:

```ts
const readLinuxChild = async ($: EngineInterface, pid: number, uptime: string): Promise<Proc | undefined> => {
  try {
    const [status, stat, cmdline] = await Promise.all([
      $.fs.read(`/proc/${pid}/status`),
      $.fs.read(`/proc/${pid}/stat`),
      // Its own failure only costs the arguments: the name from stat stands in.
      $.fs.read(`/proc/${pid}/cmdline`).catch(() => ''),
    ])

    return linuxProc(pid, status, stat, cmdline, uptime)
  } catch {
    // Ended since the table was read.
    return undefined
  }
}

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

const readWindows = async ($: EngineInterface, pid: number) => {
  const { stdout } = await $.process.run(['powershell', '-NoProfile', '-Command', powerShellSample(pid)])

  return windowsReading(stdout, pid)
}
```

Change `readProcesses`' return type to `Promise<Gathered>`. Replace the `./stats` value import with `import { isComplete, parsePsTable, powerShellSample } from './stats'` and add:

```ts
import { childPids, linuxEngine, linuxProc, macReading, windowsReading } from './sampler'
import type { Gathered } from './sampler'
```

- [ ] **Step 6: Run everything**

Run: `claude plugin test .` → `25 pass`, `0 fail`.
Run: `npx -y -p typescript@5.9.3 tsc -p .` → no output.
Run: `claude plugin validate .` → `✔ Validation passed`, and its calls line still lists `$.fs.read (via readLinuxChild, readLinux)`.

- [ ] **Step 7: Commit**

```bash
git add hooks/sampler.ts hooks/sampler.test.ts hooks/register.ts
git commit -m "refactor: reading assembly in sampler.ts, reads stay in register.ts"
```

---

### Task 4: Settings

**Files:**
- Create: `hooks/settings.ts`, `hooks/settings.test.ts`
- Modify: `.claude-plugin/plugin.json`, `hooks/status.ts`, `hooks/status.test.ts`, `hooks/register.ts`

**Interfaces:**
- Consumes: `PluginOptions` from `claude-code`; `Platform` from `./stats`.
- Produces:
  - `export type Settings = { intervalMs: Record<Platform, number>; warnMemMb: number; alertMemMb: number; warnCpuPct: number; alertCpuPct: number; toastCpuPct: number; toastCpuSeconds: number; toastMemMb: number; historyMinutes: number; statusShowChildren: boolean }`
  - `export const DEFAULTS: Settings`
  - `readSettings(options: PluginOptions): Settings`
  - `statusLine(snapshot: Snapshot, showChildren?: boolean): string` (default `true`)

- [ ] **Step 1: Write the failing tests** in `hooks/settings.test.ts`

```ts
import { expect, test } from 'claude-code/testing'

import { DEFAULTS, readSettings } from './settings'

test('no options: every default', () => {
  expect(readSettings({})).toEqual(DEFAULTS)
  expect(DEFAULTS.intervalMs).toEqual({ linux: 1000, mac: 2000, windows: 5000 })
  expect(DEFAULTS.statusShowChildren).toBe(true)
})

test('valid options are taken', () => {
  const settings = readSettings({ intervalLinuxMs: 500, warnMemMb: 1000, historyMinutes: 30, statusShowChildren: false })
  expect(settings.intervalMs.linux).toBe(500)
  expect(settings.warnMemMb).toBe(1000)
  expect(settings.historyMinutes).toBe(30)
  expect(settings.statusShowChildren).toBe(false)
})

test('out of range, wrong type or not a number: the default', () => {
  const settings = readSettings({
    intervalLinuxMs: 10,
    intervalMacMs: 'fast',
    toastCpuSeconds: 0,
    historyMinutes: 1000,
    statusShowChildren: 'yes',
  })
  expect(settings.intervalMs.linux).toBe(1000)
  expect(settings.intervalMs.mac).toBe(2000)
  expect(settings.toastCpuSeconds).toBe(60)
  expect(settings.historyMinutes).toBe(10)
  expect(settings.statusShowChildren).toBe(true)
})

test('a warn limit above its alert limit: both defaults', () => {
  const settings = readSettings({ warnMemMb: 5000, alertMemMb: 3000, warnCpuPct: 100, alertCpuPct: 200 })
  expect([settings.warnMemMb, settings.alertMemMb]).toEqual([2048, 4096])
  expect([settings.warnCpuPct, settings.alertCpuPct]).toEqual([100, 200])
})
```

Add to `hooks/status.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to see them fail**

Run: `claude plugin test . 2>&1 | grep -E "^\(fail\)| pass| fail"`
Expected: the settings file fails to load (`settings` not found) and the new status test fails.

- [ ] **Step 3: Write `hooks/settings.ts`**

```ts
// The person's settings (plugin.json userConfig), read once per load. A value
// that is missing, of the wrong type or out of range is its default.

import type { PluginOptions } from 'claude-code'

import type { Platform } from './stats'

export type Settings = {
  intervalMs: Record<Platform, number>
  warnMemMb: number
  alertMemMb: number
  warnCpuPct: number
  alertCpuPct: number
  toastCpuPct: number
  toastCpuSeconds: number
  toastMemMb: number
  historyMinutes: number
  statusShowChildren: boolean
}

export const DEFAULTS: Settings = {
  intervalMs: { linux: 1000, mac: 2000, windows: 5000 },
  warnMemMb: 2048,
  alertMemMb: 4096,
  warnCpuPct: 150,
  alertCpuPct: 300,
  toastCpuPct: 90,
  toastCpuSeconds: 60,
  toastMemMb: 1024,
  historyMinutes: 10,
  statusShowChildren: true,
}

const number = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback

// A warn limit above its alert limit could never show: both fall back.
const pair = (warn: number, alert: number, defaults: [number, number]): [number, number] =>
  warn <= alert ? [warn, alert] : defaults

export const readSettings = (options: PluginOptions): Settings => {
  const [warnMemMb, alertMemMb] = pair(
    number(options.warnMemMb, DEFAULTS.warnMemMb, 1, 1_000_000),
    number(options.alertMemMb, DEFAULTS.alertMemMb, 1, 1_000_000),
    [DEFAULTS.warnMemMb, DEFAULTS.alertMemMb],
  )
  const [warnCpuPct, alertCpuPct] = pair(
    number(options.warnCpuPct, DEFAULTS.warnCpuPct, 1, 100_000),
    number(options.alertCpuPct, DEFAULTS.alertCpuPct, 1, 100_000),
    [DEFAULTS.warnCpuPct, DEFAULTS.alertCpuPct],
  )

  return {
    intervalMs: {
      linux: number(options.intervalLinuxMs, DEFAULTS.intervalMs.linux, 250, 60_000),
      mac: number(options.intervalMacMs, DEFAULTS.intervalMs.mac, 250, 60_000),
      windows: number(options.intervalWindowsMs, DEFAULTS.intervalMs.windows, 1000, 60_000),
    },
    warnMemMb,
    alertMemMb,
    warnCpuPct,
    alertCpuPct,
    toastCpuPct: number(options.toastCpuPct, DEFAULTS.toastCpuPct, 1, 100_000),
    toastCpuSeconds: number(options.toastCpuSeconds, DEFAULTS.toastCpuSeconds, 1, 86_400),
    toastMemMb: number(options.toastMemMb, DEFAULTS.toastMemMb, 1, 1_000_000),
    historyMinutes: number(options.historyMinutes, DEFAULTS.historyMinutes, 1, 120),
    statusShowChildren:
      typeof options.statusShowChildren === 'boolean' ? options.statusShowChildren : DEFAULTS.statusShowChildren,
  }
}
```

- [ ] **Step 4: Give `statusLine` the `showChildren` parameter**

In `hooks/status.ts`, change the signature to `export const statusLine = (snapshot: Snapshot, showChildren = true) => {` and its first lines to:

```ts
  const { engine, children, childCpuPercent } = snapshot
  // Without the children, or with none running, Claude Code's own figures alone.
  const hasChildren = showChildren && (children === null || snapshot.childCount > 0)
```

The rest of the function is unchanged.

- [ ] **Step 5: Run the tests**

Run: `claude plugin test . 2>&1 | grep -E "^\(fail\)| pass| fail"`
Expected: `30 pass`, `0 fail`.

- [ ] **Step 6: Declare the settings in `.claude-plugin/plugin.json`**

Add after `"types"` (keep the other keys), and set `"version": "0.2.1"`:

```json
  "userConfig": {
    "intervalLinuxMs": { "type": "number", "title": "Refresh on Linux (ms)", "description": "How often processes are read on Linux; 250 to 60000.", "default": 1000 },
    "intervalMacMs": { "type": "number", "title": "Refresh on macOS (ms)", "description": "How often processes are read on macOS; 250 to 60000.", "default": 2000 },
    "intervalWindowsMs": { "type": "number", "title": "Refresh on Windows (ms)", "description": "How often processes are read on Windows; 1000 to 60000. Each read starts PowerShell.", "default": 5000 },
    "warnMemMb": { "type": "number", "title": "Memory warning (MB)", "description": "🟡 on the status line when Claude Code and its processes use more memory than this.", "default": 2048 },
    "alertMemMb": { "type": "number", "title": "Memory alert (MB)", "description": "🔴 on the status line above this.", "default": 4096 },
    "warnCpuPct": { "type": "number", "title": "CPU warning (%)", "description": "🟡 when the session's CPU, averaged over 10 s, is above this (100 = one core).", "default": 150 },
    "alertCpuPct": { "type": "number", "title": "CPU alert (%)", "description": "🔴 above this.", "default": 300 },
    "toastCpuPct": { "type": "number", "title": "Busy process CPU (%)", "description": "A toast when one child process stays above this CPU…", "default": 90 },
    "toastCpuSeconds": { "type": "number", "title": "Busy process time (s)", "description": "…for this many seconds.", "default": 60 },
    "toastMemMb": { "type": "number", "title": "Large process memory (MB)", "description": "A toast when one child process grows past this.", "default": 1024 },
    "historyMinutes": { "type": "number", "title": "History (minutes)", "description": "How far back the pane's sparklines reach; 1 to 120.", "default": 10 },
    "statusShowChildren": { "type": "boolean", "title": "Child processes on the status line", "description": "Show the + part for processes Claude Code started.", "default": true }
  }
```

Run: `claude plugin validate . 2>&1 | grep -E "✔|✘|warn"`
Expected: `✔ Validation passed`.

- [ ] **Step 7: Read the settings in `register.ts`**

In `hooks/register.ts`:
- delete the `INTERVAL_MS` constant and its comment;
- add `import { readSettings } from './settings'` and `import type { Settings } from './settings'`;
- change `startSampling` to take the settings: `const startSampling = async ($: EngineInterface, settings: Settings) => {`;
- in it, use `$.ui.status(statusLine(snapshot, settings.statusShowChildren))` and `$.clock.every(settings.intervalMs[platform], () => void sample())`;
- change `register` to read them once per load (a settings change reloads the module):

```ts
export const register: Register = (on, options) => {
  const settings = readSettings(options)
```

and call `void startSampling($, settings)` in the `session.start` hook.

- [ ] **Step 8: A load test with options** — add to `hooks/settings.test.ts`:

```ts
test('the mod loads with settings given', { options: { intervalLinuxMs: 500, statusShowChildren: false } }, async () => {
  expect(readSettings({ intervalLinuxMs: 500 }).intervalMs.linux).toBe(500)
})
```

Run: `claude plugin test .` → `31 pass`, `0 fail`.
Run: `npx -y -p typescript@5.9.3 tsc -p .` → no output.
Run: `claude plugin validate .` → `✔ Validation passed`.

- [ ] **Step 9: Commit**

```bash
git add .claude-plugin/plugin.json hooks/settings.ts hooks/settings.test.ts hooks/status.ts hooks/status.test.ts hooks/register.ts
git commit -m "feat: settings for intervals, limits, history and the status line"
```

---

### Task 5: Session history

**Files:**
- Create: `hooks/history.ts`, `hooks/history.test.ts`
- Modify: `types/index.d.ts`, `hooks/register.ts`

**Interfaces:**
- Consumes: `Snapshot` from `../types`.
- Produces (declared in `types/index.d.ts` so `$.state` can hold them, implemented in `history.ts`):
  - `export type Point = { t: number; memKb: number; cpuPct: number }` (milliseconds since the epoch; total memory in KB; total CPU % of one core)
  - `export type History = { points: Point[] }`
  - `historyCapacity(minutes: number, intervalMs: number): number`
  - `pushPoint(history: History, point: Point, capacity: number): History`
  - `downsample(values: number[], width: number): number[]`
  - `averageSince(points: Point[], now: number, windowMs: number, pick: (point: Point) => number): number | null`
  - `pointOf(snapshot: Snapshot, t: number): Point | null`

- [ ] **Step 1: Write the failing tests** in `hooks/history.test.ts`

```ts
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
```

- [ ] **Step 2: Run to see them fail**

Run: `claude plugin test . 2>&1 | grep -E "history|fail"`
Expected: FAIL, `history` module not found.

- [ ] **Step 3: Declare the types** in `types/index.d.ts`, above `declare module`:

```ts
// One reading's session totals: Claude Code with every process it started.
export type Point = { t: number; memKb: number; cpuPct: number }

// The newest points, oldest first; as many as the history window needs.
export type History = { points: Point[] }
```

and change the state contract to:

```ts
    // isOpen: whether the person has the pane open, so a reload can reopen it.
    // history: the session totals over the last historyMinutes, for alerts and sparklines.
    'proc-stats': { reading: Reading; isOpen: boolean; history: History }
```

- [ ] **Step 4: Write `hooks/history.ts`**

```ts
// Session totals over time: what the alerts average and the sparklines draw.

import type { History, Point, Snapshot } from '../types'

export const historyCapacity = (minutes: number, intervalMs: number) =>
  Math.max(2, Math.ceil((minutes * 60_000) / intervalMs))

// The newest `capacity` points, so a smaller capacity trims the oldest.
export const pushPoint = (history: History, point: Point, capacity: number): History => ({
  points: [...history.points, point].slice(-capacity),
})

// One value per bucket, its maximum, so a spike is never averaged away.
export const downsample = (values: number[], width: number) => {
  if (values.length <= width) return values
  const size = values.length / width

  return Array.from({ length: width }, (_, i) =>
    Math.max(...values.slice(Math.floor(i * size), Math.floor((i + 1) * size))),
  )
}

// The mean of the points in the last `windowMs`, its start included; null with none to average.
export const averageSince = (points: Point[], now: number, windowMs: number, pick: (point: Point) => number) => {
  const recent = points.filter(point => point.t >= now - windowMs)

  return recent.length === 0 ? null : recent.reduce((sum, point) => sum + pick(point), 0) / recent.length
}

// Null until CPU can be measured, so the history holds whole points only.
export const pointOf = (snapshot: Snapshot, t: number): Point | null => {
  const { engine, childKb, childCpuPercent } = snapshot
  if (engine.cpuPercent === null) return null

  return { t, memKb: engine.rssKb + childKb, cpuPct: engine.cpuPercent + (childCpuPercent ?? 0) }
}
```

- [ ] **Step 5: Run the history tests**

Run: `claude plugin test . 2>&1 | grep -E "^\(fail\)| pass| fail"`
Expected: `37 pass`, `0 fail`.

- [ ] **Step 6: Record each reading in `register.ts`**

In `hooks/register.ts`:
- add `import { historyCapacity, pointOf, pushPoint } from './history'`;
- add next to the other atoms: `const history = atom({ plugin: 'proc-stats', key: 'history' } as const, { points: [] } as History)`, and `History` to the `../types` type import;
- in `startSampling`, after the platform is known: `const capacity = historyCapacity(settings.historyMinutes, settings.intervalMs[platform])`;
- in `sample`, right after `await set({ snapshot: capRows(snapshot) })`:

```ts
        const point = pointOf(snapshot, now.wallMs)
        if (point) await update($, history, kept => pushPoint(kept, point, capacity))
```

A failed reading reaches the `catch` before this line, so it records nothing.

Run: `claude plugin test .` → `37 pass`, `0 fail`.
Run: `npx -y -p typescript@5.9.3 tsc -p .` → no output.
Run: `claude plugin validate . 2>&1 | grep -E "state|✔|✘"` → state reads and writes list `proc-stats.history`; `✔ Validation passed`.

- [ ] **Step 7: Commit**

```bash
git add types/index.d.ts hooks/history.ts hooks/history.test.ts hooks/register.ts
git commit -m "feat: session history of memory and CPU totals"
```

---

### Task 6: Document, sync and check live

**Files:**
- Modify: `README.md`
- Sync: `/home/vscode/.claude/dev-mods/e715d973-ee27-4e62-a13d-f8b843a6b679/proc-stats/`

- [ ] **Step 1: Add a Settings section to `README.md`**, after "Platforms":

```markdown
## Settings

In Claude Code's config menu (`/config`), under proc-stats:

| Setting | Default | |
|---|---|---|
| Refresh on Linux / macOS / Windows (ms) | 1000 / 2000 / 5000 | how often processes are read |
| Memory warning / alert (MB) | 2048 / 4096 | 🟡 / 🔴 on the status line (session total) |
| CPU warning / alert (%) | 150 / 300 | the same for CPU, averaged over 10 s |
| Busy process CPU (%) / time (s) | 90 / 60 | a toast for one child process |
| Large process memory (MB) | 1024 | a toast for one child process |
| History (minutes) | 10 | the pane's sparklines |
| Child processes on the status line | on | the `+` part |

A value out of range is ignored and its default used.
```

(The markers, toasts and sparklines arrive in later packages; the settings exist now so the config menu does not change shape again.)

- [ ] **Step 2: Final checks**

Run: `claude plugin test .` → `37 pass`, `0 fail`.
Run: `claude plugin validate .` → `✔ Validation passed`, no warnings.
Run: `npx -y -p typescript@5.9.3 tsc -p .` → no output.

- [ ] **Step 3: Sync to the dev copy**

```bash
DEV=/home/vscode/.claude/dev-mods/e715d973-ee27-4e62-a13d-f8b843a6b679/proc-stats
mkdir -p $DEV/.claude-plugin $DEV/hooks $DEV/types
cp .claude-plugin/plugin.json $DEV/.claude-plugin/
cp hooks/*.ts hooks/*.tsx hooks/hooks.json $DEV/hooks/
cp types/index.d.ts $DEV/types/
cd $DEV && claude plugin test . && claude plugin validate .
```

Expected: `37 pass`; `✔ Validation passed`. (The dev copy keeps the old `register.test.ts` if it had one: list `$DEV/hooks` and tell the person about any file there that the repository no longer has, rather than deleting it.)

- [ ] **Step 4: Live check (the person)**

Ask the person to confirm, in a session that loads the mod:
1. The status line looks as before.
2. `/config` lists the proc-stats settings; turning off "Child processes on the status line" removes the `+` part while a command runs.
3. `/proc-stats` opens the pane; after changing a setting (which reloads the mod) the pane is open again.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: settings"
```

---

## Roadmap: packages B–F

Each gets its own plan, written when the package before it has landed, from the spec's sections:

- **B, Alerts** (`alerts.ts`): marker level with the 10% fall-back, the per-process toast tracker, merged toasts; uses `averageSince` and `Settings`.
- **C, Pane interaction** (`view.ts`): rows as keyed Buttons of fixed-width cells, selection from `ui.focus`, detail area, sort, command rows and collapsing, stop with confirmation and force stop.
- **D, Sparklines**: pane header from `History` through `downsample`.
- **E, Origin and detached** (`origin.ts`): verify the `Monitor` wrapper and detached environments first; `tool.call` origin; `PROC_STATS_SESSION`; Detached group.
- **F, Report** (`report.ts`): `/proc-stats report`.
