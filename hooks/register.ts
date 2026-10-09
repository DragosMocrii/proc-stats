import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AlertState, History, Origin, OriginCall, Origins, PaneState, Point, Reading, SessionMark, StopState } from '../types'
import { historyCapacity, pointOf, pointSpacingMs, pushPoint, shouldRecord } from './history'
import { EMPTY_ALERTS, markerFor, stepAlerts, worse } from './alerts'
import { candidatesOf, environHasMark, macListedPids, macMarkedPids, oursOf, rememberMarks, startedFrom, unreadOf } from './detached'
import type { MarkCache } from './detached'
import { CALL_TTL_MS, EMPTY_ORIGINS, matchOrigins, UNNAMED_AGENT } from './origin'
import { drawPane } from './pane'
import type { PaneHandlers } from './pane'
import { buildSnapshot, capRows } from './snapshot'
import type { Timed } from './snapshot'
import { reportText } from './report'
import { readSettings } from './settings'
import type { Settings } from './settings'
import { statusLine } from './status'
import {
  aliveFrom,
  isAlreadyEnded,
  killArgv,
  linuxObserved,
  macLivenessArgv,
  outcomeText,
  parseMacLiveness,
  parseWindowsLiveness,
  startsOf,
  STOP_CHECK_MS,
  STOP_CHECK_TRIES,
  stopTargets,
  windowsLivenessScript,
} from './stop'
import type { Observed } from './stop'
import { cycleSort, EMPTY_PANE, isSelected, labelOf, pruneState, toggleCollapsed } from './view'
import { childPids, linuxEngine, linuxProc, macReading, windowsReading } from './sampler'
import type { Gathered } from './sampler'
import { isComplete, parseMacFields, parsePsTable, powerShellSample } from './stats'
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
const ORIGINS = { plugin: 'proc-stats', key: 'origins' } as const
const origins = atom(ORIGINS, EMPTY_ORIGINS as Origins)
const SESSION = { plugin: 'proc-stats', key: 'session' } as const
const session = atom(SESSION, { id: '', startMs: 0 } as SessionMark)
// macOS reads environments with one `ps eww` at most this often.
const MAC_SCAN_MS = 10_000
const DETACHED_OFF = 'Detached processes are not tracked: the session mark could not be set.'
// Long enough to read a process name and its numbers.
const TOAST_MS = 8000
const OPEN = { id: PANE, title: 'Processes' }
const USAGE = '/proc-stats opens the Processes pane; /proc-stats report summarizes the session here.'

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

// What finding detached processes keeps between readings: the session's mark, what is known of
// each pid's environment, and when macOS last read environments.
type Finder = { mark: SessionMark; cache: MarkCache; scannedAt: number }

// Linux: the environment of each candidate not read before, once; one that cannot be read is not ours.
const linuxDetached = async ($: EngineInterface, finder: Finder, rows: string[][], excluded: Set<number>, wallMs: number) => {
  const candidates = candidatesOf(startedFrom(rows, 2, wallMs), excluded, finder.mark.startMs)
  const read = await Promise.all(
    unreadOf(finder.cache, candidates).map(async each => {
      try {
        return { ...each, isOurs: environHasMark(await $.fs.read(`/proc/${each.pid}/environ`), finder.mark.id) }
      } catch {
        return { ...each, isOurs: false }
      }
    }),
  )
  finder.cache = rememberMarks(finder.cache, candidates, read)

  return oursOf(finder.cache, candidates)
}

// macOS: one `ps eww` over the candidates not read before, at most every MAC_SCAN_MS; until it runs they are not shown.
const macDetached = async ($: EngineInterface, finder: Finder, rows: string[][], excluded: Set<number>, wallMs: number) => {
  const candidates = candidatesOf(startedFrom(rows, 4, wallMs), excluded, finder.mark.startMs)
  const unread = unreadOf(finder.cache, candidates)
  let read: { pid: number; startMs: number; isOurs: boolean }[] = []
  if (unread.length > 0 && wallMs - finder.scannedAt >= MAC_SCAN_MS) {
    finder.scannedAt = wallMs
    try {
      const { stdout, isStdoutTruncated } = await $.process.run(['ps', 'eww', '-o', 'pid=,command=', '-p', unread.map(each => each.pid).join(',')])
      const marked = macMarkedPids(stdout, finder.mark.id)
      const listed = macListedPids(stdout)
      // A pid missing from the output stays unread (the command may have failed or been cut); with cut
      // output only a pid found marked is certain.
      read = unread
        .filter(each => marked.has(each.pid) || (!isStdoutTruncated && listed.has(each.pid)))
        .map(each => ({ ...each, isOurs: marked.has(each.pid) }))
    } catch {
      // Read again at the next scan.
    }
  }
  finder.cache = rememberMarks(finder.cache, candidates, read)

  return oursOf(finder.cache, candidates)
}

