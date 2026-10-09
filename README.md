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

`/proc-stats` opens a task-manager pane: Claude Code's own row, every process below it as a tree (PID, command, memory, CPU, how long it has run), and totals for its child processes and for everything together.

```
PID     COMMAND                                   MEM     CPU    TIME
187782  Claude Code                             484MB    2.4%  12m 4s
211146  └ bash -c timeout 15 python3 -c ...       4MB    0.0%     20s
211147    └ python3 -c ...                      200MB   98.7%     20s

        Child processes (2)                     204MB   98.7%
        Total                                   688MB  101.1%
```

TIME, then PID, give way on a narrow pane.

## Platforms

By default both views refresh every second on Linux, every 2 seconds on macOS and every 5 on Windows (configurable in Settings), and work on Linux (`/proc` and `ps`), macOS (`ps`) and Windows (PowerShell).

## Settings

In Claude Code's config menu (`/config`), under proc-stats:

| Setting | Default | |
|---|---|---|
| Refresh on Linux / macOS / Windows (ms) | 1000 / 2000 / 5000 | how often processes are read; 250-60000 on Linux and macOS, 1000-60000 on Windows |
| Memory warning / alert (MB) | 2048 / 4096 | 🟡 / 🔴 on the status line (session total); a warning above its alert is lowered to the alert; limits are at least 1 |
| CPU warning / alert (%) | 150 / 300 | the same for CPU, averaged over 10 s |
| Busy process CPU (%) / time (s) | 90 / 60 | a toast for one child process |
| Large process memory (MB) | 1024 | a toast for one child process |
| History (minutes) | 10 | the pane's sparklines; 1-120 minutes |
| Child processes on the status line | on | the `+` part |

A value out of range is ignored and its default used.

(The markers, toasts and sparklines arrive in later packages; the settings exist now so the config menu does not change shape again.)

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
