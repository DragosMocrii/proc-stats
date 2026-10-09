# proc-stats v0.3, package B: alerts

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A 🟡/🔴 marker on the status line when the session's totals pass the warning or alert limits, and a toast when one child process stays busy or grows large.

**Architecture:** A new pure module `hooks/alerts.ts` decides the marker level (with a 10% fall-back so it does not flicker) and tracks each child process for toasts; one function, `stepAlerts`, takes the previous alert state and a reading and returns the next state and the toast text. `register.ts` keeps the state in `$.state` (so a reload neither forgets a fired toast nor repeats it), prefixes the marker to the status line and shows the toast.

**Tech Stack:** TypeScript Claude Code mod (hooks module, `claude-code` API), tests with `claude-code/testing` under `claude plugin test`, type-check with `tsc` 5.9.3.

**Spec:** `docs/superpowers/specs/2026-10-09-proc-stats-v3-design.md` (sections Settings, Data and history, Alerts, Errors).

## Global Constraints

- The repository is `/home/vscode/proc-stats`, on the branch the controller names. Commit after each task. Do not push. Do not touch `/home/vscode/.claude/dev-mods/` (this session loads the mod from the repository with `--plugin-dir`; a second copy would load twice).
- `$` may not be passed into a function imported from another file; `alerts.ts` takes plain data only.
- Every value in `$.state` is declared in `types/index.d.ts` under `PluginState['proc-stats']`. A state reference is a `const` object literal `{ plugin: 'proc-stats', key: '<key>' } as const` used only for `$.state` calls and the state library (`atom`, `update`).
- Commands, run from the repository root: tests `claude plugin test .`; validate `claude plugin validate .` (must end `✔ Validation passed`, no warnings); type-check `npx -y -p typescript@5.9.3 tsc -p .`.
- Tests use only `toBe / toEqual / toBeNull / toBeDefined / toContain / toThrow / toBeGreaterThan`; assert exact values.
- From the spec, verbatim: Level is the worse of memory (current total) and CPU (10 s average): none, warn (`🟡 ` prefix) or alert (`🔴 ` prefix). A level only falls once its value is 10% below the limit. For each descendant process (not Claude Code), keyed by pid and start time: CPU — after `toastCpuSeconds` above `toastCpuPct`, one toast: `<command> has used ~<n>% CPU for <duration> · pid <pid> · /proc-stats`; memory — on first passing `toastMemMb`, one toast: `<command> grew past <size> · pid <pid> · /proc-stats`. Each kind fires once per process and re-arms after 10 s below 90% of its limit. Several in one reading become one toast: `<n> processes over limits: … · /proc-stats`. Ended processes leave the tracker. The first reading never alerts. A failed reading changes nothing.
- Settings in use (from `readSettings`): `warnMemMb`, `alertMemMb`, `warnCpuPct`, `alertCpuPct`, `toastCpuPct`, `toastCpuSeconds`, `toastMemMb`. Defaults 2048, 4096, 150, 300, 90, 60, 1024. "Above" a limit means strictly greater.
- Package A's final review recorded that `averageSince` returns a single point's value: CPU is called sustained, and the CPU marker level moves, only when the points in the 10 s window number at least 2 and span at least 5 s.

## Review Focus

- **A busy process whose CPU dips briefly** (e.g. 85% against a 90% limit, which is above the 81% fall-back): its timer keeps running and it is toasted at 60 s; a dip below 81% restarts it. Pinned in Task 2.
- **A pid reused by a new, younger process**: it gets a fresh tracker, so it is neither toasted for the old process's time nor silenced by the old one's fired toast. Pinned in Task 2.
- **A reload after a toast fired**: the tracker lives in `$.state`, so the same process is not toasted again. Pinned in Task 2 (`stepAlerts` from a state with the toast already fired).
- **An unreadable process table** (`children` null): no toasts, the trackers are kept as they were, and the CPU level stays where it was. Pinned in Tasks 1 and 2.
- **Too few or too close points** (just after start, or a sparse history): the CPU level does not move on one or two readings. Pinned in Task 1.

