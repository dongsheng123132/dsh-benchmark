import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { copyFile, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import test from 'node:test'

test('CLI runs a benchmark and returns a content-addressed artifact', async () => {
  const hash = value => createHash('sha256').update(value).digest('hex')
  const root = await mkdtemp(join(tmpdir(), 'dsh-benchmark-cli-'))
  await copyFile(new URL('fixture-runner.mjs', import.meta.url), join(root, 'runner.mjs'))
  const stdout = '{"args":["cli"]}\n'
  await writeFile(join(root, 'benchmark.json'), JSON.stringify({
    schemaVersion: 1,
    suite: { name: 'cli-smoke', revision: 'cases-v1' },
    target: { name: 'fixture', revision: 'source-v1', files: ['runner.mjs'] },
    runner: { executable: 'node', cwd: '.', warmup: 0, repeat: 1, timeoutMs: 1000, maxOutputBytes: 4096, concurrency: 1 },
    scorer: { version: 'dsh-benchmark-scorer/1', minPassRate: 1, maxMedianLatencyRegressionPct: 20, requireStableOutput: true },
    cases: [{ id: 'cli', argv: ['runner.mjs', 'args', 'cli'], expected: { exitCode: 0, stdoutSha256: hash(stdout), stderrSha256: hash(''), stdoutJsonlLines: 1 } }]
  }))
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/dsh-benchmark.mjs', import.meta.url)), 'run', '--root', root, '--manifest', 'benchmark.json', '--artifact-dir', 'artifacts'])
  let stdoutText = ''
  let stderrText = ''
  child.stdout.on('data', chunk => { stdoutText += chunk })
  child.stderr.on('data', chunk => { stderrText += chunk })
  const [code] = await once(child, 'close')
  assert.equal(code, 0, stderrText)
  const result = JSON.parse(stdoutText)
  assert.equal(result.passed, true)
  assert.match(result.artifact.path, /\.json$/)
})
