// A reading assembled from what the platform printed: Claude Code's own figures, its descendants
// and, where tracked, the detached processes this session started. The reads themselves stay in register.ts.

import {
  descendants,
  parseCmdline,
  parseMacFields,
  parseProcStat,
  parseProcStatus,
  parsePowerShell,
  toRow,
  windowsProc,
} from './stats'
import type { Proc, Sample } from './stats'

// Claude Code, the processes under it, and the detached processes this session started (where tracked).
export type Gathered = { engine: Sample; children?: Proc[]; detached?: Proc[] }

type Table = { selfPid: number; rows: string[][] }

export const linuxEngine = (status: string, stat: string, uptime: string): Sample => {
  const { rssKb, peakKb } = parseProcStatus(status)
  const { cpuSeconds, uptimeSeconds } = parseProcStat(stat, uptime)

  return { rssKb, peakKb, cpuSeconds, uptimeSeconds }
}

// A zombie has no VmRSS and no command line: no memory, and its name stands in.
export const linuxProc = (pid: number, status: string, stat: string, cmdline: string, uptime: string): Proc => {
  const { rssKb } = parseProcStatus(status)
  const { name, ...rest } = parseProcStat(stat, uptime)

  return { pid, ...rest, rssKb: Number.isFinite(rssKb) ? rssKb : 0, command: parseCmdline(cmdline) || name }
}

export const childPids = ({ selfPid, rows }: Table, pid: number) => descendants(rows.map(toRow), pid, selfPid)

// ps has no peak, so the highest resident size seen stands in for it.
export const macReading = (table: Table, pid: number, peakSeenKb: number): Gathered => {
  const own = table.rows.find(fields => Number(fields[0]) === pid)
  if (!own) throw new Error(`process ${pid} not listed`)
  const { rssKb, cpuSeconds, uptimeSeconds } = parseMacFields(own)
  const pids = new Set(childPids(table, pid))
  const children = table.rows.filter(fields => pids.has(Number(fields[0]))).map(parseMacFields)

  return { engine: { rssKb, cpuSeconds, uptimeSeconds, peakKb: Math.max(peakSeenKb, rssKb) }, children }
}

export const windowsReading = (stdout: string, pid: number): Gathered => {
  const { engine, selfPid, rows } = parsePowerShell(stdout)
  const pids = new Set(descendants(rows.map(toRow), pid, selfPid))

  return { engine, children: rows.filter(fields => pids.has(Number(fields[0]))).map(windowsProc) }
}
