// Platform parsers: the engine process's own numbers, and the process table
// its descendants are found in.

export type Platform = 'linux' | 'mac' | 'windows'

export type Sample = { rssKb: number; peakKb: number; cpuSeconds: number; uptimeSeconds: number }

// One process: below the engine, or detached from it.
export type Proc = {
  pid: number
  ppid: number
  command: string
  rssKb: number
  cpuSeconds: number
  uptimeSeconds: number
}

export type Row = { pid: number; ppid: number }

// USER_HZ: clock ticks per second in /proc/<pid>/stat; 100 on every mainstream Linux build.
const TICKS_PER_SECOND = 100

// Linux: VmRSS and VmHWM (peak resident set) from /proc/<pid>/status.
export const parseProcStatus = (text: string) => {
  const kb = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(text)?.[1] ?? NaN)

  return { rssKb: kb('VmRSS'), peakKb: kb('VmHWM') }
}

// Linux: the name sits in parentheses and may itself hold spaces and parentheses.
export const parseProcStat = (stat: string, systemUptime: string) => {
  const name = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'))
  const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  const startSeconds = Number(rest[19]) / TICKS_PER_SECOND

  return {
    name,
    ppid: Number(rest[1]),
    cpuSeconds: (Number(rest[11]) + Number(rest[12])) / TICKS_PER_SECOND,
    uptimeSeconds: Number(systemUptime.split(' ')[0]) - startSeconds,
  }
}

// Linux: /proc/<pid>/cmdline is NUL-separated; empty for a zombie.
export const parseCmdline = (text: string) => text.split('\0').filter(Boolean).join(' ')

// ps times: `[[dd-]hh:]mm:ss[.cc]` (etime, and time on Linux) or `mmm:ss.cc` (time on macOS).
export const parsePsTime = (text: string) => {
  const [days, clock] = text.includes('-') ? text.split('-') : ['0', text]
  const seconds = (clock ?? '')
    .split(':')
    .reduce((total, part) => total * 60 + Number(part), 0)

  return Number(days) * 86400 + seconds
}

const lines = (text: string) =>
  text
    .split(/\r?\n/)
    .map(line => line.trim().split(/\s+/))
    .filter(fields => fields[0] !== '')

// `echo $$; exec ps -A -o pid=,ppid=,...`: the first line is ps's own pid,
// which is a child of the engine too and is left out.
export const parsePsTable = (text: string) => {
  const [first = [], ...rest] = lines(text)

  return { selfPid: Number(first[0]), rows: rest }
}

export const toRow = (fields: string[]): Row => ({ pid: Number(fields[0]), ppid: Number(fields[1]) })

// macOS: `pid ppid rss time etime command`, the command last since it holds spaces.
export const parseMacFields = (fields: string[]): Proc => ({
  pid: Number(fields[0]),
  ppid: Number(fields[1]),
  rssKb: Number(fields[2]),
  cpuSeconds: parsePsTime(fields[3] ?? ''),
  uptimeSeconds: parsePsTime(fields[4] ?? ''),
  command: fields.slice(5).join(' '),
})

// Windows: the engine's bytes, peak bytes, CPU and uptime seconds; PowerShell's
// own pid; then `pid ppid bytes cpu100ns ageSeconds command` per process.
export const parsePowerShell = (text: string) => {
  const [engine = [], self = [], ...rest] = lines(text)
  const [rss, peak, cpu, up] = engine.map(Number)

  return {
    engine: {
      rssKb: (rss ?? NaN) / 1024,
      peakKb: (peak ?? NaN) / 1024,
      cpuSeconds: cpu ?? NaN,
      uptimeSeconds: up ?? NaN,
    },
    selfPid: Number(self[0]),
    rows: rest,
  }
}

export const windowsProc = (fields: string[]): Proc => ({
  pid: Number(fields[0]),
  ppid: Number(fields[1]),
  rssKb: Number(fields[2]) / 1024,
  cpuSeconds: Number(fields[3]) / 1e7,
  uptimeSeconds: Number(fields[4]),
  command: fields.slice(5).join(' '),
})

export const powerShellSample = (pid: number) =>
  [
    `$c = [cultureinfo]::InvariantCulture`,
    `$now = Get-Date`,
    `$p = Get-Process -Id ${pid}`,
    `[string]::Format($c, '{0} {1} {2:F2} {3:F0}', $p.WorkingSet64, $p.PeakWorkingSet64,` +
      ` $p.TotalProcessorTime.TotalSeconds, ($now - $p.StartTime).TotalSeconds)`,
    `$PID`,
    `Get-CimInstance Win32_Process | ForEach-Object {` +
      ` $cmd = if ($_.CommandLine) { $_.CommandLine -replace '\\s+', ' ' } else { $_.Name };` +
      ` $age = if ($_.CreationDate) { ($now - $_.CreationDate).TotalSeconds } else { 0 };` +
      ` [string]::Format($c, '{0} {1} {2} {3} {4:F0} {5}', $_.ProcessId, $_.ParentProcessId,` +
      ` $_.WorkingSetSize, $_.UserModeTime + $_.KernelModeTime, $age, $cmd) }`,
  ].join('; ')

// Every process below `root`, leaving out `exclude` and what it started.
export const descendants = (rows: Row[], root: number, exclude: number) => {
  const children = new Map<number, number[]>()
  for (const { pid, ppid } of rows) {
    if (pid === ppid) continue
    children.set(ppid, [...(children.get(ppid) ?? []), pid])
  }
  const found = new Set<number>()
  const queue = [...(children.get(root) ?? [])]
  while (queue.length > 0) {
    const pid = queue.shift()!
    if (pid === exclude || pid === root || found.has(pid)) continue
    found.add(pid)
    queue.push(...(children.get(pid) ?? []))
  }

  return [...found]
}

export const isComplete = (sample: Sample) => Object.values(sample).every(Number.isFinite)
