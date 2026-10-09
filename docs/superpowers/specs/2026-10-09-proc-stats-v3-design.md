# proc-stats v0.3: design

Date: 2026-10-09
Status: approved in conversation; awaiting spec review

## Intent

proc-stats shows the resource use of a Claude Code session: Claude Code's own process and every process it started. v0.3 makes it useful for **spotting runaway or heavy processes and dealing with them**, and for understanding where they came from.

Agreed scope (all of it, built in the order of the work packages below):

1. A 🟡/🔴 marker on the status line when session totals pass a limit.
2. A toast when a child process uses a lot of CPU for a long time, or grows past a memory limit.
3. Memory and CPU sparklines for the session in the pane.
4. Stopping a selected process (and what it started) from the pane, after confirmation.
5. Sorting the pane by CPU, memory or runtime, as well as the tree.
6. Bash commands shown as their real command, collapsible, with subtree totals.
7. Each command row's origin: which tool call, and which subagent.
8. The full command line and details of the selected row.
9. Detached processes started from the session (`nohup`, daemons).
10. Settings for intervals, limits, history and the status line.
11. `/proc-stats report`, a summary in the conversation.

Out of scope: desktop notifications and sounds, per-row sparklines, a long-running sampler helper, detached-process detection on Windows.

## Constraints from the mod API

- `$.ui.status` takes plain text only; it cannot be colored. Hence a marker, not colored numbers.
- A pane receives no raw key events. Its Buttons are walked by Tab and the arrows, pressed by Enter or a click, and take one-letter `hotkey`s while the pane holds the keyboard; `ui.focus` reports which element holds focus.
- A Button may hold only strings and `Text`, not `Box`es.
- `userConfig` fields in `plugin.json` appear in Claude Code's config menu and reach `register` as `options`; a change reloads the module.
- `$.state` survives reloads; the module's own variables do not.
- `$.env.set` changes the environment of every process the engine starts afterwards.
- `$` may not be passed across an import: modules that use `$` keep it in `register.ts`, and helpers take plain data or element tables.

## Architecture

The mod is split into focused modules. Everything but the sampler and the hooks is a pure function over plain data.