---

## File structure after this package

| File | Change |
|---|---|
| `hooks/alerts.ts` | **new**: levels, CPU average, per-process tracker, toast text, `stepAlerts` |
| `hooks/alerts.test.ts` | **new** |
| `types/index.d.ts` | gains `Level`, `ProcTrack`, `AlertState`; state contract gains `alerts` |
| `hooks/register.ts` | reads and writes the `alerts` state, prefixes the marker, shows the toast |
| `README.md`, `.claude-plugin/plugin.json` | an Alerts section; version 0.2.2 |

---

### Task 1: Marker levels

**Files:**
- Create: `hooks/alerts.ts`, `hooks/alerts.test.ts`
- Modify: `types/index.d.ts`

**Interfaces:**
- Consumes: `averageSince(points, now, windowMs, pick)` from `hooks/history.ts`; `Point`, `Snapshot` from `../types`; `Settings`, `DEFAULTS` from `hooks/settings.ts`.
- Produces:
  - in `types/index.d.ts`: `export type Level = 'none' | 'warn' | 'alert'`, `export type ProcTrack = { uptimeSeconds: number; cpuSince: number | null; cpuFired: boolean; cpuCoolSince: number | null; memFired: boolean; memCoolSince: number | null }`, `export type AlertState = { levels: { mem: Level; cpu: Level }; tracks: Record<string, ProcTrack> }`
  - in `hooks/alerts.ts`: `CPU_WINDOW_MS = 10_000`, `FALL_BACK = 0.9`, `COOL_MS = 10_000`, `EMPTY_ALERTS: AlertState`, `levelFor(value: number, warn: number, alert: number, previous: Level): Level`, `worse(a: Level, b: Level): Level`, `markerFor(level: Level): string`, `cpuAverage(points: Point[], now: number): number | null`, `sessionLevels(snapshot: Snapshot, points: Point[], now: number, settings: Settings, previous: AlertState['levels']): AlertState['levels']`

- [ ] **Step 1: Declare the types** in `types/index.d.ts`, above `declare module`:

```ts
// The status-line marker's level for one measure: below warning, above it, above alert.
export type Level = 'none' | 'warn' | 'alert'

// One child process's toast tracking. Times are milliseconds since the epoch.
export type ProcTrack = {
  // How long it had run at the last reading; a younger process under the same pid is a new one.
  uptimeSeconds: number
  // When its CPU went over the toast limit (kept through dips above 90% of it).
  cpuSince: number | null
  cpuFired: boolean
  // When it fell below 90% of the limit after a toast; 10 s there re-arms it.
  cpuCoolSince: number | null
  memFired: boolean
  memCoolSince: number | null
}

// What the alerts remember between readings, and across reloads.
export type AlertState = { levels: { mem: Level; cpu: Level }; tracks: Record<string, ProcTrack> }
```

Leave the state contract unchanged in this task (Task 3 adds `alerts` to it).

- [ ] **Step 2: Write the failing tests** in `hooks/alerts.test.ts`

