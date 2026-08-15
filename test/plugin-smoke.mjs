import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDefinitions } from '../index.js'
import * as plugin from '../index.js'

const hash = value => createHash('sha256').update(value).digest('hex')
assert.equal('default' in plugin, false, 'a default export makes the real DSH Loader discard namespace inject metadata')
assert.equal(plugin.name, 'dsh-benchmark')
assert.deepEqual(plugin.inject, ['tools'])
const root = await mkdtemp(join(tmpdir(), 'dsh-benchmark-plugin-'))
await copyFile(new URL('fixture-runner.mjs', import.meta.url), join(root, 'runner.mjs'))
const stdout = '{"args":["smoke"]}\n'
await writeFile(join(root, 'benchmark.json'), JSON.stringify({
  schemaVersion: 1,
  suite: { name: 'plugin-smoke', revision: 'cases-v1' },
  target: { name: 'fixture', revision: 'source-v1', files: ['runner.mjs'] },
  runner: { executable: 'node', cwd: '.', warmup: 0, repeat: 1, timeoutMs: 1000, maxOutputBytes: 4096, concurrency: 1 },
  scorer: { version: 'dsh-benchmark-scorer/1', minPassRate: 1, maxMedianLatencyRegressionPct: 20, requireStableOutput: true },
  cases: [{ id: 'smoke', argv: ['runner.mjs', 'args', 'smoke'], expected: { exitCode: 0, stdoutSha256: hash(stdout), stderrSha256: hash(''), stdoutJsonlLines: 1 } }]
}))
const tools = createDefinitions({}, { workspaceRoot: root })
assert.deepEqual(tools.map(tool => tool.name), ['dsh_benchmark_inspect', 'dsh_benchmark_run', 'dsh_benchmark_compare'])
const inspected = await tools[0].execute({ manifestPath: 'benchmark.json' })
assert.equal(inspected.cases[0].argvCount, 3)
const result = await tools[1].execute({ manifestPath: 'benchmark.json', artifactDir: 'artifacts' })
assert.equal(result.passed, true)
assert.equal(result.artifact.verifiedByReadBack, true)
const comparison = await tools[2].execute({ manifestPath: 'benchmark.json', baselinePath: result.artifact.path, currentPath: result.artifact.path, artifactDir: 'comparisons' })
assert.equal(comparison.passed, true)
console.log(JSON.stringify({ ok: true, namespacePlugin: true, inject: plugin.inject, tools: tools.map(tool => tool.name), report: result.artifact, comparison: comparison.artifact }))
