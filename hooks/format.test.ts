import { expect, test } from 'claude-code/testing'

import { MB } from './fixtures'
import { formatDuration, formatPair } from './format'

test('memory pair shares one unit', () => {
  expect(formatPair(484 * MB, 15 * MB)).toBe('(484 + 15)MB')
  expect(formatPair(1.5 * 1024 * MB, 512 * MB)).toBe('(1.50 + 0.50)GB')
  expect(formatPair(484 * MB, undefined)).toBe('(484 + ?)MB')
  expect(formatPair(484 * MB, 0)).toBe('484MB')
})

test('durations', () => {
  expect(formatDuration(42)).toBe('42s')
  expect(formatDuration(3725)).toBe('1h 2m')
  expect(formatDuration(90000)).toBe('1d 1h')
})
