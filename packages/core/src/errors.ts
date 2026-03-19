export class PsyQueueError extends Error {
  public readonly code: string
  public readonly context?: Record<string, unknown>

  constructor(code: string, message: string, context?: Record<string, unknown>) {
    super(message)
    this.name = 'PsyQueueError'
    this.code = code
    this.context = context
  }
}

export class PluginError extends PsyQueueError {
  public readonly pluginName: string

  constructor(pluginName: string, message: string, context?: Record<string, unknown>) {
    super('PLUGIN_ERROR', `[${pluginName}] ${message}`, context)
    this.pluginName = pluginName
  }
}

export class DependencyError extends PsyQueueError {
  constructor(pluginName: string, missingDep: string) {
    super(
      'MISSING_DEPENDENCY',
      `Plugin "${pluginName}" requires "${missingDep}" but none is registered. Install a backend: @psyqueue/backend-sqlite, @psyqueue/backend-redis, or @psyqueue/backend-postgres`,
      { pluginName, missingDep }
    )
  }
}

export class CircularDependencyError extends PsyQueueError {
  constructor(chain: string[]) {
    super(
      'CIRCULAR_DEPENDENCY',
      `Circular dependency detected: ${chain.join(' → ')}`,
      { chain }
    )
  }
}

export class RateLimitError extends PsyQueueError {
  public readonly retryAfter: number

  constructor(tenantId: string, retryAfter: number) {
    super('RATE_LIMIT_EXCEEDED', `Tenant ${tenantId} exceeded rate limit`, { tenantId, retryAfter })
    this.retryAfter = retryAfter
  }
}

export class DuplicateJobError extends PsyQueueError {
  public readonly existingJobId: string

  constructor(idempotencyKey: string, existingJobId: string) {
    super('DUPLICATE_JOB', `Duplicate job with idempotency key "${idempotencyKey}"`, {
      idempotencyKey,
      existingJobId,
    })
    this.existingJobId = existingJobId
  }
}

export class SchemaError extends PsyQueueError {
  public readonly jobName: string
  public readonly foundVersion: number
  public readonly expectedVersion: number
  public readonly validationErrors: string[]

  constructor(jobName: string, foundVersion: number, expectedVersion: number, validationErrors: string[]) {
    super('SCHEMA_MISMATCH', `Schema mismatch for "${jobName}": found v${foundVersion}, expected v${expectedVersion}`, {
      jobName,
      foundVersion,
      expectedVersion,
      validationErrors,
    })
    this.jobName = jobName
    this.foundVersion = foundVersion
    this.expectedVersion = expectedVersion
    this.validationErrors = validationErrors
  }
}