```ts
import { expect, test } from 'claude-code/testing'

import type { Snapshot } from '../types'
import { cpuAverage, EMPTY_ALERTS, levelFor, markerFor, sessionLevels, worse } from './alerts'
import { MB } from './fixtures'
import { DEFAULTS } from './settings'

const snapshot = (engineMb: number, childMb: number, extra: Partial<Snapshot> = {}): Snapshot => ({
  platform: 'linux',
  pid: 10,
  engine: { rssKb: engineMb * MB, peakKb: engineMb * MB, cpuPercent: 1, uptimeSeconds: 60 },
  children: [],
  childCount: 0,
  childKb: childMb * MB,
  childCpuPercent: 0,
  ...extra,
})

const cpuPoints = (from: number, to: number, stepMs: number, cpuPct: number) =>
  Array.from({ length: Math.floor((to - from) / stepMs) + 1 }, (_, i) => ({ t: from + i * stepMs, memKb: 0, cpuPct }))

test('levels rise above each limit, never at it', () => {
  expect(levelFor(2048, 2048, 4096, 'none')).toBe('none')
  expect(levelFor(2100, 2048, 4096, 'none')).toBe('warn')
  expect(levelFor(4100, 2048, 4096, 'none')).toBe('alert')
  expect(levelFor(4100, 2048, 4096, 'warn')).toBe('alert')
})

test('a level falls only 10% below its limit', () => {
  expect(levelFor(3900, 2048, 4096, 'alert')).toBe('alert')
  expect(levelFor(3600, 2048, 4096, 'alert')).toBe('warn')
  expect(levelFor(1900, 2048, 4096, 'warn')).toBe('warn')
  expect(levelFor(1800, 2048, 4096, 'warn')).toBe('none')
  expect(levelFor(1800, 2048, 4096, 'alert')).toBe('none')
})

test('the worse level, and its marker', () => {
  expect(worse('warn', 'alert')).toBe('alert')
  expect(worse('none', 'warn')).toBe('warn')
  expect(worse('none', 'none')).toBe('none')
  expect(markerFor('none')).toBe('')
  expect(markerFor('warn')).toBe('🟡 ')
  expect(markerFor('alert')).toBe('🔴 ')
})

test('a CPU average needs two points spanning half the window', () => {
  expect(cpuAverage(cpuPoints(0, 10_000, 1000, 100), 10_000)).toBe(100)
  expect(cpuAverage(cpuPoints(5000, 10_000, 5000, 200), 10_000)).toBe(200)
  expect(cpuAverage(cpuPoints(9000, 10_000, 1000, 100), 10_000)).toBeNull()
  expect(cpuAverage([{ t: 10_000, memKb: 0, cpuPct: 500 }], 10_000)).toBeNull()
  expect(cpuAverage([], 10_000)).toBeNull()
  // Points older than the window do not count toward it.
  expect(cpuAverage([...cpuPoints(0, 2000, 1000, 900), ...cpuPoints(12_000, 13_000, 1000, 100)], 13_000)).toBeNull()
})

test('session levels: memory from the current total, CPU from the average', () => {
  const levels = sessionLevels(snapshot(1000, 1100), cpuPoints(0, 10_000, 1000, 350), 10_000, DEFAULTS, EMPTY_ALERTS.levels)
  expect(levels).toEqual({ mem: 'warn', cpu: 'alert' })
})

test('without a CPU average the CPU level stays where it was', () => {
  const previous = { mem: 'none' as const, cpu: 'warn' as const }
  expect(sessionLevels(snapshot(100, 0), [], 10_000, DEFAULTS, previous)).toEqual({ mem: 'none', cpu: 'warn' })
})

test('an unreadable process table: memory from Claude Code alone', () => {
  const unknown = snapshot(3000, 0, { children: null, childCpuPercent: null })
  expect(sessionLevels(unknown, [], 10_000, DEFAULTS, EMPTY_ALERTS.levels).mem).toBe('warn')
})
```

- [ ] **Step 3: Run to see them fail**

Run: `claude plugin test . 2>&1 | grep -E "alerts|^\(fail\)| pass| fail"`
Expected: the alerts test file fails to load (`./alerts` not found); the other 44 pass.

- [ ] **Step 4: Write `hooks/alerts.ts`**

