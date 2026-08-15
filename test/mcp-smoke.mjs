import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'

const hash = value => createHash('sha256').update(value).digest('hex')
const manifestJson = JSON.stringify({
  schemaVersion: 1,
  suite: { name: 'mcp-smoke', revision: 'cases-v1' },
  target: { name: 'fixture', revision: 'source-v1', files: ['runner.mjs'] },
  runner: { executable: 'node', cwd: '.', warmup: 0, repeat: 1, timeoutMs: 1000, maxOutputBytes: 4096, concurrency: 1 },
  scorer: { version: 'dsh-benchmark-scorer/1', minPassRate: 1, maxMedianLatencyRegressionPct: 20, requireStableOutput: true },
  cases: [{ id: 'smoke', argv: ['runner.mjs', 'args', 'smoke'], expected: { exitCode: 0, stdoutSha256: hash('{"args":["smoke"]}\n') } }]
})
const report = {
  schemaVersion: 1,
  kind: 'dsh.benchmark-report',
  suite: { name: 'mcp-smoke', revision: 'cases-v1' },
  target: { name: 'fixture', revision: 'source-v1', fingerprint: hash('fixture') },
  cases: [{ id: 'smoke', summary: { passRate: 1, medianLatencyNs: 10, stableOutput: true }, passed: true }],
  passed: true
}
const reportJson = `${JSON.stringify(report, null, 2)}\n`
const forbiddenJson = JSON.stringify({ ...report, apiToken: 'do-not-echo' })

const child = spawn(process.execPath, ['mcp-server.mjs'], { cwd: process.cwd(), shell: false, stdio: ['pipe', 'pipe', 'inherit'] })
let output = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', chunk => { output += chunk })
const request = value => child.stdin.write(`${JSON.stringify(value)}\n`)
request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
request({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
request({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'benchmark_manifest_lint', arguments: { manifestJson } } })
request({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'benchmark_report_address', arguments: { reportJson } } })
request({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'benchmark_report_address', arguments: { reportJson: forbiddenJson } } })
child.stdin.end()
await new Promise((resolve, reject) => {
  child.on('exit', code => code === 0 ? resolve() : reject(new Error(`MCP exited ${code}`)))
  child.on('error', reject)
})
const messages = output.trim().split(/\r?\n/).map(JSON.parse)
assert.equal(messages[0].result.serverInfo.version, '0.2.0')
assert.deepEqual(messages[1].result.tools.map(({ name }) => name), ['benchmark_manifest_lint', 'benchmark_report_address'])
assert.equal(messages[2].result.structuredContent.cases[0].argvCount, 3)
assert.equal('argv' in messages[2].result.structuredContent.cases[0], false)
assert.equal(messages[3].result.structuredContent.reportSha256, hash(reportJson))
assert.equal(messages[3].result.structuredContent.verifiedByRecomputation, true)
assert.match(messages[4].error.message, /forbidden raw or secret-bearing field/)
assert.doesNotMatch(output, /do-not-echo/)
process.stdout.write(`${JSON.stringify({ ok: true, tools: messages[1].result.tools.map(({ name }) => name), proofOnly: true, secretFieldRejected: true })}\n`)
