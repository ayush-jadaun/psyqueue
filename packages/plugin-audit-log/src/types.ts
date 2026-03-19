export interface AuditEntry {
  id: string
  timestamp: string        // ISO 8601
  event: string
  jobId: string
  jobName: string
  queue: string
  tenantId?: string
  payload?: unknown        // only when includePayload: true
  prevHash: string
  hash: string
}

export interface AuditFilter {
  event?: string | string[]
  jobId?: string
  queue?: string
  from?: Date
  to?: Date
}
