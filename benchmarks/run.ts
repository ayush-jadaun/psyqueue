import { runThroughputBenchmarks, formatThroughputResults } from './throughput.js'
import { runLatencyBenchmarks, formatLatencyResults } from './latency.js'
import { runWorkflowBenchmarks, formatWorkflowResults } from './workflow.js'
import { runComparisonBenchmarks, formatComparisonResults } from './comparison.js'

const W = 56 // box width (inner)

function boxTop(): string {
  return '\u2554' + '\u2550'.repeat(W) + '\u2557'
}

function boxMid(): string {
  return '\u2560' + '\u2550'.repeat(W) + '\u2563'
}

function boxBot(): string {
  return '\u255A' + '\u2550'.repeat(W) + '\u255D'
}

function boxLine(text: string): string {
  const padded = text.length > W ? text.slice(0, W) : text + ' '.repeat(W - text.length)
  return '\u2551' + padded + '\u2551'
}

function boxSection(title: string, content: string): string {
  const lines: string[] = []
  lines.push(boxMid())
  lines.push(boxLine(` ${title}`))
  lines.push(boxLine(''))
  for (const line of content.split('\n')) {
    lines.push(boxLine(line))
  }
  return lines.join('\n')
}

async function main() {
  console.log('')
  console.log(boxTop())
  console.log(boxLine('              PsyQueue Benchmarks'))
  console.log(boxLine(''))
  console.log(boxLine(` Node ${process.version} | ${process.platform} ${process.arch}`))
  console.log(boxLine(` Date: ${new Date().toISOString().split('T')[0]}`))

  // --- Throughput ---
  console.log('')
  console.log(' Running throughput benchmarks...')
  const throughputResults = await runThroughputBenchmarks()
  const throughputFormatted = formatThroughputResults(throughputResults)

  // Find the 10K result for the summary
  const tenK = throughputResults.find(r => r.count === 10000)
  let throughputSummary = throughputFormatted
  if (tenK) {
    throughputSummary =
      `  Peak (10K jobs):` +
      `\n    Enqueue:  ${tenK.enqueueOpsPerSec.toLocaleString()} jobs/sec` +
      `\n    Process:  ${tenK.processOpsPerSec.toLocaleString()} jobs/sec` +
      `\n    E2E:      ${tenK.e2eOpsPerSec.toLocaleString()} jobs/sec` +
      `\n` +
      `\n  All scales:` +
      `\n${throughputFormatted}`
  }

  // --- Latency ---
  console.log(' Running latency benchmarks...')
  const latencyResults = await runLatencyBenchmarks(1000)
  const latencyFormatted = formatLatencyResults(latencyResults)

  // --- Workflow ---
  console.log(' Running workflow benchmarks...')
  const workflowResults = await runWorkflowBenchmarks(10)
  const workflowFormatted = formatWorkflowResults(workflowResults)

  // --- Comparison ---
  console.log(' Running comparison benchmarks...')
  const comparisonResults = await runComparisonBenchmarks(1000)
  const comparisonFormatted = formatComparisonResults(comparisonResults)

  // --- Output report ---
  console.log('')
  console.log(boxTop())
  console.log(boxLine('              PsyQueue Benchmarks'))
  console.log(boxLine(''))
  console.log(boxLine(` Node ${process.version} | ${process.platform} ${process.arch}`))
  console.log(boxLine(` Date: ${new Date().toISOString().split('T')[0]}`))

  console.log(boxSection('Throughput (SQLite :memory:)', throughputSummary))
  console.log(boxSection('Latency (1K samples)', latencyFormatted))
  console.log(boxSection('Workflow Execution', workflowFormatted))
  console.log(boxSection('Comparison', comparisonFormatted))

  console.log(boxBot())
  console.log('')
}

main().then(() => {
  process.exit(0)
}).catch((err) => {
  console.error('Benchmark failed:', err)
  process.exit(1)
})
