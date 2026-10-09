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

declare module 'claude-code' {
  interface PluginState {
    // isOpen: whether the person has the pane open, so a reload can reopen it.
    'proc-stats': { reading: Reading; isOpen: boolean }
  }
}
