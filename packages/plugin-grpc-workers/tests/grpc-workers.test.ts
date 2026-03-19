import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { grpcWorkers } from '../src/index.js'
import { PsyQueue } from 'psyqueue'
import { sqlite } from '../../backend-sqlite/src/index.js'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

function buildProtoContent(): string {
  return `
syntax = "proto3";

package psyqueue;

service WorkerService {
  rpc FetchJobs (FetchRequest) returns (FetchResponse);
  rpc Ack (AckRequest) returns (AckResponse);
  rpc Nack (NackRequest) returns (NackResponse);
  rpc Heartbeat (HeartbeatRequest) returns (HeartbeatResponse);
}

message FetchRequest {
  string queue = 1;
  int32 count = 2;
}

message JobMessage {
  string id = 1;
  string queue = 2;
  string name = 3;
  string payload = 4;
  string completion_token = 5;
  int32 attempt = 6;
  int32 max_retries = 7;
}

message FetchResponse {
  repeated JobMessage jobs = 1;
}

message AckRequest {
  string job_id = 1;
  string completion_token = 2;
}

message AckResponse {
  bool already_completed = 1;
}

message NackRequest {
  string job_id = 1;
  bool requeue = 2;
  int32 delay = 3;
  string reason = 4;
}

message NackResponse {
  bool ok = 1;
}

message HeartbeatRequest {
  string worker_id = 1;
}

message HeartbeatResponse {
  bool ok = 1;
  int64 timestamp = 2;
}
`
}

interface GrpcClient {
  FetchJobs: (req: unknown, metadata: grpc.Metadata, cb: (err: grpc.ServiceError | null, res: unknown) => void) => void
  Ack: (req: unknown, metadata: grpc.Metadata, cb: (err: grpc.ServiceError | null, res: unknown) => void) => void
  Nack: (req: unknown, metadata: grpc.Metadata, cb: (err: grpc.ServiceError | null, res: unknown) => void) => void
  Heartbeat: (req: unknown, metadata: grpc.Metadata, cb: (err: grpc.ServiceError | null, res: unknown) => void) => void
  close: () => void
}

function createClient(port: number): GrpcClient {
  const protoContent = buildProtoContent()
  const tmpDir = os.tmpdir()
  const protoPath = path.join(tmpDir, `psyqueue-test-${Date.now()}.proto`)
  fs.writeFileSync(protoPath, protoContent)

  const packageDefinition = protoLoader.loadSync(protoPath, {
    keepCase: true,
    longs: Number,
    enums: String,
    defaults: true,
    oneofs: true,
  })

  try { fs.unlinkSync(protoPath) } catch (_e) { /* ignore */ }

  const proto = grpc.loadPackageDefinition(packageDefinition) as Record<string, unknown>
  const psyqueuePkg = proto['psyqueue'] as Record<string, unknown>
  const WorkerService = psyqueuePkg['WorkerService'] as grpc.ServiceClientConstructor

  return new WorkerService(
    `localhost:${port}`,
    grpc.credentials.createInsecure(),
  ) as unknown as GrpcClient
}

function callWithMeta<T>(
  method: (req: unknown, metadata: grpc.Metadata, cb: (err: grpc.ServiceError | null, res: T) => void) => void,
  req: unknown,
  token?: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const metadata = new grpc.Metadata()
    if (token) {
      metadata.set('authorization', `Bearer ${token}`)
    }
    method(req, metadata, (err, res) => {
      if (err) reject(err)
      else resolve(res)
    })
  })
}

