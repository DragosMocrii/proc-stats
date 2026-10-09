import { expect, test } from 'claude-code/testing'

import { MB } from './fixtures'
import { sparkline, sparkLines } from './sparkline'

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

test('memory scales to its highest point; CPU to one core or its highest point', () => {
  expect(sparkLines([point(0, 512, 50), point(1000, 1024, 200)], 20)).toEqual(['mem ▅█ 1.00GB', 'cpu ▃█ 200.0%'])
  expect(sparkLines([point(0, 512, 0), point(1000, 512, 50)], 20)).toEqual(['mem ██ 512MB', 'cpu ▁▅ 50.0%'])
})

test('a narrow pane drops the chart before the value', () => {
  expect(sparkLines([point(0, 512, 50), point(1000, 1024, 200)], 11)).toEqual(['mem  1.00GB', 'cpu  200.0%'])
})
