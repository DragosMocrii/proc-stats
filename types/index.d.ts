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
}

export type Snapshot = {
  platform: string
  pid: number
  engine: { rssKb: number; peakKb: number; cpuPercent: number | null; uptimeSeconds: number }
  // Null when the process table could not be read; capped for the pane.
  children: ProcRow[] | null
  // Over every process found, capped rows included.
  childCount: number
  childKb: number
  childCpuPercent: number | null
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

declare module 'claude-code' {
  interface PluginState {
    // isOpen: whether the person has the pane open, so a reload can reopen it.
    // history: the session totals over the last historyMinutes, for alerts and sparklines.
    'proc-stats': { reading: Reading; isOpen: boolean; history: History }
  }
}
