// The person's settings (plugin.json userConfig), read once per load. A value
// that is missing, of the wrong type or out of range is its default.

import type { PluginOptions } from 'claude-code'

import type { Platform } from './stats'

export type Settings = {
  intervalMs: Record<Platform, number>
  warnMemMb: number
  alertMemMb: number
  warnCpuPct: number
  alertCpuPct: number
  toastCpuPct: number
  toastCpuSeconds: number
  toastMemMb: number
  historyMinutes: number
  statusShowChildren: boolean
}

export const DEFAULTS: Settings = {
  intervalMs: { linux: 1000, mac: 2000, windows: 5000 },
  warnMemMb: 2048,
  alertMemMb: 4096,
  warnCpuPct: 150,
  alertCpuPct: 300,
  toastCpuPct: 90,
  toastCpuSeconds: 60,
  toastMemMb: 1024,
  historyMinutes: 10,
  statusShowChildren: true,
}

const number = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback

// A warn limit above its alert limit could never show: it is lowered to the alert limit.
const pair = (warn: number, alert: number): [number, number] => [Math.min(warn, alert), alert]

export const readSettings = (options: PluginOptions): Settings => {
  const [warnMemMb, alertMemMb] = pair(
    number(options.warnMemMb, DEFAULTS.warnMemMb, 1, 1_000_000),
    number(options.alertMemMb, DEFAULTS.alertMemMb, 1, 1_000_000),
  )
  const [warnCpuPct, alertCpuPct] = pair(
    number(options.warnCpuPct, DEFAULTS.warnCpuPct, 1, 100_000),
    number(options.alertCpuPct, DEFAULTS.alertCpuPct, 1, 100_000),
  )

  return {
    intervalMs: {
      linux: number(options.intervalLinuxMs, DEFAULTS.intervalMs.linux, 250, 60_000),
      mac: number(options.intervalMacMs, DEFAULTS.intervalMs.mac, 250, 60_000),
      windows: number(options.intervalWindowsMs, DEFAULTS.intervalMs.windows, 1000, 60_000),
    },
    warnMemMb,
    alertMemMb,
    warnCpuPct,
    alertCpuPct,
    toastCpuPct: number(options.toastCpuPct, DEFAULTS.toastCpuPct, 1, 100_000),
    toastCpuSeconds: number(options.toastCpuSeconds, DEFAULTS.toastCpuSeconds, 1, 86_400),
    toastMemMb: number(options.toastMemMb, DEFAULTS.toastMemMb, 1, 1_000_000),
    historyMinutes: number(options.historyMinutes, DEFAULTS.historyMinutes, 1, 120),
    statusShowChildren:
      typeof options.statusShowChildren === 'boolean' ? options.statusShowChildren : DEFAULTS.statusShowChildren,
  }
}