const readLinux = async ($: EngineInterface, pid: number, finder: Finder | null): Promise<Gathered> => {
  const [status, stat, uptime] = await Promise.all([
    $.fs.read(`/proc/${pid}/status`),
    $.fs.read(`/proc/${pid}/stat`),
    $.fs.read('/proc/uptime'),
  ])
  const engine = linuxEngine(status, stat, uptime)
  try {
    const table = await psTable($, 'pid=,ppid=,etime=')
    const pids = childPids(table, pid)
    const excluded = new Set([pid, table.selfPid, ...pids])
    const ours = finder ? await linuxDetached($, finder, table.rows, excluded, await $.clock.now()) : []
    const [procs, detached] = await Promise.all([
      Promise.all(pids.map(child => readLinuxChild($, child, uptime))),
      Promise.all(ours.map(each => readLinuxChild($, each, uptime))),
    ])

    return { engine, children: procs.filter(proc => proc !== undefined), detached: detached.filter(proc => proc !== undefined) }
  } catch {
    return { engine }
  }
}

const readMac = async ($: EngineInterface, pid: number, peakSeenKb: number, finder: Finder | null): Promise<Gathered> => {
  const table = await psTable($, 'pid=,ppid=,rss=,time=,etime=,command=')
  const gathered = macReading(table, pid, peakSeenKb)
  if (!finder) return gathered
  const excluded = new Set([pid, table.selfPid, ...(gathered.children ?? []).map(child => child.pid)])
  const ours = new Set(await macDetached($, finder, table.rows, excluded, await $.clock.now()))

  return { ...gathered, detached: table.rows.filter(fields => ours.has(Number(fields[0]))).map(parseMacFields) }
}

const readWindows = async ($: EngineInterface, pid: number) => {
  const { stdout } = await $.process.run(['powershell', '-NoProfile', '-Command', powerShellSample(pid)])

  return windowsReading(stdout, pid)
}

const readProcesses = (
  $: EngineInterface,
  platform: Platform,
  pid: number,
  peakSeenKb: number,
  finder: Finder | null,
): Promise<Gathered> => {
  switch (platform) {
    case 'linux':
      return readLinux($, pid, finder)
    case 'mac':
      return readMac($, pid, peakSeenKb, finder)
    case 'windows':
      return readWindows($, pid)
  }
}

// Sends the signal; a failure is the first line of what the command said, else null. A process that
// had already ended is no failure.
const signal = async ($: EngineInterface, platform: string, pids: number[], isForce: boolean) => {
  try {
    const { exitCode, stderr } = await $.process.run(killArgv(platform, pids, isForce))
    if (exitCode === 0 || isAlreadyEnded(stderr)) return null

    return stderr.trim().split('\n')[0] || `exit ${exitCode}`
  } catch (error) {
    return error instanceof Error ? error.message : 'the command could not start'
  }
}

const toast = ($: EngineInterface, text: string) => $.ui.toast(text, { timeoutMs: TOAST_MS })

// The Linux start of one pid; null once it ended (its stat is gone, or it is a zombie).
const linuxStart = async ($: EngineInterface, pid: number, uptime: string, wallMs: number) => {
  try {
    return linuxObserved(pid, await $.fs.read(`/proc/${pid}/stat`), uptime, wallMs)
  } catch {
    return null
  }
}

// Which of a stop's targets still run, read per pid outside the tree, since one may have left it
// (its parent ended); a pid now used by a process started later is not one of them. Null when the
// liveness could not be read at all.
const aliveTargets = async ($: EngineInterface, platform: string, stop: StopState): Promise<number[] | null> => {
  const targets = stop.pids.map((pid, index) => ({ pid, startMs: stop.starts?.[index] ?? NaN }))
  try {
    let observed: Observed[]
    if (platform === 'linux') {
      const uptime = await $.fs.read('/proc/uptime')
      const wallMs = await $.clock.now()
      const starts = await Promise.all(stop.pids.map(pid => linuxStart($, pid, uptime, wallMs)))
      observed = starts.filter(seen => seen !== null)
    } else {
      const { stdout } = await $.process.run(
        platform === 'mac'
          ? macLivenessArgv(stop.pids)
          : ['powershell', '-NoProfile', '-Command', windowsLivenessScript(stop.pids)],
      )
      const wallMs = await $.clock.now()
      observed = platform === 'mac' ? parseMacLiveness(stdout, wallMs) : parseWindowsLiveness(stdout, wallMs)
    }

    return aliveFrom(targets, observed)
  } catch {
    return null
  }
}

