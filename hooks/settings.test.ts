import { expect, test } from 'claude-code/testing'

import { DEFAULTS, readSettings } from './settings'

test('no options: every default', () => {
  expect(readSettings({})).toEqual(DEFAULTS)
  expect(DEFAULTS.intervalMs).toEqual({ linux: 1000, mac: 2000, windows: 5000 })
  expect(DEFAULTS.statusShowChildren).toBe(true)
})

test('valid options are taken', () => {
  const settings = readSettings({ intervalLinuxMs: 500, warnMemMb: 1000, historyMinutes: 30, statusShowChildren: false })
  expect(settings.intervalMs.linux).toBe(500)
  expect(settings.warnMemMb).toBe(1000)
  expect(settings.historyMinutes).toBe(30)
  expect(settings.statusShowChildren).toBe(false)
})

test('out of range, wrong type or not a number: the default', () => {
  const settings = readSettings({
    intervalLinuxMs: 10,
    intervalMacMs: 'fast',
    toastCpuSeconds: 0,
    historyMinutes: 1000,
    statusShowChildren: 'yes',
  })
  expect(settings.intervalMs.linux).toBe(1000)
  expect(settings.intervalMs.mac).toBe(2000)
  expect(settings.toastCpuSeconds).toBe(60)
  expect(settings.historyMinutes).toBe(10)
  expect(settings.statusShowChildren).toBe(true)
})

test('a warn limit above its alert limit: both defaults', () => {
  const settings = readSettings({ warnMemMb: 5000, alertMemMb: 3000, warnCpuPct: 100, alertCpuPct: 200 })
  expect([settings.warnMemMb, settings.alertMemMb]).toEqual([2048, 4096])
  expect([settings.warnCpuPct, settings.alertCpuPct]).toEqual([100, 200])
})

test('the mod loads with settings given', { options: { intervalLinuxMs: 500, statusShowChildren: false } }, async () => {
  expect(readSettings({ intervalLinuxMs: 500 }).intervalMs.linux).toBe(500)
})
