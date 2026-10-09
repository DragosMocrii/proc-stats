# proc-stats

A Claude Code mod that pins a status line with the session's own resource use, and opens a task-manager pane of it on `/proc-stats`:

```
mem 484MB · peak 530MB · cpu 2.4% · up 12m 4s
```

While the session has processes running under it (Bash commands, watchers, test runs, local MCP servers), or ones it started that have since detached, their share is added after a `+`:

```
mem (484 + 215)MB · peak 530MB · cpu (2.4 + 98.7)% · up 12m 4s
```

- **mem**: resident memory of Claude Code, plus every process below it and every detached process it started.
- **peak**: Claude Code's highest resident memory. On macOS, where `ps` has no peak, it is the highest seen since the mod loaded.
- **cpu**: share of one core since the last reading, as `top` shows it.
- **up**: how long Claude Code has been running.

## Processes pane

`/proc-stats` opens a task-manager pane and gives it the keyboard (Esc hands it back to the prompt; click the pane or press ctrl+x then tab to return):

- **History:** two lines at the top chart the session's total memory and CPU (Claude Code and everything it started) over the history window (10 minutes by default; see Settings), each followed by the current value and the window's highest (`max`). Memory is scaled from the window's lowest to its highest point, and never to less than 64 MB or a tenth of its highest point (whichever is more), so a slow leak rises across the full height while small noise stays flat and a steady line sits mid-height; CPU is scaled from zero to one core, or to its highest point when that is more. Short spikes stay visible. Readings are drawn evenly spaced, so a gap (such as while the machine sleeps) does not show.
- **Rows:** Claude Code's own row, then every process below it as a tree. A Bash command Claude ran shows as `$ <command>`; a `$ …` row also says what started it when it can tell — `· Bash`, `· Monitor`, `· subagent: <type>`, or `· agent` for one it cannot name — and the details name the subagent's task (commands started before the mod loaded show none); ▾/▸ marks a row with processes under it. Under the rows, **Child processes** sums every process below Claude Code and **Total** adds Claude Code's own.
- **Detached:** processes the session started that no longer run under Claude Code (`nohup … &`, `setsid`, daemons) follow the tree under a **Detached** heading, with their own subtotal. They count toward the totals, the history, the status-line marker and the toasts, and can be stopped like any other row. In a sorted view their parent reads `detached`. The mod finds them by a variable, `PROC_STATS_SESSION`, that it sets for every command the session starts; if it cannot set it, a line under the rows says detached processes are not tracked.
- **↑ / ↓** move between rows; the row you land on is selected and its full command, pid, parent, start time, memory and CPU show under the table.
- **Enter or a click** selects a row, and on a row with processes under it collapses or expands it (collapsed, it shows its subtree's totals).
- **s** sorts by CPU, memory or runtime (highest first, each row followed by its parent), then back to the tree.
- **k** stops the selected process and everything it started: it asks first (**y** Stop, **n** Cancel; Esc, leaving the pane, cancels too), sends SIGTERM (Windows: `taskkill /T`), and after 3 seconds offers **f** Force stop (SIGKILL) if anything is still running, even a process that left the tree when its parent ended. Once a stop is sent the footer offers **n** Dismiss. Claude Code's own row cannot be stopped.
  - Stopping a `$ …` row that Claude is still running ends that tool call.
  - A stop reaches only the first 500 listed processes.
  - On Windows a first stop may need **f**: `taskkill` without `/F` cannot end console processes.

TIME, then PID, give way on a narrow pane.

## Report

`/proc-stats report` writes a summary of the session into the conversation, where Claude reads it too: the platform and how long Claude Code has run; the memory and CPU of Claude Code, its child processes and both together now; the highest memory and CPU of the history window and how long ago they were; the five processes using the most memory, with what started them; up to ten detached processes; the marker level; and the last five alerts.

## Platforms

By default both views refresh every second on Linux, every 2 seconds on macOS and every 5 on Windows (configurable in Settings), and work on Linux (`/proc` and `ps`), macOS (`ps`) and Windows (PowerShell). Detached processes are found on Linux (`/proc/<pid>/environ`, read once per process) and macOS (`ps eww`, at most every 10 seconds, so a new one can take that long to show), and not on Windows.

## Settings

In Claude Code's config menu (`/config`), under proc-stats:

| Setting | Default | |
|---|---|---|
| Refresh on Linux / macOS / Windows (ms) | 1000 / 2000 / 5000 | how often processes are read; 250-60000 on Linux and macOS, 1000-60000 on Windows |
| Memory warning / alert (MB) | 2048 / 4096 | 🟡 / 🔴 on the status line (session total); a warning above its alert is lowered to the alert; limits are at least 1 |
| CPU warning / alert (%) | 150 / 300 | the same for CPU, averaged over the last 10 s (two refreshes when the refresh is slower) |
| Busy process CPU (%) / time (s) | 90 / 60 | a toast for one child process |
| Large process memory (MB) | 1024 | a toast for one child process |
| History (minutes) | 10 | the pane's sparklines; 1-120 minutes |
| Child processes on the status line | on | the `+` part |

A value out of range is ignored and its default used.

## Alerts

- **Status line:** 🟡 at the start of the line when the session (Claude Code and every process it started) uses more memory than the warning limit, or more CPU on average over the last 10 seconds (two refreshes when the refresh is slower); 🔴 above the alert limit. A marker clears only once its value is 10% below the limit, so it does not flicker.
- **Toasts:** one when a child process stays above the busy-process CPU limit for the set time (short dips are tolerated), and one when it grows past the large-process memory limit. Each fires once per process, and again only after the process has been 10 seconds below 90% of the limit. Several at once become one toast.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install proc-stats --marketplace DragosMocrii/proc-stats
```

Answer `y` to add the marketplace, then choose a scope (user scope loads it in every session).

## Limits

- A detached process is found only if it keeps the environment it started with (a program that clears it, such as `env -i`, is not found), and only on Linux and macOS.
- A program a command opens that outlives it, such as a browser or editor started by `xdg-open` or `code .`, carries the session's mark and is counted as a detached process.
- A command that starts and ends between two readings is not counted.
- `+ ?` means the process table could not be read (for example no `ps` in a minimal container).

## Development

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```
