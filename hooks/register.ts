import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ProcRow, Reading, Snapshot } from '../types'
import { formatBytes, formatDuration, formatPair, formatPercent } from './format'
import { drawPane } from './pane'
import {
  descendants,
  isComplete,
  parseCmdline,
  parseMacFields,
  parseProcStat,
  parseProcStatus,
  parsePowerShell,
  parsePsTable,
  powerShellSample,
  toRow,
  windowsProc,
} from './stats'
import type { Platform, Proc, Sample } from './stats'

const PANE = 'proc-stats'
const COMMAND = 'proc-stats'
// Each reading starts ps (PowerShell on Windows), which costs more on a busy Mac and most on Windows.
const INTERVAL_MS: Record<Platform, number> = { linux: 1000, mac: 2000, windows: 5000 }
// A build can start hundreds of workers; the pane needs no more than this.
const MAX_ROWS = 500

const reading = atom({ plugin: 'proc-stats', key: 'reading' } as const, {} as Reading)
const isOpen = atom({ plugin: 'proc-stats', key: 'isOpen' } as const, false)
const OPEN = { id: PANE, title: 'Processes' }

// The engine, and the processes it started (undefined when the table cannot be read).
export type Timed = { engine: Sample; children?: Proc[]; wallMs: number }

// CPU a process spent since the last reading, and as a share of one core. A pid
// whose process is younger than the one seen before was reused: a new process,
// counted whole over the time it has run.
export const procCpu = (now: Proc, was: Proc | undefined, elapsed: number) => {
  const isSame = was !== undefined && now.uptimeSeconds >= was.uptimeSeconds - 1
  if (isSame) {
    const delta = Math.max(0, now.cpuSeconds - was.cpuSeconds)

    return { delta, percent: (delta / elapsed) * 100 }
  }
  const window = Math.max(1, Math.min(elapsed, now.uptimeSeconds))

  return { delta: now.cpuSeconds, percent: (now.cpuSeconds / window) * 100 }
}

// Depth-first from the engine, each level by pid.
export const treeOrder = (procs: Proc[], root: number) => {
  const byParent = new Map<number, Proc[]>()
  for (const proc of procs) byParent.set(proc.ppid, [...(byParent.get(proc.ppid) ?? []), proc])
  for (const list of byParent.values()) list.sort((a, b) => a.pid - b.pid)
  const ordered: { proc: Proc; depth: number }[] = []
  const seen = new Set<number>()
  const visit = (pid: number, depth: number) => {
    for (const proc of byParent.get(pid) ?? []) {
      if (seen.has(proc.pid)) continue
      seen.add(proc.pid)
      ordered.push({ proc, depth })
      visit(proc.pid, depth + 1)
    }
  }
  visit(root, 0)
  // A process whose parent ended between reads is kept, at the top level.
  for (const proc of procs) if (!seen.has(proc.pid)) ordered.push({ proc, depth: 0 })

  return ordered
}

export const buildSnapshot = (
  platform: Platform,
  pid: number,
  now: Timed,
  before: Timed | undefined,
): Snapshot => {
  const elapsed = before ? (now.wallMs - before.wallMs) / 1000 : 0
  const isMeasured = before !== undefined && elapsed > 0
  const was = new Map((before?.children ?? []).map(proc => [proc.pid, proc]))
  const canCompare = isMeasured && before?.children !== undefined
  let childDelta = 0
  const rows = now.children
    ? treeOrder(now.children, pid).map(({ proc, depth }): ProcRow => {
        const cpu = canCompare ? procCpu(proc, was.get(proc.pid), elapsed) : undefined
        childDelta += cpu?.delta ?? 0

        return {
          pid: proc.pid,
          ppid: proc.ppid,
          depth,
          command: proc.command,
          rssKb: proc.rssKb,
          cpuPercent: cpu ? cpu.percent : null,
          uptimeSeconds: proc.uptimeSeconds,
        }
      })
    : null

  return {
    platform,
    pid,
    engine: {
      rssKb: now.engine.rssKb,
      peakKb: now.engine.peakKb,
      cpuPercent:
        isMeasured && before
          ? (Math.max(0, now.engine.cpuSeconds - before.engine.cpuSeconds) / elapsed) * 100
          : null,
      uptimeSeconds: now.engine.uptimeSeconds,
    },
    children: rows,
    childCount: rows?.length ?? 0,
    childKb: rows?.reduce((sum, row) => sum + row.rssKb, 0) ?? 0,
    childCpuPercent: canCompare ? (childDelta / elapsed) * 100 : null,
  }
}

