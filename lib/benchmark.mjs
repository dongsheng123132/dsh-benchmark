import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { arch, platform, release } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

const MANIFEST_LIMIT = 1024 * 1024
const REPORT_LIMIT = 64 * 1024 * 1024
const SCORER_VERSION = 'dsh-benchmark-scorer/1'
const DEFAULTS = Object.freeze({ warmup: 1, repeat: 5, timeoutMs: 30_000, maxOutputBytes: 1024 * 1024, concurrency: 1 })
const SENSITIVE_KEY = /(secret|token|password|authorization|cookie|api[-_]?key|credential)/i
const EXECUTABLE_HASHES = new Map()

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableJson(value[key])]))
  return value
}

function jsonBytes(value) {
  return `${JSON.stringify(stableJson(value), null, 2)}\n`
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
}

function assertString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string`)
  return value
}

function assertIdentifier(value, label) {
  assertString(value, label)
  if (!/^[A-Za-z0-9][A-Za-z0-9._@/+:-]{0,127}$/.test(value)) throw new Error(`${label} must be a public identifier of at most 128 safe characters`)
  return value
}

function boundedInteger(value, fallback, min, max, label) {
  const selected = value ?? fallback
  if (!Number.isSafeInteger(selected) || selected < min || selected > max) throw new Error(`${label} must be an integer from ${min} to ${max}`)
  return selected
}

function boundedNumber(value, fallback, min, max, label) {
  const selected = value ?? fallback
  if (typeof selected !== 'number' || !Number.isFinite(selected) || selected < min || selected > max) throw new Error(`${label} must be a number from ${min} to ${max}`)
  return selected
}

function relativePath(value, label) {
  assertString(value, label)
  if (isAbsolute(value)) throw new Error(`${label} must be relative to workspaceRoot`)
  return value
}

function inside(root, target) {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

async function rootPath(value) {
  return realpath(resolve(value ?? process.cwd()))
}

async function safeExistingPath(root, value, label, kind = 'file') {
  const candidate = resolve(root, relativePath(value, label))
  if (!inside(root, candidate)) throw new Error(`${label} must not escape workspaceRoot`)
  const actual = await realpath(candidate)
  if (!inside(root, actual)) throw new Error(`${label} resolves outside workspaceRoot`)
  const stat = await lstat(actual)
  if (stat.isSymbolicLink() || (kind === 'file' && !stat.isFile()) || (kind === 'directory' && !stat.isDirectory())) throw new Error(`${label} must resolve to a regular ${kind}`)
  return actual
}

function checkUnknownSensitiveFields(value, label = 'manifest') {
  if (Array.isArray(value)) return value.forEach((item, index) => checkUnknownSensitiveFields(item, `${label}[${index}]`))
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) throw new Error(`${label}.${key} is a forbidden secret-bearing field`)
    checkUnknownSensitiveFields(child, `${label}.${key}`)
  }
}

function normalizeExpected(value, label) {
  assertObject(value, label)
  const normalized = { exitCode: boundedInteger(value.exitCode, 0, 0, 255, `${label}.exitCode`) }
  for (const key of ['stdoutSha256', 'stderrSha256']) {
    if (value[key] !== undefined) {
      if (!/^[a-f0-9]{64}$/.test(value[key])) throw new Error(`${label}.${key} must be 64 lowercase hex characters`)
      normalized[key] = value[key]
    }
  }
  if (value.stdoutJsonlLines !== undefined) normalized.stdoutJsonlLines = boundedInteger(value.stdoutJsonlLines, 0, 0, 1_000_000, `${label}.stdoutJsonlLines`)
  if (Object.keys(normalized).length === 1) throw new Error(`${label} must include at least one deterministic output expectation`)
  return normalized
}

function normalizeManifest(raw) {
  assertObject(raw, 'manifest')
  checkUnknownSensitiveFields(raw)
  if (raw.schemaVersion !== 1) throw new Error('manifest.schemaVersion must be 1')
  assertObject(raw.suite, 'manifest.suite')
  const suite = { name: assertIdentifier(raw.suite.name, 'manifest.suite.name'), revision: assertIdentifier(raw.suite.revision, 'manifest.suite.revision') }
  assertObject(raw.target, 'manifest.target')
  if (!Array.isArray(raw.target.files) || raw.target.files.length === 0) throw new Error('manifest.target.files must be a non-empty array')
  const target = {
    name: assertIdentifier(raw.target.name, 'manifest.target.name'),
    revision: assertIdentifier(raw.target.revision, 'manifest.target.revision'),
    files: raw.target.files.map((file, index) => relativePath(file, `manifest.target.files[${index}]`))
  }
  assertObject(raw.runner, 'manifest.runner')
  const runner = {
    executable: assertString(raw.runner.executable, 'manifest.runner.executable'),
    cwd: relativePath(raw.runner.cwd ?? '.', 'manifest.runner.cwd'),
    warmup: boundedInteger(raw.runner.warmup, DEFAULTS.warmup, 0, 20, 'manifest.runner.warmup'),
    repeat: boundedInteger(raw.runner.repeat, DEFAULTS.repeat, 1, 100, 'manifest.runner.repeat'),
    timeoutMs: boundedInteger(raw.runner.timeoutMs, DEFAULTS.timeoutMs, 100, 300_000, 'manifest.runner.timeoutMs'),
    maxOutputBytes: boundedInteger(raw.runner.maxOutputBytes, DEFAULTS.maxOutputBytes, 1, 16 * 1024 * 1024, 'manifest.runner.maxOutputBytes'),
    concurrency: boundedInteger(raw.runner.concurrency, DEFAULTS.concurrency, 1, 8, 'manifest.runner.concurrency')
  }
  assertObject(raw.scorer, 'manifest.scorer')
  if (raw.scorer.version !== SCORER_VERSION) throw new Error(`manifest.scorer.version must be ${SCORER_VERSION}`)
  const scorer = {
    version: SCORER_VERSION,
    minPassRate: boundedNumber(raw.scorer.minPassRate, 1, 0, 1, 'manifest.scorer.minPassRate'),
    maxMedianLatencyRegressionPct: boundedNumber(raw.scorer.maxMedianLatencyRegressionPct, 20, 0, 1000, 'manifest.scorer.maxMedianLatencyRegressionPct'),
    requireStableOutput: raw.scorer.requireStableOutput ?? true
  }
  if (typeof scorer.requireStableOutput !== 'boolean') throw new Error('manifest.scorer.requireStableOutput must be boolean')
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) throw new Error('manifest.cases must be a non-empty array')
  const ids = new Set()
  const cases = raw.cases.map((entry, index) => {
    const label = `manifest.cases[${index}]`
    assertObject(entry, label)
    const id = assertIdentifier(entry.id, `${label}.id`)
    if (ids.has(id)) throw new Error(`case id must be unique: ${id}`)
    ids.add(id)
    if (!Array.isArray(entry.argv) || !entry.argv.every(value => typeof value === 'string')) throw new Error(`${label}.argv must be an array of strings`)
    const normalized = { id, argv: [...entry.argv], expected: normalizeExpected(entry.expected, `${label}.expected`) }
    if (entry.stdinJsonl !== undefined) {
      if (!Array.isArray(entry.stdinJsonl)) throw new Error(`${label}.stdinJsonl must be an array`)
      normalized.stdin = `${entry.stdinJsonl.map(item => JSON.stringify(stableJson(item))).join('\n')}\n`
    } else normalized.stdin = ''
    return normalized
  })
  return { schemaVersion: 1, suite, target, runner, scorer, cases }
}

async function readJsonUnderRoot(root, path, label, maxBytes) {
  const actual = await safeExistingPath(root, path, label)
  const bytes = await readFile(actual)
  if (bytes.length > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`)
  let parsed
  try { parsed = JSON.parse(bytes.toString('utf8')) } catch { throw new Error(`${label} must be valid UTF-8 JSON`) }
  return { actual, bytes, parsed }
}

