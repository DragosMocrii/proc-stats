import { expect, test } from 'claude-code/testing'

import { engine, proc } from './fixtures'
import { buildSnapshot } from './snapshot'
import { fit, labelOf, oneLine, unwrapCommand } from './view'

const wrap = (inner: string) =>
  `/bin/bash -c source /home/u/.claude/shell-snapshots/snapshot-bash-1-abc.sh 2>/dev/null || true && shopt -u extglob 2>/dev/null || true && eval '${inner}' < /dev/null && pwd -P >| /tmp/claude-1-cwd`

test('rows carry their start time', () => {
  const snapshot = buildSnapshot('linux', 10, { engine, children: [proc(11, 10, { uptimeSeconds: 100 })], wallMs: 500_000 }, undefined)
  expect(snapshot.children?.[0]?.startMs).toBe(400_000)
})

test('the command inside Claude Code\'s Bash wrapper', () => {
  expect(unwrapCommand(wrap('npm test'))).toBe('npm test')
  expect(unwrapCommand(wrap(`echo '"'"'hi'"'"'`))).toBe("echo 'hi'")
  expect(unwrapCommand('python3 -c x')).toBeNull()
  expect(unwrapCommand("bash -c eval 'x'")).toBeNull()
  expect(unwrapCommand(wrap('unterminated').replace(/' < \/dev\/null.*$/, ''))).toBeNull()
})

test('labels: the command you ran, on one line', () => {
  expect(labelOf(wrap('npm   test\n  --watch'))).toBe('$ npm test --watch')
  expect(labelOf('python3  -c\nx')).toBe('python3 -c x')
  expect(oneLine('  a\t b \n')).toBe('a b')
})

test('cells are cut with … and padded, by code points', () => {
  expect(fit('abc', 5)).toBe('abc  ')
  expect(fit('abc', 5, true)).toBe('  abc')
  expect(fit('abcdef', 4)).toBe('abc…')
  expect(fit('ab😀cd', 4)).toBe('ab😀…')
  expect(fit('abc', 3)).toBe('abc')
})
