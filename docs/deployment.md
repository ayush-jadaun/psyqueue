# Deployment Guide

## Publishing to npm (using Bumpcraft)

PsyQueue uses [Bumpcraft](https://www.npmjs.com/package/bumpcraft) for semantic versioning and releases.

### Prerequisites

- npm account at [npmjs.com](https://npmjs.com)
- Create organization `psyqueue` for `@psyqueue/*` scoped packages
- Add `NPM_TOKEN` to your GitHub repo secrets (Settings → Secrets → Actions)

### Release Flow

```bash
# Preview what would happen (no changes made)
pnpm release:dry

# Validate commits and see next version
pnpm release:preview

# Publish for real
pnpm release
```

Bumpcraft reads your Conventional Commits (`feat:`, `fix:`, `perf:`, etc.) and automatically:
1. Determines bump type (major/minor/patch)
2. Updates `package.json` versions
3. Generates/updates `CHANGELOG.md`
4. Creates a git tag
5. Publishes to npm

### Automated Publishing (CI)

On every push to `main`, GitHub Actions runs `.github/workflows/publish.yml`:
1. Install → Build → Test (with Redis + Postgres services)
2. `npx bumpcraft release` — auto-publishes if there are releasable commits

### Manual Publishing

```bash
# Login to npm
npm login

# Build and test first
pnpm build && pnpm test

# Publish each package
cd packages/core && npm publish --access public
cd ../backend-sqlite && npm publish --access public
cd ../backend-redis && npm publish --access public
# ... repeat for each package
```

---

## Deploying PsyQueue in Your Application

### Minimal Setup (SQLite, single server)

Best for: prototyping, small apps, single-server deployments.

```bash
npm install psyqueue @psyqueue/backend-sqlite
```

```ts
import { PsyQueue } from 'psyqueue'
import { sqlite } from '@psyqueue/backend-sqlite'

const q = new PsyQueue()
q.use(sqlite({ path: './data/jobs.db' }))  // persistent file

q.handle('email.send', async (ctx) => {
  await sendEmail(ctx.job.payload)
  return { sent: true }
})

await q.start()
q.startWorker('email.send', { concurrency: 5 })

// Graceful shutdown
process.on('SIGTERM', async () => {
  await q.stop()
  process.exit(0)
})
```

### Production Setup (Redis)

Best for: multi-server, high throughput, distributed workers.

```bash
npm install psyqueue @psyqueue/backend-redis @psyqueue/plugin-scheduler @psyqueue/plugin-crash-recovery @psyqueue/dashboard
```

```ts
import { PsyQueue } from 'psyqueue'
import { redis } from '@psyqueue/backend-redis'
import { scheduler } from '@psyqueue/plugin-scheduler'
import { crashRecovery } from '@psyqueue/plugin-crash-recovery'
import { dashboard } from '@psyqueue/dashboard'

const q = new PsyQueue()
q.use(redis({ url: process.env.REDIS_URL }))
q.use(scheduler())
q.use(crashRecovery({ walPath: './data/psyqueue.wal' }))
q.use(dashboard({ port: 4000, getBackend: () => (q as any).backend }))

q.handle('order.process', async (ctx) => { /* ... */ })

await q.start()
q.startWorker('order.process', { concurrency: 10 })

console.log('Dashboard: http://localhost:4000')
```

### Docker Deployment

```bash
docker build -t psyqueue-app .
docker run -d \
  -e REDIS_URL=redis://redis:6379 \
  -e DASHBOARD_PORT=4000 \
  -p 4000:4000 \
  psyqueue-app
```

### Docker Compose (Full Stack)

```yaml
version: '3.8'
services:
  redis:
    image: redis:7-alpine
    ports: ['6379:6379']
    volumes: ['redis_data:/data']

  postgres:
    image: postgres:16-alpine
    ports: ['5432:5432']
    environment:
      POSTGRES_DB: psyqueue
      POSTGRES_USER: psyqueue
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes: ['pg_data:/var/lib/postgresql/data']

  jaeger:
    image: jaegertracing/all-in-one:latest
    ports:
      - '16686:16686'  # UI
      - '4318:4318'    # OTLP HTTP

  app:
    build: .
    ports: ['4000:4000']
    environment:
      REDIS_URL: redis://redis:6379
      DATABASE_URL: postgres://psyqueue:${POSTGRES_PASSWORD}@postgres:5432/psyqueue
      DASHBOARD_PORT: 4000
      JAEGER_ENDPOINT: http://jaeger:4318
    depends_on: [redis, postgres, jaeger]

  worker:
    build: .
    command: node worker.js
    environment:
      REDIS_URL: redis://redis:6379
    depends_on: [redis]
    deploy:
      replicas: 3  # scale workers independently

volumes:
  redis_data:
  pg_data:
```

### Kubernetes

**Deployment (API + Dashboard):**
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: psyqueue-api
spec:
  replicas: 2
  selector:
    matchLabels:
      app: psyqueue-api
  template:
    metadata:
      labels:
        app: psyqueue-api
    spec:
      containers:
        - name: api
          image: your-registry/psyqueue-app:latest
          ports:
            - containerPort: 4000
          env:
            - name: REDIS_URL
              valueFrom:
                secretKeyRef:
                  name: psyqueue-secrets
                  key: redis-url
            - name: DASHBOARD_PORT
              value: '4000'
          livenessProbe:
            httpGet:
              path: /api/health
              port: 4000
            initialDelaySeconds: 10
          readinessProbe:
            httpGet:
              path: /api/health
              port: 4000
---
apiVersion: v1
kind: Service
metadata:
  name: psyqueue-api
spec:
  selector:
    app: psyqueue-api
  ports:
    - port: 4000
      targetPort: 4000
```

**Worker Deployment (autoscale based on queue depth):**
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: psyqueue-worker
spec:
  replicas: 3
  selector:
    matchLabels:
      app: psyqueue-worker
  template:
    spec:
      containers:
        - name: worker
          image: your-registry/psyqueue-app:latest
          command: ['node', 'worker.js']
          env:
            - name: REDIS_URL
              valueFrom:
                secretKeyRef:
                  name: psyqueue-secrets
                  key: redis-url
            - name: WORKER_CONCURRENCY
              value: '10'
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: psyqueue-worker-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: psyqueue-worker
  minReplicas: 1
  maxReplicas: 20
  metrics:
    - type: External
      external:
        metric:
          name: psyqueue_queue_depth
        target:
          type: AverageValue
          averageValue: '100'
```

### Serverless (AWS Lambda / Cloud Functions)

For serverless, use `processNext()` instead of `startWorker()`:

```ts
// handler.ts — Lambda function triggered by SQS/EventBridge/cron
import { PsyQueue } from 'psyqueue'
import { redis } from '@psyqueue/backend-redis'

const q = new PsyQueue()
q.use(redis({ url: process.env.REDIS_URL }))
q.handle('task', async (ctx) => { /* process */ })

export async function handler() {
  await q.start()

  // Process up to 10 jobs per invocation
  let processed = 0
  while (processed < 10) {
    const ok = await q.processNext('task')
    if (!ok) break  // queue empty
    processed++
  }

  await q.stop()
  return { processed }
}
```

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `REDIS_URL` | Redis connection string | `redis://localhost:6379` |
| `DATABASE_URL` | PostgreSQL connection string | — |
| `DASHBOARD_PORT` | Dashboard HTTP port | `4000` |
| `DASHBOARD_USER` | Dashboard basic auth user | — |
| `DASHBOARD_PASS` | Dashboard basic auth password | — |
| `JAEGER_ENDPOINT` | OpenTelemetry OTLP endpoint | — |
| `WORKER_CONCURRENCY` | Workers per queue | `1` |
| `LOG_LEVEL` | Logging level | `info` |

---

## Health Checks

```bash
# Dashboard health endpoint
curl http://localhost:4000/api/health
# {"status":"ok","timestamp":"2026-03-19T..."}

# Prometheus metrics
curl http://localhost:9090/metrics
# psyqueue_jobs_enqueued_total{queue="email"} 1234
# psyqueue_queue_depth{queue="email"} 42
```

---

## Monitoring

### Prometheus + Grafana

```ts
import { metrics } from '@psyqueue/plugin-metrics'
q.use(metrics({ exporter: 'prometheus', port: 9090 }))
```

**Key Grafana queries:**
- Queue depth: `psyqueue_queue_depth`
- Throughput: `rate(psyqueue_jobs_completed_total[5m])`
- Error rate: `rate(psyqueue_jobs_failed_total[5m]) / rate(psyqueue_jobs_enqueued_total[5m])`
- P95 latency: `histogram_quantile(0.95, psyqueue_job_duration_ms_bucket)`

### OpenTelemetry → Jaeger

```ts
import { otelTracing } from '@psyqueue/plugin-otel-tracing'
q.use(otelTracing({
  serviceName: 'my-app',
  exporter: 'otlp',
  endpoint: process.env.JAEGER_ENDPOINT,
}))
```

Traces show: HTTP request → job enqueue → job process → downstream calls, all correlated.

---

## Scaling Guide

### Horizontal (more workers)

```bash
# Run N worker processes, all sharing the same Redis
WORKER_CONCURRENCY=10 node worker.js  # server 1
WORKER_CONCURRENCY=10 node worker.js  # server 2
WORKER_CONCURRENCY=10 node worker.js  # server 3
# Total: 30 concurrent job processors
```

### Vertical (more concurrency per worker)

```ts
q.startWorker('heavy-queue', { concurrency: 50 })
```

### Multi-Region

Use the offline-sync plugin for edge locations with unreliable connectivity:

```ts
import { offlineSync } from '@psyqueue/plugin-offline-sync'
q.use(offlineSync({
  localPath: './local-buffer.db',
  remote: 'grpc://central-queue:50051',
  sync: { mode: 'opportunistic' },
}))
```

---

## Security Checklist

- [ ] Dashboard auth enabled (basic or bearer token)
- [ ] gRPC/HTTP worker transport uses token auth
- [ ] No secrets stored in job payloads (use references/IDs)
- [ ] Audit log enabled for compliance environments
- [ ] Redis requires password (`requirepass` in redis.conf)
- [ ] Postgres uses strong credentials + SSL
- [ ] `.env` files not committed to git