async function readManifest(options) {
  const root = await rootPath(options.workspaceRoot)
  const loaded = await readJsonUnderRoot(root, options.manifestPath, 'manifestPath', MANIFEST_LIMIT)
  return { root, manifest: normalizeManifest(loaded.parsed), manifestSha256: sha256(loaded.bytes) }
}

async function targetEvidence(root, target) {
  const files = []
  for (const path of target.files) {
    const actual = await safeExistingPath(root, path, `target file ${path}`)
    const bytes = await readFile(actual)
    files.push({ path: relative(root, actual).split(sep).join('/'), bytes: bytes.length, sha256: sha256(bytes) })
  }
  return { name: target.name, revision: target.revision, files, fingerprint: sha256(jsonBytes(files)) }
}

async function runnerEvidence(root, runner) {
  const cwd = await safeExistingPath(root, runner.cwd, 'runner.cwd', 'directory')
  let executable
  if (runner.executable === 'node') executable = process.execPath
  else executable = await safeExistingPath(root, runner.executable, 'runner.executable')
  if (!EXECUTABLE_HASHES.has(executable)) EXECUTABLE_HASHES.set(executable, readFile(executable).then(sha256))
  const executableSha256 = await EXECUTABLE_HASHES.get(executable)
  return { cwd, executable, public: { executable: runner.executable, executableSha256, cwd: relative(root, cwd).split(sep).join('/') || '.' } }
}

