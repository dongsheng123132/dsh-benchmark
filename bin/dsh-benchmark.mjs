#!/usr/bin/env node
import { compareBenchmarkReports, inspectBenchmarkManifest, runBenchmark } from '../lib/benchmark.mjs'

function usage() {
  return 'Usage: dsh-benchmark <inspect|run|compare> --root <dir> --manifest <relative.json> [--artifact-dir <dir>] [--baseline <report>] [--current <report>]'
}

function parse(argv) {
  const command = argv.shift()
  const allowed = new Set(['--root', '--manifest', '--artifact-dir', '--baseline', '--current'])
  const values = {}
  while (argv.length) {
    const flag = argv.shift()
    if (!allowed.has(flag) || argv.length === 0) throw new Error(usage())
    values[flag.slice(2)] = argv.shift()
  }
  if (!['inspect', 'run', 'compare'].includes(command) || !values.root || !values.manifest) throw new Error(usage())
  if (command !== 'inspect' && !values['artifact-dir']) throw new Error(usage())
  if (command === 'compare' && (!values.baseline || !values.current)) throw new Error(usage())
  return {
    command,
    workspaceRoot: values.root,
    manifestPath: values.manifest,
    artifactDir: values['artifact-dir'],
    baselinePath: values.baseline,
    currentPath: values.current
  }
}

try {
  const options = parse(process.argv.slice(2))
  const result = options.command === 'inspect'
    ? await inspectBenchmarkManifest(options)
    : options.command === 'run'
      ? await runBenchmark(options)
      : await compareBenchmarkReports(options)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (options.command !== 'inspect' && !result.passed) process.exitCode = 2
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'unknown error' })}\n`)
  process.exitCode = 1
}