const sameStop = (a: StopState | null | undefined, b: StopState) =>
  a?.pid === b.pid && a.startMs === b.startMs && a.phase === b.phase

// Replaces the stop only while it is still the one given, in the phase given: the person may have
// dismissed it, or another press moved it on, meanwhile. True when it was replaced.
const moveStop = async ($: EngineInterface, from: StopState, next: StopState | null) => {
  let isMoved = false
  await update($, pane, state => {
    isMoved = sameStop(state.stop, from)

    return isMoved ? { ...state, stop: next } : state
  })

  return isMoved
}

// STOP_CHECK_MS after a signal: done when none of the targets runs; else offer a force stop, or, after one,
// report. Without a reading, or liveness, it tries again, up to STOP_CHECK_TRIES times, then offers force stop.
const checkStop = async ($: EngineInterface) => {
  const stop = (await $.state.get(PANE_STATE)).value?.stop
  if (!stop || (stop.phase !== 'sent' && stop.phase !== 'forced')) return
  const snapshot = (await $.state.get(READING)).value?.snapshot
  const alive = snapshot ? await aliveTargets($, snapshot.platform, stop) : null
  if (alive === null) {
    // A stop saved by an earlier version has no count.
    const checks = Number.isFinite(stop.checks) ? stop.checks : 0
    if (checks >= STOP_CHECK_TRIES) {
      await moveStop($, stop, { ...stop, phase: 'stuck' })
      return
    }
    if (await moveStop($, stop, { ...stop, checks: checks + 1 })) $.clock.after(STOP_CHECK_MS, () => void checkStop($))
    return
  }
  if (alive.length > 0 && stop.phase === 'sent') {
    await moveStop($, stop, { ...stop, phase: 'stuck' })
    return
  }
  if (await moveStop($, stop, null)) toast($, outcomeText(stop, alive))
}

// What the pane's presses do. Built here because they call $, which pane.tsx never receives.
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
      if (state.stop) return
      const pids = snapshot && state.selected ? stopTargets(snapshot, state.selected) : null
      const row = snapshot?.children?.find(each => isSelected(each, state.selected))
      if (!pids || !row) {
        $.ui.toast('proc-stats: that process is no longer listed')
        return
      }
      const stop: StopState = {
        pid: row.pid,
        startMs: row.startMs,
        label: labelOf(row.command),
        pids,
        starts: startsOf(snapshot!, pids),
        checks: 0,
        phase: 'confirm',
      }
      await update($, pane, state => (state.stop ? state : { ...state, stop }))
    })(),
  // y: the targets again from this reading, then confirm → sent as one compare-and-set, so a second
  // press (or one racing it) signals nothing.
  onConfirm: () =>
    void (async () => {
      const snapshot = (await $.state.get(READING)).value?.snapshot
      if (!snapshot) return
      let won: StopState | null = null
      let isGone = false
      await update($, pane, state => {
        won = null
        isGone = false
        if (state.stop?.phase !== 'confirm') return state
        const pids = stopTargets(snapshot, state.stop)
        if (!pids) {
          isGone = true
          return { ...state, stop: null }
        }
        won = { ...state.stop, pids, starts: startsOf(snapshot, pids), checks: 0, phase: 'sent' }

        return { ...state, stop: won }
      })
      if (isGone) toast($, 'proc-stats: that process is no longer listed')
      const sent = won as StopState | null
      if (!sent) return
      const failure = await signal($, snapshot.platform, sent.pids, false)
      if (failure) toast($, `proc-stats: ${failure}`)
      $.clock.after(STOP_CHECK_MS, () => void checkStop($))
    })(),
  // f: stuck → forced as one compare-and-set, then SIGKILL to exactly the targets still running,
  // wherever they run now; with none left, the outcome.
  onForce: () =>
    void (async () => {
      const snapshot = (await $.state.get(READING)).value?.snapshot
      if (!snapshot) {
        toast($, 'proc-stats: no reading yet; try again')
        return
      }
      let won: StopState | null = null
      await update($, pane, state => {
        won = null
        if (state.stop?.phase !== 'stuck') return state
        won = { ...state.stop, checks: 0, phase: 'forced' }

        return { ...state, stop: won }
      })
      const forced = won as StopState | null
      if (!forced) return
      const alive = await aliveTargets($, snapshot.platform, forced)
      if (alive === null) {
        await moveStop($, forced, { ...forced, phase: 'stuck' })
        toast($, 'proc-stats: could not check which processes still run; try again')
        return
      }
      if (alive.length === 0) {
        if (await moveStop($, forced, null)) toast($, outcomeText(forced, []))
        return
      }
      const failure = await signal($, snapshot.platform, alive, true)
      if (failure) toast($, `proc-stats: ${failure}`)
      $.clock.after(STOP_CHECK_MS, () => void checkStop($))
    })(),
  onCancel: () => void update($, pane, state => ({ ...state, stop: null })),
})

