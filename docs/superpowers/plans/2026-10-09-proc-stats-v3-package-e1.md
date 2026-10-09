# proc-stats v0.3, package E1: where processes come from

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each `$ …` row in the Processes pane says which tool started it, and in which agent — `$ npm test · Bash`, `$ tail -f log · Monitor`, `$ make · subagent: code-reviewer` — and the details name the subagent's task.

**Architecture:** A `tool.call` hook on `Bash` and `Monitor` records each call's exact command, tool and agent before it runs (`$.state` `origins.calls`). Each reading, a pure `matchOrigins` gives every unmatched wrapper row (Claude Code's `bash -c … eval '<command>' …`, unwrapped by package C's `unwrapCommand`) the oldest recorded call with that exact command, keyed by pid and start time (`origins.byPid`), and prunes ended processes and calls older than 10 minutes. The pane appends the origin to the command cell and adds it to the details.

**Tech Stack:** TypeScript Claude Code mod (hooks module, `claude-code` API), tests with `claude-code/testing` under `claude plugin test`, type-check with `tsc` 5.9.3.

**Spec:** `docs/superpowers/specs/2026-10-09-proc-stats-v3-design.md` (Origin). Package E2 (detached processes) follows in its own plan.

## Global Constraints

- The repository is `/home/vscode/proc-stats`, on the branch the controller names. Commit after each task. Do not push. Do not touch `/home/vscode/.claude/dev-mods/`.
- `$` may not be passed into a function imported from another file; `origin.ts`, `view.ts`, `pane.tsx` take plain data.
- Every `$.state` value is declared in `types/index.d.ts`; refs are `const` literals `{ plugin: 'proc-stats', key: '<key>' } as const`.
- A hook on a gating event (`tool.call`) has `.catch(($, e, next) => next(e))` and never denies or rewrites the call: recording must never block or change a tool call.
- Commands: tests `claude plugin test .`; validate `claude plugin validate .` (ends `✔ Validation passed`, no warnings); type-check `npx -y -p typescript@5.9.3 tsc -p .`.
- Verified before planning: Monitor commands run under the same wrapper as Bash (`/bin/bash -c source …/shell-snapshots/… && eval '<command>' < /dev/null && pwd -P >| …`), and `unwrapCommand` returns the command exactly as the tool call gave it (single quotes decoded from `'"'"'`).
- From the spec, verbatim: "A `tool.call` hook on `Bash` and `Monitor` records, before the call runs, its command, the tool, and its subagent (`agentId`, named through `$.agent.list()`), then passes the call on unchanged. A wrapper row matches a recorded call when the command unwrapped from its `eval '…'` equals the call's command. This holds for parallel and background calls. Unmatched wrapper rows still show the unwrapped command, with origin `—`. Matches are stored in `$.state` by pid and start time and pruned when the process ends; recorded calls are pruned after their process is matched or after 10 minutes."
- Ruling recorded in the plan: an unmatched row shows no origin text (not `—`) in the command cell, so ordinary rows stay uncluttered; the details say `origin unknown` for an unmatched wrapper row.

## Review Focus

