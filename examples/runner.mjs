import { createInterface } from 'node:readline'

for await (const line of createInterface({ input: process.stdin })) {
  if (!line) continue
  const value = JSON.parse(line)
  process.stdout.write(`${JSON.stringify({ doubled: value.number * 2 })}\n`)
}
