// The pane's rows as text: labels, cells, tree or sorted order, collapsing, selection and details.

import type { PaneState, ProcRow, Selected, Snapshot, SortMode } from '../types'
import { formatBytes, formatDuration, formatPercent } from './format'

export const EMPTY_PANE: PaneState = { sort: 'tree', collapsed: [], selected: null, stop: null }

// A process's start, taken from readings, can move by a second or so; further apart is another process.
export const START_TOLERANCE_MS = 2000

const SORTS: SortMode[] = ['tree', 'cpu', 'mem', 'time']

// Whitespace runs, newlines included, become one space.
export const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

const EVAL = " && eval '"

// Claude Code runs a Bash command as `bash -c source <…/shell-snapshots/…> … && eval '<command>' < /dev/null && …`,
// a `'` inside written `'"'"'`. The command, or null for any other process.
export const unwrapCommand = (command: string): string | null => {
  const start = command.indexOf(EVAL)
  if (start < 0 || !command.includes('shell-snapshots/')) return null
  let rest = command.slice(start + EVAL.length)
  let inner = ''
  for (;;) {
    const quote = rest.indexOf("'")
    if (quote < 0) return null
    inner += rest.slice(0, quote)
    rest = rest.slice(quote + 1)
    if (!rest.startsWith(`"'"'`)) return inner
    inner += "'"
    rest = rest.slice(4)
  }
}

// What a row is called: `$ <command>` for a Bash command Claude Code ran, else the command line.
export const labelOf = (command: string) => {
  const inner = unwrapCommand(command)

  return inner === null ? oneLine(command) : `$ ${oneLine(inner)}`
}

// Cut to `width` code points with … when cut, then padded to `width`.
export const fit = (text: string, width: number, alignRight = false) => {
  const chars = Array.from(text)
  const kept = chars.length > width ? [...chars.slice(0, Math.max(0, width - 1)), '…'] : chars
  const pad = ' '.repeat(Math.max(0, width - kept.length))

  return alignRight ? pad + kept.join('') : kept.join('') + pad
}

// Tree lines for rows in tree order: `├ ` or `└ ` before each, and `│ ` under
// every ancestor that has a sibling still to come.
export const treePrefixes = (rows: { depth: number }[]) => {
  const isLastAt: boolean[] = []

  return rows.map(({ depth }, index) => {
    const next = rows.slice(index + 1).find(row => row.depth <= depth)
    const isLast = next === undefined || next.depth < depth
    const prefix = isLastAt.slice(0, depth).map(last => (last ? '  ' : '│ ')).join('')
    isLastAt[depth] = isLast

    return `${prefix}${isLast ? '└' : '├'} `
  })
}

export type ViewRow = {
  row: ProcRow
  label: string
  // Tree lines in the tree view; empty when sorted.
  prefix: string
  // The parent's label in sorted views; null in the tree.
  parent: string | null
  // The row's own figures, or its subtree's while collapsed.
  rssKb: number
  cpuPercent: number | null
  hasChildren: boolean
  isCollapsed: boolean
}

// The index just past a row's subtree (rows are in tree order).
const subtreeEnd = (rows: ProcRow[], index: number) => {
  const depth = rows[index]!.depth
  let end = index + 1
  while (end < rows.length && rows[end]!.depth > depth) end++

  return end
}

const sumCpu = (rows: ProcRow[]) =>
  rows.some(row => row.cpuPercent === null) ? null : rows.reduce((sum, row) => sum + (row.cpuPercent ?? 0), 0)

// A process's label, or its pid when it is not among the rows (past the cap, or ended).
const labelIn = (rows: ProcRow[], pid: number) => {
  const found = rows.find(row => row.pid === pid)

  return found ? labelOf(found.command) : `pid ${pid}`
}

const sortKey: Record<Exclude<SortMode, 'tree'>, (row: ProcRow) => number> = {
  cpu: row => row.cpuPercent ?? -1,
  mem: row => row.rssKb,
  time: row => row.uptimeSeconds,
}

