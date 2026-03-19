import type { PsyPlugin, Kernel, Job } from 'psyqueue'
import {
  trace,
  SpanStatusCode,
  SpanKind,
  ROOT_CONTEXT,
} from '@opentelemetry/api'
import {
  NodeTracerProvider,
} from '@opentelemetry/sdk-trace-node'
import {
  SimpleSpanProcessor,
  ConsoleSpanExporter,
  InMemorySpanExporter,
} from '@opentelemetry/sdk-trace-base'

export { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'

export interface OtelTracingOpts {
  serviceName: string
  /** 'memory' uses InMemorySpanExporter (for testing), 'console' uses ConsoleSpanExporter */
  exporter?: 'console' | 'memory'
  traceEnqueue?: boolean
  traceProcess?: boolean
  attributes?: (job: Job) => Record<string, string | number>
  /** Provide a pre-configured InMemorySpanExporter instance (for testing) */
  exporterInstance?: InMemorySpanExporter
}

export type OtelTracingPlugin = PsyPlugin & {
  getExporter(): InMemorySpanExporter | null
}

export function otelTracing(opts: OtelTracingOpts): OtelTracingPlugin {
  const traceEnqueue = opts.traceEnqueue ?? true
  const traceProcess = opts.traceProcess ?? true

  let memoryExporter: InMemorySpanExporter | null = null
  let provider: NodeTracerProvider | null = null

  const plugin: OtelTracingPlugin = {
    name: 'otel-tracing',
    version: '0.1.0',
    provides: 'otel-tracing',

    getExporter(): InMemorySpanExporter | null {
      return memoryExporter
    },

    init(k: Kernel): void {
      // Resolve the span exporter
      if (opts.exporterInstance) {
        memoryExporter = opts.exporterInstance
      } else if (opts.exporter === 'memory') {
        memoryExporter = new InMemorySpanExporter()
      }

      const spanExporter = memoryExporter ?? new ConsoleSpanExporter()

      // Build a local provider. Use getTracer() from the instance directly so we
      // don't need to register globally — this gives proper test isolation.
      provider = new NodeTracerProvider()
      provider.addSpanProcessor(new SimpleSpanProcessor(spanExporter))

      // getTracer on the instance directly, no global register() call needed for tests
      const tracer = provider.getTracer(opts.serviceName)

      if (traceEnqueue) {
        k.pipeline(
          'enqueue',
          async (ctx, next) => {
            const job = ctx.job
            const spanAttrs: Record<string, string | number> = {
              'psyqueue.job.id': job.id,
              'psyqueue.job.name': job.name,
              'psyqueue.job.queue': job.queue,
              'psyqueue.job.attempt': job.attempt,
            }

            if (opts.attributes) {
              const custom = opts.attributes(job)
              Object.assign(spanAttrs, custom)
            }

            const span = tracer.startSpan('psyqueue.enqueue', {
              kind: SpanKind.PRODUCER,
              attributes: spanAttrs,
            })

            const spanCtx = span.spanContext()
            // Store trace context in job fields and meta for process-side propagation
            job.traceId = spanCtx.traceId
            job.spanId = spanCtx.spanId
            job.meta['_otel_traceId'] = spanCtx.traceId
            job.meta['_otel_spanId'] = spanCtx.spanId

            try {
              await next()
              span.setStatus({ code: SpanStatusCode.OK })
            } catch (err) {
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: err instanceof Error ? err.message : String(err),
              })
              throw err
            } finally {
              span.end()
            }
          },
          { phase: 'observe' },
        )
      }

      if (traceProcess) {
        k.pipeline(
          'process',
          async (ctx, next) => {
            const job = ctx.job
            const spanAttrs: Record<string, string | number> = {
              'psyqueue.job.id': job.id,
              'psyqueue.job.name': job.name,
              'psyqueue.job.queue': job.queue,
              'psyqueue.job.attempt': job.attempt,
            }

            if (opts.attributes) {
              const custom = opts.attributes(job)
              Object.assign(spanAttrs, custom)
            }

            // Rebuild parent context from job meta (propagated from enqueue span)
            const parentTraceId = job.meta['_otel_traceId'] as string | undefined
            const parentSpanId = job.meta['_otel_spanId'] as string | undefined

            let parentCtx = ROOT_CONTEXT
            if (parentTraceId && parentSpanId) {
              const remoteSpanCtx = {
                traceId: parentTraceId,
                spanId: parentSpanId,
                isRemote: true,
                traceFlags: 1, // SAMPLED
              }
              parentCtx = trace.setSpanContext(ROOT_CONTEXT, remoteSpanCtx)
            }

            const span = tracer.startSpan(
              'psyqueue.process',
              {
                kind: SpanKind.CONSUMER,
                attributes: spanAttrs,
              },
              parentCtx,
            )

            const spanCtx = span.spanContext()
            job.traceId = spanCtx.traceId
            job.spanId = spanCtx.spanId

            try {
              await next()
              span.setStatus({ code: SpanStatusCode.OK })
            } catch (err) {
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: err instanceof Error ? err.message : String(err),
              })
              throw err
            } finally {
              span.end()
            }
          },
          { phase: 'observe' },
        )
      }
    },

    async start(): Promise<void> {
      // Provider is ready from init
    },

    async stop(): Promise<void> {
      if (provider) {
        await provider.shutdown()
        provider = null
      }
    },
  }

  return plugin
}