function casePublic(entry) {
  return {
    id: entry.id,
    argvCount: entry.argv.length,
    argvSha256: sha256(jsonBytes(entry.argv)),
    stdinBytes: Buffer.byteLength(entry.stdin),
    stdinSha256: sha256(entry.stdin),
    expected: entry.expected
  }
}

export async function inspectBenchmarkManifest(options) {
  const { root, manifest, manifestSha256 } = await readManifest(options)
  const target = await targetEvidence(root, manifest.target)
  const runner = await runnerEvidence(root, manifest.runner)
  return {
    schemaVersion: 1,
    manifestSha256,
    suite: manifest.suite,
    target,
    environment: { platform: platform(), arch: arch(), osRelease: release(), node: process.versions.node },
    runner: { ...runner.public, warmup: manifest.runner.warmup, repeat: manifest.runner.repeat, timeoutMs: manifest.runner.timeoutMs, maxOutputBytes: manifest.runner.maxOutputBytes, concurrency: manifest.runner.concurrency },
    scorer: manifest.scorer,
    cases: manifest.cases.map(casePublic)
  }
}

function scoreRun(raw, expected) {
  const checks = { notTimedOut: !raw.timedOut, withinOutputLimit: !raw.outputLimited, exitCode: raw.exitCode === expected.exitCode }
  if (expected.stdoutSha256 !== undefined) checks.stdoutSha256 = raw.stdout.sha256 === expected.stdoutSha256
  if (expected.stderrSha256 !== undefined) checks.stderrSha256 = raw.stderr.sha256 === expected.stderrSha256
  if (expected.stdoutJsonlLines !== undefined) checks.stdoutJsonlLines = raw.stdout.jsonlLines === expected.stdoutJsonlLines && raw.stdout.jsonlValid
  return { checks, passed: Object.values(checks).every(Boolean) }
}

function countJsonl(buffer) {
  if (buffer.length === 0) return { jsonlValid: true, jsonlLines: 0 }
  const lines = buffer.toString('utf8').split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  try {
    for (const line of lines) JSON.parse(line)
    return { jsonlValid: true, jsonlLines: lines.length }
  } catch {
    return { jsonlValid: false, jsonlLines: lines.length }
  }
}

function sanitizedEnv() {
  const env = { CI: '1', NO_COLOR: '1', TZ: 'UTC', LANG: 'C', LC_ALL: 'C' }
  if (process.platform === 'win32') {
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot
    if (process.env.WINDIR) env.WINDIR = process.env.WINDIR
  }
  return env
}

