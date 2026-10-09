import { expect, test } from 'claude-code/testing'

import { MB } from './fixtures'
import { memoryScale, sparkline, sparkLines } from './sparkline'

const point = (t: number, memMb: number, cpuPct: number) => ({ t, memKb: memMb * MB, cpuPct })

test('values become blocks from 0 to the top', () => {
  expect(sparkline([0, 50, 100], 3, 100)).toBe('▁▅█')
  expect(sparkline([0, 0], 5, 0)).toBe('▁▁')
  expect(sparkline([10, 20], 0, 20)).toBe('')
})

test('fewer values than columns: as long as the values; more: bucket maxima', () => {
  expect(sparkline([100, 100], 10, 100)).toBe('██')
  expect(sparkline([0, 100, 0, 0], 2, 100)).toBe('█▁')
})

test('no lines before two points', () => {
  expect(sparkLines([], 40)).toBeNull()
  expect(sparkLines([point(0, 500, 10)], 40)).toBeNull()
})

test('memory scales from its lowest to its highest point, at least 64 MB or 10% tall', () => {
  expect(memoryScale([512 * MB, 1024 * MB])).toEqual([512 * MB, 1024 * MB])
  // Flat: a span of 64 MB centred on the value, so it draws mid-height.
  expect(memoryScale([512 * MB, 512 * MB])).toEqual([480 * MB, 544 * MB])
  // Never below zero.
  expect(memoryScale([10 * MB, 10 * MB])).toEqual([0, 64 * MB])
})

test('lines: chart padded to its width, then the current value and the window maximum', () => {
  expect(sparkLines([point(0, 512, 50), point(1000, 1024, 200)], 40)).toEqual([
    'mem ▁█                 1.00GB max 1.00GB',
    'cpu ▃█                 200.0% max 200.0%',
  ])
  expect(sparkLines([point(0, 512, 0), point(1000, 512, 50)], 40)).toEqual([
    'mem ▅▅                   512MB max 512MB',
    'cpu ▁▅                   50.0% max 50.0%',
  ])
})

test('a slow leak fills the height', () => {
  const leak = [650, 660, 670, 680, 690, 700, 710, 720].map((memMb, index) => point(index * 1000, memMb, 10))
  expect(sparkLines(leak, 60)?.[0]?.startsWith('mem ▁▂▃▄▅▆▇█ ')).toBe(true)
})

test('the values stay in place while the chart fills', () => {
  const flat = (count: number) => Array.from({ length: count }, (_, index) => point(index * 1000, 512, 50))
  expect(sparkLines(flat(2), 40)?.[0]?.indexOf(' max ')).toBe(sparkLines(flat(10), 40)?.[0]?.indexOf(' max '))
})

test('a narrow pane drops the chart before the values', () => {
  expect(sparkLines([point(0, 512, 50), point(1000, 1024, 200)], 11)).toEqual([
    'mem  1.00GB max 1.00GB',
    'cpu  200.0% max 200.0%',
  ])
})