```ts
// The status-line marker and the toasts for busy or large child processes.

import type { AlertState, Level, Point, Snapshot } from '../types'
import { averageSince } from './history'
import type { Settings } from './settings'

// The CPU average the marker reads, and how much of it the points must cover.
export const CPU_WINDOW_MS = 10_000
const MIN_COVER_MS = 5_000
// A level, or a fired toast, clears only below this share of its limit.
export const FALL_BACK = 0.9
// How long a fired toast stays below FALL_BACK before it re-arms.
export const COOL_MS = 10_000

export const EMPTY_ALERTS: AlertState = { levels: { mem: 'none', cpu: 'none' }, tracks: {} }

const RANK: Record<Level, number> = { none: 0, warn: 1, alert: 2 }

// Above a limit rises at once; falling waits until 10% below the limit held.
export const levelFor = (value: number, warn: number, alert: number, previous: Level): Level => {
  const raw: Level = value > alert ? 'alert' : value > warn ? 'warn' : 'none'
  if (RANK[raw] >= RANK[previous]) return raw
  if (previous === 'alert' && value > alert * FALL_BACK) return 'alert'

  return value > warn * FALL_BACK ? 'warn' : 'none'
}

export const worse = (a: Level, b: Level): Level => (RANK[a] >= RANK[b] ? a : b)

export const markerFor = (level: Level) => (level === 'alert' ? '🔴 ' : level === 'warn' ? '🟡 ' : '')

// Null until the window holds two points at least MIN_COVER_MS apart, so one spike is no average.
export const cpuAverage = (points: Point[], now: number): number | null => {
  const recent = points.filter(point => point.t >= now - CPU_WINDOW_MS)
  const first = recent[0]
  const last = recent[recent.length - 1]
  if (!first || !last || recent.length < 2 || last.t - first.t < MIN_COVER_MS) return null

  return averageSince(recent, now, CPU_WINDOW_MS, point => point.cpuPct)
}

// Memory is the current total (Claude Code alone while the table is unreadable); CPU the average.
export const sessionLevels = (
  snapshot: Snapshot,
  points: Point[],
  now: number,
  settings: Settings,
  previous: AlertState['levels'],
): AlertState['levels'] => {
  const memMb = (snapshot.engine.rssKb + snapshot.childKb) / 1024
  const cpu = cpuAverage(points, now)

  return {
    mem: levelFor(memMb, settings.warnMemMb, settings.alertMemMb, previous.mem),
    cpu: cpu === null ? previous.cpu : levelFor(cpu, settings.warnCpuPct, settings.alertCpuPct, previous.cpu),
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `claude plugin test . 2>&1 | grep -E "^\(fail\)| pass| fail"`
Expected: `51 pass`, `0 fail`.
Run: `npx -y -p typescript@5.9.3 tsc -p .` → no output.

- [ ] **Step 6: Commit**

```bash
git add types/index.d.ts hooks/alerts.ts hooks/alerts.test.ts
git commit -m "feat(alerts): marker levels from session totals with a 10% fall-back"
```

---

### Task 2: Toasts for busy and large child processes

**Files:**
- Modify: `hooks/alerts.ts`, `hooks/alerts.test.ts`

**Interfaces:**
- Consumes: Task 1's `FALL_BACK`, `COOL_MS`, `EMPTY_ALERTS`, `sessionLevels`; `ProcRow`, `ProcTrack`, `AlertState`, `Snapshot`, `Point` types; `formatBytes`, `formatDuration` from `hooks/format.ts`.
- Produces:
  - `export type Fired = { kind: 'cpu' | 'mem'; pid: number; command: string; cpuPercent: number; seconds: number; limitKb: number }`
  - `trackProcesses(tracks: Record<string, ProcTrack>, rows: ProcRow[], now: number, settings: Settings): { tracks: Record<string, ProcTrack>; fired: Fired[] }`
  - `toastText(fired: Fired[]): string | null`
  - `stepAlerts(state: AlertState, snapshot: Snapshot, points: Point[], now: number, settings: Settings): { state: AlertState; toast: string | null }`

- [ ] **Step 1: Write the failing tests** — append to `hooks/alerts.test.ts`, and extend its imports:

```ts
import type { ProcRow, ProcTrack } from '../types'
import { stepAlerts, toastText, trackProcesses } from './alerts'
```

```ts
const row = (pid: number, extra: Partial<ProcRow> = {}): ProcRow => ({
  pid,
  ppid: 10,
  depth: 0,
  command: `cmd${pid}`,
  rssKb: 10 * MB,
  cpuPercent: 0,
  uptimeSeconds: 100,
  ...extra,
})

