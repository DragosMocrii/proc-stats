# proc-stats v0.3, package F: `/proc-stats report`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/proc-stats report` answers in the conversation with a plain-text summary of the session (platform and uptime, current totals, the history window's peaks and when they were, the five heaviest processes with their origin, the marker level, and recent alerts), read by the person and by the model; `/proc-stats` alone still opens the pane.

**Architecture:** The alerts start keeping the last 5 toasts they sent (`AlertState.recent`), so the report can list them. A pure `reportText` in a new `hooks/report.ts` builds the text from plain data: the reading, the history points, the alert state, the origins, the time and the history window. `register.ts` reads that state when `/proc-stats report` runs and returns the text as the command's output; an unknown argument returns how to use the command.

**Tech Stack:** TypeScript Claude Code mod (hooks module, `claude-code` API), tests with `claude-code/testing` under `claude plugin test`, type-check with `tsc` 5.9.3.

**Spec:** `docs/superpowers/specs/2026-10-09-proc-stats-v3-design.md` (Report). Packages A–E1 are merged on main; E2 (detached processes) is not.

## Global Constraints

- The repository is `/home/vscode/proc-stats`, on the branch the controller names. Commit after each task. Do not push. Do not touch `/home/vscode/.claude/dev-mods/`.
- `$` may not be passed into a function imported from another file; `report.ts` and `alerts.ts` take plain data. Everything that calls `$` stays in `register.ts`.
- Every `$.state` value is declared in `types/index.d.ts`; refs are `const` literals `{ plugin: 'proc-stats', key: '<key>' } as const`. Every value has a safe empty default, so state saved by an earlier version (an `AlertState` without `recent`) reads correctly.
- Commands: tests `claude plugin test .`; validate `claude plugin validate .` (ends `✔ Validation passed`, no warnings); type-check `npx -y -p typescript@5.9.3 tsc -p .`.
- From the spec, verbatim: "`/proc-stats report` returns text that both the person and the model read: platform and uptime; current totals for Claude Code, children and detached; peaks over the history window with their time; the 5 heaviest processes with origin; up to 10 detached processes; the marker level and recent toasts. Every line is derived from current state. `/proc-stats` with no argument opens the pane."
- Ruling recorded in the plan: package E2 (detached processes) is not built, so the report has no detached totals and no detached list. E2 adds them, with its own tests, when it lands.
- Ruling recorded in the plan: "heaviest" means the most memory (ties by CPU, then lower pid). Peak times are shown as ages (`2m 0s ago`), which need no time zone. "Recent toasts" are the alerts' last 5 toasts, newest first, each with its age; the stop flow's outcome toasts are not alerts and are not kept.
- Ruling recorded in the plan: the argument is trimmed and compared without case (`/proc-stats Report` works). Any other non-empty argument answers with how to use the command and opens nothing.

## Review Focus

- **State saved before this package** (an `alerts` value without `recent`, after a reload onto the new version): the report says `Recent alerts: none` and the first toast creates the list. Pinned in Task 1 (`EMPTY_ALERTS` has no `recent`) and Task 2 (the default input).
- **An idle session**: a reading that sends no toast must not add `recent` to the alert state, or every idle reading would rewrite `$.state`. Pinned in Task 1.
- **No reading yet, or a failed one** (the report run right after start, or when `/proc` cannot be read): one line saying so, never a thrown hook. Pinned in Task 2 and Task 3.
- **No process table** (`children: null`): the report says child processes are unknown instead of `0`, and lists no heaviest processes. Pinned in Task 2.
- **The command typed with another argument, or with no argument**: an unknown argument opens nothing and explains; a bare `/proc-stats` still opens the pane. Pinned in Task 3.

---

### Task 1: The alerts keep their recent toasts

**Files:**
- Modify: `types/index.d.ts` (the `AlertState` declaration)
- Modify: `hooks/alerts.ts` (`stepAlerts`, a new constant)
- Test: `hooks/alerts.test.ts`

**Interfaces:**
- Consumes: `stepAlerts`, `toastText`, `EMPTY_ALERTS` (all in `hooks/alerts.ts`).
- Produces:
  - type `SentToast = { t: number; text: string }`; `AlertState` gains `recent?: SentToast[]` (oldest first; absent until the first toast).
  - `alerts.ts`: `export const RECENT_TOASTS = 5`. `stepAlerts` returns, in `state`, every field it was given, with `recent` appended to (last 5 kept) only when the reading sent a toast.