describe('gRPC Workers Plugin', () => {
  let q: PsyQueue
  let port: number
  let portCounter = 0

  beforeEach(async () => {
    portCounter++
    port = 49152 + (process.pid % 1000) * 10 + portCounter // unique per test + per process
  })

  afterEach(async () => {
    try { await q.stop() } catch (_e) { /* ignore */ }
  })

  it('starts server and accepts connections', async () => {
    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))
    q.use(grpcWorkers({ port, tokens: ['test-token'] }))
    await q.start()

    const client = createClient(port)
    try {
      const res = await callWithMeta<{ ok: boolean; timestamp: number }>(
        client.Heartbeat.bind(client),
        { worker_id: 'w1' },
        'test-token',
      )
      expect(res.ok).toBe(true)
      expect(res.timestamp).toBeGreaterThan(0)
    } finally {
      client.close()
    }
  })

  it('fetches enqueued jobs via gRPC', async () => {
    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))
    q.use(grpcWorkers({ port }))
    q.handle('send-email', async () => 'done')
    await q.start()

    await q.enqueue('send-email', { to: 'test@example.com' }, { queue: 'emails' })

    const client = createClient(port)
    try {
      const res = await callWithMeta<{ jobs: Array<{ id: string; name: string; queue: string; payload: string }> }>(
        client.FetchJobs.bind(client),
        { queue: 'emails', count: 5 },
      )
      expect(res.jobs).toHaveLength(1)
      expect(res.jobs[0]!.name).toBe('send-email')
      expect(res.jobs[0]!.queue).toBe('emails')
      expect(JSON.parse(res.jobs[0]!.payload)).toEqual({ to: 'test@example.com' })
    } finally {
      client.close()
    }
  })

  it('acks a job successfully', async () => {
    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))
    q.use(grpcWorkers({ port }))
    q.handle('task', async () => 'ok')
    await q.start()

    await q.enqueue('task', { data: 1 }, { queue: 'work' })

    const client = createClient(port)
    try {
      // Fetch job first
      const fetchRes = await callWithMeta<{ jobs: Array<{ id: string; completion_token: string }> }>(
        client.FetchJobs.bind(client),
        { queue: 'work', count: 1 },
      )
      expect(fetchRes.jobs).toHaveLength(1)

      const job = fetchRes.jobs[0]!

      // Ack the job
      const ackRes = await callWithMeta<{ already_completed: boolean }>(
        client.Ack.bind(client),
        { job_id: job.id, completion_token: job.completion_token },
      )
      expect(ackRes.already_completed).toBe(false)
    } finally {
      client.close()
    }
  })

  it('rejects requests with invalid auth token', async () => {
    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))
    q.use(grpcWorkers({ port, auth: true, tokens: ['secret-token'] }))
    await q.start()

    const client = createClient(port)
    try {
      await expect(
        callWithMeta(
          client.Heartbeat.bind(client),
          { worker_id: 'w1' },
          'wrong-token',
        ),
      ).rejects.toThrow()
    } finally {
      client.close()
    }
  })

  it('nacks a job with requeue', async () => {
    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))
    q.use(grpcWorkers({ port }))
    q.handle('task', async () => 'ok')
    await q.start()

    await q.enqueue('task', { data: 1 }, { queue: 'work' })

    const client = createClient(port)
    try {
      // Fetch job
      const fetchRes = await callWithMeta<{ jobs: Array<{ id: string }> }>(
        client.FetchJobs.bind(client),
        { queue: 'work', count: 1 },
      )
      const job = fetchRes.jobs[0]!

      // Nack with requeue
      const nackRes = await callWithMeta<{ ok: boolean }>(
        client.Nack.bind(client),
        { job_id: job.id, requeue: true, delay: 0, reason: 'retry later' },
      )
      expect(nackRes.ok).toBe(true)
    } finally {
      client.close()
    }
  })

  it('returns empty jobs array from empty queue', async () => {
    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))
    q.use(grpcWorkers({ port }))
    await q.start()

    const client = createClient(port)
    try {
      const res = await callWithMeta<{ jobs: unknown[] }>(
        client.FetchJobs.bind(client),
        { queue: 'empty-queue', count: 5 },
      )
      expect(res.jobs).toHaveLength(0)
    } finally {
      client.close()
    }
  })
})