// Readings of one process at the given times (ms) and CPU percents; the toasts fired at each.
const runCpu = (readings: [number, number][], start: Record<string, ProcTrack> = {}) => {
  let tracks = start
  return readings.map(([t, cpuPercent]) => {
    const step = trackProcesses(tracks, [row(5, { cpuPercent, uptimeSeconds: 100 + t / 1000 })], t, DEFAULTS)
    tracks = step.tracks
    return step.fired.map(fired => fired.kind)
  })
}

test('CPU: a toast after 60 s above the limit, not before', () => {
  expect(runCpu([[0, 100], [59_000, 100], [60_000, 100]])).toEqual([[], [], ['cpu']])
})

test('CPU: a dip above 90% of the limit keeps the timer; below it, restarts it', () => {
  expect(runCpu([[0, 100], [30_000, 85], [60_000, 100]])).toEqual([[], [], ['cpu']])
  expect(runCpu([[0, 100], [30_000, 80], [60_000, 100]])).toEqual([[], [], []])
})

test('CPU: once per process, again only after 10 s below 90% of the limit', () => {
  expect(
    runCpu([
      [0, 100],
      [60_000, 100],
      [61_000, 100],
      [70_000, 50],
      [80_000, 50],
      [81_000, 100],
      [141_000, 100],
    ]),
  ).toEqual([[], ['cpu'], [], [], [], [], ['cpu']])
})

test('a reused pid is a new process: fresh tracker', () => {
  const old: ProcTrack = {
    uptimeSeconds: 500,
    cpuSince: 0,
    cpuFired: true,
    cpuCoolSince: null,
    memFired: true,
    memCoolSince: null,
  }
  const { tracks, fired } = trackProcesses({ 5: old }, [row(5, { uptimeSeconds: 2, cpuPercent: 100 })], 1000, DEFAULTS)
  expect(fired).toEqual([])
  expect(tracks['5']).toEqual({
    uptimeSeconds: 2,
    cpuSince: 1000,
    cpuFired: false,
    cpuCoolSince: null,
    memFired: false,
    memCoolSince: null,
  })
})

test('memory: once on passing the limit, again after 10 s below 90% of it', () => {
  let tracks: Record<string, ProcTrack> = {}
  const at = (t: number, mb: number) => {
    const step = trackProcesses(tracks, [row(6, { rssKb: mb * MB, uptimeSeconds: 100 + t / 1000 })], t, DEFAULTS)
    tracks = step.tracks
    return step.fired.map(fired => fired.kind)
  }
  expect([at(0, 1000), at(1000, 1025), at(2000, 1100), at(3000, 900), at(13_000, 900), at(14_000, 1100)]).toEqual([
    [],
    ['mem'],
    [],
    [],
    [],
    ['mem'],
  ])
})

test('ended processes leave the tracker', () => {
  const first = trackProcesses({}, [row(5), row(6)], 0, DEFAULTS)
  expect(Object.keys(trackProcesses(first.tracks, [row(6)], 1000, DEFAULTS).tracks)).toEqual(['6'])
})

test('toast text: one, several, and a long command', () => {
  const cpu = { kind: 'cpu' as const, pid: 5, command: 'cmd5', cpuPercent: 99.6, seconds: 60, limitKb: 0 }
  const mem = { kind: 'mem' as const, pid: 6, command: 'cmd6', cpuPercent: 0, seconds: 0, limitKb: 1024 * MB }
  expect(toastText([])).toBeNull()
  expect(toastText([cpu])).toBe('cmd5 has used ~100% CPU for 1m 0s · pid 5 · /proc-stats')
  expect(toastText([mem])).toBe('cmd6 grew past 1.00GB · pid 6 · /proc-stats')
  expect(toastText([cpu, mem])).toBe('2 processes over limits: cmd5, cmd6 · /proc-stats')
  expect(toastText([cpu, { ...mem, pid: 5, command: 'cmd5' }])).toBe(
    'cmd5 has used ~100% CPU for 1m 0s · pid 5 · cmd5 grew past 1.00GB · pid 5 · /proc-stats',
  )
  const long = 'x'.repeat(60)
  expect(toastText([{ ...cpu, command: long }])).toBe(`${'x'.repeat(39)}… has used ~100% CPU for 1m 0s · pid 5 · /proc-stats`)
})

