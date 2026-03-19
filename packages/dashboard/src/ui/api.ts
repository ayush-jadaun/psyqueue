const BASE = '/api'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init)
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`${res.status}: ${body}`)
  }
  return res.json() as Promise<T>
}

export interface OverviewData {
  totalPending: number
  totalActive: number
  totalCompleted: number
  totalFailed: number
  queues: Array<{ name: string }>
}

export interface QueueInfo {
  name: string
  pending: number
  active: number
  completed: number
  failed: number
}

export interface Job {
  id: string
  queue: string
  name: string
  payload: unknown
  priority: number
  maxRetries: number
  attempt: number
  backoff: string
  timeout: number
  status: string
  createdAt: string
  scheduledAt?: string
  meta: Record<string, unknown>
}

export interface JobListResult {
  data: Job[]
  total: number
  limit: number
  offset: number
  hasMore: boolean
}

export function fetchOverview(): Promise<OverviewData> {
  return request<OverviewData>('/overview')
}

export function fetchQueues(): Promise<{ queues: QueueInfo[] }> {
  return request<{ queues: QueueInfo[] }>('/queues')
}

export function fetchJobs(params: {
  queue?: string
  status?: string
  limit?: number
  offset?: number
}): Promise<JobListResult> {
  const qs = new URLSearchParams()
  if (params.queue) qs.set('queue', params.queue)
  if (params.status) qs.set('status', params.status)
  if (params.limit) qs.set('limit', String(params.limit))
  if (params.offset) qs.set('offset', String(params.offset))
  const query = qs.toString()
  return request<JobListResult>(`/jobs${query ? `?${query}` : ''}`)
}

export function fetchJob(id: string): Promise<Job> {
  return request<Job>(`/jobs/${id}`)
}

export function retryJob(id: string): Promise<{ success: boolean; jobId: string }> {
  return request<{ success: boolean; jobId: string }>(`/jobs/${id}/retry`, { method: 'POST' })
}