async function executeOnce(runtime, entry, phase, index) {
  const start = process.hrtime.bigint()
  const stdout = []
  const stderr = []
  let stdoutBytes = 0
  let stderrBytes = 0
  let outputLimited = false
  let timedOut = false
  const child = spawn(runtime.executable, entry.argv, {
    cwd: runtime.cwd,
    env: sanitizedEnv(),
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  function collect(target, chunk, which) {
    if (which === 'stdout') stdoutBytes += chunk.length
    else stderrBytes += chunk.length
    if (stdoutBytes + stderrBytes > runtime.maxOutputBytes) {
      outputLimited = true
      child.kill('SIGKILL')
      return
    }
    target.push(chunk)
  }
  child.stdout.on('data', chunk => collect(stdout, chunk, 'stdout'))
  child.stderr.on('data', chunk => collect(stderr, chunk, 'stderr'))
  child.stdin.end(entry.stdin)
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, runtime.timeoutMs)
  const outcome = await new Promise((resolveOutcome, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolveOutcome({ code, signal }))
  }).finally(() => clearTimeout(timer))
  const durationNs = Number(process.hrtime.bigint() - start)
  const stdoutBuffer = Buffer.concat(stdout)
  const stderrBuffer = Buffer.concat(stderr)
  const raw = {
    phase,
    index,
    durationNs,
    exitCode: outcome.code,
    signal: outcome.signal,
    timedOut,
    outputLimited,
    stdout: { bytes: stdoutBytes, capturedBytes: stdoutBuffer.length, sha256: sha256(stdoutBuffer), ...countJsonl(stdoutBuffer) },
    stderr: { bytes: stderrBytes, capturedBytes: stderrBuffer.length, sha256: sha256(stderrBuffer) }
  }
  return { ...raw, score: scoreRun(raw, entry.expected) }
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  async function run() {
    while (true) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await worker(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
  return results
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2)
}

function summarize(entry, runs, scorer) {
  const measured = runs.filter(run => run.phase === 'measure')
  const hashes = measured.map(run => run.stdout.sha256)
  const passRate = measured.filter(run => run.score.passed).length / measured.length
  const summary = {
    passRate,
    passedRuns: measured.filter(run => run.score.passed).length,
    totalRuns: measured.length,
    medianLatencyNs: median(measured.map(run => run.durationNs)),
    minLatencyNs: Math.min(...measured.map(run => run.durationNs)),
    maxLatencyNs: Math.max(...measured.map(run => run.durationNs)),
    stableOutput: new Set(hashes).size === 1
  }
  return { ...summary, passed: passRate >= scorer.minPassRate && (!scorer.requireStableOutput || summary.stableOutput) }
}

async function executeBenchmark(root, manifest, manifestSha256) {
  const target = await targetEvidence(root, manifest.target)
  const runner = await runnerEvidence(root, manifest.runner)
  const tasks = manifest.cases.flatMap(entry => [
    ...Array.from({ length: manifest.runner.warmup }, (_, index) => ({ entry, phase: 'warmup', index })),
    ...Array.from({ length: manifest.runner.repeat }, (_, index) => ({ entry, phase: 'measure', index }))
  ])
  const rawResults = await mapLimit(tasks, manifest.runner.concurrency, task => executeOnce({ ...manifest.runner, ...runner }, task.entry, task.phase, task.index))
  const cases = manifest.cases.map(entry => {
    const runs = tasks.map((task, index) => ({ task, run: rawResults[index] })).filter(value => value.task.entry.id === entry.id).map(value => value.run)
    const summary = summarize(entry, runs, manifest.scorer)
    return { ...casePublic(entry), runs, summary, passed: summary.passed }
  })
  return {
    schemaVersion: 1,
    kind: 'dsh.benchmark-report',
    manifestSha256,
    suite: manifest.suite,
    target,
    environment: { platform: platform(), arch: arch(), osRelease: release(), node: process.versions.node },
    runner: { ...runner.public, warmup: manifest.runner.warmup, repeat: manifest.runner.repeat, timeoutMs: manifest.runner.timeoutMs, maxOutputBytes: manifest.runner.maxOutputBytes, concurrency: manifest.runner.concurrency, environmentPolicy: 'sanitized-v1' },
    scorer: manifest.scorer,
    cases,
    passed: cases.every(entry => entry.passed)
  }
}

async function ensureArtifactDir(root, value) {
  const target = resolve(root, relativePath(value, 'artifactDir'))
  if (!inside(root, target)) throw new Error('artifactDir must not escape workspaceRoot')
  let current = root
  for (const part of relative(root, target).split(sep).filter(Boolean)) {
    const candidate = join(current, part)
    try {
      const stat = await lstat(candidate)
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('artifactDir contains a symlink or non-directory component')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      await mkdir(candidate)
    }
    current = await realpath(candidate)
    if (!inside(root, current)) throw new Error('artifactDir resolves outside workspaceRoot')
  }
  return current
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'benchmark'
}

async function writeArtifact(root, artifactDir, prefix, value) {
  const directory = await ensureArtifactDir(root, artifactDir)
  const content = jsonBytes(value)
  const digest = sha256(content)
  const target = join(directory, basename(`${slug(prefix)}-${digest.slice(0, 12)}.json`))
  try {
    await writeFile(target, content, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    const stat = await lstat(target)
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('existing artifact path is not a regular file')
    if (await readFile(target, 'utf8') !== content) throw new Error('existing content-addressed artifact diverged')
  }
  const readBack = await readFile(target)
  if (sha256(readBack) !== digest) throw new Error('artifact read-back verification failed')
  return { path: relative(root, target).split(sep).join('/'), sha256: digest, bytes: readBack.length, verifiedByReadBack: true }
}

export async function runBenchmark(options) {
  if (options.artifactDir === undefined) throw new Error('artifactDir is required')
  const { root, manifest, manifestSha256 } = await readManifest(options)
  const report = await executeBenchmark(root, manifest, manifestSha256)
  const artifact = await writeArtifact(root, options.artifactDir, `${manifest.suite.name}-${manifest.target.revision}.benchmark`, report)
  return { passed: report.passed, artifact, report }
}

async function readReport(root, path, label) {
  const loaded = await readJsonUnderRoot(root, path, label, REPORT_LIMIT)
  if (loaded.parsed?.kind !== 'dsh.benchmark-report' || loaded.parsed?.schemaVersion !== 1) throw new Error(`${label} is not a dsh.benchmark-report`)
  return { report: loaded.parsed, sha256: sha256(loaded.bytes) }
}

export async function compareBenchmarkReports(options) {
  if (options.artifactDir === undefined) throw new Error('artifactDir is required')
  const { root, manifest, manifestSha256 } = await readManifest(options)
  const baseline = await readReport(root, options.baselinePath, 'baselinePath')
  const current = await readReport(root, options.currentPath, 'currentPath')
  if (baseline.report.suite?.name !== manifest.suite.name || current.report.suite?.name !== manifest.suite.name) throw new Error('report suite does not match manifest')
  const baselineCases = new Map(baseline.report.cases.map(entry => [entry.id, entry]))
  const comparisons = current.report.cases.map(entry => {
    const before = baselineCases.get(entry.id)
    if (!before) return { id: entry.id, passed: false, error: { code: 'BASELINE_CASE_MISSING' } }
    const latencyRegressionPct = before.summary.medianLatencyNs === 0 ? (entry.summary.medianLatencyNs === 0 ? 0 : null) : ((entry.summary.medianLatencyNs - before.summary.medianLatencyNs) / before.summary.medianLatencyNs) * 100
    const checks = {
      passRate: entry.summary.passRate >= manifest.scorer.minPassRate,
      outputStable: !manifest.scorer.requireStableOutput || entry.summary.stableOutput,
      latency: latencyRegressionPct !== null && latencyRegressionPct <= manifest.scorer.maxMedianLatencyRegressionPct
    }
    return {
      id: entry.id,
      baseline: { passRate: before.summary.passRate, medianLatencyNs: before.summary.medianLatencyNs, stableOutput: before.summary.stableOutput },
      current: { passRate: entry.summary.passRate, medianLatencyNs: entry.summary.medianLatencyNs, stableOutput: entry.summary.stableOutput },
      latencyRegressionPct,
      checks,
      passed: Object.values(checks).every(Boolean)
    }
  })
  const reportTarget = report => ({
    name: typeof report.target?.name === 'string' ? report.target.name : null,
    revision: typeof report.target?.revision === 'string' ? report.target.revision : null,
    fingerprint: /^[a-f0-9]{64}$/.test(report.target?.fingerprint ?? '') ? report.target.fingerprint : null
  })
  const comparison = {
    schemaVersion: 1,
    kind: 'dsh.benchmark-comparison',
    manifestSha256,
    scorer: manifest.scorer,
    suite: manifest.suite,
    baseline: { reportSha256: baseline.sha256, target: reportTarget(baseline.report) },
    current: { reportSha256: current.sha256, target: reportTarget(current.report) },
    cases: comparisons,
    passed: comparisons.length === manifest.cases.length && comparisons.every(entry => entry.passed)
  }
  const artifact = await writeArtifact(root, options.artifactDir, `${manifest.suite.name}.comparison`, comparison)
  return { passed: comparison.passed, artifact, comparison }
}

export { normalizeManifest, SCORER_VERSION }
