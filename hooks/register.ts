import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AlertState, History, PaneState, Point, Reading, StopState } from '../types'
import { historyCapacity, pointOf, pointSpacingMs, pushPoint, shouldRecord } from './history'
import { EMPTY_ALERTS, markerFor, stepAlerts, worse } from './alerts'
import { drawPane } from './pane'
import type { PaneHandlers } from './pane'
import { buildSnapshot, capRows } from './snapshot'
import type { Timed } from './snapshot'
import { readSettings } from './settings'
import type { Settings } from './settings'
import { statusLine } from './status'
import { killArgv, outcomeText, STOP_CHECK_MS, stillListed, stopTargets } from './stop'
import { cycleSort, EMPTY_PANE, isSelected, labelOf, pruneState, toggleCollapsed } from './view'
import { childPids, linuxEngine, linuxProc, macReading, windowsReading } from './sampler'
import type { Gathered } from './sampler'
import { isComplete, parsePsTable, powerShellSample } from './stats'
import type { Platform, Proc } from './stats'

const PANE = 'proc-stats'
const COMMAND = 'proc-stats'

const READING = { plugin: 'proc-stats', key: 'reading' } as const
const PANE_STATE = { plugin: 'proc-stats', key: 'pane' } as const
const reading = atom(READING, {} as Reading)
const pane = atom(PANE_STATE, EMPTY_PANE as PaneState)
const isOpen = atom({ plugin: 'proc-stats', key: 'isOpen' } as const, false)
const HISTORY = { plugin: 'proc-stats', key: 'history' } as const
const ALERTS = { plugin: 'proc-stats', key: 'alerts' } as const
const history = atom(HISTORY, { points: [] } as History)
const alerts = atom(ALERTS, EMPTY_ALERTS as AlertState)
// Long enough to read a process name and its numbers.
const TOAST_MS = 8000
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

// What the pane's presses do. Built here because they call $, which pane.tsx never receives.
// Sends the signal; a failure is the first line of what the command said, else null.
const signal = async ($: EngineInterface, platform: string, pids: number[], isForce: boolean) => {
  const { exitCode, stderr } = await $.process.run(killArgv(platform, pids, isForce))

  return exitCode === 0 ? null : (stderr.trim().split('\n')[0] ?? `exit ${exitCode}`)
}

const setStop = ($: EngineInterface, stop: StopState | null) => update($, pane, state => ({ ...state, stop }))

// STOP_CHECK_MS after a signal: done when nothing is listed; else offer a force stop, or, after one, report.
const checkStop = async ($: EngineInterface) => {
  const stop = (await $.state.get(PANE_STATE)).value?.stop
  const snapshot = (await $.state.get(READING)).value?.snapshot
  if (!stop || !snapshot || (stop.phase !== 'sent' && stop.phase !== 'forced')) return
  const remaining = stillListed(snapshot, stop.pids)
  if (remaining.length > 0 && stop.phase === 'sent') {
    await setStop($, { ...stop, phase: 'stuck' })
    return
  }
  $.ui.toast(outcomeText(stop, remaining))
  await setStop($, null)
}

const paneHandlers = ($: EngineInterface): PaneHandlers => ({
  onRow: target =>
    void update($, pane, state => ({
      ...state,
      selected: { pid: target.pid, startMs: target.startMs },
      collapsed: target.hasChildren ? toggleCollapsed(state.collapsed, target.pid) : state.collapsed,
    })),
  onSort: () => void update($, pane, state => ({ ...state, sort: cycleSort(state.sort) })),
  // k: ask first. The targets are checked again at y, so a process that ended meanwhile is left alone.
  onStop: () =>
    void (async () => {
      const state = (await $.state.get(PANE_STATE)).value ?? EMPTY_PANE
      const snapshot = (await $.state.get(READING)).value?.snapshot
      const pids = snapshot && state.selected ? stopTargets(snapshot, state.selected) : null
      const row = snapshot?.children?.find(each => isSelected(each, state.selected))
      if (!pids || !row) {
        $.ui.toast('proc-stats: that process is no longer listed')
        return
      }
      await setStop($, { pid: row.pid, startMs: row.startMs, label: labelOf(row.command), pids, phase: 'confirm' })
    })(),
  onConfirm: () =>
    void (async () => {
      const stop = (await $.state.get(PANE_STATE)).value?.stop
      const snapshot = (await $.state.get(READING)).value?.snapshot
      if (!stop || stop.phase !== 'confirm' || !snapshot) return
      const pids = stopTargets(snapshot, stop)
      if (!pids) {
        $.ui.toast('proc-stats: that process is no longer listed')
        await setStop($, null)
        return
      }
      const failure = await signal($, snapshot.platform, pids, false)
      if (failure) $.ui.toast(`proc-stats: ${failure}`)
      await setStop($, { ...stop, pids, phase: 'sent' })
      $.clock.after(STOP_CHECK_MS, () => void checkStop($))
    })(),
  onForce: () =>
    void (async () => {
      const stop = (await $.state.get(PANE_STATE)).value?.stop
      const snapshot = (await $.state.get(READING)).value?.snapshot
      if (!stop || stop.phase !== 'stuck' || !snapshot) return
      const current = stopTargets(snapshot, stop)
      const pids = current ? stop.pids.filter(pid => current.includes(pid)) : []
      if (pids.length === 0) {
        $.ui.toast(outcomeText(stop, []))
        await setStop($, null)
        return
      }
      const failure = await signal($, snapshot.platform, pids, true)
      if (failure) $.ui.toast(`proc-stats: ${failure}`)
      await setStop($, { ...stop, phase: 'forced' })
      $.clock.after(STOP_CHECK_MS, () => void checkStop($))
    })(),
  onCancel: () => void setStop($, null),
})