export const viewRows = (snapshot: Snapshot, state: PaneState): ViewRow[] => {
  const rows = snapshot.children ?? []
  const labels = new Map(rows.map(row => [row.pid, labelOf(row.command)]))
  const label = (pid: number) => labels.get(pid) ?? labelIn(rows, pid)
  const sort = state.sort
  if (sort !== 'tree') {
    const key = sortKey[sort]

    return [...rows]
      .sort((a, b) => key(b) - key(a) || a.pid - b.pid)
      .map(row => ({
        row,
        label: label(row.pid),
        prefix: '',
        parent: row.ppid === snapshot.pid ? 'Claude Code' : label(row.ppid),
        rssKb: row.rssKb,
        cpuPercent: row.cpuPercent,
        hasChildren: false,
        isCollapsed: false,
      }))
  }
  const visible: ViewRow[] = []
  for (let index = 0; index < rows.length; ) {
    const row = rows[index]!
    const end = subtreeEnd(rows, index)
    const hasChildren = end > index + 1
    const isCollapsed = hasChildren && state.collapsed.includes(row.pid)
    const span = isCollapsed ? rows.slice(index, end) : [row]
    visible.push({
      row,
      label: label(row.pid),
      prefix: '',
      parent: null,
      rssKb: span.reduce((sum, each) => sum + each.rssKb, 0),
      cpuPercent: sumCpu(span),
      hasChildren,
      isCollapsed,
    })
    index = isCollapsed ? end : index + 1
  }
  const prefixes = treePrefixes(visible.map(view => view.row))

  return visible.map((view, index) => ({ ...view, prefix: prefixes[index] ?? '' }))
}

export const isSelected = (row: { pid: number; startMs: number }, selected: Selected | null) =>
  selected !== null && selected.pid === row.pid && Math.abs(selected.startMs - row.startMs) <= START_TOLERANCE_MS

export const cycleSort = (sort: SortMode): SortMode => SORTS[(SORTS.indexOf(sort) + 1) % SORTS.length]!

export const toggleCollapsed = (collapsed: number[], pid: number) =>
  collapsed.includes(pid) ? collapsed.filter(each => each !== pid) : [...collapsed, pid]

// Forgets what names an ended process. Claude Code's row stays selectable; a stop past its confirmation
// is kept (a process it left running may run outside the tree, unlisted), cleared by f or n; an unreadable
// table changes nothing.
export const pruneState = (state: PaneState, snapshot: Snapshot): PaneState => {
  const rows = snapshot.children
  if (rows === null) return state
  const isListed = (chosen: Selected) => rows.some(row => isSelected(row, chosen))
  const selected =
    state.selected && (state.selected.pid === snapshot.pid || isListed(state.selected)) ? state.selected : null
  const stop = state.stop && (state.stop.phase !== 'confirm' || isListed(state.stop)) ? state.stop : null
  const collapsed = state.collapsed.filter(pid => rows.some(row => row.pid === pid))

  return { ...state, selected, collapsed, stop }
}

const clockTime = (ms: number) => {
  const date = new Date(ms)

  return [date.getHours(), date.getMinutes(), date.getSeconds()].map(part => String(part).padStart(2, '0')).join(':')
}

// The selected row's full command, then its facts; null with nothing (listed) selected.
export const detailLines = (snapshot: Snapshot, selected: Selected | null): string[] | null => {
  if (selected === null) return null
  const { engine } = snapshot
  if (selected.pid === snapshot.pid) {
    return [
      `Claude Code · pid ${snapshot.pid} · ${formatBytes(engine.rssKb)} · ${formatPercent(engine.cpuPercent)} · up ${formatDuration(engine.uptimeSeconds)}`,
    ]
  }
  const rows = snapshot.children ?? []
  const row = rows.find(each => isSelected(each, selected))
  if (!row) return null
  const parent = row.ppid === snapshot.pid ? 'Claude Code' : labelIn(rows, row.ppid)

  return [
    oneLine(row.command),
    `pid ${row.pid} · parent ${row.ppid} (${parent}) · started ${clockTime(row.startMs)} · ${formatBytes(row.rssKb)} · ${formatPercent(row.cpuPercent)} · up ${formatDuration(row.uptimeSeconds)}`,
  ]
}

export type TotalLine = { label: string; mem: string; cpu: string }

// The children's subtotal and the session total, when there are children.
export const totalLines = (snapshot: Snapshot): TotalLine[] => {
  const { engine, children, childCount, childKb, childCpuPercent } = snapshot
  if (children === null || childCount === 0) return []
  const both = engine.cpuPercent !== null && childCpuPercent !== null ? engine.cpuPercent + childCpuPercent : null

  return [
    { label: `Child processes (${childCount})`, mem: formatBytes(childKb), cpu: formatPercent(childCpuPercent) },
    { label: 'Total', mem: formatBytes(engine.rssKb + childKb), cpu: formatPercent(both) },
  ]
}

// One dim line under the rows: why there are none, or how many are left out.
export const noteLine = (snapshot: Snapshot) => {
  if (snapshot.children === null) return 'Child process list unavailable'
  if (snapshot.childCount === 0) return 'No child processes'
  const hidden = snapshot.childCount - snapshot.children.length

  return hidden > 0 ? `… ${hidden} more` : null
}