- [ ] **Step 1: Declare the type.** In `types/index.d.ts`, replace

```ts
// What the alerts remember between readings, and across reloads.
export type AlertState = { levels: { mem: Level; cpu: Level }; tracks: Record<string, ProcTrack> }
```

with

```ts
// A toast the alerts sent: when (ms since the epoch) and its text.
export type SentToast = { t: number; text: string }

// What the alerts remember between readings, and across reloads; `recent` holds the last toasts, oldest first
// (absent until the first one).
export type AlertState = { levels: { mem: Level; cpu: Level }; tracks: Record<string, ProcTrack>; recent?: SentToast[] }
```

- [ ] **Step 2: Write the failing test.** In `hooks/alerts.test.ts`, change the type import to

```ts
import type { AlertState, ProcRow, ProcTrack, Snapshot } from '../types'
```

and append:

```ts
test('stepAlerts: each toast sent is kept for the report, the last 5, oldest first', () => {
  let state: AlertState = EMPTY_ALERTS
  for (let pid = 1; pid <= 6; pid++) {
    const big = snapshot(100, 2000, { children: [row(pid, { rssKb: 2000 * MB })], childCount: 1 })
    state = stepAlerts(state, big, [], pid * 1000, DEFAULTS, 1000).state
  }
  expect(state.recent).toEqual(
    [2, 3, 4, 5, 6].map(pid => ({ t: pid * 1000, text: `cmd${pid} grew past 1.00GB · pid ${pid} · /proc-stats` })),
  )
  // A reading without a toast keeps them; an idle state never gains the field, so it is not written.
  const quiet = snapshot(100, 0)
  expect(stepAlerts(state, quiet, [], 7000, DEFAULTS, 1000).state.recent).toEqual(state.recent)
  expect('recent' in stepAlerts(EMPTY_ALERTS, quiet, [], 7000, DEFAULTS, 1000).state).toBe(false)
})
```

- [ ] **Step 3: Run it to see it fail.**

Run: `cd /home/vscode/proc-stats && claude plugin test .`
Expected: `(fail) stepAlerts: each toast sent is kept for the report, the last 5, oldest first` (`state.recent` is `undefined`); every other test passes.

- [ ] **Step 4: Implement.** In `hooks/alerts.ts`, above `export const EMPTY_ALERTS`, add

```ts
// How many sent toasts the alerts keep for the report.
export const RECENT_TOASTS = 5

```

and replace the end of `stepAlerts` and its comment:

```ts
// One reading: the next alert state and the toast, if any. The first reading (no CPU yet)
// and an unreadable table move the levels only.
export const stepAlerts = (state: AlertState, snapshot: Snapshot, points: Point[], now: number, settings: Settings, intervalMs: number) => {
  const levels = sessionLevels(snapshot, points, now, settings, state.levels, intervalMs)
  if (snapshot.engine.cpuPercent === null || snapshot.children === null) {
    return { state: { levels, tracks: state.tracks }, toast: null }
  }
  const { tracks, fired } = trackProcesses(state.tracks, snapshot.children, now, settings)

  return { state: { levels, tracks }, toast: toastText(fired) }
}
```

with

```ts
// One reading: the next alert state and the toast, if any, which joins the recent toasts. The first
// reading (no CPU yet) and an unreadable table move the levels only.
export const stepAlerts = (state: AlertState, snapshot: Snapshot, points: Point[], now: number, settings: Settings, intervalMs: number) => {
  const levels = sessionLevels(snapshot, points, now, settings, state.levels, intervalMs)
  if (snapshot.engine.cpuPercent === null || snapshot.children === null) {
    return { state: { ...state, levels }, toast: null }
  }
  const { tracks, fired } = trackProcesses(state.tracks, snapshot.children, now, settings)
  const toast = toastText(fired)
  // A toast sent joins the recent ones; without one they stay as they were (absent until the first).
  const recent = toast ? { recent: [...(state.recent ?? []), { t: now, text: toast }].slice(-RECENT_TOASTS) } : {}

  return { state: { ...state, levels, tracks, ...recent }, toast }
}
```