// One loop feeds both views: the status line, and the reading the pane draws.
const startSampling = async ($: EngineInterface, settings: Settings) => {
  const set = (next: Reading) => update($, reading, () => next)

  try {
    const platform = await detectPlatform($)
    const pid = await enginePid($, platform)
    const capacity = historyCapacity(settings.historyMinutes, settings.intervalMs[platform])
    const windowMs = settings.historyMinutes * 60_000
    const spacingMs = pointSpacingMs(settings.historyMinutes)
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
        await set({ snapshot: capRows(snapshot) })
        try {
          const kept = (await $.state.get(PANE_STATE)).value ?? EMPTY_PANE
          const pruned = pruneState(kept, snapshot)
          if (JSON.stringify(pruned) !== JSON.stringify(kept)) await update($, pane, state => pruneState(state, snapshot))
        } catch {
          // The pane keeps its state this reading.
        }
        // A get reads one moment, so the points for the alerts come from the update itself.
        let points: Point[] = []
        try {
          points = (await $.state.get(HISTORY)).value?.points ?? []
          const point = pointOf(snapshot, now.wallMs)
          if (point) {
            await update($, history, kept => {
              const next = shouldRecord(kept, point, spacingMs)
                ? pushPoint(kept, point, capacity, windowMs)
                : kept
              points = next.points

              return next
            })
          }
        } catch {
          // The point is skipped; the reading above stands.
        }
        // Alerts after the history, which holds this reading's point; their failure costs the marker only.
        let marker = ''
        try {
          const previous = (await $.state.get(ALERTS)).value ?? EMPTY_ALERTS
          const step = stepAlerts(previous, snapshot, points, now.wallMs, settings, settings.intervalMs[platform])
          // Written only when it changed: an idle session leaves the state alone.
          if (JSON.stringify(step.state) !== JSON.stringify(previous)) await update($, alerts, () => step.state)
          marker = markerFor(worse(step.state.levels.mem, step.state.levels.cpu))
          if (step.toast) $.ui.toast(step.toast, { timeoutMs: TOAST_MS })
        } catch {
          // No marker or toast this reading; the status line still shows.
        }
        $.ui.status(`${marker}${statusLine(snapshot, settings.statusShowChildren)}`)
        before = now
      } catch {
        const error = `cannot read process ${pid} on ${platform}`
        $.ui.status(`proc-stats: ${error}`)
        await set({ error })
      } finally {
        isBusy = false
      }
    }

    $.clock.every(settings.intervalMs[platform], () => void sample())
    await sample()
  } catch (error) {
    const text = error instanceof Error ? error.message : 'unavailable'
    $.ui.status(`proc-stats: ${text}`)
    await set({ error: text })
  }
}

// A settings change reloads the module, so they are read once per load.
export const register: Register = (on, options) => {
  const settings = readSettings(options)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: COMMAND,
      description: 'Show Claude Code and the processes it started in a task-manager pane',
    })
    void startSampling($, settings)
    // A reload closes the pane (an unload no hook hears); put it back if it was open.
    if (await read($, isOpen)) void $.ui.open(OPEN).catch(() => undefined)

    return started
  })

  on('command.run', { command: COMMAND }, async $ => {
    const opened = await $.ui.open({ ...OPEN, focus: true })
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
    drawPane($.ui.resolve(e), await read($, reading), await read($, pane), e.props.bodyColumns, paneHandlers($)),
  )

  // Arrow keys move the focus ring over the rows; the row it lands on is the selection.
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const moved = await next(e)
    if (e.element === undefined) {
      const stop = (await $.state.get(PANE_STATE)).value?.stop
      if (stop?.phase === 'confirm') await setStop($, null)
    }
    const pid = e.element?.startsWith('pid:') ? Number(e.element.slice(4)) : null
    if (pid !== null && !('deny' in moved)) {
      const snapshot = (await $.state.get(READING)).value?.snapshot
      const row = snapshot?.children?.find(each => each.pid === pid)
      await update($, pane, state => ({ ...state, selected: { pid, startMs: row?.startMs ?? 0 } }))
    }

    return moved
  }).catch(($, e, next) => next(e))
}
