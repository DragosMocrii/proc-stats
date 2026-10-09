# proc-stats

A Claude Code mod that pins a status line with the session's own resource use:

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

It refreshes every 5 seconds (10 on Windows) and works on Linux (`/proc` and `ps`), macOS (`ps`) and Windows (PowerShell).

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