// What the pane is handed: the totals over every process, the rows capped.
export const capRows = (snapshot: Snapshot): Snapshot => ({
  ...snapshot,
  children: snapshot.children?.slice(0, MAX_ROWS) ?? null,
})

// The children's share shows only while there are any; `?` when the table could not be read.
export const statusLine = (snapshot: Snapshot) => {
  const { engine, children, childCpuPercent } = snapshot
  const hasChildren = children === null || snapshot.childCount > 0
  let cpu = '…'
  if (engine.cpuPercent !== null) {
    const own = engine.cpuPercent.toFixed(1)
    cpu = hasChildren
      ? `(${own} + ${childCpuPercent === null ? '?' : childCpuPercent.toFixed(1)})%`
      : formatPercent(engine.cpuPercent)
  }
  const childKb = children === null ? undefined : snapshot.childKb

  return `mem ${formatPair(engine.rssKb, hasChildren ? childKb : 0)} · peak ${formatBytes(engine.peakKb)} · cpu ${cpu} · up ${formatDuration(engine.uptimeSeconds)}`
}

const detectPlatform = async ($: EngineInterface): Promise<Platform> => {
  if ((await $.env.get('OS')) === 'Windows_NT') return 'windows'
  const { stdout } = await $.process.run(['uname', '-s'])

  return stdout.trim() === 'Darwin' ? 'mac' : 'linux'
}

// The engine starts each command itself, so a command's parent is the engine.
const enginePid = async ($: EngineInterface, platform: Platform) => {
  const { stdout } =
    platform === 'windows'
      ? await $.process.run([
          'powershell',
          '-NoProfile',
          '-Command',
          '(Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId',
        ])
      : await $.process.run(['sh', '-c', 'echo $PPID'])
  const pid = Number(stdout.trim())
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`no engine pid in "${stdout.trim()}"`)

  return pid
}

// `exec` gives ps the shell's pid, printed first, so it can leave itself out.
const psTable = async ($: EngineInterface, columns: string) => {
  const { stdout } = await $.process.run(['sh', '-c', `echo $$; exec ps -A -o ${columns}`])

  return parsePsTable(stdout)
}

const linuxProc = async ($: EngineInterface, pid: number, uptime: string): Promise<Proc | undefined> => {
  try {
    const [status, stat, cmdline] = await Promise.all([
      $.fs.read(`/proc/${pid}/status`),
      $.fs.read(`/proc/${pid}/stat`),
      // Its own failure only costs the arguments: the name from stat stands in.
      $.fs.read(`/proc/${pid}/cmdline`).catch(() => ''),
    ])
    // A zombie has no VmRSS and no command line.
    const { rssKb } = parseProcStatus(status)
    const { name, ...rest } = parseProcStat(stat, uptime)

    return {
      pid,
      ...rest,
      rssKb: Number.isFinite(rssKb) ? rssKb : 0,
      command: parseCmdline(cmdline) || name,
    }
  } catch {
    // Ended since the table was read.
    return undefined
  }
}

const readLinux = async ($: EngineInterface, pid: number) => {
  const [status, stat, uptime] = await Promise.all([
    $.fs.read(`/proc/${pid}/status`),
    $.fs.read(`/proc/${pid}/stat`),
    $.fs.read('/proc/uptime'),
  ])
  const { rssKb, peakKb } = parseProcStatus(status)
  const { cpuSeconds, uptimeSeconds } = parseProcStat(stat, uptime)
  const engine = { rssKb, peakKb, cpuSeconds, uptimeSeconds }
  try {
    const { selfPid, rows } = await psTable($, 'pid=,ppid=')
    const pids = descendants(rows.map(toRow), pid, selfPid)
    const procs = await Promise.all(pids.map(child => linuxProc($, child, uptime)))

    return { engine, children: procs.filter(proc => proc !== undefined) }
  } catch {
    return { engine }
  }
}

