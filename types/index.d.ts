// One process below Claude Code, in tree order.
export type ProcRow = {
  pid: number
  ppid: number
  // 0 for a direct child of Claude Code.
  depth: number
  command: string
  rssKb: number
  // Null on the first reading, which has nothing to measure from.
  cpuPercent: number | null
  uptimeSeconds: number
  // When it started, in ms since the epoch: the reading's time less its runtime, so it can move by a second between readings.
  startMs: number
  // Set on a process this session started that no longer runs under Claude Code.
  detached?: true
}

export type Snapshot = {
  platform: string
  pid: number
  engine: { rssKb: number; peakKb: number; cpuPercent: number | null; uptimeSeconds: number }
  // Null when the process table could not be read; capped for the pane.
  children: ProcRow[] | null
  // Over every process found, capped rows included: those under Claude Code and the detached ones.
  childCount: number
  childKb: number
  childCpuPercent: number | null
  // The detached processes alone (rows marked detached, after the tree).
  detachedCount: number
  detachedKb: number
  detachedCpuPercent: number | null
  // Why detached processes are not tracked, when they are not (Windows says nothing).
  detachedOff?: string
}

export type Reading = { snapshot?: Snapshot; error?: string }

// One reading's session totals: Claude Code with every process it started.
export type Point = { t: number; memKb: number; cpuPct: number }

// The newest points, oldest first; as many as the history window needs.
export type History = { points: Point[] }

// The status-line marker's level for one measure: below warning, above it, above alert.
export type Level = 'none' | 'warn' | 'alert'

// One child process's toast tracking. Times are milliseconds since the epoch.
export type ProcTrack = {
  // When the process started (now minus its uptime at the first reading); a start more than
  // 2 s later under the same pid is a new process.
  startMs: number
  // When its CPU went over the toast limit (kept through dips above 90% of it).
  cpuSince: number | null
  cpuFired: boolean
  // When it fell below 90% of the limit after a toast; 10 s there re-arms it.
  cpuCoolSince: number | null
  memFired: boolean
  memCoolSince: number | null
}

// A toast the alerts sent: when (ms since the epoch) and its text.
export type SentToast = { t: number; text: string }

// What the alerts remember between readings, and across reloads; `recent` holds the last toasts, oldest first
// (absent until the first one).
export type AlertState = { levels: { mem: Level; cpu: Level }; tracks: Record<string, ProcTrack>; recent?: SentToast[] }

// How the pane orders its rows: the process tree, or flat by CPU, memory or runtime (highest first).
export type SortMode = 'tree' | 'cpu' | 'mem' | 'time'

// A chosen process: its pid and start, so a pid reused by another process is not it.
export type Selected = { pid: number; startMs: number }

// A stop in progress: confirm → sent → stuck (still running at the check) → forced.
// `starts` holds each pid's start (ms), from the reading the pids came from; `checks` counts checks
// that found no reading or could not read which processes still run.
export type StopState = Selected & {
  label: string
  pids: number[]
  starts: number[]
  checks: number
  phase: 'confirm' | 'sent' | 'stuck' | 'forced'
}

// The pane's own state, kept across reloads. `collapsed` holds the pids of collapsed rows.
export type PaneState = { sort: SortMode; collapsed: number[]; selected: Selected | null; stop: StopState | null }

// Who started a process: the tool, and the subagent whose call it was (null for the main conversation).
export type Origin = { tool: string; agent: { type: string; description: string } | null }

// A Bash or Monitor call recorded before it ran: its tool_use_id, its exact command (as a PreToolUse rewrite
// left it), when (ms since the epoch), and when it settled (null while it runs).
export type OriginCall = Origin & { id: string; command: string; at: number; settledAt: number | null }

// Calls not yet matched to a process, and the origins of listed processes by pid (with their start).
export type Origins = { calls: OriginCall[]; byPid: Record<string, Origin & { startMs: number }> }

declare module 'claude-code' {
  interface PluginState {
    // isOpen: whether the person has the pane open, so a reload can reopen it.
    // history: the session totals over the last historyMinutes, for alerts and sparklines.
    // alerts: the marker levels and each child process's toast tracking, kept across reloads.
    // pane: the Processes pane's sort, collapsed rows, selection and stop in progress.
    // origins: recorded Bash/Monitor calls and the origins of listed processes.
    'proc-stats': { reading: Reading; isOpen: boolean; history: History; alerts: AlertState; pane: PaneState; origins: Origins }
  }
}
