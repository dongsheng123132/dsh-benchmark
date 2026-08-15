import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const checkout = process.env.DSH_CHECKOUT
if (!checkout) throw new Error('DSH_CHECKOUT must point to a built DeepSeek Harness checkout')
const pluginEntry = process.env.PLUGIN_ENTRY
const plugin = pluginEntry ? await import(pathToFileURL(resolve(pluginEntry)).href) : await import('../index.js')
const importBuilt = relative => import(pathToFileURL(resolve(checkout, relative)).href)
const { Context } = await importBuilt('vendor/cordis/lib/index.js')
const { default: SystemPrompt } = await importBuilt('packages/core/system-prompt/lib/index.js')
const { default: ToolRuntime } = await importBuilt('packages/core/tools/lib/index.js')
const { TokenMeter } = await importBuilt('packages/llm/token-meter/lib/index.js')

const hash = value => createHash('sha256').update(value).digest('hex')
const root = await mkdtemp(join(tmpdir(), 'dsh-benchmark-runtime-'))
await copyFile(new URL('fixture-runner.mjs', import.meta.url), join(root, 'runner.mjs'))
await writeFile(join(root, 'benchmark.json'), JSON.stringify({
  schemaVersion: 1,
  suite: { name: 'runtime-smoke', revision: 'cases-v1' },
  target: { name: 'fixture', revision: 'source-v1', files: ['runner.mjs'] },
  runner: { executable: 'node', cwd: '.', warmup: 0, repeat: 1, timeoutMs: 1000, maxOutputBytes: 4096, concurrency: 1 },
  scorer: { version: 'dsh-benchmark-scorer/1', minPassRate: 1, maxMedianLatencyRegressionPct: 20, requireStableOutput: true },
  cases: [{ id: 'smoke', argv: ['runner.mjs', 'args', 'runtime'], expected: { exitCode: 0, stdoutSha256: hash('{"args":["runtime"]}\n'), stderrSha256: hash(''), stdoutJsonlLines: 1 } }]
}))

const ctx = new Context()
try {
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(plugin, { workspaceRoot: root })
  const tools = ctx.get('tools')
  const names = tools.schemas().filter(({ name }) => name.startsWith('dsh_benchmark_')).map(({ name }) => name)
  assert.deepEqual(names, ['dsh_benchmark_inspect', 'dsh_benchmark_run', 'dsh_benchmark_compare'])
  const run = await tools.execute({ signal: new AbortController().signal, callId: 'benchmark-run', name: 'dsh_benchmark_run', arguments: { manifestPath: 'benchmark.json', artifactDir: 'reports' } }, {})
  assert.equal(run.isError, false)
  assert.equal(run.value.passed, true)
  assert.equal(run.value.artifact.verifiedByReadBack, true)
  const compare = await tools.execute({ signal: new AbortController().signal, callId: 'benchmark-compare', name: 'dsh_benchmark_compare', arguments: { manifestPath: 'benchmark.json', baselinePath: run.value.artifact.path, currentPath: run.value.artifact.path, artifactDir: 'comparisons' } }, {})
  assert.equal(compare.isError, false)
  assert.equal(compare.value.passed, true)
  assert.equal(compare.value.artifact.verifiedByReadBack, true)
  process.stdout.write(`${JSON.stringify({ ok: true, dshTools: names, report: run.value.artifact, comparison: compare.value.artifact })}\n`)
} finally {
  await ctx.fiber.dispose()
}