const readMac = async ($: EngineInterface, pid: number, peakSeenKb: number) => {
  const { selfPid, rows } = await psTable($, 'pid=,ppid=,rss=,time=,etime=,command=')
  const own = rows.find(fields => Number(fields[0]) === pid)
  if (!own) throw new Error(`process ${pid} not listed`)
  const { rssKb, cpuSeconds, uptimeSeconds } = parseMacFields(own)
  const pids = new Set(descendants(rows.map(toRow), pid, selfPid))
  const children = rows.filter(fields => pids.has(Number(fields[0]))).map(parseMacFields)

  // ps has no peak, so the highest resident size seen stands in for it.
  return { engine: { rssKb, cpuSeconds, uptimeSeconds, peakKb: Math.max(peakSeenKb, rssKb) }, children }
}

const readWindows = async ($: EngineInterface, pid: number) => {
  const { stdout } = await $.process.run(['powershell', '-NoProfile', '-Command', powerShellSample(pid)])
  const { engine, selfPid, rows } = parsePowerShell(stdout)
  const pids = new Set(descendants(rows.map(toRow), pid, selfPid))

  return { engine, children: rows.filter(fields => pids.has(Number(fields[0]))).map(windowsProc) }
}

const readProcesses = (
  $: EngineInterface,
  platform: Platform,
  pid: number,
  peakSeenKb: number,
): Promise<{ engine: Sample; children?: Proc[] }> => {
  switch (platform) {
    case 'linux':
      return readLinux($, pid)
    case 'mac':
      return readMac($, pid, peakSeenKb)
    case 'windows':
      return readWindows($, pid)
  }
}

// One loop feeds both views: the status line, and the reading the pane draws.
const startSampling = async ($: EngineInterface) => {
  const set = (next: Reading) => update($, reading, () => next)

  try {
    const platform = await detectPlatform($)
    const pid = await enginePid($, platform)
    let before: Timed | undefined
    let isBusy = false

    const sample = async () => {
      if (isBusy) return
      isBusy = true
      try {
        const sample = await readProcesses($, platform, pid, before?.engine.peakKb ?? 0)
        if (!isComplete(sample.engine)) throw new Error('unreadable sample')
        const now = { ...sample, wallMs: await $.clock.now() }
        const snapshot = buildSnapshot(platform, pid, now, before)
        $.ui.status(statusLine(snapshot))
        await set({ snapshot: capRows(snapshot) })
        before = now
      } catch {
        const error = `cannot read process ${pid} on ${platform}`
        $.ui.status(`proc-stats: ${error}`)
        await set({ error })
      } finally {
        isBusy = false
      }
    }

    $.clock.every(INTERVAL_MS[platform], () => void sample())
    await sample()
  } catch (error) {
    const text = error instanceof Error ? error.message : 'unavailable'
    $.ui.status(`proc-stats: ${text}`)
    await set({ error: text })
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: COMMAND,
      description: 'Show Claude Code and the processes it started in a task-manager pane',
    })
    void startSampling($)
    // A reload closes the pane (an unload no hook hears); put it back if it was open.
    if (await read($, isOpen)) void $.ui.open(OPEN)

    return started
  })

  on('command.run', { command: COMMAND }, async $ => {
    const opened = await $.ui.open(OPEN)
    await update($, isOpen, () => true)

    return { text: opened.isPlaced ? 'Processes pane opened.' : 'Processes pane could not be placed.' }
  }).catch(($, e, next) =>
    next.called ? next(e) : { text: 'proc-stats: the Processes pane could not be opened.' },
  )

  // A close the person or the engine makes. A reload is no close: the pane comes back.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    await update($, isOpen, () => false)

    return closed
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) =>
    drawPane($.ui.resolve(e), await read($, reading), e.props.bodyColumns),
  )
}