`register.ts` needs no change: it already writes `step.state` whenever it differs from the stored value.

- [ ] **Step 5: Run the checks.**

Run: `cd /home/vscode/proc-stats && claude plugin test . && npx -y -p typescript@5.9.3 tsc -p . && claude plugin validate .`
Expected: every test passes (the existing `stepAlerts: the first reading and an unreadable table never toast, and keep the trackers` still passes unchanged); tsc prints nothing; `✔ Validation passed`.

- [ ] **Step 6: Commit.**

```bash
cd /home/vscode/proc-stats && git add types/index.d.ts hooks/alerts.ts hooks/alerts.test.ts && git commit -m "feat(alerts): keep the last 5 toasts sent, for the report"
```

---

### Task 2: The report text

**Files:**
- Create: `hooks/report.ts`
- Test: `hooks/report.test.ts`

**Interfaces:**
- Consumes: `AlertState` (with `recent?`, from Task 1), `Origins`, `Point`, `ProcRow`, `Reading` from `../types`; `worse` from `./alerts`; `formatBytes`, `formatDuration`, `formatPercent` from `./format`; `originLabel`, `originOf` from `./origin`; `labelOf` from `./view`; `EMPTY_ALERTS` (alerts), `EMPTY_ORIGINS` (origin) and `MB` (fixtures) in the test.
- Produces:
  - `export type ReportInput = { reading: Reading; points: Point[]; alerts: AlertState; origins: Origins; now: number; historyMinutes: number }`
  - `export const HEAVIEST = 5`
  - `export const reportText = (input: ReportInput) => string`: lines joined by `\n`.

