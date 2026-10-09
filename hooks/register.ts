import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Reading } from '../types'
import { drawPane } from './pane'
import { buildSnapshot, capRows } from './snapshot'
import type { Timed } from './snapshot'
import { statusLine } from './status'
import { childPids, linuxEngine, linuxProc, macReading, windowsReading } from './sampler'
import type { Gathered } from './sampler'
import { isComplete, parsePsTable, powerShellSample } from './stats'
import type { Platform, Proc } from './stats'

const PANE = 'proc-stats'
const COMMAND = 'proc-stats'
// Each reading starts ps (PowerShell on Windows), which costs more on a busy Mac and most on Windows.
const INTERVAL_MS: Record<Platform, number> = { linux: 1000, mac: 2000, windows: 5000 }

const reading = atom({ plugin: 'proc-stats', key: 'reading' } as const, {} as Reading)
const isOpen = atom({ plugin: 'proc-stats', key: 'isOpen' } as const, false)
const OPEN = { id: PANE, title: 'Processes' }

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

const readLinuxChild = async ($: EngineInterface, pid: number, uptime: string): Promise<Proc | undefined> => {
  try {
    const [status, stat, cmdline] = await Promise.all([
      $.fs.read(`/proc/${pid}/status`),
      $.fs.read(`/proc/${pid}/stat`),
      // Its own failure only costs the arguments: the name from stat stands in.
      $.fs.read(`/proc/${pid}/cmdline`).catch(() => ''),
    ])

    return linuxProc(pid, status, stat, cmdline, uptime)
  } catch {
    // Ended since the table was read.
    return undefined
  }
}

const readLinux = async ($: EngineInterface, pid: number): Promise<Gathered> => {
  const [status, stat, uptime] = await Promise.all([
    $.fs.read(`/proc/${pid}/status`),
    $.fs.read(`/proc/${pid}/stat`),
    $.fs.read('/proc/uptime'),
  ])
  const engine = linuxEngine(status, stat, uptime)
  try {
    const pids = childPids(await psTable($, 'pid=,ppid='), pid)
    const procs = await Promise.all(pids.map(child => readLinuxChild($, child, uptime)))

    return { engine, children: procs.filter(proc => proc !== undefined) }
  } catch {
    return { engine }
  }
}

const readMac = async ($: EngineInterface, pid: number, peakSeenKb: number) =>
  macReading(await psTable($, 'pid=,ppid=,rss=,time=,etime=,command='), pid, peakSeenKb)

const readWindows = async ($: EngineInterface, pid: number) => {
  const { stdout } = await $.process.run(['powershell', '-NoProfile', '-Command', powerShellSample(pid)])

  return windowsReading(stdout, pid)
}

const readProcesses = (
  $: EngineInterface,
  platform: Platform,
  pid: number,
  peakSeenKb: number,
): Promise<Gathered> => {
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
