import type { EngineInterface, Register } from 'claude-code'

import {
  descendants,
  isComplete,
  parseMacFields,
  parseProcStat,
  parseProcStatus,
  parsePowerShell,
  parsePsTable,
  powerShellSample,
  toRow,
  windowsUsage,
} from './stats'
import type { Platform, Sample, Usage } from './stats'

// PowerShell takes a moment to start, so Windows samples less often.
const INTERVAL_MS: Record<Platform, number> = { linux: 5000, mac: 5000, windows: 10000 }

// The engine, and the processes it started (undefined when the table cannot be read).
type Reading = { engine: Sample; children?: Usage[]; wallMs: number }

export const formatBytes = (kb: number) =>
  kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(2)}GB` : `${Math.round(kb / 1024)}MB`

// With children, both numbers in the larger one's unit: `(484 + 15)MB`.
export const formatPair = (kb: number, childKb: number | undefined) => {
  if (childKb === 0) return formatBytes(kb)
  const isGb = Math.max(kb, childKb ?? 0) >= 1024 * 1024
  const one = (n: number) => (isGb ? (n / 1024 / 1024).toFixed(2) : String(Math.round(n / 1024)))

  return `(${one(kb)} + ${childKb === undefined ? '?' : one(childKb)})${isGb ? 'GB' : 'MB'}`
}

export const formatDuration = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s % 60}s`

  return `${s}s`
}

// CPU is the share of one core between two readings, as top shows it.
export const cpuPercent = (cpuSeconds: number, elapsedSeconds: number) =>
  Math.max(0, cpuSeconds / elapsedSeconds) * 100

// CPU the children spent since the last reading: each process's time over what
// it had then, a new process's whole time. Processes that ended in between drop out.
export const childCpuSeconds = (now: Usage[], before: Usage[]) => {
  const was = new Map(before.map(usage => [usage.pid, usage.cpuSeconds]))

  return now.reduce((sum, { pid, cpuSeconds }) => sum + Math.max(0, cpuSeconds - (was.get(pid) ?? 0)), 0)
}

// The children's share shows only while there are any; `?` when the table could not be read.
export const formatLine = (now: Reading, before: Reading | undefined) => {
  const elapsed = before ? (now.wallMs - before.wallMs) / 1000 : 0
  const hasChildren = now.children === undefined || now.children.length > 0
  const childKb = hasChildren ? now.children?.reduce((sum, usage) => sum + usage.rssKb, 0) : 0
  let cpu = '…'
  if (before && elapsed > 0) {
    const own = cpuPercent(now.engine.cpuSeconds - before.engine.cpuSeconds, elapsed).toFixed(1)
    const children =
      now.children && before.children
        ? cpuPercent(childCpuSeconds(now.children, before.children), elapsed).toFixed(1)
        : '?'
    cpu = hasChildren ? `(${own} + ${children})%` : `${own}%`
  }

  return `mem ${formatPair(now.engine.rssKb, childKb)} · peak ${formatBytes(now.engine.peakKb)} · cpu ${cpu} · up ${formatDuration(now.engine.uptimeSeconds)}`
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

const linuxUsage = async ($: EngineInterface, pid: number): Promise<Usage | undefined> => {
  try {
    const [status, stat] = await Promise.all([
      $.fs.read(`/proc/${pid}/status`),
      $.fs.read(`/proc/${pid}/stat`),
    ])
    // A zombie has no VmRSS: it holds no memory.
    const { rssKb } = parseProcStatus(status)

    return { pid, rssKb: Number.isFinite(rssKb) ? rssKb : 0, cpuSeconds: parseProcStat(stat, '0').cpuSeconds }
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
  const engine = { ...parseProcStatus(status), ...parseProcStat(stat, uptime) }
  try {
    const { selfPid, rows } = await psTable($, 'pid=,ppid=')
    const pids = descendants(rows.map(toRow), pid, selfPid)
    const usages = await Promise.all(pids.map(child => linuxUsage($, child)))

    return { engine, children: usages.filter(usage => usage !== undefined) }
  } catch {
    return { engine }
  }
}

const readMac = async ($: EngineInterface, pid: number, peakSeenKb: number) => {
  const { selfPid, rows } = await psTable($, 'pid=,ppid=,rss=,time=,etime=')
  const own = rows.find(fields => Number(fields[0]) === pid)
  if (!own) throw new Error(`process ${pid} not listed`)
  const ps = parseMacFields(own)
  const pids = new Set(descendants(rows.map(toRow), pid, selfPid))
  const children = rows
    .filter(fields => pids.has(Number(fields[0])))
    .map(fields => ({ pid: Number(fields[0]), ...parseMacFields(fields) }))

  // ps has no peak, so the highest resident size seen stands in for it.
  return { engine: { ...ps, peakKb: Math.max(peakSeenKb, ps.rssKb) }, children }
}

const readWindows = async ($: EngineInterface, pid: number) => {
  const { stdout } = await $.process.run(['powershell', '-NoProfile', '-Command', powerShellSample(pid)])
  const { engine, selfPid, rows } = parsePowerShell(stdout)
  const pids = new Set(descendants(rows.map(toRow), pid, selfPid))

  return { engine, children: rows.filter(fields => pids.has(Number(fields[0]))).map(windowsUsage) }
}

const read = (
  $: EngineInterface,
  platform: Platform,
  pid: number,
  peakSeenKb: number,
): Promise<{ engine: Sample; children?: Usage[] }> => {
  switch (platform) {
    case 'linux':
      return readLinux($, pid)
    case 'mac':
      return readMac($, pid, peakSeenKb)
    case 'windows':
      return readWindows($, pid)
  }
}

const startSampling = async ($: EngineInterface) => {
  try {
    const platform = await detectPlatform($)
    const pid = await enginePid($, platform)
    let before: Reading | undefined
    let isBusy = false

    const sample = async () => {
      if (isBusy) return
      isBusy = true
      try {
        const sample = await read($, platform, pid, before?.engine.peakKb ?? 0)
        if (!isComplete(sample.engine)) throw new Error('unreadable sample')
        const now = { ...sample, wallMs: await $.clock.now() }
        $.ui.status(formatLine(now, before))
        before = now
      } catch {
        $.ui.status(`proc-stats: cannot read process ${pid} on ${platform}`)
      } finally {
        isBusy = false
      }
    }

    $.clock.every(INTERVAL_MS[platform], () => void sample())
    await sample()
  } catch (error) {
    $.ui.status(`proc-stats: ${error instanceof Error ? error.message : 'unavailable'}`)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    void startSampling($)

    return started
  })
}