- [ ] **Step 1: Write the failing tests** in `hooks/report.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'

import type { AlertState, Origins, ProcRow, Snapshot } from '../types'
import { EMPTY_ALERTS } from './alerts'
import { MB } from './fixtures'
import { EMPTY_ORIGINS } from './origin'
import { reportText } from './report'
import type { ReportInput } from './report'

const NOW = 1_000_000

const row = (pid: number, rssMb: number, cpuPercent: number | null, command = `cmd${pid}`): ProcRow => ({
  pid,
  ppid: 10,
  depth: 0,
  command,
  rssKb: rssMb * MB,
  cpuPercent,
  uptimeSeconds: 30,
  startMs: NOW - 30_000,
})

const snapshot = (children: ProcRow[] | null): Snapshot => ({
  platform: 'linux',
  pid: 10,
  engine: { rssKb: 484 * MB, peakKb: 530 * MB, cpuPercent: 2, uptimeSeconds: 3725 },
  children,
  childCount: children?.length ?? 0,
  childKb: (children ?? []).reduce((total, each) => total + each.rssKb, 0),
  childCpuPercent: children === null ? null : children.reduce((total, each) => total + (each.cpuPercent ?? 0), 0),
})

const input = (over: Partial<ReportInput> = {}): ReportInput => ({
  reading: { snapshot: snapshot([]) },
  points: [],
  alerts: EMPTY_ALERTS,
  origins: EMPTY_ORIGINS,
  now: NOW,
  historyMinutes: 10,
  ...over,
})

const WRAPPED = "/bin/bash -c source /home/u/.claude/shell-snapshots/s.sh && eval 'npm test' < /dev/null && pwd -P >| /tmp/cwd"

test('report: a busy session, every section', () => {
  const children = [row(11, 20, 1), row(12, 812, 95, WRAPPED), row(13, 20, 3), row(14, 5, 0), row(15, 1, 0), row(16, 2, 0)]
  const origins: Origins = { calls: [], byPid: { 12: { tool: 'Bash', agent: null, startMs: NOW - 30_000 } } }
  const alerts: AlertState = {
    levels: { mem: 'warn', cpu: 'none' },
    tracks: {},
    recent: [
      { t: NOW - 242_000, text: 'npm test grew past 1.00GB · pid 12 · /proc-stats' },
      { t: NOW - 60_000, text: 'cmd13 has used ~95% CPU for 1m 0s · pid 13 · /proc-stats' },
    ],
  }
  // Memory peaks twice at 1300 MB: the first time is when it was reached.
  const points = [
    { t: NOW - 300_000, memKb: 900 * MB, cpuPct: 20 },
    { t: NOW - 120_000, memKb: 1300 * MB, cpuPct: 50 },
    { t: NOW - 30_000, memKb: 1300 * MB, cpuPct: 145 },
  ]
  expect(reportText(input({ reading: { snapshot: snapshot(children) }, points, alerts, origins }))).toBe(
    [
      'proc-stats report · Linux · Claude Code pid 10 · up 1h 2m',
      'Now: Claude Code 484MB, 2.0% CPU · 6 child processes 860MB, 99.0% CPU · total 1.31GB, 101.0% CPU',
      'Peaks in the last 10 min: memory 1.27GB 2m 0s ago · CPU 145.0% 30s ago',
      'Heaviest processes:',
      '  1. 812MB · 95.0% CPU · pid 12 · $ npm test · Bash',
      '  2. 20MB · 3.0% CPU · pid 13 · cmd13',
      '  3. 20MB · 1.0% CPU · pid 11 · cmd11',
      '  4. 5MB · 0.0% CPU · pid 14 · cmd14',
      '  5. 2MB · 0.0% CPU · pid 16 · cmd16',
      'Marker: 🟡 warn (memory warn, CPU none)',
      'Recent alerts:',
      '  1m 0s ago · cmd13 has used ~95% CPU for 1m 0s · pid 13 · /proc-stats',
      '  4m 2s ago · npm test grew past 1.00GB · pid 12 · /proc-stats',
    ].join('\n'),
  )
})

test('report: no reading yet, or a failed one, is one line', () => {
  expect(reportText(input({ reading: {} }))).toBe('proc-stats report: no reading yet')
  expect(reportText(input({ reading: { error: 'cannot read process 10 on linux' } }))).toBe(
    'proc-stats report: cannot read process 10 on linux',
  )
})

test('report: an unreadable process table is unknown, not zero', () => {
  expect(reportText(input({ reading: { snapshot: snapshot(null) } }))).toBe(
    [
      'proc-stats report · Linux · Claude Code pid 10 · up 1h 2m',
      'Now: Claude Code 484MB, 2.0% CPU · child processes unknown (the process table could not be read)',
      'Peaks in the last 10 min: no history yet',
      'Marker: none',
      'Recent alerts: none',
    ].join('\n'),
  )
})

test('report: a quiet session, with an alert state saved before toasts were kept', () => {
  expect(reportText(input())).toBe(
    [
      'proc-stats report · Linux · Claude Code pid 10 · up 1h 2m',
      'Now: Claude Code 484MB, 2.0% CPU · no child processes',
      'Peaks in the last 10 min: no history yet',
      'Marker: none',
      'Recent alerts: none',
    ].join('\n'),
  )
})

test('report: the first reading has no CPU yet; one child; the alert level and window as given', () => {
  const quiet = snapshot([row(11, 20, null)])
  const first = { ...quiet, engine: { ...quiet.engine, cpuPercent: null }, childCpuPercent: null }
  const alerts: AlertState = { levels: { mem: 'none', cpu: 'alert' }, tracks: {} }
  expect(reportText(input({ reading: { snapshot: first }, historyMinutes: 30, alerts }))).toBe(
    [
      'proc-stats report · Linux · Claude Code pid 10 · up 1h 2m',
      'Now: Claude Code 484MB, … CPU · 1 child process 20MB, … CPU · total 504MB, … CPU',
      'Peaks in the last 30 min: no history yet',
      'Heaviest processes:',
      '  1. 20MB · … CPU · pid 11 · cmd11',
      'Marker: 🔴 alert (memory none, CPU alert)',
      'Recent alerts: none',
    ].join('\n'),
  )
})

test('report: a long command is cut to 80 code points', () => {
  const long = row(11, 20, 1, `node ${'x'.repeat(100)}`)
  const line = reportText(input({ reading: { snapshot: snapshot([long]) } })).split('\n')[4]
  expect(line).toBe(`  1. 20MB · 1.0% CPU · pid 11 · node ${'x'.repeat(74)}…`)
})
```

- [ ] **Step 2: Run them to see them fail.**

Run: `cd /home/vscode/proc-stats && claude plugin test .`
Expected: `hooks/report.test.ts` fails to load (`./report` does not exist); every other test passes.

- [ ] **Step 3: Implement** `hooks/report.ts`:

