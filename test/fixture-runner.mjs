import { createInterface } from 'node:readline'

const [mode, ...args] = process.argv.slice(2)

if (mode === 'jsonl') {
  for await (const line of createInterface({ input: process.stdin })) {
    if (!line) continue
    const value = JSON.parse(line)
    process.stdout.write(`${JSON.stringify({ doubled: value.number * 2 })}\n`)
  }
} else if (mode === 'args') {
  process.stdout.write(`${JSON.stringify({ args })}\n`)
} else if (mode === 'env') {
  process.stdout.write(`${JSON.stringify({ inherited: Boolean(process.env.DSH_BENCH_SECRET) })}\n`)
} else if (mode === 'sleep') {
  await new Promise(resolve => setTimeout(resolve, Number(args[0])))
  process.stdout.write('{"done":true}\n')
} else if (mode === 'spam') {
  process.stdout.write('x'.repeat(Number(args[0])))
} else if (mode === 'exit') {
  process.exitCode = Number(args[0])
} else {
  process.stderr.write('unknown mode\n')
  process.exitCode = 64
}
