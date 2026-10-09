# proc-stats

A Claude Code mod that pins a status line with the session's own resource use, and opens a task-manager pane of it on `/proc-stats`:

```
mem 484MB · peak 530MB · cpu 2.4% · up 12m 4s
```

While the session has processes running under it (Bash commands, watchers, test runs, local MCP servers), their share is added after a `+`:

```
mem (484 + 215)MB · peak 530MB · cpu (2.4 + 98.7)% · up 12m 4s
```

- **mem**: resident memory of Claude Code, plus every process below it.
- **peak**: Claude Code's highest resident memory. On macOS, where `ps` has no peak, it is the highest seen since the mod loaded.
- **cpu**: share of one core since the last reading, as `top` shows it.
- **up**: how long Claude Code has been running.

## Processes pane

`/proc-stats` opens a task-manager pane and gives it the keyboard (Esc hands it back to the prompt; click the pane or press ctrl+x then tab to return):

- **History:** two lines at the top chart the session's total memory and CPU (Claude Code and everything it started) over the history window (10 minutes by default; see Settings), with the current value at the end. Memory is scaled to the window's highest point; CPU to one core, or to its highest point when that is more. Short spikes stay visible.
- **Rows:** Claude Code's own row, then every process below it as a tree. A Bash command Claude ran shows as `$ <command>`; ▾/▸ marks a row with processes under it. Under the rows, **Child processes** sums every process below Claude Code and **Total** adds Claude Code's own.
- **↑ / ↓** move between rows; the row you land on is selected and its full command, pid, parent, start time, memory and CPU show under the table.
- **Enter or a click** selects a row, and on a row with processes under it collapses or expands it (collapsed, it shows its subtree's totals).
- **s** sorts by CPU, memory or runtime (highest first, each row followed by its parent), then back to the tree.
- **k** stops the selected process and everything it started: it asks first (**y** Stop, **n** Cancel; Esc, leaving the pane, cancels too), sends SIGTERM (Windows: `taskkill /T`), and after 3 seconds offers **f** Force stop (SIGKILL) if anything is still running, even a process that left the tree when its parent ended. Once a stop is sent the footer offers **n** Dismiss. Claude Code's own row cannot be stopped.
  - Stopping a `$ …` row that Claude is still running ends that tool call.
  - A stop reaches only the first 500 listed processes.
  - On Windows a first stop may need **f**: `taskkill` without `/F` cannot end console processes.

TIME, then PID, give way on a narrow pane.

## Platforms

By default both views refresh every second on Linux, every 2 seconds on macOS and every 5 on Windows (configurable in Settings), and work on Linux (`/proc` and `ps`), macOS (`ps`) and Windows (PowerShell).

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

(Which tool call or subagent started each process arrives in a later package; the settings exist now so the config menu does not change shape again.)

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

- A process that detaches from Claude Code (`nohup`, daemons) is no longer counted.
- A command that starts and ends between two readings is not counted.
- `+ ?` means the process table could not be read (for example no `ps` in a minimal container).

## Development

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```
