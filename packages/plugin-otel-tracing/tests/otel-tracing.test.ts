import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import { otelTracing } from '../src/index.js'
import { PsyQueue } from 'psyqueue'
import { sqlite } from '../../backend-sqlite/src/index.js'

function makeQueue(
  exporterInstance: InMemorySpanExporter,
  opts?: { traceEnqueue?: boolean; traceProcess?: boolean },
): PsyQueue {
  const q = new PsyQueue()
  q.use(sqlite({ path: ':memory:' }))
  q.use(
    otelTracing({
      serviceName: 'test-service',
      exporterInstance,
      traceEnqueue: opts?.traceEnqueue ?? true,
      traceProcess: opts?.traceProcess ?? true,
    }),
  )
  return q
}

describe('otelTracing plugin', () => {
  let exporter: InMemorySpanExporter
  let q: PsyQueue

  beforeEach(() => {
    exporter = new InMemorySpanExporter()
    q = makeQueue(exporter)
  })

  afterEach(async () => {
    await q.stop()
    exporter.reset()
  })

  it('creates a span on enqueue with correct name', async () => {
    q.handle('myJob', async () => 'done')
    await q.start()

    await q.enqueue('myJob', { foo: 'bar' })

    const spans = exporter.getFinishedSpans()
    const enqueueSpan = spans.find(s => s.name === 'psyqueue.enqueue')
    expect(enqueueSpan).toBeDefined()
    expect(enqueueSpan!.name).toBe('psyqueue.enqueue')
  })

  it('creates a span on enqueue with job attributes', async () => {
    q.handle('myJob', async () => 'done')
    await q.start()

    await q.enqueue('myJob', {}, { queue: 'myQueue' })

    const spans = exporter.getFinishedSpans()
    const enqueueSpan = spans.find(s => s.name === 'psyqueue.enqueue')
    expect(enqueueSpan).toBeDefined()
    expect(enqueueSpan!.attributes['psyqueue.job.name']).toBe('myJob')
    expect(enqueueSpan!.attributes['psyqueue.job.queue']).toBe('myQueue')
  })

  it('creates a span on process with correct name', async () => {
    q.handle('myJob', async () => 'done')
    await q.start()

    await q.enqueue('myJob', {})
    await q.processNext('myJob')

    const spans = exporter.getFinishedSpans()
    const processSpan = spans.find(s => s.name === 'psyqueue.process')
    expect(processSpan).toBeDefined()
    expect(processSpan!.name).toBe('psyqueue.process')
  })

  it('propagates traceId from enqueue to process (parent-child relationship)', async () => {
    q.handle('myJob', async () => 'done')
    await q.start()

    await q.enqueue('myJob', {})
    await q.processNext('myJob')

    const spans = exporter.getFinishedSpans()
    const enqueueSpan = spans.find(s => s.name === 'psyqueue.enqueue')
    const processSpan = spans.find(s => s.name === 'psyqueue.process')

    expect(enqueueSpan).toBeDefined()
    expect(processSpan).toBeDefined()

    // The process span should have the same traceId as the enqueue span
    expect(processSpan!.spanContext().traceId).toBe(enqueueSpan!.spanContext().traceId)

    // The process span parent should be the enqueue span
    expect(processSpan!.parentSpanId).toBe(enqueueSpan!.spanContext().spanId)
  })

  it('applies custom attributes function to spans', async () => {
    const customExporter = new InMemorySpanExporter()
    const customQ = new PsyQueue()
    customQ.use(sqlite({ path: ':memory:' }))
    customQ.use(
      otelTracing({
        serviceName: 'test-service',
        exporterInstance: customExporter,
        attributes: (job) => ({
          'custom.tenant': job.tenantId ?? 'default',
          'custom.priority': job.priority,
        }),
      }),
    )
    customQ.handle('myJob', async () => 'done')
    await customQ.start()

    await customQ.enqueue('myJob', {}, { tenantId: 'tenant-1', priority: 5 })

    const spans = customExporter.getFinishedSpans()
    const enqueueSpan = spans.find(s => s.name === 'psyqueue.enqueue')
    expect(enqueueSpan).toBeDefined()
    expect(enqueueSpan!.attributes['custom.tenant']).toBe('tenant-1')
    expect(enqueueSpan!.attributes['custom.priority']).toBe(5)

    await customQ.stop()
    customExporter.reset()
  })

  it('sets traceId and spanId on job object during process', async () => {
    let capturedTraceId: string | undefined
    let capturedSpanId: string | undefined

    q.handle('myJob', async (ctx) => {
      capturedTraceId = ctx.job.traceId
      capturedSpanId = ctx.job.spanId
      return 'done'
    })
    await q.start()

    await q.enqueue('myJob', {})
    await q.processNext('myJob')

    expect(capturedTraceId).toBeDefined()
    expect(capturedSpanId).toBeDefined()
    expect(capturedTraceId).toHaveLength(32) // OTel traceId is 32 hex chars
    expect(capturedSpanId).toHaveLength(16)  // OTel spanId is 16 hex chars
  })

  it('skips enqueue span when traceEnqueue is false', async () => {
    // Create a fresh queue with traceEnqueue=false
    await q.stop()
    exporter.reset()
    q = makeQueue(exporter, { traceEnqueue: false, traceProcess: true })

    q.handle('myJob', async () => 'done')
    await q.start()

    await q.enqueue('myJob', {})
    await q.processNext('myJob')

    const spans = exporter.getFinishedSpans()
    const enqueueSpan = spans.find(s => s.name === 'psyqueue.enqueue')
    const processSpan = spans.find(s => s.name === 'psyqueue.process')

    expect(enqueueSpan).toBeUndefined()
    expect(processSpan).toBeDefined()
  })

  it('skips process span when traceProcess is false', async () => {
    await q.stop()
    exporter.reset()
    q = makeQueue(exporter, { traceEnqueue: true, traceProcess: false })

    q.handle('myJob', async () => 'done')
    await q.start()

    await q.enqueue('myJob', {})
    await q.processNext('myJob')

    const spans = exporter.getFinishedSpans()
    const enqueueSpan = spans.find(s => s.name === 'psyqueue.enqueue')
    const processSpan = spans.find(s => s.name === 'psyqueue.process')

    expect(enqueueSpan).toBeDefined()
    expect(processSpan).toBeUndefined()
  })
})
