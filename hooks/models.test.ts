import { expect, test } from 'claude-code/testing'

import { modelName, modelParts, modelText, pruneModels, withModel } from './models'

test('model names: after claude-, without a trailing date, with a context tag kept', () => {
  expect(modelName('claude-sonnet-5-5')).toBe('sonnet-5-5')
  expect(modelName('claude-opus-5-5-20260301')).toBe('opus-5-5')
  expect(modelName('us.anthropic.claude-haiku-5-5')).toBe('haiku-5-5')
  expect(modelName('claude-opus-5-5[1m]')).toBe('opus-5-5[1m]')
  expect(modelName('claude-opus-5-5-20260301[1m]')).toBe('opus-5-5[1m]')
  expect(modelName('sonnet')).toBe('sonnet')
  expect(modelName('gpt-x')).toBe('gpt-x')
})

test('withModel: the same map when unchanged, a new one when changed, effort omitted when undefined', () => {
  const kept = { '': { model: 'claude-opus-5-5', effort: 'high' as const } }
  expect(withModel(kept, '', { model: 'claude-opus-5-5', effort: 'high' })).toBe(kept)
  const changed = withModel(kept, '', { model: 'claude-opus-5-5', effort: 'max' })
  expect(changed).not.toBe(kept)
  expect(changed).toEqual({ '': { model: 'claude-opus-5-5', effort: 'max' } })
  const added = withModel(kept, 'a1', { model: 'claude-haiku-5-5', effort: undefined })
  expect(added).toEqual({ '': { model: 'claude-opus-5-5', effort: 'high' }, a1: { model: 'claude-haiku-5-5' } })
  expect('effort' in added.a1!).toBe(false)
  expect(withModel(added, 'a1', { model: 'claude-haiku-5-5', effort: undefined })).toBe(added)
  expect(kept).toEqual({ '': { model: 'claude-opus-5-5', effort: 'high' } })
})

test('pruneModels keeps the main conversation and listed agents, and returns the same map when nothing drops', () => {
  const kept = { '': { model: 'm' }, a1: { model: 'm' }, gone: { model: 'm' } }
  expect(pruneModels(kept, ['a1'])).toEqual({ '': { model: 'm' }, a1: { model: 'm' } })
  const clean = { '': { model: 'm' }, a1: { model: 'm' } }
  expect(pruneModels(clean, ['a1', 'a2'])).toBe(clean)
  expect(pruneModels({}, [])).toEqual({})
})

test('model text: nothing when unknown, else the name and the effort when there is one', () => {
  expect(modelText(undefined)).toBe('')
  expect(modelText({ model: 'claude-sonnet-5-5' })).toBe(' · sonnet-5-5')
  expect(modelText({ model: 'claude-opus-5-5', effort: 'high' })).toBe(' · opus-5-5 · high')
  expect(modelText({ model: 'claude-opus-5-5', effort: 8000 })).toBe(' · opus-5-5 · 8000')
})

test('model parts: nothing when unknown, else the name and the effort when there is one', () => {
  expect(modelParts(undefined)).toBe('')
  expect(modelParts({ model: 'claude-sonnet-5-5' })).toBe('sonnet-5-5')
  expect(modelParts({ model: 'claude-opus-5-5', effort: 'high' })).toBe('opus-5-5 · high')
  expect(modelParts({ model: 'claude-opus-5-5', effort: 8000 })).toBe('opus-5-5 · 8000')
})
