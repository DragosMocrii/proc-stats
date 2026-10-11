// The model and effort of each agent's latest request, as the Subagents rows and Claude Code's row show them.

import type { ModelUse } from '../types'

// The model id as shown: after `claude-` (a provider prefix goes too), without a trailing `-YYYYMMDD` date; a `[…]` tag stays.
export const modelName = (id: string): string => {
  const at = id.indexOf('claude-')
  if (at < 0) return id

  return id.slice(at + 'claude-'.length).replace(/-\d{8}(?=\[|$)/, '')
}

// The map with `use` under `key`: `kept` itself when it holds that already.
export const withModel = (kept: Record<string, ModelUse>, key: string, use: ModelUse): Record<string, ModelUse> => {
  const had = kept[key]
  if (had !== undefined && had.model === use.model && had.effort === use.effort) return kept

  return { ...kept, [key]: use.effort === undefined ? { model: use.model } : { model: use.model, effort: use.effort } }
}

// The map without the agents the listing does not name; the main conversation (`''`) stays. `kept` itself when nothing drops.
export const pruneModels = (kept: Record<string, ModelUse>, listedIds: readonly string[]): Record<string, ModelUse> => {
  const keys = Object.keys(kept)
  const stays = keys.filter(key => key === '' || listedIds.includes(key))
  if (stays.length === keys.length) return kept

  return Object.fromEntries(stays.map(key => [key, kept[key]!]))
}

// The model and effort as shown, joined by ` · `: `model` and `model · effort` when known, else nothing.
export const modelParts = (use: ModelUse | undefined): string =>
  use === undefined ? '' : `${modelName(use.model)}${use.effort === undefined ? '' : ` · ${use.effort}`}`

// The dim text after a name or status: ` · model` and ` · effort` when known, else nothing.
export const modelText = (use: ModelUse | undefined): string => {
  const parts = modelParts(use)

  return parts === '' ? '' : ` · ${parts}`
}
