import type { Elements, RenderSurface } from 'claude-code'

import type { ProcRow, Reading, Snapshot } from '../types'
import { formatBytes, formatDuration, formatPercent } from './format'
import { treePrefixes } from './view'

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

export type Line = {
  pid: string
  command: string
  mem: string
  cpu: string
  time: string
  style: 'header' | 'own' | 'child' | 'total' | 'note'
}

const childLine = (row: ProcRow, prefix: string): Line => ({
  pid: String(row.pid),
  command: `${prefix}${row.command}`,
  mem: formatBytes(row.rssKb),
  cpu: formatPercent(row.cpuPercent),
  time: formatDuration(row.uptimeSeconds),
  style: 'child',
})

// Zebra rows: every other process row, Claude Code's own counted first.
export const stripes = (lines: Line[]) => {
  let row = 0

  return lines.map(line => (line.style === 'own' || line.style === 'child') && row++ % 2 === 1)
}

// Claude Code first, the processes below it as a tree, then the totals.
export const paneLines = (snapshot: Snapshot): Line[] => {
  const { engine, children, childCpuPercent } = snapshot
  const lines: Line[] = [
    { pid: 'PID', command: 'COMMAND', mem: 'MEM', cpu: 'CPU', time: 'TIME', style: 'header' },
    {
      pid: String(snapshot.pid),
      command: 'Claude Code',
      mem: formatBytes(engine.rssKb),
      cpu: formatPercent(engine.cpuPercent),
      time: formatDuration(engine.uptimeSeconds),
      style: 'own',
    },
  ]
  if (children === null) {
    const note = 'Child process list unavailable'

    return [...lines, { pid: '', command: note, mem: '', cpu: '', time: '', style: 'note' }]
  }
  const prefixes = treePrefixes(children)
  lines.push(...children.map((row, index) => childLine(row, prefixes[index] ?? '')))
  if (children.length === 0) {
    const note = 'No child processes'

    return [...lines, { pid: '', command: note, mem: '', cpu: '', time: '', style: 'note' }]
  }
  const { childCount, childKb } = snapshot
  const both =
    engine.cpuPercent !== null && childCpuPercent !== null ? engine.cpuPercent + childCpuPercent : null
  const hidden = childCount - children.length
  if (hidden > 0) {
    lines.push({ pid: '', command: `… ${hidden} more`, mem: '', cpu: '', time: '', style: 'note' })
  }

  return [
    ...lines,
    { pid: '', command: `Child processes (${childCount})`, mem: formatBytes(childKb), cpu: formatPercent(childCpuPercent), time: '', style: 'total' },
    { pid: '', command: 'Total', mem: formatBytes(engine.rssKb + childKb), cpu: formatPercent(both), time: '', style: 'total' },
  ]
}

export const drawPane = (
  { Box, Text }: Elements[RenderSurface],
  { snapshot, error }: Reading,
  bodyColumns: number,
) => {
  if (!snapshot) {
    return (
      <Box paddingX={PADDING_X} paddingBottom={PADDING_BOTTOM}>
        <Text dimColor>{error ?? 'Reading…'}</Text>
      </Box>
    )
  }
  const { showPid, showTime, commandWidth } = paneColumns(bodyColumns - (PADDING_X + ROW_PADDING_X) * 2)
  const lines = paneLines(snapshot)
  const striped = stripes(lines)
  const cell = (text: string, width: number, line: Line, background: string | undefined, isRight = false) => (
    <Box width={width} justifyContent={isRight ? 'flex-end' : 'flex-start'}>
      <Text
        wrap="truncate-end"
        backgroundColor={background}
        color={line.style === 'header' ? HEADER_TEXT : undefined}
        bold={line.style === 'header' || line.style === 'own' || line.style === 'total'}
        dimColor={line.style === 'note'}
      >
        {text}
      </Text>
    </Box>
  )

  return (
    <Box flexDirection="column" paddingX={PADDING_X} paddingBottom={PADDING_BOTTOM}>
      <Box marginBottom={1} paddingX={ROW_PADDING_X}>
        <Text dimColor>
          peak {formatBytes(snapshot.engine.peakKb)} · {snapshot.platform}
          {snapshot.platform === 'mac' ? ' (peak is the highest seen)' : ''}
        </Text>
      </Box>
      {lines.map((line, index) => {
        const background =
          line.style === 'header' ? HEADER_COLOR : striped[index] ? STRIPE_COLOR : undefined

        return (
          <Box
            flexDirection="row"
            columnGap={1}
            paddingX={ROW_PADDING_X}
            backgroundColor={background}
            marginTop={line.style === 'total' && line.command !== 'Total' ? 1 : 0}
          >
            {showPid && cell(line.pid, PID_WIDTH, line, background)}
            {cell(line.command, commandWidth, line, background)}
            {cell(line.mem, NUMBER_WIDTH, line, background, true)}
            {cell(line.cpu, NUMBER_WIDTH, line, background, true)}
            {showTime && cell(line.time, TIME_WIDTH, line, background, true)}
          </Box>
        )
      })}
    </Box>
  )
}
