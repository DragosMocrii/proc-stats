# proc-stats v0.3, package D: sparklines

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two sparkline lines at the top of the Processes pane — the session's total memory and CPU over the history window — so a leak or a spike shows as a shape, not just a current number.

**Architecture:** A pure module `hooks/sparkline.ts` turns the history's points into two text lines of Unicode blocks (`▁▂▃▄▅▆▇█`), downsampled to the pane's width with package A's `downsample` (bucket maxima, so spikes survive). `pane.tsx` draws them above the "peak" line; `register.ts` passes the history it already keeps in `$.state` to the drawing.

**Tech Stack:** TypeScript Claude Code mod (hooks module, `claude-code` API), tests with `claude-code/testing` under `claude plugin test`, type-check with `tsc` 5.9.3.

**Spec:** `docs/superpowers/specs/2026-10-09-proc-stats-v3-design.md` (Data and history: "Sparklines downsample the buffer to the available width, keeping each bucket's maximum, so spikes stay visible"; Pane › Layout: "two sparkline lines (memory, CPU) with current values"; "On narrow panes, columns give way as today and sparklines shorten").

## Global Constraints

- The repository is `/home/vscode/proc-stats`, on the branch the controller names. Commit after each task. Do not push. Do not touch `/home/vscode/.claude/dev-mods/`.
- `$` may not be passed into a function imported from another file; `sparkline.ts` and `pane.tsx` take plain data.
- A Button holds only strings and `Text`; the sparkline lines are plain `Text`, not Buttons.
- Commands, run from the repository root: tests `claude plugin test .`; validate `claude plugin validate .` (ends `✔ Validation passed`, no warnings); type-check `npx -y -p typescript@5.9.3 tsc -p .`.
- Tests use only `toBe / toEqual / toBeNull / toBeDefined / toBeUndefined / toContain`; assert exact values.
- Scales (decided in this plan; the spec is silent): memory from 0 to the window's highest point (so a rising line reads as growth, not noise); CPU from 0 to `max(100, highest point)` (one full core is the top until something uses more).
- The history holds whole points only (package A): `{ t, memKb, cpuPct }` totals of Claude Code and every process it started, at most 2400 of them, oldest first.

## Review Focus

- **Fewer points than columns** (just after start, or a short window): the chart is as long as the points, not stretched or padded with fake values. Pinned in Task 1.
- **No history yet** (fewer than 2 points): no chart lines at all, and nothing else in the pane moves. Pinned in Tasks 1 and 2.
- **CPU above one core** (e.g. 310%): the scale grows to the highest value, so the bar tops out at that point, not clipped at 100%. Pinned in Task 1.
- **A flat or zero series** (memory constant, CPU 0): no division by zero; a zero series is all `▁`. Pinned in Task 1.
- **A very narrow pane**: the chart shrinks to nothing before the current value is cut. Pinned in Task 1.

---

### Task 1: Sparkline text

**Files:**
- Create: `hooks/sparkline.ts`, `hooks/sparkline.test.ts`

**Interfaces:**
- Consumes: `downsample(values: number[], width: number): number[]` from `hooks/history.ts`; `formatBytes`, `formatPercent` from `hooks/format.ts`; `fit` from `hooks/view.ts`; `Point` from `../types`.
- Produces: `BLOCKS: string[]` (8 blocks, lowest first); `sparkline(values: number[], width: number, top: number): string`; `sparkLines(points: Point[], width: number): [string, string] | null`.

- [ ] **Step 1: Write the failing tests** in `hooks/sparkline.test.ts`

```ts
import { expect, test } from 'claude-code/testing'

import { MB } from './fixtures'
import { sparkline, sparkLines } from './sparkline'

const point = (t: number, memMb: number, cpuPct: number) => ({ t, memKb: memMb * MB, cpuPct })

test('values become blocks from 0 to the top', () => {
  expect(sparkline([0, 50, 100], 3, 100)).toBe('▁▅█')
  expect(sparkline([0, 0], 5, 0)).toBe('▁▁')
  expect(sparkline([10, 20], 0, 20)).toBe('')
})

test('fewer values than columns: as long as the values; more: bucket maxima', () => {
  expect(sparkline([100, 100], 10, 100)).toBe('██')
  expect(sparkline([0, 100, 0, 0], 2, 100)).toBe('█▁')
})

test('no lines before two points', () => {
  expect(sparkLines([], 40)).toBeNull()
  expect(sparkLines([point(0, 500, 10)], 40)).toBeNull()
})

test('memory scales to its highest point; CPU to one core or its highest point', () => {
  expect(sparkLines([point(0, 512, 50), point(1000, 1024, 200)], 20)).toEqual(['mem ▅█ 1.00GB', 'cpu ▃█ 200.0%'])
  expect(sparkLines([point(0, 512, 0), point(1000, 512, 50)], 20)).toEqual(['mem ██ 512MB', 'cpu ▁▅ 50.0%'])
})

test('a narrow pane drops the chart before the value', () => {
  expect(sparkLines([point(0, 512, 50), point(1000, 1024, 200)], 11)).toEqual(['mem  1.00GB', 'cpu  200.0%'])
})
```