// This session's mark: made once and kept across reloads, then set for every command started from now
// on. Null when it could not be set: detached processes are then not tracked.
const markSession = async ($: EngineInterface): Promise<SessionMark | null> => {
  try {
    const fresh = { id: crypto.randomUUID(), startMs: await $.clock.now() }
    let mark = fresh
    await update($, session, kept => (mark = kept.id ? kept : fresh))
    await $.env.set('PROC_STATS_SESSION', mark.id)

    return mark
  } catch {
    return null
  }
}

// One loop feeds both views: the status line, and the reading the pane draws.
const startSampling = async ($: EngineInterface, settings: Settings, mark: SessionMark | null) => {
  const set = (next: Reading) => update($, reading, () => next)

  try {
    const platform = await detectPlatform($)
    const pid = await enginePid($, platform)
    const capacity = historyCapacity(settings.historyMinutes, settings.intervalMs[platform])
    const windowMs = settings.historyMinutes * 60_000
    const spacingMs = pointSpacingMs(settings.historyMinutes)
    let before: Timed | undefined
    let isBusy = false
    // Windows finds no detached processes (documented); elsewhere only with the session marked.
    const finder: Finder | null = mark && platform !== 'windows' ? { mark, cache: new Map(), scannedAt: -Infinity } : null
    const detachedOff = mark === null && platform !== 'windows' ? { detachedOff: DETACHED_OFF } : {}

    const sample = async () => {
      if (isBusy) return
      isBusy = true
      try {
        const sample = await readProcesses($, platform, pid, before?.engine.peakKb ?? 0, finder)
        if (!isComplete(sample.engine)) throw new Error('unreadable sample')
        const now = { ...sample, wallMs: await $.clock.now() }
        const snapshot = { ...buildSnapshot(platform, pid, now, before), ...detachedOff }
        await set({ snapshot: capRows(snapshot) })
        try {
          const kept = (await $.state.get(PANE_STATE)).value ?? EMPTY_PANE
          const pruned = pruneState(kept, snapshot)
          if (JSON.stringify(pruned) !== JSON.stringify(kept)) await update($, pane, state => pruneState(state, snapshot))
        } catch {
          // The pane keeps its state this reading.
        }
        try {
          const kept = (await $.state.get(ORIGINS)).value ?? EMPTY_ORIGINS
          const matched = matchOrigins(kept, snapshot, now.wallMs)
          if (JSON.stringify(matched) !== JSON.stringify(kept)) {
            await update($, origins, current => matchOrigins(current, snapshot, now.wallMs))
          }
        } catch {
          // Origins catch up at the next reading.
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

// The agent of a call: the listed subagent, an unnamed agent when the listing does not name it
// (or cannot be read), or null for the main conversation.
const agentOf = async ($: EngineInterface, agentId: string | undefined): Promise<Origin['agent']> => {
  if (!agentId) return null
  try {
    const listed = (await $.agent.list()).find(agent => agent.id === agentId)
    if (listed) return { type: listed.type, description: listed.description }
  } catch {
    // Unnamed below.
  }

  return { ...UNNAMED_AGENT }
}

// Records a Bash or Monitor call before it runs, with the agent whose call it is, and drops calls
// past the TTL. Never throws: a failure here costs the origin only, never the call.
const recordCall = async ($: EngineInterface, tool: string, e: { tool_use_id: string; command?: unknown; agentId?: string }) => {
  if (typeof e.command !== 'string' || !e.command) return
  try {
    const at = await $.clock.now()
    const call: OriginCall = { id: e.tool_use_id, tool, agent: await agentOf($, e.agentId), command: e.command, at, settledAt: null }
    await update($, origins, kept => ({ ...kept, calls: [...kept.calls.filter(each => at - each.at <= CALL_TTL_MS), call] }))
  } catch {
    // The process will show without an origin.
  }
}

// Marks a recorded call settled: the tool returned. Never throws.
const settleCall = async ($: EngineInterface, id: string) => {
  try {
    const settledAt = await $.clock.now()
    await update($, origins, kept =>
      kept.calls.some(each => each.id === id)
        ? { ...kept, calls: kept.calls.map(each => (each.id === id ? { ...each, settledAt } : each)) }
        : kept,
    )
  } catch {
    // The call stays running until its TTL.
  }
}

// The command a recorded call runs, as the check sees it: after any PreToolUse rewrite. Never throws.
const checkCall = async ($: EngineInterface, e: { tool_use_id?: string; input: unknown }) => {
  const id = e.tool_use_id
  const command = (e.input as { command?: unknown } | null)?.command
  if (!id || typeof command !== 'string' || !command) return
  try {
    const kept = (await $.state.get(ORIGINS)).value ?? EMPTY_ORIGINS
    if (!kept.calls.some(each => each.id === id && each.command !== command)) return
    await update($, origins, current => ({
      ...current,
      calls: current.calls.map(each => (each.id === id ? { ...each, command } : each)),
    }))
  } catch {
    // The call keeps the command it was recorded with.
  }
}

// Runs a Bash or Monitor call: recorded before, settled after, the call and its answer unchanged.
const traceCall = async <E extends { tool_use_id: string; command?: unknown; agentId?: string }, R>(
  $: EngineInterface,
  tool: string,
  e: E,
  next: (e: E) => Promise<R>,
): Promise<R> => {
  await recordCall($, tool, e)
  try {
    return await next(e)
  } finally {
    await settleCall($, e.tool_use_id)
  }
}

// The report from current state, as the person and the model read it.
const report = async ($: EngineInterface, historyMinutes: number) =>
  reportText({
    reading: await read($, reading),
    points: (await read($, history)).points,
    alerts: await read($, alerts),
    origins: await read($, origins),
    now: await $.clock.now(),
    historyMinutes,
  })

// A settings change reloads the module, so they are read once per load.
export const register: Register = (on, options) => {
  const settings = readSettings(options)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: COMMAND,
      description: 'Show Claude Code and the processes it started in a task-manager pane, or a report',
      argumentHint: '[report]',
    })
    void startSampling($, settings, await markSession($))
    // A reload drops the check timer of a stop already signalled; schedule it again.
    const phase = (await $.state.get(PANE_STATE)).value?.stop?.phase
    if (phase === 'sent' || phase === 'forced') $.clock.after(STOP_CHECK_MS, () => void checkStop($))
    // A reload closes the pane (an unload no hook hears); put it back if it was open.
    if (await read($, isOpen)) void $.ui.open(OPEN).catch(() => undefined)

    return started
  })

  // Where processes come from: each Bash and Monitor call is recorded before it runs.
  on('tool.call', { tool: 'Bash' }, ($, e, next) => traceCall($, 'Bash', e, next)).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Monitor' }, ($, e, next) => traceCall($, 'Monitor', e, next)).catch(($, e, next) => next(e))

  // A PreToolUse hook may rewrite the command; the check sees it as it will run.
  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    await checkCall($, e)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.check', { tool: 'Monitor' }, async ($, e, next) => {
    await checkCall($, e)

    return next(e)
  }).catch(($, e, next) => next(e))

  // Bare: the pane. `report`: the report as the command's output. Anything else: how to use it.
  on('command.run', { command: COMMAND }, async ($, e) => {
    const typed = e.args.trim()
    if (typed.toLowerCase() === 'report') {
      try {
        return { text: await report($, settings.historyMinutes) }
      } catch {
        return { text: 'the report could not be made; try again.' }
      }
    }
    if (typed !== '') return { text: `unknown argument "${typed}". ${USAGE}` }
    const opened = await $.ui.open({ ...OPEN, focus: true })
    await update($, isOpen, () => true)

    return { text: opened.isPlaced ? 'Processes pane opened.' : 'Processes pane could not be placed.' }
  }).catch(($, e, next) =>
    next.called ? next(e) : { text: 'the Processes pane could not be opened.' },
  )

  // A close the person or the engine makes. A reload is no close: the pane comes back.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    await update($, isOpen, () => false)

    return closed
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) =>
    drawPane(
      $.ui.resolve(e),
      await read($, reading),
      await read($, pane),
      (await read($, history)).points,
      await read($, origins),
      e.props.bodyColumns,
      paneHandlers($),
    ),
  )

  // Arrow keys move the focus ring over the rows; the row it lands on is the selection.
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const moved = await next(e)
    if (e.element === undefined) {
      await update($, pane, state => (state.stop?.phase === 'confirm' ? { ...state, stop: null } : state))
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