- **Two parallel calls with the same command** (e.g. `npm test` twice): each wrapper gets one call, in start order, never both the same call. Pinned in Task 1.
- **A process that started long before its matching command was recorded** (another session's or a pre-reload wrapper with the same text): not matched to a call recorded after it started. Pinned in Task 1.
- **A pid reused by a new process**: its stored origin is dropped (start time differs), not inherited. Pinned in Task 1.
- **The tool call itself**: recording failure never blocks, denies or changes the Bash/Monitor call. Pinned in Task 2.
- **Long-running sessions**: unmatched calls expire after 10 minutes, matched ones leave `calls`, and ended processes leave `byPid`, so state stays small. Pinned in Task 1.

---

### Task 1: Matching calls to rows

**Files:**
- Modify: `types/index.d.ts`
- Create: `hooks/origin.ts`, `hooks/origin.test.ts`

**Interfaces:**
- Consumes: `unwrapCommand` and `START_TOLERANCE_MS` from `hooks/view.ts`; `Snapshot`, `ProcRow`.
- Produces:
  - types: `export type Origin = { tool: string; agent: { type: string; description: string } | null }`, `export type OriginCall = Origin & { command: string; at: number }`, `export type Origins = { calls: OriginCall[]; byPid: Record<string, Origin & { startMs: number }> }`
  - `origin.ts`: `EMPTY_ORIGINS: Origins`, `CALL_TTL_MS = 600_000`, `matchOrigins(origins: Origins, snapshot: Snapshot, now: number): Origins`, `originOf(origins: Origins, row: { pid: number; startMs: number }): Origin | null`, `originLabel(origin: Origin): string`, `originDetail(origin: Origin): string`

- [ ] **Step 1: Declare the types** in `types/index.d.ts`, above `declare module`:

```ts
// Who started a process: the tool, and the subagent whose call it was (null for the main conversation).
export type Origin = { tool: string; agent: { type: string; description: string } | null }

// A Bash or Monitor call recorded before it ran: its exact command, and when (ms since the epoch).
export type OriginCall = Origin & { command: string; at: number }

// Calls not yet matched to a process, and the origins of listed processes by pid (with their start).
export type Origins = { calls: OriginCall[]; byPid: Record<string, Origin & { startMs: number }> }
```

- [ ] **Step 2: Write the failing tests** in `hooks/origin.test.ts`

```ts
import { expect, test } from 'claude-code/testing'

import type { OriginCall, Origins } from '../types'
import { engine, proc } from './fixtures'
import { CALL_TTL_MS, EMPTY_ORIGINS, matchOrigins, originDetail, originLabel, originOf } from './origin'
import { buildSnapshot } from './snapshot'

const wrap = (inner: string) =>
  `/bin/bash -c source /home/u/.claude/shell-snapshots/snapshot-bash-1-abc.sh 2>/dev/null || true && eval '${inner}' < /dev/null && pwd -P >| /tmp/claude-1-cwd`

// A reading at `wallMs` of wrapper processes: [pid, command, uptime seconds].
const reading = (wallMs: number, rows: [number, string, number][]) =>
  buildSnapshot(
    'linux',
    10,
    { engine, children: rows.map(([pid, inner, uptimeSeconds]) => proc(pid, 10, { command: wrap(inner), uptimeSeconds })), wallMs },
    undefined,
  )

const call = (command: string, at: number, extra: Partial<OriginCall> = {}): OriginCall => ({
  tool: 'Bash',
  agent: null,
  command,
  at,
  ...extra,
})

const origins = (calls: OriginCall[]): Origins => ({ calls, byPid: {} })

test('a wrapper row takes the call with its exact command, which then leaves the calls', () => {
  const snapshot = reading(100_000, [[11, 'npm test', 5]])
  const next = matchOrigins(origins([call('npm test', 94_000), call('ls', 94_500)]), snapshot, 100_000)
  expect(next.byPid['11']).toEqual({ tool: 'Bash', agent: null, startMs: 95_000 })
  expect(next.calls.map(each => each.command)).toEqual(['ls'])
})

test('two calls with the same command go to two processes, in start order', () => {
  const snapshot = reading(100_000, [[12, 'npm test', 3], [11, 'npm test', 5]])
  const first = call('npm test', 94_000, { tool: 'Monitor' })
  const second = call('npm test', 96_000)
  const next = matchOrigins(origins([first, second]), snapshot, 100_000)
  expect(next.byPid['11']?.tool).toBe('Monitor')
  expect(next.byPid['12']?.tool).toBe('Bash')
  expect(next.calls).toEqual([])
})

test('a call recorded after the process started is not its origin', () => {
  const snapshot = reading(100_000, [[11, 'npm test', 60]])
  const next = matchOrigins(origins([call('npm test', 90_000)]), snapshot, 100_000)
  expect(next.byPid).toEqual({})
  expect(next.calls.length).toBe(1)
})

test('ended processes and reused pids lose their origin; old calls expire', () => {
  const snapshot = reading(100_000, [[11, 'npm test', 5]])
  const kept: Origins = {
    calls: [call('old', 100_000 - CALL_TTL_MS - 1), call('fresh', 99_000)],
    byPid: {
      11: { tool: 'Bash', agent: null, startMs: 95_000 },
      12: { tool: 'Bash', agent: null, startMs: 50_000 },
    },
  }
  const next = matchOrigins(kept, snapshot, 100_000)
  expect(Object.keys(next.byPid)).toEqual(['11'])
  expect(next.calls.map(each => each.command)).toEqual(['fresh'])
  const reused = matchOrigins({ calls: [], byPid: { 11: { tool: 'Bash', agent: null, startMs: 10_000 } } }, snapshot, 100_000)
  expect(reused.byPid).toEqual({})
})

test('an unreadable table changes nothing; non-wrapper rows never match', () => {
  const kept = origins([call('python3 -c x', 94_000)])
  expect(matchOrigins(kept, { ...reading(100_000, []), children: null }, 100_000)).toEqual(kept)
  const plain = buildSnapshot('linux', 10, { engine, children: [proc(11, 10, { command: 'python3 -c x', uptimeSeconds: 5 })], wallMs: 100_000 }, undefined)
  expect(matchOrigins(kept, plain, 100_000).byPid).toEqual({})
})

test('looking up, labelling and describing an origin', () => {
  const kept: Origins = { calls: [], byPid: { 11: { tool: 'Bash', agent: null, startMs: 95_000 } } }
  expect(originOf(kept, { pid: 11, startMs: 95_800 })).toEqual({ tool: 'Bash', agent: null })
  expect(originOf(kept, { pid: 11, startMs: 99_000 })).toBeNull()
  expect(originOf(EMPTY_ORIGINS, { pid: 11, startMs: 0 })).toBeNull()
  const sub = { tool: 'Bash', agent: { type: 'code-reviewer', description: 'Review the diff' } }
  expect(originLabel({ tool: 'Monitor', agent: null })).toBe('Monitor')
  expect(originLabel(sub)).toBe('subagent: code-reviewer')
  expect(originDetail({ tool: 'Bash', agent: null })).toBe('started by Bash in the main conversation')
  expect(originDetail(sub)).toBe('started by Bash in subagent code-reviewer: Review the diff')
})
```

(Starts: a row read at 100 000 ms with uptime 5 s started at 95 000. In the order test pid 11 started at 95 000 and pid 12 at 97 000, so 11 takes the earlier call. In the "after" test the process started at 40 000, 50 s before the call at 90 000.)

- [ ] **Step 3: Run to see them fail**

Run: `claude plugin test . 2>&1 | grep -E "origin|^\(fail\)| pass| fail"` → the origin test file fails to load; the other 109 pass.

- [ ] **Step 4: Write `hooks/origin.ts`**

```ts
// Which tool call, and which agent, started each of Claude Code's Bash and Monitor processes.

import type { Origin, Origins, ProcRow, Snapshot } from '../types'
import { START_TOLERANCE_MS, unwrapCommand } from './view'

export const EMPTY_ORIGINS: Origins = { calls: [], byPid: {} }

// An unmatched call is forgotten after this long.
export const CALL_TTL_MS = 600_000

// Each reading: keep origins whose process is still listed with the same start; give each unmatched
// wrapper row, oldest first, the oldest recorded call with its exact command that was recorded no
// later than the process started (within the start tolerance); drop calls matched or expired.
// An unreadable table changes nothing.
export const matchOrigins = (origins: Origins, snapshot: Snapshot, now: number): Origins => {
  const rows = snapshot.children
  if (rows === null) return origins
  const byPid: Origins['byPid'] = {}
  for (const row of rows) {
    const kept = origins.byPid[String(row.pid)]
    if (kept && Math.abs(kept.startMs - row.startMs) <= START_TOLERANCE_MS) byPid[String(row.pid)] = kept
  }
  let calls = origins.calls.filter(each => now - each.at <= CALL_TTL_MS)
  const waiting = rows
    .filter(row => byPid[String(row.pid)] === undefined)
    .map(row => ({ row, inner: unwrapCommand(row.command) }))
    .filter((each): each is { row: ProcRow; inner: string } => each.inner !== null)
    .sort((a, b) => a.row.startMs - b.row.startMs)
  for (const { row, inner } of waiting) {
    const index = calls.findIndex(each => each.command === inner && each.at <= row.startMs + START_TOLERANCE_MS)
    if (index < 0) continue
    const { tool, agent } = calls[index]!
    byPid[String(row.pid)] = { tool, agent, startMs: row.startMs }
    calls = [...calls.slice(0, index), ...calls.slice(index + 1)]
  }

  return { calls, byPid }
}

// The origin of a listed process, matched by pid and start; null when unknown.
export const originOf = (origins: Origins, row: { pid: number; startMs: number }): Origin | null => {
  const kept = origins.byPid[String(row.pid)]
  if (!kept || Math.abs(kept.startMs - row.startMs) > START_TOLERANCE_MS) return null

  return { tool: kept.tool, agent: kept.agent }
}

// Short, for the command cell: the tool, or the subagent's type.
export const originLabel = (origin: Origin) => (origin.agent ? `subagent: ${origin.agent.type}` : origin.tool)

// Long, for the details.
export const originDetail = (origin: Origin) =>
  origin.agent
    ? `started by ${origin.tool} in subagent ${origin.agent.type}: ${origin.agent.description}`
    : `started by ${origin.tool} in the main conversation`
```

- [ ] **Step 5: Run the tests**

Run: `claude plugin test . 2>&1 | grep -E "^\(fail\)| pass| fail"` → `115 pass`, `0 fail`.
Run: `npx -y -p typescript@5.9.3 tsc -p .` → no output.

- [ ] **Step 6: Commit**

```bash
git add types/index.d.ts hooks/origin.ts hooks/origin.test.ts
git commit -m "feat(origin): match recorded Bash and Monitor calls to their processes"
```

---

### Task 2: Recording calls and matching each reading

**Files:**
- Modify: `types/index.d.ts` (state contract), `hooks/register.ts`, `hooks/register.test.ts` (create if absent)

**Interfaces:**
- Consumes: Task 1's `EMPTY_ORIGINS`, `matchOrigins`; `Origins`, `OriginCall`.
- Produces: the `origins` state value, kept current each reading.

- [ ] **Step 1: State contract** — in `types/index.d.ts` add `origins: Origins` to `'proc-stats'`, with a comment line `// origins: recorded Bash/Monitor calls and the origins of listed processes.`

- [ ] **Step 2: Write the failing test** in `hooks/register.test.ts` (a new file; if one exists, append):

```ts
import { expect, test } from 'claude-code/testing'

test('a Bash call is recorded before it runs and passes on unchanged', async ($, on) => {
  const writes: unknown[] = []
  on('state.set', { plugin: 'proc-stats', key: 'origins' }, ($, e, next) => {
    writes.push(e.value)
    return next(e)
  })
  const seen: unknown[] = []
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    seen.push(e.command)
    return { result: 'ok' }
  })
  await $.tool.call({ tool: 'Bash', input: { command: 'npm test' } })
  expect(seen).toEqual(['npm test'])
  const last = writes[writes.length - 1] as { calls: { command: string; tool: string; agent: unknown }[] }
  expect(last.calls.map(each => [each.command, each.tool, each.agent])).toEqual([['npm test', 'Bash', null]])
})
```

The exact shapes of `$.tool.call`'s argument and of a `state.set` hook's `e` come from the testing types: check them (`grep -n "tool: {" -A30` and `'state.set'` in `/home/vscode/proc-stats/.claude-plugin/types/claude-code/index.d.ts`) and adjust only the call syntax, not what is asserted: the call reaches the tool unchanged, and the `origins` write holds one call with that command, tool `Bash`, agent null. If the kit cannot raise a `tool.call` or observe a state write, report DONE_WITH_CONCERNS and keep Task 1's unit coverage as the guard.

- [ ] **Step 3: Run to see it fail**

Run: `claude plugin test . 2>&1 | grep -E "^\(fail\)| pass| fail"` → the new test fails (nothing recorded).

- [ ] **Step 4: Implement in `hooks/register.ts`**

Imports: `import { EMPTY_ORIGINS, matchOrigins } from './origin'`; add `OriginCall, Origins` to the `../types` type import.

Ref and atom, next to the others:

```ts
const ORIGINS = { plugin: 'proc-stats', key: 'origins' } as const
const origins = atom(ORIGINS, EMPTY_ORIGINS as Origins)
```

Above `register`:

```ts
// Records a Bash or Monitor call before it runs, with the subagent whose call it is. Never throws:
// a failure here costs the origin only, never the call.
const recordCall = async ($: EngineInterface, tool: string, command: string | undefined, agentId: string | undefined) => {
  if (!command) return
  try {
    const listed = agentId ? (await $.agent.list()).find(agent => agent.id === agentId) : undefined
    const call: OriginCall = {
      tool,
      agent: listed ? { type: listed.type, description: listed.description } : null,
      command,
      at: await $.clock.now(),
    }
    await update($, origins, kept => ({ ...kept, calls: [...kept.calls, call] }))
  } catch {
    // The process will show without an origin.
  }
}
```

In `register`, the hooks (they only record, then pass the call on as it came):

```ts
  // Where processes come from: each Bash and Monitor call is recorded before it runs.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    await recordCall($, 'Bash', e.command, e.agentId)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Monitor' }, async ($, e, next) => {
    await recordCall($, 'Monitor', e.command, e.agentId)

    return next(e)
  }).catch(($, e, next) => next(e))
```

In `sample()`, next to the pane prune (after `await set({ snapshot: capRows(snapshot) })`), match origins against the uncapped `snapshot`, writing only on a change:

```ts
        try {
          const kept = (await $.state.get(ORIGINS)).value ?? EMPTY_ORIGINS
          const matched = matchOrigins(kept, snapshot, now.wallMs)
          if (JSON.stringify(matched) !== JSON.stringify(kept)) {
            await update($, origins, current => matchOrigins(current, snapshot, now.wallMs))
          }
        } catch {
          // Origins catch up at the next reading.
        }
```

(The write applies `matchOrigins` to the value current at write time, so a call recorded during the reading is not lost.)

- [ ] **Step 5: Run everything**

Run: `claude plugin test .` → `116 pass`, `0 fail`.
Run: `npx -y -p typescript@5.9.3 tsc -p .` → no output.
Run: `claude plugin validate . 2>&1 | grep -E "gating|state|calls|✔|✘"` → `gating hook with .catch: tool.call{tool=Bash}` and `{tool=Monitor}`; state lists `proc-stats.origins`; calls include `$.agent.list`; `✔ Validation passed`, no warnings.

- [ ] **Step 6: Commit**

```bash
git add types/index.d.ts hooks/register.ts hooks/register.test.ts
git commit -m "feat(origin): record Bash and Monitor calls; match them each reading"
```

---

### Task 3: Origins in the pane

**Files:**
- Modify: `hooks/pane.tsx`, `hooks/view.ts`, `hooks/register.ts`, `hooks/pane.test.ts`, `hooks/view.test.ts`, `README.md`, `.claude-plugin/plugin.json`

**Interfaces:**
- Consumes: Task 1's `originOf`, `originLabel`, `originDetail`, `unwrapCommand`.
- Produces: `commandCell(view: ViewRow, width: number, origin?: string)`; `detailLines(snapshot, selected, origins?: Origins)` (third line `started by …` or `origin unknown`); `drawPane(elements, reading, state, points, origins: Origins, bodyColumns, handlers)`.

- [ ] **Step 1: Write the failing tests**

Append to `hooks/view.test.ts` (it already has `wrap`, `engine`, `proc`, `buildSnapshot`; extend the `./view` import with nothing new):

```ts
test('details say who started a Bash command, or that it is unknown', () => {
  const snapshot = buildSnapshot('linux', 10, { engine, children: [proc(11, 10, { command: wrap('npm test'), uptimeSeconds: 5 }), proc(12, 10, { command: 'sleep 9', uptimeSeconds: 5 })], wallMs: 100_000 }, undefined)
  const origins = { calls: [], byPid: { 11: { tool: 'Bash', agent: null, startMs: 95_000 } } }
  expect(detailLines(snapshot, { pid: 11, startMs: 95_000 }, origins)?.[2]).toBe('started by Bash in the main conversation')
  expect(detailLines(snapshot, { pid: 11, startMs: 95_000 }, { calls: [], byPid: {} })?.[2]).toBe('origin unknown')
  expect(detailLines(snapshot, { pid: 12, startMs: 95_000 }, origins)?.length).toBe(2)
})
```

Append to `hooks/pane.test.ts`:

```ts
test('a command row names its origin; sorted views add the parent after it', () => {
  const view = viewRows(snapshot, state())[0]!
  expect(commandCell(view, 30, 'Bash')).toEqual({ main: fit('└ ▾ cmd11', 23), parent: ' · Bash' })
  const sorted = viewRows(snapshot, state({ sort: 'mem' }))[0]!
  expect(commandCell(sorted, 30, 'Monitor').parent).toBe(fit(' · Monitor ← cmd11', 10))
})
```

(The tail — ` · <origin>` then ` ← <parent>` — gets at most a third of the width: 10 cells at width 30. ` · Bash` is 7 cells, so the main gets 23; the sorted row's tail ` · Monitor ← cmd11` is 18 cells, cut to 10. Add `fit` to that file's `./view` import.)

- [ ] **Step 2: Run to see them fail** — `claude plugin test . 2>&1 | grep -E "^\(fail\)| pass| fail"` → the new tests fail.

- [ ] **Step 3: Implement**

`hooks/pane.tsx` — `commandCell` gains the origin, one dim tail for origin and parent:

```tsx
// The command cell: tree lines, the collapse marker and the label; then, dim, its origin and
// (in sorted views) its parent, given at most a third of the width.
export const commandCell = (view: ViewRow, width: number, origin?: string) => {
  const main = `${view.prefix}${marker(view)}${view.label}`
  const tail = `${origin ? ` · ${origin}` : ''}${view.parent !== null ? ` ← ${view.parent}` : ''}`
  if (tail === '') return { main: fit(main, width), parent: '' }
  const tailWidth = Math.min(Array.from(tail).length, Math.floor(width / 3))

  return { main: fit(main, width - tailWidth), parent: fit(tail, tailWidth) }
}
```

`drawPane` takes `origins: Origins` after `points` (import `Origins` from `../types`, `originLabel, originOf` from `./origin`); in `childRows` pass the origin label:

```tsx
      commandCell(view, commandWidth, (() => {
        const origin = originOf(origins, view.row)
        return origin ? originLabel(origin) : undefined
      })()),
```

and `detailLines(snapshot, state.selected, origins)`.

`hooks/view.ts` — `detailLines(snapshot, selected, origins?: Origins)`: after the two existing lines for a child row, add a third when the row is a Bash wrapper (`unwrapCommand(row.command) !== null`) or has an origin:

```ts
  const origin = origins ? originOf(origins, row) : null
  const lines = [/* the two existing lines */]
  if (origin) return [...lines, originDetail(origin)]
  if (origins && unwrapCommand(row.command) !== null) return [...lines, 'origin unknown']

  return lines
```

(import `Origins` type and `originDetail, originOf` from `./origin` — `origin.ts` imports from `view.ts` too; the cycle is type-and-function only at module level and runs no code on import, which TypeScript and the engine allow. If the validator or tsc reports the cycle, move `originOf`/`originLabel`/`originDetail` into `view.ts` instead and import them in `origin.ts`.)

`hooks/register.ts` — the render hook passes `await read($, origins)` after the history points.

- [ ] **Step 4: Run everything**

`claude plugin test .` → `118 pass`, `0 fail`; `npx -y -p typescript@5.9.3 tsc -p .` → no output; `claude plugin validate .` → `✔ Validation passed`, no warnings.

- [ ] **Step 5: README and version** — in "## Processes pane", extend the Rows bullet with: "A `$ …` row also says what started it — `· Bash`, `· Monitor`, or `· subagent: <type>` — and the details name the subagent's task." Change the later-package note to name only detached processes. Set `"version": "0.2.6"`. Validate.

- [ ] **Step 6: Commit**

```bash
git add hooks/pane.tsx hooks/view.ts hooks/register.ts hooks/pane.test.ts hooks/view.test.ts README.md .claude-plugin/plugin.json
git commit -m "feat(pane): command rows and details name their origin"
```

- [ ] **Step 7: Live check (the person, after the final review)**

1. A Bash command run by Claude shows `$ <command> · Bash` in the pane while it runs.
2. A Monitor shows `· Monitor`; a subagent's command shows `· subagent: <type>` and the details give its task.
