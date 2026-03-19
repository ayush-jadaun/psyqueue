import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Registry } from 'prom-client'
import { metrics } from '../src/index.js'
import { PsyQueue } from '@psyqueue/core'
import { sqlite } from '../../backend-sqlite/src/index.js'

function makeQueue(registry: Registry): PsyQueue {
  const q = new PsyQueue()
  q.use(sqlite({ path: ':memory:' }))
  q.use(metrics({ registry }))
  return q
}

async function getMetricValue(
  registry: Registry,
  metricName: string,
  labels: Record<string, string>,
): Promise<number> {
  const metrics = await registry.getMetricsAsJSON()
  const metric = metrics.find((m) => m.name === metricName)
  if (!metric) return 0

  for (const val of (metric as { values: Array<{ labels: Record<string, string>; value: number }> }).values) {
    const matches = Object.entries(labels).every(([k, v]) => val.labels[k] === v)
    if (matches) return val.value
  }
  return 0
}

describe('metrics plugin', () => {
  let registry: Registry
  let q: PsyQueue

  beforeEach(() => {
    registry = new Registry()
  })

  afterEach(async () => {
    await q.stop()
  })

  it('increments enqueued counter on enqueue', async () => {
    q = makeQueue(registry)
    q.handle('sendEmail', async () => 'ok')
    await q.start()

    await q.enqueue('sendEmail', {})
    await q.enqueue('sendEmail', {})

    const value = await getMetricValue(registry, 'psyqueue_jobs_enqueued_total', {
      queue: 'sendEmail',
      name: 'sendEmail',
    })
    expect(value).toBe(2)
  })

  it('increments completed counter on job completion', async () => {
    q = makeQueue(registry)
    q.handle('sendEmail', async () => 'ok')
    await q.start()

    await q.enqueue('sendEmail', {})
    await q.processNext('sendEmail')

    const value = await getMetricValue(registry, 'psyqueue_jobs_completed_total', {
      queue: 'sendEmail',
      name: 'sendEmail',
    })
    expect(value).toBe(1)
  })

  it('increments failed counter on job failure', async () => {
    q = makeQueue(registry)
    q.handle('badJob', async () => {
      throw new Error('intentional failure')
    })
    await q.start()

    await q.enqueue('badJob', {}, { maxRetries: 0 })
    await q.processNext('badJob')

    const value = await getMetricValue(registry, 'psyqueue_jobs_failed_total', {
      queue: 'badJob',
      name: 'badJob',
    })
    expect(value).toBe(1)
  })

  it('records job duration in histogram on completion', async () => {
    q = makeQueue(registry)
    q.handle('timedJob', async () => {
      await new Promise(r => setTimeout(r, 10))
      return 'done'
    })
    await q.start()

    await q.enqueue('timedJob', {})
    await q.processNext('timedJob')

    const allMetrics = await registry.getMetricsAsJSON()
    const histMetric = allMetrics.find(m => m.name === 'psyqueue_job_duration_ms')
    expect(histMetric).toBeDefined()

    // Sum should be > 0 (some time elapsed)
    const sumEntry = (histMetric as { values: Array<{ labels: Record<string, string>; value: number; metricName: string }> })
      .values.find(v => v.metricName === 'psyqueue_job_duration_ms_sum' && v.labels['queue'] === 'timedJob')
    expect(sumEntry).toBeDefined()
    expect(sumEntry!.value).toBeGreaterThan(0)
  })

  it('labels include queue and job name', async () => {
    q = makeQueue(registry)
    q.handle('myTask', async () => 'ok')
    await q.start()

    await q.enqueue('myTask', {}, { queue: 'custom-queue' })
    await q.processNext('custom-queue')

    const enqueued = await getMetricValue(registry, 'psyqueue_jobs_enqueued_total', {
      queue: 'custom-queue',
      name: 'myTask',
    })
    expect(enqueued).toBe(1)

    const completed = await getMetricValue(registry, 'psyqueue_jobs_completed_total', {
      queue: 'custom-queue',
      name: 'myTask',
    })
    expect(completed).toBe(1)
  })

  it('custom prefix works', async () => {
    const customRegistry = new Registry()
    const customQ = new PsyQueue()
    customQ.use(sqlite({ path: ':memory:' }))
    customQ.use(metrics({ prefix: 'myapp', registry: customRegistry }))
    customQ.handle('job', async () => 'ok')
    await customQ.start()

    await customQ.enqueue('job', {})

    const value = await getMetricValue(customRegistry, 'myapp_jobs_enqueued_total', {
      queue: 'job',
      name: 'job',
    })
    expect(value).toBe(1)

    // Standard prefix should NOT be in this registry
    const allMetrics = await customRegistry.getMetricsAsJSON()
    const hasPsyqueue = allMetrics.some(m => m.name.startsWith('psyqueue_'))
    expect(hasPsyqueue).toBe(false)

    await customQ.stop()

    // Dummy q so afterEach works
    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))
    q.use(metrics({ registry }))
    await q.start()
  })

  it('queue depth gauge increments on enqueue and decrements on complete', async () => {
    q = makeQueue(registry)
    q.handle('task', async () => 'ok')
    await q.start()

    await q.enqueue('task', {})
    await q.enqueue('task', {})

    const depthAfterEnqueue = await getMetricValue(registry, 'psyqueue_queue_depth', {
      queue: 'task',
    })
    expect(depthAfterEnqueue).toBe(2)

    await q.processNext('task')

    const depthAfterProcess = await getMetricValue(registry, 'psyqueue_queue_depth', {
      queue: 'task',
    })
    expect(depthAfterProcess).toBe(1)
  })
})