(Checks: `[0, 50, 100]` over 100 → `round(0)=0`, `round(3.5)=4`, `round(7)=7` → `▁▅█`. In the first `sparkLines` case the values are `1.00GB` and `200.0%` (6 cells each), so the chart gets `20 − 4 − 1 − 6 = 9` columns and draws its 2 points; memory 512/1024 → `▅`, 1024 → `█`; CPU over `max(100, 200)` = 200: 50 → `round(1.75)=2` → `▃`, 200 → `█`. In the second, memory is flat at 512 MB → both `█`; CPU over 100: 0 → `▁`, 50 → `▅`; the values `512MB` and `50.0%` are 5 cells each, so no padding. At width 11 the chart gets 0 columns.)

- [ ] **Step 2: Run to see them fail**

Run: `claude plugin test . 2>&1 | grep -E "sparkline|^\(fail\)| pass| fail"`
Expected: the sparkline test file fails to load (`./sparkline` not found); the other 100 pass.

- [ ] **Step 3: Write `hooks/sparkline.ts`**

```ts
// The session's history as two lines of blocks: memory and CPU over the window.

import type { Point } from '../types'
import { formatBytes, formatPercent } from './format'
import { downsample } from './history'
import { fit } from './view'

export const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

// One block per value from 0 to `top`, at most `width` of them (bucket maxima when more).
export const sparkline = (values: number[], width: number, top: number) => {
  if (width <= 0) return ''
  const top_ = top > 0 ? top : 1

  return downsample(values, width)
    .map(value => BLOCKS[Math.min(7, Math.max(0, Math.round((value / top_) * 7)))]!)
    .join('')
}

// `mem <chart> <now>` and `cpu <chart> <now>` in `width` cells; null until there are two points.
export const sparkLines = (points: Point[], width: number): [string, string] | null => {
  const last = points[points.length - 1]
  if (points.length < 2 || !last) return null
  const memory = points.map(point => point.memKb)
  const cpu = points.map(point => point.cpuPct)
  const memNow = formatBytes(last.memKb)
  const cpuNow = formatPercent(last.cpuPct)
  const valueWidth = Math.max(memNow.length, cpuNow.length)
  // `mem ` + chart + ` ` + value.
  const chartWidth = Math.max(0, width - 4 - 1 - valueWidth)

  return [
    `mem ${sparkline(memory, chartWidth, Math.max(...memory))} ${fit(memNow, valueWidth, true)}`,
    `cpu ${sparkline(cpu, chartWidth, Math.max(100, ...cpu))} ${fit(cpuNow, valueWidth, true)}`,
  ]
}
```

(`Math.max(...memory)` over at most 2400 points is well within argument limits.)

- [ ] **Step 4: Run the tests**

Run: `claude plugin test . 2>&1 | grep -E "^\(fail\)| pass| fail"` → `105 pass`, `0 fail`.
Run: `npx -y -p typescript@5.9.3 tsc -p .` → no output.

- [ ] **Step 5: Commit**

```bash
git add hooks/sparkline.ts hooks/sparkline.test.ts
git commit -m "feat(sparkline): memory and CPU history as lines of blocks"
```

---

### Task 2: Sparklines in the pane

**Files:**
- Modify: `hooks/pane.tsx`, `hooks/register.ts`, `hooks/pane.test.ts`, `README.md`, `.claude-plugin/plugin.json`

**Interfaces:**
- Consumes: Task 1's `sparkLines(points, width)`; the `history` atom already in `register.ts` (`const history = atom(HISTORY, { points: [] } as History)`).
- Produces: `drawPane(elements, reading, state, points: Point[], bodyColumns, handlers)` — a new `points` parameter after `state`.

- [ ] **Step 1: Write the failing mount test** — append to `hooks/pane.test.ts`:

