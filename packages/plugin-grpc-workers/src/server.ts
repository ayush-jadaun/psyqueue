import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { BackendAdapter, DequeuedJob } from '@psyqueue/core'

export interface GrpcServerOpts {
  port: number
  tokens?: string[]
  queues?: string[]
  backend: BackendAdapter
  onEvent?: (event: string, data: Record<string, unknown>) => void
}

interface FetchRequest {
  queue: string
  count: number
}

interface AckRequest {
  job_id: string
  completion_token: string
}

interface NackRequest {
  job_id: string
  requeue: boolean
  delay: number
  reason: string
}

interface HeartbeatRequest {
  worker_id: string
}

type GrpcCall<Req> = grpc.ServerUnaryCall<Req, unknown>
type GrpcCallback = grpc.sendUnaryData<unknown>

function buildProtoDefinition(): string {
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

export class GrpcWorkerServer {
  private server: grpc.Server
  private readonly opts: GrpcServerOpts
  private workers = new Map<string, number>()

  constructor(opts: GrpcServerOpts) {
    this.opts = opts
    this.server = new grpc.Server()
    this.setupService()
  }

  private checkAuth(call: grpc.ServerUnaryCall<unknown, unknown>, callback: GrpcCallback): boolean {
    const tokens = this.opts.tokens
    if (!tokens || tokens.length === 0) return true

    const metadata = call.metadata
    const authValues = metadata.get('authorization')
    const token = authValues.length > 0 ? String(authValues[0]) : ''
    const bearerToken = token.startsWith('Bearer ') ? token.slice(7) : token

    if (!tokens.includes(bearerToken)) {
      callback({
        code: grpc.status.UNAUTHENTICATED,
        details: 'Invalid or missing auth token',
      })
      return false
    }
    return true
  }

  private setupService(): void {
    const protoContent = buildProtoDefinition()

    const tmpDir = os.tmpdir()
    const protoPath = path.join(tmpDir, `psyqueue-worker-${Date.now()}.proto`)
    fs.writeFileSync(protoPath, protoContent)

    const packageDefinition = protoLoader.loadSync(protoPath, {
      keepCase: true,
      longs: Number,
      enums: String,
      defaults: true,
      oneofs: true,
    })

    try { fs.unlinkSync(protoPath) } catch { /* ignore */ }

    const proto = grpc.loadPackageDefinition(packageDefinition) as Record<string, unknown>
    const psyqueuePkg = proto['psyqueue'] as Record<string, unknown>
    const WorkerService = psyqueuePkg['WorkerService'] as grpc.ServiceClientConstructor

    this.server.addService(WorkerService.service, {
      FetchJobs: this.handleFetchJobs.bind(this),
      Ack: this.handleAck.bind(this),
      Nack: this.handleNack.bind(this),
      Heartbeat: this.handleHeartbeat.bind(this),
    })
  }

  private async handleFetchJobs(
    call: GrpcCall<FetchRequest>,
    callback: GrpcCallback,
  ): Promise<void> {
    if (!this.checkAuth(call as grpc.ServerUnaryCall<unknown, unknown>, callback)) return

    try {
      const { queue, count } = call.request as FetchRequest

      if (this.opts.queues && this.opts.queues.length > 0 && !this.opts.queues.includes(queue)) {
        callback({
          code: grpc.status.PERMISSION_DENIED,
          details: `Queue "${queue}" is not in the allowed list`,
        })
        return
      }

      const jobs = await this.opts.backend.dequeue(queue, count || 1)

      const jobMessages = jobs.map((j: DequeuedJob) => ({
        id: j.id,
        queue: j.queue,
        name: j.name,
        payload: JSON.stringify(j.payload),
        completion_token: j.completionToken,
        attempt: j.attempt,
        max_retries: j.maxRetries,
      }))

      this.opts.onEvent?.('grpc:fetch', { queue, count: jobs.length })
      callback(null, { jobs: jobMessages })
    } catch (err) {
      callback({
        code: grpc.status.INTERNAL,
        details: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private async handleAck(
    call: GrpcCall<AckRequest>,
    callback: GrpcCallback,
  ): Promise<void> {
    if (!this.checkAuth(call as grpc.ServerUnaryCall<unknown, unknown>, callback)) return

    try {
      const { job_id, completion_token } = call.request as AckRequest
      const result = await this.opts.backend.ack(job_id, completion_token)
      this.opts.onEvent?.('grpc:ack', { jobId: job_id })
      callback(null, { already_completed: result.alreadyCompleted })
    } catch (err) {
      callback({
        code: grpc.status.INTERNAL,
        details: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private async handleNack(
    call: GrpcCall<NackRequest>,
    callback: GrpcCallback,
  ): Promise<void> {
    if (!this.checkAuth(call as grpc.ServerUnaryCall<unknown, unknown>, callback)) return

    try {
      const { job_id, requeue, delay, reason } = call.request as NackRequest
      await this.opts.backend.nack(job_id, { requeue, delay, reason })
      this.opts.onEvent?.('grpc:nack', { jobId: job_id })
      callback(null, { ok: true })
    } catch (err) {
      callback({
        code: grpc.status.INTERNAL,
        details: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private handleHeartbeat(
    call: GrpcCall<HeartbeatRequest>,
    callback: GrpcCallback,
  ): void {
    if (!this.checkAuth(call as grpc.ServerUnaryCall<unknown, unknown>, callback)) return

    const { worker_id } = call.request as HeartbeatRequest
    this.workers.set(worker_id, Date.now())
    this.opts.onEvent?.('grpc:heartbeat', { workerId: worker_id })
    callback(null, { ok: true, timestamp: Date.now() })
  }

  async listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.bindAsync(
        `127.0.0.1:${this.opts.port}`,
        grpc.ServerCredentials.createInsecure(),
        (err, boundPort) => {
          if (err) {
            reject(err)
            return
          }
          resolve(boundPort)
        },
      )
    })
  }

  async shutdown(): Promise<void> {
    return new Promise((resolve) => {
      this.server.tryShutdown(() => resolve())
    })
  }

  getWorkers(): Map<string, number> {
    return new Map(this.workers)
  }
}
