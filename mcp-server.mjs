#!/usr/bin/env node
import readline from 'node:readline'
import { addressBenchmarkReportJson, inspectBenchmarkManifestJson } from './lib/benchmark.mjs'

const MAX_LINE_BYTES = 8 * 1024 * 1024
const tools = [
  {
    name: 'benchmark_manifest_lint',
    description: 'Validate one bounded inline benchmark manifest and return only identifiers, policies and input hashes. Does not access files or execute a runner.',
    inputSchema: {
      type: 'object', required: ['manifestJson'], additionalProperties: false,
      properties: { manifestJson: { type: 'string', maxLength: 1_048_576 } }
    }
  },
  {
    name: 'benchmark_report_address',
    description: 'Recompute the SHA-256 and a bounded summary of one inline benchmark report while rejecting raw-output and secret-bearing fields. Does not access the filesystem.',
    inputSchema: {
      type: 'object', required: ['reportJson'], additionalProperties: false,
      properties: { reportJson: { type: 'string', maxLength: 2_097_152 } }
    }
  }
]

async function call(name, args) {
  if (name === 'benchmark_manifest_lint') return inspectBenchmarkManifestJson(args.manifestJson)
  if (name === 'benchmark_report_address') return addressBenchmarkReportJson(args.reportJson)
  throw new Error('Unknown tool')
}

const send = value => process.stdout.write(`${JSON.stringify(value)}\n`)
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of lines) {
  if (!line.trim() || Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) continue
  let request
  try { request = JSON.parse(line) } catch { continue }
  if (request.id === undefined) continue
  try {
    if (request.method === 'initialize') {
      send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: request.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'dsh-benchmark', version: '0.2.0' } } })
    } else if (request.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: request.id, result: { tools } })
    } else if (request.method === 'tools/call') {
      const result = await call(request.params?.name, request.params?.arguments ?? {})
      send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } })
    } else {
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } })
    }
  } catch (error) {
    send({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: error.message, data: { code: 'INVALID_EVIDENCE' } } })
  }
}