```ts
// The `/proc-stats report` text: what the person and the model read about the session, from current state.

import type { AlertState, Origins, Point, ProcRow, Reading } from '../types'
import { worse } from './alerts'
import { formatBytes, formatDuration, formatPercent } from './format'
import { originLabel, originOf } from './origin'
import { labelOf } from './view'

// How many processes the report names, heaviest (most memory) first.
export const HEAVIEST = 5
// A command is cut to this many code points.
const COMMAND_MAX = 80

export type ReportInput = {
  reading: Reading
  points: Point[]
  alerts: AlertState
  origins: Origins
  // ms since the epoch
  now: number
  historyMinutes: number
}

const PLATFORMS: Record<string, string> = { linux: 'Linux', mac: 'macOS', windows: 'Windows' }

const cut = (text: string) => {
  const chars = Array.from(text)

  return chars.length > COMMAND_MAX ? `${chars.slice(0, COMMAND_MAX - 1).join('')}…` : text
}

const ago = (now: number, t: number) => `${formatDuration((now - t) / 1000)} ago`

const sum = (a: number | null, b: number | null) => (a === null || b === null ? null : a + b)

// The first point holding the highest value: when the peak was reached.
const peakOf = (points: Point[], pick: (point: Point) => number) =>
  points.reduce<Point | null>((best, point) => (best === null || pick(point) > pick(best) ? point : best), null)

const heaviest = (rows: ProcRow[]) =>
  [...rows]
    .sort((a, b) => b.rssKb - a.rssKb || (b.cpuPercent ?? 0) - (a.cpuPercent ?? 0) || a.pid - b.pid)
    .slice(0, HEAVIEST)

export const reportText = ({ reading, points, alerts, origins, now, historyMinutes }: ReportInput) => {
  const snapshot = reading.snapshot
  if (!snapshot) return `proc-stats report: ${reading.error ?? 'no reading yet'}`
  const { engine, children, childCount, childKb, childCpuPercent } = snapshot
  const lines = [
    `proc-stats report · ${PLATFORMS[snapshot.platform] ?? snapshot.platform} · Claude Code pid ${snapshot.pid} · up ${formatDuration(engine.uptimeSeconds)}`,
  ]

  const own = `Claude Code ${formatBytes(engine.rssKb)}, ${formatPercent(engine.cpuPercent)} CPU`
  if (children === null) lines.push(`Now: ${own} · child processes unknown (the process table could not be read)`)
  else if (childCount === 0) lines.push(`Now: ${own} · no child processes`)
  else {
    const noun = childCount === 1 ? 'child process' : 'child processes'
    lines.push(
      `Now: ${own} · ${childCount} ${noun} ${formatBytes(childKb)}, ${formatPercent(childCpuPercent)} CPU · total ${formatBytes(engine.rssKb + childKb)}, ${formatPercent(sum(engine.cpuPercent, childCpuPercent))} CPU`,
    )
  }

  const memPeak = peakOf(points, point => point.memKb)
  const cpuPeak = peakOf(points, point => point.cpuPct)
  lines.push(
    memPeak && cpuPeak
      ? `Peaks in the last ${historyMinutes} min: memory ${formatBytes(memPeak.memKb)} ${ago(now, memPeak.t)} · CPU ${formatPercent(cpuPeak.cpuPct)} ${ago(now, cpuPeak.t)}`
      : `Peaks in the last ${historyMinutes} min: no history yet`,
  )

  if (children && children.length > 0) {
    lines.push('Heaviest processes:')
    heaviest(children).forEach((row, index) => {
      const origin = originOf(origins, row)
      const from = origin ? ` · ${originLabel(origin)}` : ''
      lines.push(`  ${index + 1}. ${formatBytes(row.rssKb)} · ${formatPercent(row.cpuPercent)} CPU · pid ${row.pid} · ${cut(labelOf(row.command))}${from}`)
    })
  }

  const { mem, cpu } = alerts.levels
  const level = worse(mem, cpu)
  lines.push(level === 'none' ? 'Marker: none' : `Marker: ${level === 'alert' ? '🔴' : '🟡'} ${level} (memory ${mem}, CPU ${cpu})`)

  const recent = alerts.recent ?? []
  if (recent.length === 0) lines.push('Recent alerts: none')
  else {
    lines.push('Recent alerts:')
    for (const toast of [...recent].reverse()) lines.push(`  ${ago(now, toast.t)} · ${toast.text}`)
  }

  return lines.join('\n')
}
```

