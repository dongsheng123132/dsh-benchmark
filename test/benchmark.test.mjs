import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { compareBenchmarkReports, inspectBenchmarkManifest, normalizeManifest, runBenchmark } from '../lib/benchmark.mjs'

const emptyHash = hash('')

function hash(value) {
  return createHash('sha256').update(value).digest('hex')
}

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`
}

function manifestFor(cases, overrides = {}) {
  return {
    schemaVersion: 1,
    suite: { name: 'fixture-suite', revision: 'cases-v1' },
    target: { name: 'fixture-runner', revision: 'source-v1', files: ['runner.mjs'] },
    runner: { executable: 'node', cwd: '.', warmup: 1, repeat: 2, timeoutMs: 1000, maxOutputBytes: 4096, concurrency: 2 },
    scorer: { version: 'dsh-benchmark-scorer/1', minPassRate: 1, maxMedianLatencyRegressionPct: 20, requireStableOutput: true },
    cases,
    ...overrides
  }
}

async function workspace(manifest) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-benchmark-'))
  await copyFile(new URL('fixture-runner.mjs', import.meta.url), join(root, 'runner.mjs'))
  await writeFile(join(root, 'benchmark.json'), JSON.stringify(manifest, null, 2))
  return root
}

test('runs fixed JSONL cases and writes read-back verified raw evidence', async () => {
  const stdout = jsonLine({ doubled: 4 }) + jsonLine({ doubled: 10 })
  const manifest = manifestFor([{ id: 'jsonl', argv: ['runner.mjs', 'jsonl'], stdinJsonl: [{ number: 2 }, { number: 5 }], expected: { exitCode: 0, stdoutSha256: hash(stdout), stderrSha256: emptyHash, stdoutJsonlLines: 2 } }])
  const root = await workspace(manifest)
  const inspected = await inspectBenchmarkManifest({ workspaceRoot: root, manifestPath: 'benchmark.json' })
  assert.equal(inspected.cases[0].argvCount, 2)
  assert.equal('argv' in inspected.cases[0], false)
  assert.equal(inspected.target.fingerprint.length, 64)

  const result = await runBenchmark({ workspaceRoot: root, manifestPath: 'benchmark.json', artifactDir: 'artifacts' })
  assert.equal(result.passed, true)
  assert.equal(result.artifact.verifiedByReadBack, true)
  assert.equal(result.report.cases[0].runs.length, 3)
  assert.deepEqual(result.report.cases[0].runs.map(run => run.phase), ['warmup', 'measure', 'measure'])
  assert.equal(result.report.cases[0].runs.every(run => run.score.passed), true)
  assert.equal(hash(await readFile(join(root, result.artifact.path))), result.artifact.sha256)
})

test('does not invoke a shell and does not inherit secret environment variables', async () => {
  const literal = 'value;echo PWNED > marker.txt'
  const argsOutput = jsonLine({ args: [literal] })
  const envOutput = jsonLine({ inherited: false })
  const manifest = manifestFor([
    { id: 'literal-argv', argv: ['runner.mjs', 'args', literal], expected: { exitCode: 0, stdoutSha256: hash(argsOutput), stderrSha256: emptyHash, stdoutJsonlLines: 1 } },
    { id: 'clean-env', argv: ['runner.mjs', 'env'], expected: { exitCode: 0, stdoutSha256: hash(envOutput), stderrSha256: emptyHash, stdoutJsonlLines: 1 } }
  ])
  const root = await workspace(manifest)
  process.env.DSH_BENCH_SECRET = 'never-report-this-value'
  try {
    const result = await runBenchmark({ workspaceRoot: root, manifestPath: 'benchmark.json', artifactDir: 'artifacts' })
    assert.equal(result.passed, true)
    await assert.rejects(readFile(join(root, 'marker.txt')), /ENOENT/)
    const reportText = await readFile(join(root, result.artifact.path), 'utf8')
    assert.equal(reportText.includes(literal), false)
    assert.equal(reportText.includes('never-report-this-value'), false)
  } finally {
    delete process.env.DSH_BENCH_SECRET
  }
})

test('records deterministic timeout and output-limit failures without raw output', async () => {
  const manifest = manifestFor([
    { id: 'timeout', argv: ['runner.mjs', 'sleep', '500'], expected: { exitCode: 0, stdoutSha256: emptyHash } },
    { id: 'output-limit', argv: ['runner.mjs', 'spam', '10000'], expected: { exitCode: 0, stdoutSha256: hash('x'.repeat(10000)) } }
  ])
  manifest.runner.warmup = 0
  manifest.runner.repeat = 1
  manifest.runner.timeoutMs = 100
  manifest.runner.maxOutputBytes = 128
  const root = await workspace(manifest)
  const result = await runBenchmark({ workspaceRoot: root, manifestPath: 'benchmark.json', artifactDir: 'artifacts' })
  assert.equal(result.passed, false)
  assert.equal(result.report.cases[0].runs[0].timedOut, true)
  assert.equal(result.report.cases[1].runs[0].outputLimited, true)
  assert.equal(JSON.stringify(result.report).includes('xxxxx'), false)
})

test('compares baseline and current reports using manifest thresholds', async () => {
  const stdout = jsonLine({ args: ['ok'] })
  const manifest = manifestFor([{ id: 'case', argv: ['runner.mjs', 'args', 'ok'], expected: { exitCode: 0, stdoutSha256: hash(stdout), stderrSha256: emptyHash, stdoutJsonlLines: 1 } }])
  manifest.runner.warmup = 0
  manifest.runner.repeat = 1
  const root = await workspace(manifest)
  const baseline = await runBenchmark({ workspaceRoot: root, manifestPath: 'benchmark.json', artifactDir: 'reports' })
  const currentReport = structuredClone(baseline.report)
  currentReport.target.revision = 'source-v2'
  currentReport.cases[0].summary.medianLatencyNs = Math.ceil(baseline.report.cases[0].summary.medianLatencyNs * 1.5)
  await writeFile(join(root, 'current.json'), `${JSON.stringify(currentReport, null, 2)}\n`)
  const comparison = await compareBenchmarkReports({ workspaceRoot: root, manifestPath: 'benchmark.json', baselinePath: baseline.artifact.path, currentPath: 'current.json', artifactDir: 'comparisons' })
  assert.equal(comparison.passed, false)
  assert.equal(comparison.comparison.cases[0].checks.latency, false)
  assert.equal(comparison.artifact.verifiedByReadBack, true)
})

test('rejects secret-bearing fields, path escapes and artifact symlinks', async () => {
  const validCase = { id: 'case', argv: ['runner.mjs', 'exit', '0'], expected: { exitCode: 0, stdoutSha256: emptyHash } }
  const withSecret = manifestFor([validCase])
  withSecret.runner.env = { API_TOKEN: 'secret' }
  assert.throws(() => normalizeManifest(withSecret), /forbidden secret-bearing field/)

  const root = await workspace(manifestFor([validCase]))
  await assert.rejects(runBenchmark({ workspaceRoot: root, manifestPath: '../benchmark.json', artifactDir: 'artifacts' }), /must not escape/)
  await assert.rejects(runBenchmark({ workspaceRoot: root, manifestPath: 'benchmark.json', artifactDir: '../artifacts' }), /must not escape/)

  const outside = await mkdtemp(join(tmpdir(), 'dsh-benchmark-outside-'))
  await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(runBenchmark({ workspaceRoot: root, manifestPath: 'benchmark.json', artifactDir: 'linked/new' }), /symlink/)
})