```ts
test('the pane draws the memory and CPU history above the table, once there is some', async ($, on) => {
  on('state.get', { plugin: 'proc-stats', key: 'reading' }, () => ({ value: { value: { snapshot }, version: 1 } }))
  let points: { t: number; memKb: number; cpuPct: number }[] = []
  on('state.get', { plugin: 'proc-stats', key: 'history' }, () => ({ value: { value: { points }, version: 1 } }))
  const mount = () =>
    $.ui.mount({
      plugin: 'proc-stats',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'proc-stats',
      props: { ...PANE_PROPS, bodyColumns: 80 },
    })
  const empty = await mount()
  expect(await empty.find({ type: 'Text', text: /^cpu / })).toBeUndefined()
  await empty.unmount()
  points = [
    { t: 0, memKb: 512 * MB, cpuPct: 50 },
    { t: 1000, memKb: 1024 * MB, cpuPct: 200 },
  ]
  const drawn = await mount()
  expect(await drawn.find({ type: 'Text', text: /^mem ▅█ +1\.00GB$/ })).toBeDefined()
  expect(await drawn.find({ type: 'Text', text: /^cpu ▃█ +200\.0%$/ })).toBeDefined()
  await drawn.unmount()
})
```

(`MB`, `snapshot` and `PANE_PROPS` already exist at the top of `pane.test.ts`; `MB` is imported from `./fixtures` there.)

- [ ] **Step 2: Run to see it fail**

Run: `claude plugin test . 2>&1 | grep -E "^\(fail\)| pass| fail"` → the new test fails (no `mem`/`cpu` lines).

- [ ] **Step 3: Draw them** — in `hooks/pane.tsx`:

Add imports: `import type { PaneState, Point, Reading } from '../types'` (add `Point`) and `import { sparkLines } from './sparkline'`.

Change the signature to take the points after `state`:

```tsx
export const drawPane = (
  { Box, Text, Button }: Elements[RenderSurface],
  { snapshot, error }: Reading,
  state: PaneState,
  points: Point[],
  bodyColumns: number,
  handlers: PaneHandlers,
) => {
```

After `const views = viewRows(snapshot, state)` add:

```tsx
  // The history's shape over the window, in the width the rows use.
  const charts = sparkLines(points, bodyColumns - (PADDING_X + ROW_PADDING_X) * 2)
```

In the returned tree, immediately before the `<Box marginBottom={1} paddingX={ROW_PADDING_X}>` that holds the "peak …" line, add:

```tsx
      {charts !== null && (
        <Box flexDirection="column" paddingX={ROW_PADDING_X}>
          <Text>{charts[0]}</Text>
          <Text>{charts[1]}</Text>
        </Box>
      )}
```

In `hooks/register.ts`, pass the history to the drawing (the render hook subscribes to it, so a recorded point redraws the pane):

```ts
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) =>
    drawPane(
      $.ui.resolve(e),
      await read($, reading),
      await read($, pane),
      (await read($, history)).points,
      e.props.bodyColumns,
      paneHandlers($),
    ),
  )
```

- [ ] **Step 4: Run everything**

Run: `claude plugin test . 2>&1 | grep -E "^\(fail\)| pass| fail"` → `106 pass`, `0 fail`.
Run: `npx -y -p typescript@5.9.3 tsc -p .` → no output.
Run: `claude plugin validate . 2>&1 | grep -E "state reads|✔|✘"` → state reads include `proc-stats.history`; `✔ Validation passed`, no warnings.

- [ ] **Step 5: README and version**

In `README.md`, in the "## Processes pane" section, add as the first bullet:

```markdown
- **History:** two lines at the top chart the session's total memory and CPU (Claude Code and everything it started) over the history window (10 minutes by default; see Settings), with the current value at the end. Memory is scaled to the window's highest point; CPU to one core, or to its highest point when that is more. Short spikes stay visible.
```

and remove "sparklines" from the README's note about what arrives in a later package (only process origins remain). In `.claude-plugin/plugin.json` set `"version": "0.2.4"`.

Run: `claude plugin validate .` → `✔ Validation passed`.

- [ ] **Step 6: Commit**

```bash
git add hooks/pane.tsx hooks/register.ts hooks/pane.test.ts README.md .claude-plugin/plugin.json
git commit -m "feat(pane): memory and CPU sparklines above the table"
```

- [ ] **Step 7: Live check (the person, after the final review)**

1. `/proc-stats` shows `mem …` and `cpu …` lines with blocks growing to the right as readings arrive.
2. A dummy process using a core for 20 s shows a raised block run in the CPU line that stays visible after it ends.
3. Narrowing the pane shortens the charts; the values stay readable.
