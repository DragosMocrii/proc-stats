// Shared test data: a process, and Claude Code's own figures.

import type { Proc } from './stats'

export const MB = 1024

export const proc = (pid: number, ppid: number, extra: Partial<Proc> = {}): Proc => ({
  pid,
  ppid,
  command: `cmd${pid}`,
  rssKb: 10 * MB,
  cpuSeconds: 0,
  uptimeSeconds: 100,
  ...extra,
})

export const engine = { rssKb: 484 * MB, peakKb: 530 * MB, cpuSeconds: 1, uptimeSeconds: 60 }

// /proc/<pid>/stat with its state and start (clock ticks since boot); the name holds parentheses.
export const statLine = (pid: number, state: string, startTicks: number) =>
  `${pid} (my (odd) name) ${state} 1 ${Array.from({ length: 17 }, () => '0').join(' ')} ${startTicks} 0 0`