test('stepAlerts: the first reading and an unreadable table never toast, and keep the trackers', () => {
  const fired: ProcTrack = { uptimeSeconds: 100, cpuSince: null, cpuFired: false, cpuCoolSince: null, memFired: false, memCoolSince: null }
  const state = { levels: EMPTY_ALERTS.levels, tracks: { 6: fired } }
  const big = [row(6, { rssKb: 2000 * MB })]
  // childKb 0 keeps the memory level at none, so the assertion is about toasts and trackers.
  const first = snapshot(100, 0, { children: big, childCount: 1, engine: { rssKb: 100 * MB, peakKb: 100 * MB, cpuPercent: null, uptimeSeconds: 1 } })
  expect(stepAlerts(state, first, [], 1000, DEFAULTS)).toEqual({ state, toast: null })
  const unknown = snapshot(100, 0, { children: null, childCpuPercent: null })
  expect(stepAlerts(state, unknown, [], 1000, DEFAULTS).toast).toBeNull()
  expect(stepAlerts(state, unknown, [], 1000, DEFAULTS).state.tracks).toEqual(state.tracks)
})

test('stepAlerts: a toast once, and not again after a reload restores the state', () => {
  const big = snapshot(100, 2000, { children: [row(6, { rssKb: 2000 * MB })], childCount: 1 })
  const once = stepAlerts(EMPTY_ALERTS, big, [], 1000, DEFAULTS)
  expect(once.toast).toBe('cmd6 grew past 1.00GB · pid 6 · /proc-stats')
  // The state round-trips through $.state as plain data.
  const restored = JSON.parse(JSON.stringify(once.state))
  expect(stepAlerts(restored, big, [], 2000, DEFAULTS).toast).toBeNull()
  expect(once.state.levels.mem).toBe('warn')
})
```

(The several-in-one-reading rule counts processes, not toasts: two kinds for one pid read as that process's two lines; two pids read as `2 processes over limits`.)

- [ ] **Step 2: Run to see them fail**

Run: `claude plugin test . 2>&1 | grep -E "^\(fail\)| pass| fail"`
Expected: the alerts file fails to load (`stepAlerts`, `toastText`, `trackProcesses` not exported); the rest pass.

- [ ] **Step 3: Add the tracker, the text and `stepAlerts`** to `hooks/alerts.ts`

Extend the imports:

```ts
import type { AlertState, Level, Point, ProcRow, ProcTrack, Snapshot } from '../types'
import { formatBytes, formatDuration } from './format'
```

Append:

```ts
export type Fired = { kind: 'cpu' | 'mem'; pid: number; command: string; cpuPercent: number; seconds: number; limitKb: number }

const fresh = (uptimeSeconds: number): ProcTrack => ({
  uptimeSeconds,
  cpuSince: null,
  cpuFired: false,
  cpuCoolSince: null,
  memFired: false,
  memCoolSince: null,
})

// A fired toast re-arms after COOL_MS spent below FALL_BACK of its limit.
const cool = (isFired: boolean, isBelow: boolean, since: number | null, now: number) => {
  if (!isFired || !isBelow) return { isFired, since: null }
  const start = since ?? now

  return now - start >= COOL_MS ? { isFired: false, since: null } : { isFired, since: start }
}

