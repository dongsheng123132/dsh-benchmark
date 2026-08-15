import { defineTool } from '@deepseek-ai/dsh-tools'
import { compareBenchmarkReports, inspectBenchmarkManifest, runBenchmark } from './lib/benchmark.mjs'

export const name = 'dsh-benchmark'
export const inject = ['tools']

function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function base(config, args) {
  return { workspaceRoot: config.workspaceRoot ?? process.cwd(), artifactDir: args.artifactDir }
}

export function createDefinitions(_ctx, config = {}) {
  return [
    defineTool({
      name: 'dsh_benchmark_inspect',
      description: 'Inspect a benchmark manifest without executing it. Returns suite, target revision, case IDs, bounded runner policy, scorer rules and manifest SHA-256; command arguments are represented only by hashes.',
      parameters: { manifestPath: { type: 'string', required: true, description: 'Benchmark manifest path relative to workspaceRoot.' } },
      output: { schema: { type: 'json' }, render: renderJson },
      execute(args) { return inspectBenchmarkManifest({ ...base(config, args), manifestPath: args.manifestPath }) }
    }),
    defineTool({
      name: 'dsh_benchmark_run',
      description: 'Run fixed benchmark cases with shell disabled, constrained cwd, sanitized environment, bounded timeout/output/concurrency, warmups and repeats. Writes a content-addressed report and verifies it by read-back.',
      parameters: {
        manifestPath: { type: 'string', required: true, description: 'Benchmark manifest path relative to workspaceRoot.' },
        artifactDir: { type: 'string', required: true, description: 'Only directory that may be written, relative to workspaceRoot.' }
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute(args) { return runBenchmark({ ...base(config, args), manifestPath: args.manifestPath }) }
    }),
    defineTool({
      name: 'dsh_benchmark_compare',
      description: 'Compare a current content-addressed benchmark report with a baseline using the scorer thresholds from the explicit manifest. Writes and read-back verifies a content-addressed comparison artifact.',
      parameters: {
        manifestPath: { type: 'string', required: true, description: 'Benchmark manifest containing scorer rules.' },
        baselinePath: { type: 'string', required: true, description: 'Baseline report relative to workspaceRoot.' },
        currentPath: { type: 'string', required: true, description: 'Current report relative to workspaceRoot.' },
        artifactDir: { type: 'string', required: true, description: 'Only directory that may be written, relative to workspaceRoot.' }
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute(args) { return compareBenchmarkReports({ ...base(config, args), manifestPath: args.manifestPath, baselinePath: args.baselinePath, currentPath: args.currentPath }) }
    })
  ]
}

export function apply(ctx, config = {}) {
  for (const definition of createDefinitions(ctx, config)) ctx.tools.register(definition)
}