| Module | Holds |
|---|---|
| `settings.ts` | `options` → a typed `Settings` with defaults; the only reader of `options` |
| `stats.ts` | per-platform parsers (exists) |
| `sampler.ts` | parsing a full reading: Claude Code, descendants, detached processes (pid, ppid, command, memory, CPU seconds, start time, marker) |
| `snapshot.ts` | two readings → `Snapshot`: per-process CPU %, tree, totals (today's `buildSnapshot`) |
| `history.ts` | ring buffer of `{ t, memKb, cpuPct }` totals; downsampling by max; averages |
| `alerts.ts` | marker level with hysteresis; per-process toast tracker |
| `origin.ts` | unwrapping the Bash wrapper's `eval '…'`; matching tool calls to rows |
| `view.ts` | pane rows as fixed-width text cells; sorting; collapsing; selection; stop targets; sparkline text |
| `pane.tsx` | drawing only, from `view.ts` output and the element table |
| `report.ts` | the report text |
| `register.ts` | the timer, hooks, commands, `$` calls (fs, process, env, state, ui) |

Step one of the work is the split itself, with no visible change.

## Settings (`userConfig`)

| Field | Default | Meaning |
|---|---|---|
| `intervalLinuxMs` | 1000 | refresh on Linux |
| `intervalMacMs` | 2000 | refresh on macOS |
| `intervalWindowsMs` | 5000 | refresh on Windows |
| `warnMemMb` / `alertMemMb` | 2048 / 4096 | marker memory limits (session total) |
| `warnCpuPct` / `alertCpuPct` | 150 / 300 | marker CPU limits (session total, 10 s average) |
| `toastCpuPct` / `toastCpuSeconds` | 90 / 60 | CPU toast: per process, sustained |
| `toastMemMb` | 1024 | memory toast: per process |
| `historyMinutes` | 10 | sparkline window |
| `statusShowChildren` | true | show the `+ children` part of the status line |

Invalid or missing values fall back to the defaults.

## Data and history

- Each successful reading appends one point (time, total memory, total CPU %) to a ring buffer in `$.state`, sized for `historyMinutes` at the current interval. Totals include Claude Code, descendants and detached processes.
- Sparklines downsample the buffer to the available width, keeping each bucket's maximum, so spikes stay visible.
- Alerts use the average of the last 10 s of points.
- A failed reading changes no history. A reading without a process table yields children unknown, as today.

## Alerts

**Marker.** Level is the worse of memory (current total) and CPU (10 s average): none, warn (`🟡 ` prefix) or alert (`🔴 ` prefix). A level only falls once its value is 10% below the limit. The level lives in `$.state`.

**Toasts.** For each descendant and detached process (not Claude Code), keyed by pid and start time:

- CPU: when it first exceeds `toastCpuPct` is recorded; after `toastCpuSeconds` above it, one toast: `<command> has used ~<n>% CPU for <duration> · pid <pid> · /proc-stats`.
- Memory: on first passing `toastMemMb`, one toast: `<command> grew past <size> · pid <pid> · /proc-stats`.
- Each kind fires once per process and re-arms after 10 s below 90% of its limit.
- Several in one reading become one toast: `<n> processes over limits: … · /proc-stats`.
- Ended processes leave the tracker. The first reading never alerts.

## Pane

**Layout**, top to bottom: two sparkline lines (memory, CPU) with current values; peak memory and platform; the table (header, Claude Code, tree or sorted list, Detached group, totals); the detail area for the selected row; a footer of key buttons.

**Rows** are plain keyed Buttons (`pid:<pid>`) built from fixed-width text cells (padded and cut by `view.ts`). The header and zebra stripes color each cell's background with theme keys (`claude`/`inverseText`, `subtle`). Tree lines (`├ └ │`) as today.

**Selection** is the focused row, stored from `ui.focus` in `$.state` by pid and start time; it survives updates and is dropped when the process ends.

**Keys** (also footer buttons):

| Key | Action |
|---|---|
| ↑ / ↓ | move between rows (the focus ring) |
| Enter / click | select; on a command row also expand or collapse |
| `s` | sort: tree → CPU → memory → runtime → tree |
| `k` | stop the selected process |
| Esc | cancel a confirmation, else return to the prompt |

Sorted views are flat, with the parent's command dim after each row.

**Command rows.** A Bash wrapper row shows its real command, `$ npm test`, and its origin. It starts expanded; collapsed, it shows its subtree's total memory and CPU.

**Stopping.** `k` turns the footer into `Stop <command> (pid <pid>) and the <n> processes it started? [y] Stop  [n] Cancel`. `y` sends SIGTERM to the process's descendants (deepest first) and then to the process, using the latest reading's tree (Windows: `taskkill /T /PID`). After 3 s, if any are still listed, the footer offers `[f] Force stop` (SIGKILL; Windows `taskkill /F /T`). A pid is acted on only while the latest reading lists it with the same start time. The Claude Code row cannot be stopped. A toast reports the outcome.

**Detail area**: the full command line wrapped, pid, parent, start time, origin, memory and CPU of the selected row.

On narrow panes, columns give way as today and sparklines shorten.

## Origin

- A `tool.call` hook on `Bash` and `Monitor` records, before the call runs, its command, the tool, and its subagent (`agentId`, named through `$.agent.list()`), then passes the call on unchanged.
- A wrapper row matches a recorded call when the command unwrapped from its `eval '…'` (with `'"'"'` unquoted) equals the call's command. This holds for parallel and background calls.
- Unmatched wrapper rows still show the unwrapped command, with origin `—`.
- Matches are stored in `$.state` by pid and start time and pruned when the process ends; recorded calls are pruned after their process is matched or after 10 minutes.

## Detached processes

- At session start, `$.env.set('PROC_STATS_SESSION', <random id>)`. Every command started afterwards carries it, including ones that detach.
- A process is detached when it is not under Claude Code, started after the session, and its environment holds the id.
- Linux: read `/proc/<pid>/environ` once per new process, cached by pid and start time.
- macOS: `ps eww -o pid=,command=` every 10 s, cached the same way.
- Windows: not detected (documented).
- Detached processes form a **Detached** group with its own subtotal; they count toward totals, the marker and toasts, and can be stopped.
- An unreadable environment counts as not ours. If `$.env.set` fails, detection is off and the detail area says so.

## Report

`/proc-stats report` returns text that both the person and the model read: platform and uptime; current totals for Claude Code, children and detached; peaks over the history window with their time; the 5 heaviest processes with origin; up to 10 detached processes; the marker level and recent toasts. Every line is derived from current state. `/proc-stats` with no argument opens the pane.

## Errors

- A failed reading: status line shows `proc-stats: cannot read …`; history, alerts and selection are unchanged.
- A stop that fails (permission, already gone): the outcome toast says so; nothing is retried without the person.
- Every `$.state` value has a safe empty default, so a reload mid-session draws correctly.

## Testing

Unit tests per module:

- `settings`: defaults, invalid values.
- `history`: push and wrap, downsampling by max, averages.
- `alerts`: levels each side of each limit, the 10% fall-back, CPU toast at exactly the duration, once-only and re-arming, reused pid, merging, memory toast.
- `origin`: unwrapping, including `'"'"'` and newlines; matching with two parallel calls.
- `sampler`: marker found in `/proc/<pid>/environ` and `ps eww` text; the detached filter and its cache.
- `view`: cells, cutting and padding, stripes, each sort, collapsing with subtotals, stop targets with the reused-pid guard, sparkline text.
- `report`: text from a fixed snapshot.

Mounted pane tests on `terminal` and `desktop`: pressing a row, `s`, and `k` then `n`, with the stop action stubbed. A hook test raising a `tool.call` through the kit records an origin. A real-terminal check of the pane and status line after each work package.

## To verify at the start of its package

- **A:** the `userConfig` field format (number and boolean fields, defaults) against this build's types.
- **E:** that `Monitor` commands run under the same `bash -c … eval '…'` wrapper as `Bash`; if not, match `Monitor` calls by their own wrapper format, or fall back to timing (new top-level children while the call starts).
- **E:** that a process detached with `setsid`/`nohup` keeps `PROC_STATS_SESSION` in its environment on Linux and macOS.

## Work packages

| # | Package | Contains |
|---|---|---|
| A | Restructure, settings, history | the module split (no visible change), `settings.ts`, `history.ts` |
| B | Alerts | marker, CPU and memory toasts |
| C | Pane interaction | rows as buttons, selection, detail area, sort, command rows and collapsing, stop |
| D | Sparklines | pane header from history |
| E | Origin and detached | `tool.call` origin, session marker, Detached group |
| F | Report | `/proc-stats report` |

Each package ends with tests, `claude plugin validate`, a type-check, a live check, and a version bump.