// One reading of the child processes: the trackers after it, and the toasts it fires.
export const trackProcesses = (tracks: Record<string, ProcTrack>, rows: ProcRow[], now: number, settings: Settings) => {
  const next: Record<string, ProcTrack> = {}
  const fired: Fired[] = []
  const cpuLimit = settings.toastCpuPct
  const memLimitKb = settings.toastMemMb * 1024
  for (const row of rows) {
    const was = tracks[String(row.pid)]
    // A younger process under a known pid is another process.
    const track: ProcTrack =
      was && row.uptimeSeconds >= was.uptimeSeconds - 1 ? { ...was, uptimeSeconds: row.uptimeSeconds } : fresh(row.uptimeSeconds)

    if (row.cpuPercent !== null) {
      const cpu = row.cpuPercent
      const cooled = cool(track.cpuFired, cpu < cpuLimit * FALL_BACK, track.cpuCoolSince, now)
      track.cpuFired = cooled.isFired
      track.cpuCoolSince = cooled.since
      track.cpuSince = cpu > cpuLimit ? (track.cpuSince ?? now) : cpu < cpuLimit * FALL_BACK ? null : track.cpuSince
      if (!track.cpuFired && track.cpuSince !== null && now - track.cpuSince >= settings.toastCpuSeconds * 1000) {
        track.cpuFired = true
        fired.push({ kind: 'cpu', pid: row.pid, command: row.command, cpuPercent: cpu, seconds: (now - track.cpuSince) / 1000, limitKb: 0 })
      }
    }

    const cooled = cool(track.memFired, row.rssKb < memLimitKb * FALL_BACK, track.memCoolSince, now)
    track.memFired = cooled.isFired
    track.memCoolSince = cooled.since
    if (!track.memFired && row.rssKb > memLimitKb) {
      track.memFired = true
      fired.push({ kind: 'mem', pid: row.pid, command: row.command, cpuPercent: 0, seconds: 0, limitKb: memLimitKb })
    }

    next[String(row.pid)] = track
  }

  return { tracks: next, fired }
}

const short = (command: string) => (command.length > 40 ? `${command.slice(0, 39)}…` : command)

const describe = (fired: Fired) =>
  fired.kind === 'cpu'
    ? `${short(fired.command)} has used ~${Math.round(fired.cpuPercent)}% CPU for ${formatDuration(fired.seconds)} · pid ${fired.pid}`
    : `${short(fired.command)} grew past ${formatBytes(fired.limitKb)} · pid ${fired.pid}`

// One toast per reading: each process's lines, or a count once several processes fire together.
export const toastText = (fired: Fired[]) => {
  if (fired.length === 0) return null
  const pids = [...new Set(fired.map(entry => entry.pid))]
  if (pids.length === 1) return `${fired.map(describe).join(' · ')} · /proc-stats`
  const names = pids.map(pid => short(fired.find(entry => entry.pid === pid)!.command))

  return `${pids.length} processes over limits: ${names.join(', ')} · /proc-stats`
}

// One reading: the next alert state and the toast, if any. The first reading (no CPU yet)
// and an unreadable table move the levels only.
export const stepAlerts = (state: AlertState, snapshot: Snapshot, points: Point[], now: number, settings: Settings) => {
  const levels = sessionLevels(snapshot, points, now, settings, state.levels)
  if (snapshot.engine.cpuPercent === null || snapshot.children === null) {
    return { state: { levels, tracks: state.tracks }, toast: null }
  }
  const { tracks, fired } = trackProcesses(state.tracks, snapshot.children, now, settings)

  return { state: { levels, tracks }, toast: toastText(fired) }
}
```

- [ ] **Step 4: Run the tests**

Run: `claude plugin test . 2>&1 | grep -E "^\(fail\)| pass| fail"`
Expected: `60 pass`, `0 fail`.
Run: `npx -y -p typescript@5.9.3 tsc -p .` → no output.

- [ ] **Step 5: Commit**

```bash
git add hooks/alerts.ts hooks/alerts.test.ts
git commit -m "feat(alerts): toasts for child processes busy or large for long"
```

---

### Task 3: Wire the alerts into the mod

**Files:**
- Modify: `types/index.d.ts` (state contract), `hooks/register.ts`, `README.md`, `.claude-plugin/plugin.json`

**Interfaces:**
- Consumes: `EMPTY_ALERTS`, `stepAlerts`, `markerFor`, `worse` from `hooks/alerts.ts`; `AlertState`, `History` types.
- Produces: the `alerts` state value; the status line `<marker><statusLine(...)>`; one `$.ui.toast(text, { timeoutMs: 8000 })` per reading at most.

- [ ] **Step 1: Add `alerts` to the state contract** in `types/index.d.ts`:

```ts
    // isOpen: whether the person has the pane open, so a reload can reopen it.
    // history: the session totals over the last historyMinutes, for alerts and sparklines.
    // alerts: the marker levels and each child process's toast tracking, kept across reloads.
    'proc-stats': { reading: Reading; isOpen: boolean; history: History; alerts: AlertState }
