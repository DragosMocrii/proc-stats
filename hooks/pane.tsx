import type { Elements, RenderSurface } from 'claude-code'

import type { PaneState, Point, Reading } from '../types'
import { formatBytes, formatDuration, formatPercent } from './format'
import { sparkLines } from './sparkline'
import { confirmText } from './stop'
import { detailLines, fit, isSelected, noteLine, totalLines, viewRows } from './view'
import type { ViewRow } from './view'

const PID_WIDTH = 7
const NUMBER_WIDTH = 7
const TIME_WIDTH = 7
const MIN_COMMAND = 12
// Space around the pane's contents, in cells: each side, and below. Rows pad
// their own sides too, so a stripe reaches past the text it holds.
const PADDING_X = 1
const ROW_PADDING_X = 1
const PADDING_BOTTOM = 1
// Theme keys, so both follow the person's light or dark theme.
const HEADER_COLOR = 'claude'
const HEADER_TEXT = 'inverseText'
const STRIPE_COLOR = 'subtle'

// The columns that fit: TIME goes first, then PID, the command keeping the rest.
export const paneColumns = (bodyColumns: number) => {
  const fixed = (showPid: boolean, showTime: boolean) =>
    (showPid ? PID_WIDTH + 1 : 0) + (NUMBER_WIDTH + 1) * 2 + (showTime ? TIME_WIDTH + 1 : 0)
  const showTime = bodyColumns - fixed(true, true) >= MIN_COMMAND
  const showPid = bodyColumns - fixed(true, false) >= MIN_COMMAND || showTime

  return {
    showPid,
    showTime,
    commandWidth: Math.max(MIN_COMMAND, bodyColumns - fixed(showPid, showTime)),
  }
}

export type RowTarget = { pid: number; startMs: number; hasChildren: boolean }

// What the pane's presses do; register.ts builds them. Stop handlers are optional: without them no stop is offered.
export type PaneHandlers = {
  onRow: (target: RowTarget) => void
  onSort: () => void
  onStop?: () => void
  onConfirm?: () => void
  onCancel?: () => void
  onForce?: () => void
}

const marker = (view: ViewRow) => (view.hasChildren ? (view.isCollapsed ? '▸ ' : '▾ ') : '')

// The command cell: tree lines, the collapse marker and the label; in sorted views the parent after it.
export const commandCell = (view: ViewRow, width: number) => {
  const main = `${view.prefix}${marker(view)}${view.label}`
  if (view.parent === null) return { main: fit(main, width), parent: '' }
  const tail = ` ← ${view.parent}`
  const tailWidth = Math.min(Array.from(tail).length, Math.floor(width / 3))

  return { main: fit(main, width - tailWidth), parent: fit(tail, tailWidth) }
}