- [ ] **Step 4: Run the checks.**

Run: `cd /home/vscode/proc-stats && claude plugin test . && npx -y -p typescript@5.9.3 tsc -p . && claude plugin validate .`
Expected: every test passes, the six `report:` tests included; tsc prints nothing; `✔ Validation passed`.

- [ ] **Step 5: Commit.**

```bash
cd /home/vscode/proc-stats && git add hooks/report.ts hooks/report.test.ts && git commit -m "feat(report): the /proc-stats report text from current state"
```

---

### Task 3: `/proc-stats report` runs it

**Files:**
- Modify: `hooks/register.ts` (imports, a `USAGE` constant, a `report` helper, the command's registration and its `command.run` hook)
- Test: `hooks/command.test.ts` (new)
- Modify: `README.md` (a Report section), `.claude-plugin/plugin.json` (version `0.2.6` → `0.2.7`)

**Interfaces:**
- Consumes: `reportText` from `./report` (Task 2); the existing atoms `reading`, `history`, `alerts`, `origins` and `read` in `register.ts`; `settings.historyMinutes`.
- Produces: `/proc-stats report` (any case, surrounding spaces ignored) answers `{ text: reportText(...) }`; another argument answers `{ text: 'proc-stats: unknown argument "<arg>". ' + USAGE }`; no argument opens the pane as before.

- [ ] **Step 1: Write the failing tests** in `hooks/command.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]

// `/proc-stats <args>` typed at the prompt.
const run = (args: string) => ({
  command: 'proc-stats',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 80 },
})

// Whether the pane was opened; the kit has no pane of its own.
const watchOpen = (on: On) => {
  let opened = false
  on('ui.open', () => {
    opened = true
    return { value: { isPlaced: true as const } }
  })

  return () => opened
}

const SNAPSHOT = {
  platform: 'linux',
  pid: 10,
  engine: { rssKb: 484 * 1024, peakKb: 530 * 1024, cpuPercent: 2, uptimeSeconds: 60 },
  children: [],
  childCount: 0,
  childKb: 0,
  childCpuPercent: 0,
}

test('/proc-stats report answers with the report from current state, and opens nothing', async ($, on) => {
  on('clock.now', () => ({ value: 100_000 }))
  on('state.get', { plugin: 'proc-stats', key: 'reading' } as const, () => ({ value: { value: { snapshot: SNAPSHOT }, version: 1 } }))
  on('state.get', { plugin: 'proc-stats', key: 'history' } as const, () => ({
    value: { value: { points: [{ t: 70_000, memKb: 600 * 1024, cpuPct: 40 }] }, version: 1 },
  }))
  on('state.get', { plugin: 'proc-stats', key: 'alerts' } as const, () => ({
    value: {
      value: { levels: { mem: 'none', cpu: 'warn' }, tracks: {}, recent: [{ t: 40_000, text: 'cmd6 grew past 1.00GB · pid 6 · /proc-stats' }] },
      version: 1,
    },
  }))
  const opened = watchOpen(on)
  const { text } = await $.command.run(run(' Report '))
  expect(text).toBe(
    [
      'proc-stats report · Linux · Claude Code pid 10 · up 1m 0s',
      'Now: Claude Code 484MB, 2.0% CPU · no child processes',
      'Peaks in the last 10 min: memory 600MB 30s ago · CPU 40.0% 30s ago',
      'Marker: 🟡 warn (memory none, CPU warn)',
      'Recent alerts:',
      '  1m 0s ago · cmd6 grew past 1.00GB · pid 6 · /proc-stats',
    ].join('\n'),
  )
  expect(opened()).toBe(false)
})

test('/proc-stats report before the first reading says so', async ($, on) => {
  on('clock.now', () => ({ value: 100_000 }))
  const { text } = await $.command.run(run('report'))
  expect(text).toBe('proc-stats report: no reading yet')
})

test('/proc-stats with another argument says how to use it, and opens nothing', async ($, on) => {
  const opened = watchOpen(on)
  const { text } = await $.command.run(run('nope'))
  expect(text).toBe('proc-stats: unknown argument "nope". /proc-stats opens the Processes pane; /proc-stats report summarizes the session here.')
  expect(opened()).toBe(false)
})

test('/proc-stats alone still opens the pane', async ($, on) => {
  const opened = watchOpen(on)
  const { text } = await $.command.run(run(''))
  expect(text).toBe('Processes pane opened.')
  expect(opened()).toBe(true)
})
```

- [ ] **Step 2: Run them to see them fail.**

Run: `cd /home/vscode/proc-stats && claude plugin test .`
Expected: the first three `/proc-stats …` tests fail (today every argument opens the pane: `Processes pane opened.`); `/proc-stats alone still opens the pane` passes.

- [ ] **Step 3: Implement** in `hooks/register.ts`.

Import the report, beside the other module imports (after `import type { Timed } from './snapshot'`):

```ts
import { reportText } from './report'
```

Below `const OPEN = { id: PANE, title: 'Processes' }`:

```ts
const USAGE = '/proc-stats opens the Processes pane; /proc-stats report summarizes the session here.'
```

Above `// A settings change reloads the module, so they are read once per load.`:

```ts
// The report from current state, as the person and the model read it.
const report = async ($: EngineInterface, historyMinutes: number) =>
  reportText({
    reading: await read($, reading),
    points: (await read($, history)).points,
    alerts: await read($, alerts),
    origins: await read($, origins),
    now: await $.clock.now(),
    historyMinutes,
  })

```

In `session.start`, the registration becomes:

```ts
    await $.command.register({
      name: COMMAND,
      description: 'Show Claude Code and the processes it started in a task-manager pane, or a report',
      argumentHint: '[report]',
    })
```

The `command.run` hook's head, `on('command.run', { command: COMMAND }, async $ => {`, becomes (the pane-opening body below it, and its `.catch`, unchanged):

```ts
  // Bare: the pane. `report`: the report as the command's output. Anything else: how to use it.
  on('command.run', { command: COMMAND }, async ($, e) => {
    const typed = e.args.trim()
    if (typed.toLowerCase() === 'report') {
      try {
        return { text: await report($, settings.historyMinutes) }
      } catch {
        return { text: 'proc-stats: the report could not be made; try again.' }
      }
    }
    if (typed !== '') return { text: `proc-stats: unknown argument "${typed}". ${USAGE}` }
```

- [ ] **Step 4: Document it.** In `README.md`, insert above `## Platforms`:

```markdown
## Report

`/proc-stats report` writes a summary of the session into the conversation, where Claude reads it too: the platform and how long Claude Code has run; the memory and CPU of Claude Code, its child processes and both together now; the highest memory and CPU of the history window and how long ago they were; the five processes using the most memory, with what started them; the marker level; and the last five alerts.

```

In `.claude-plugin/plugin.json`, change `"version": "0.2.6"` to `"version": "0.2.7"`.

- [ ] **Step 5: Run the checks.**

Run: `cd /home/vscode/proc-stats && claude plugin test . && npx -y -p typescript@5.9.3 tsc -p . && claude plugin validate .`
Expected: every test passes, the four `/proc-stats` tests included; tsc prints nothing; `✔ Validation passed`.

- [ ] **Step 6: Commit.**

```bash
cd /home/vscode/proc-stats && git add hooks/register.ts hooks/command.test.ts README.md .claude-plugin/plugin.json && git commit -m "feat(command): /proc-stats report answers with the report; other arguments explain"
```

- [ ] **Step 7 (controller, with the person): live check.** In the session that loads `~/proc-stats` with `--plugin-dir`, after `/reload-plugins`: the person runs `/proc-stats report` with a command running (for example `sleep 60` in the background), and the controller confirms that the report shows in the transcript and that the controller (the model) can read its text in its own context. If the model cannot read it, add `context: [text]` beside `text` in the report answer, which the engine records for the model:

```ts
      try {
        const text = await report($, settings.historyMinutes)
        return { text, context: [text] }
      } catch {
```

and add `expect(answer.context).toEqual([answer.text])` to the first test in `hooks/command.test.ts` (with `const answer = await $.command.run(run(' Report '))` and `answer.text` in place of `text`), then run the checks and commit with `fix(command): the model reads the report too`.
