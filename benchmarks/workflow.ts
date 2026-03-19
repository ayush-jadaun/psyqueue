import { PsyQueue } from 'psyqueue'
import { sqlite } from '@psyqueue/backend-sqlite'
import { workflows, workflow } from '@psyqueue/plugin-workflows'
import { saga } from '@psyqueue/plugin-saga'

export interface WorkflowResult {
  label: string
  totalMs: number
  stepsProcessed: number
  avgPerStepMs: number
}

/**
 * Benchmark a simple 3-step sequential workflow:
 *   step1 -> step2 -> step3
 */
async function benchmarkSequentialWorkflow(iterations: number): Promise<WorkflowResult> {
  const timings: number[] = []

  for (let iter = 0; iter < iterations; iter++) {
    const q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))

    const wfPlugin = workflows()
    q.use(wfPlugin)

    const wfDef = workflow('sequential-bench')
      .step('step1', async () => ({ value: 1 }))
      .step('step2', async () => ({ value: 2 }), { after: 'step1' })
      .step('step3', async () => ({ value: 3 }), { after: 'step2' })
      .build()

    wfPlugin.engine.registerDefinition(wfDef)
    q.handle('sequential-bench', wfPlugin.engine.createHandler('sequential-bench'))

    await q.start()

    const start = performance.now()

    // Start the workflow
    await q.enqueue('sequential-bench', { iter })

    // Process all 3 steps sequentially
    // Each step completion triggers the next step to be enqueued
    for (let step = 0; step < 3; step++) {
      // Wait briefly for the step to be available
      let processed = false
      for (let attempt = 0; attempt < 10; attempt++) {
        processed = await q.processNext('sequential-bench')
        if (processed) break
      }
    }

    timings.push(performance.now() - start)
    await q.stop()
  }

  const total = timings.reduce((a, b) => a + b, 0) / timings.length
  return {
    label: '3-step sequential',
    totalMs: total,
    stepsProcessed: 3,
    avgPerStepMs: total / 3,
  }
}

/**
 * Benchmark a 5-step parallel workflow (fan-out then fan-in):
 *   step1 ─┬─ step2a ─┬─ step3
 *           ├─ step2b ─┤
 *           └─ step2c ─┘
 *
 * step1 runs first, then step2a/step2b/step2c run in parallel,
 * then step3 runs after all parallel steps complete.
 */
async function benchmarkParallelWorkflow(iterations: number): Promise<WorkflowResult> {
  const timings: number[] = []

  for (let iter = 0; iter < iterations; iter++) {
    const q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))

    const wfPlugin = workflows()
    q.use(wfPlugin)

    const wfDef = workflow('parallel-bench')
      .step('step1', async () => ({ value: 'start' }))
      .step('step2a', async () => ({ value: 'a' }), { after: 'step1' })
      .step('step2b', async () => ({ value: 'b' }), { after: 'step1' })
      .step('step2c', async () => ({ value: 'c' }), { after: 'step1' })
      .step('step3', async () => ({ value: 'done' }), { after: ['step2a', 'step2b', 'step2c'] })
      .build()

    wfPlugin.engine.registerDefinition(wfDef)
    q.handle('parallel-bench', wfPlugin.engine.createHandler('parallel-bench'))

    await q.start()

    const start = performance.now()

    await q.enqueue('parallel-bench', { iter })

    // Process all 5 steps: step1, then 3 parallel, then step3
    for (let step = 0; step < 5; step++) {
      let processed = false
      for (let attempt = 0; attempt < 10; attempt++) {
        processed = await q.processNext('parallel-bench')
        if (processed) break
      }
    }

    timings.push(performance.now() - start)
    await q.stop()
  }

  const total = timings.reduce((a, b) => a + b, 0) / timings.length
  return {
    label: '5-step fan-out/fan-in',
    totalMs: total,
    stepsProcessed: 5,
    avgPerStepMs: total / 5,
  }
}

/**
 * Benchmark a workflow with saga compensation:
 *   step1 -> step2 -> step3 (step3 fails, triggers compensation)
 */
async function benchmarkSagaWorkflow(iterations: number): Promise<WorkflowResult> {
  const timings: number[] = []

  for (let iter = 0; iter < iterations; iter++) {
    const q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))

    const wfPlugin = workflows()
    q.use(wfPlugin)
    q.use(saga())

    const compensated: string[] = []

    const wfDef = workflow('saga-bench')
      .step('step1', async () => ({ value: 'done1' }), {
        compensate: async () => { compensated.push('step1'); return {} },
      })
      .step('step2', async () => ({ value: 'done2' }), {
        after: 'step1',
        compensate: async () => { compensated.push('step2'); return {} },
      })
      .step('step3', async () => {
        throw new Error('Intentional failure for saga benchmark')
      }, { after: 'step2' })
      .build()

    wfPlugin.engine.registerDefinition(wfDef)
    q.handle('saga-bench', wfPlugin.engine.createHandler('saga-bench'))

    await q.start()

    const start = performance.now()

    await q.enqueue('saga-bench', { iter })

    // Process step1, step2 (succeed), step3 (fails -> dead letter -> saga compensation)
    for (let step = 0; step < 3; step++) {
      for (let attempt = 0; attempt < 10; attempt++) {
        const processed = await q.processNext('saga-bench')
        if (processed) break
      }
    }

    timings.push(performance.now() - start)
    await q.stop()
  }

  const total = timings.reduce((a, b) => a + b, 0) / timings.length
  return {
    label: 'Saga compensation (3-step, failure on step3)',
    totalMs: total,
    stepsProcessed: 3,
    avgPerStepMs: total / 3,
  }
}

export interface WorkflowResults {
  sequential: WorkflowResult
  parallel: WorkflowResult
  saga: WorkflowResult
}

export async function runWorkflowBenchmarks(iterations = 10): Promise<WorkflowResults> {
  const sequential = await benchmarkSequentialWorkflow(iterations)
  const parallel = await benchmarkParallelWorkflow(iterations)
  const sagaResult = await benchmarkSagaWorkflow(iterations)

  return {
    sequential,
    parallel,
    saga: sagaResult,
  }
}

export function formatWorkflowResults(r: WorkflowResults): string {
  const fmt = (v: number) => v.toFixed(1)
  const lines: string[] = []

  for (const wf of [r.sequential, r.parallel, r.saga]) {
    lines.push(`  ${wf.label}:`)
    lines.push(`    Total: ${fmt(wf.totalMs)}ms  Steps: ${wf.stepsProcessed}  Avg/step: ${fmt(wf.avgPerStepMs)}ms`)
  }

  return lines.join('\n')
}

// Run standalone
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  console.log('=== Workflow Benchmarks ===\n')
  const results = await runWorkflowBenchmarks()
  console.log(formatWorkflowResults(results))
}