export const drawPane = (
  { Box, Text, Button }: Elements[RenderSurface],
  { snapshot, error }: Reading,
  state: PaneState,
  points: Point[],
  bodyColumns: number,
  handlers: PaneHandlers,
) => {
  if (!snapshot) {
    return (
      <Box paddingX={PADDING_X} paddingBottom={PADDING_BOTTOM}>
        <Text dimColor>{error ?? 'Reading…'}</Text>
      </Box>
    )
  }
  // The cells inside the pane's and each row's padding: what the rows and the charts lay out in.
  const contentWidth = bodyColumns - (PADDING_X + ROW_PADDING_X) * 2
  const { showPid, showTime, commandWidth } = paneColumns(contentWidth)
  const views = viewRows(snapshot, state)
  // The history's shape over the window, in the width the rows use.
  const charts = sparkLines(points, contentWidth)
  const numbers = (mem: string, cpu: string, time: string) =>
    ` ${fit(mem, NUMBER_WIDTH, true)} ${fit(cpu, NUMBER_WIDTH, true)}${showTime ? ` ${fit(time, TIME_WIDTH, true)}` : ''}`
  const pidCell = (pid: string) => (showPid ? `${fit(pid, PID_WIDTH)} ` : '')

  // One row: a plain keyed Button of Text cells, striped by its Box; the selected row underlined.
  const row = (
    key: string,
    target: RowTarget,
    command: { main: string; parent: string },
    figures: string,
    pid: string,
    isStriped: boolean,
    isBold: boolean,
  ) => {
    const background = isStriped ? STRIPE_COLOR : undefined
    const underline = isSelected(target, state.selected) || (target.pid === snapshot.pid && state.selected?.pid === snapshot.pid)
    const cells =
      command.parent === ''
        ? [
            <Text backgroundColor={background} bold={isBold} underline={underline}>{`${pidCell(pid)}${command.main}`}</Text>,
            <Text backgroundColor={background} bold={isBold}>{figures}</Text>,
          ]
        : [
            <Text backgroundColor={background} bold={isBold} underline={underline}>{`${pidCell(pid)}${command.main}`}</Text>,
            <Text backgroundColor={background} dimColor>{command.parent}</Text>,
            <Text backgroundColor={background} bold={isBold}>{figures}</Text>,
          ]

    return (
      <Box paddingX={ROW_PADDING_X} backgroundColor={background}>
        <Button key={key} plain onPress={() => handlers.onRow(target)}>
          {cells}
        </Button>
      </Box>
    )
  }

  const { engine } = snapshot
  const engineRow = row(
    `pid:${snapshot.pid}`,
    { pid: snapshot.pid, startMs: 0, hasChildren: false },
    { main: fit('Claude Code', commandWidth), parent: '' },
    numbers(formatBytes(engine.rssKb), formatPercent(engine.cpuPercent), formatDuration(engine.uptimeSeconds)),
    String(snapshot.pid),
    false,
    true,
  )
  // Zebra rows count Claude Code's own as the first.
  const childRows = views.map((view, index) =>
    row(
      `pid:${view.row.pid}`,
      { pid: view.row.pid, startMs: view.row.startMs, hasChildren: view.hasChildren && state.sort === 'tree' },
      commandCell(view, commandWidth),
      numbers(formatBytes(view.rssKb), formatPercent(view.cpuPercent), formatDuration(view.row.uptimeSeconds)),
      String(view.row.pid),
      index % 2 === 0,
      false,
    ),
  )
  const note = noteLine(snapshot)
  const totals = totalLines(snapshot)
  const details = detailLines(snapshot, state.selected)
  const stop = state.stop
  const canStop =
    handlers.onStop !== undefined &&
    state.selected !== null &&
    state.selected.pid !== snapshot.pid &&
    views.some(view => isSelected(view.row, state.selected))

  return (
    <Box flexDirection="column" paddingX={PADDING_X} paddingBottom={PADDING_BOTTOM}>
      {charts !== null && (
        <Box flexDirection="column" paddingX={ROW_PADDING_X}>
          <Text>{charts[0]}</Text>
          <Text>{charts[1]}</Text>
        </Box>
      )}
      <Box marginBottom={1} paddingX={ROW_PADDING_X}>
        <Text dimColor>
          peak {formatBytes(engine.peakKb)} · {snapshot.platform}
          {snapshot.platform === 'mac' ? ' (peak is the highest seen)' : ''}
        </Text>
      </Box>
      <Box paddingX={ROW_PADDING_X} backgroundColor={HEADER_COLOR}>
        <Text color={HEADER_TEXT} bold>
          {`${pidCell('PID')}${fit(state.sort === 'tree' ? 'COMMAND' : `COMMAND (by ${state.sort})`, commandWidth)}${numbers('MEM', 'CPU', 'TIME')}`}
        </Text>
      </Box>
      {engineRow}
      {childRows}
      {note !== null && (
        <Box paddingX={ROW_PADDING_X}>
          <Text dimColor>{`${pidCell('')}${note}`}</Text>
        </Box>
      )}
      {totals.length > 0 && (
        <Box flexDirection="column" marginTop={1} paddingX={ROW_PADDING_X}>
          {totals.map(total => (
            <Text bold>{`${pidCell('')}${fit(total.label, commandWidth)}${numbers(total.mem, total.cpu, '')}`}</Text>
          ))}
        </Box>
      )}
      {details !== null && (
        <Box flexDirection="column" marginTop={1} paddingX={ROW_PADDING_X}>
          {details.map((line, index) => (
            <Text dimColor={index > 0}>{line}</Text>
          ))}
        </Box>
      )}
      {stop?.phase === 'confirm' && (
        <Box marginTop={1} paddingX={ROW_PADDING_X}>
          <Text>{confirmText(stop)}</Text>
        </Box>
      )}
      <Box flexDirection="row" columnGap={2} marginTop={stop?.phase === 'confirm' ? 0 : 1} paddingX={ROW_PADDING_X}>
        {stop === null && (
          <Button key="sort" plain hotkey="s" onPress={handlers.onSort}>
            {`Sort: ${state.sort}`}
          </Button>
        )}
        {stop === null && canStop && handlers.onStop && (
          <Button key="stop" plain hotkey="k" onPress={handlers.onStop}>
            Stop process
          </Button>
        )}
        {stop?.phase === 'confirm' && handlers.onConfirm && (
          <Button key="confirm" plain hotkey="y" onPress={handlers.onConfirm}>
            Stop
          </Button>
        )}
        {(stop?.phase === 'sent' || stop?.phase === 'forced') && <Text dimColor>Stopping…</Text>}
        {stop?.phase === 'stuck' && <Text>Still running.</Text>}
        {stop?.phase === 'stuck' && handlers.onForce && (
          <Button key="force" plain hotkey="f" onPress={handlers.onForce}>
            Force stop
          </Button>
        )}
        {stop && handlers.onCancel && (
          <Button key="cancel" plain hotkey="n" onPress={handlers.onCancel}>
            {stop.phase === 'confirm' ? 'Cancel' : 'Dismiss'}
          </Button>
        )}
      </Box>
    </Box>
  )
}
