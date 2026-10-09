// The pane's rows as text: labels, cells, tree or sorted order, collapsing, selection and details.

// Whitespace runs, newlines included, become one space.
export const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

const EVAL = " && eval '"

// Claude Code runs a Bash command as `bash -c source <…/shell-snapshots/…> … && eval '<command>' < /dev/null && …`,
// a `'` inside written `'"'"'`. The command, or null for any other process.
export const unwrapCommand = (command: string): string | null => {
  const start = command.indexOf(EVAL)
  if (start < 0 || !command.includes('shell-snapshots/')) return null
  let rest = command.slice(start + EVAL.length)
  let inner = ''
  for (;;) {
    const quote = rest.indexOf("'")
    if (quote < 0) return null
    inner += rest.slice(0, quote)
    rest = rest.slice(quote + 1)
    if (!rest.startsWith(`"'"'`)) return inner
    inner += "'"
    rest = rest.slice(4)
  }
}

// What a row is called: `$ <command>` for a Bash command Claude Code ran, else the command line.
export const labelOf = (command: string) => {
  const inner = unwrapCommand(command)

  return inner === null ? oneLine(command) : `$ ${oneLine(inner)}`
}

// Cut to `width` code points with … when cut, then padded to `width`.
export const fit = (text: string, width: number, alignRight = false) => {
  const chars = Array.from(text)
  const kept = chars.length > width ? [...chars.slice(0, Math.max(0, width - 1)), '…'] : chars
  const pad = ' '.repeat(Math.max(0, width - kept.length))

  return alignRight ? pad + kept.join('') : kept.join('') + pad
}
