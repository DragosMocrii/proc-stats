// Demo stand-in: takes a process name, holds some memory, and keeps the CPU at a share or in bursts.
const { fork } = require('node:child_process')
const { existsSync } = require('node:fs')

const LIFETIME_MS = 5 * 60_000

module.exports = ({ title, mb, busy = 0, burst, children = [] }) => {
  process.title = title
  const held = Buffer.alloc(mb * 1024 * 1024, 1)
  const spin = ms => { const end = Date.now() + ms; while (Date.now() < end); }
  // `busy`: a steady share of one core; `burst`: [on ms, off ms] at full speed.
  if (burst) {
    const [on, off] = burst
    const cycle = () => { spin(on); setTimeout(cycle, off) }
    setTimeout(cycle, off)
  } else if (busy > 0) {
    setInterval(() => spin(100 * busy), 100)
  }
  for (const child of children) fork(__filename.replace('hold.js', 'child.js'), [JSON.stringify(child)])
  setInterval(() => held[0]++, 60_000)
  // A demo leaves nothing behind: each stand-in ends once the recorder removes its project, or on its own.
  setInterval(() => existsSync(__dirname) || process.exit(0), 1000)
  setTimeout(() => process.exit(0), LIFETIME_MS)
}