```

- [ ] **Step 2: Wire `register.ts`**

Add imports:

```ts
import { EMPTY_ALERTS, markerFor, stepAlerts, worse } from './alerts'
```

and `AlertState` to the `../types` type import. Replace the `history` atom line with named references and atoms:

```ts
const HISTORY = { plugin: 'proc-stats', key: 'history' } as const
const ALERTS = { plugin: 'proc-stats', key: 'alerts' } as const
const history = atom(HISTORY, { points: [] } as History)
const alerts = atom(ALERTS, EMPTY_ALERTS as AlertState)
// Long enough to read a process name and its numbers.
const TOAST_MS = 8000
```

In `sample()`, remove the line `$.ui.status(statusLine(snapshot, settings.statusShowChildren))` from its current place, and after the history `try { … } catch { … }` block (before `before = now`) add:

```ts
        // Alerts after the history, which holds this reading's point; their failure costs the marker only.
        let marker = ''
        try {
          const points = (await $.state.get(HISTORY)).value?.points ?? []
          const previous = (await $.state.get(ALERTS)).value ?? EMPTY_ALERTS
          const step = stepAlerts(previous, snapshot, points, now.wallMs, settings)
          await update($, alerts, () => step.state)
          marker = markerFor(worse(step.state.levels.mem, step.state.levels.cpu))
          if (step.toast) $.ui.toast(step.toast, { timeoutMs: TOAST_MS })
        } catch {
          // No marker or toast this reading; the status line still shows.
        }
        $.ui.status(`${marker}${statusLine(snapshot, settings.statusShowChildren)}`)
```

(`snapshot` here is the uncapped one, so every child process is tracked, not only the 500 rows the pane receives.)

Run: `npx -y -p typescript@5.9.3 tsc -p .` → no output.
Run: `claude plugin validate . 2>&1 | grep -E "state|✔|✘"` → state reads and writes include `proc-stats.alerts`; `✔ Validation passed`, no warnings.
Run: `claude plugin test .` → `60 pass`, `0 fail`.

- [ ] **Step 3: README and version**

In `README.md`, after the "## Settings" section, add:

```markdown
## Alerts

- **Status line:** 🟡 at the start of the line when the session (Claude Code and every process it started) uses more memory than the warning limit, or more CPU on average over the last 10 seconds; 🔴 above the alert limit. A marker clears only once its value is 10% below the limit, so it does not flicker.
- **Toasts:** one when a child process stays above the busy-process CPU limit for the set time (short dips are tolerated), and one when it grows past the large-process memory limit. Each fires once per process, and again only after the process has been 10 seconds below 90% of the limit. Several at once become one toast.
```

In `.claude-plugin/plugin.json` set `"version": "0.2.2"`.

Run: `claude plugin validate .` → `✔ Validation passed`.

- [ ] **Step 4: Commit**

```bash
git add types/index.d.ts hooks/register.ts README.md .claude-plugin/plugin.json
git commit -m "feat: status-line marker and process toasts"
```

- [ ] **Step 5: Live check (the person, after the final review)**

1. With nothing heavy running, the status line has no marker.
2. A command holding about 2.1 GB (e.g. `python3 -c "b = bytearray(2100 * 1024 * 1024); [b.__setitem__(i, 1) for i in range(0, len(b), 4096)]; import time; time.sleep(30)"`) shows 🟡 within a reading or two, and one toast `python3 -c … grew past 1.00GB`; the marker goes once it ends.
3. A command keeping one core busy for 70 s shows one toast at about 60 s.
