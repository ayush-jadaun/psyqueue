import { describe, it, expect } from 'vitest'
import {
  PsyQueueError,
  PluginError,
  DependencyError,
  CircularDependencyError,
  RateLimitError,
  DuplicateJobError,
  SchemaError,
} from '../src/errors.js'

describe('PsyQueueError', () => {
  it('is an instance of Error', () => {
    const err = new PsyQueueError('SOME_CODE', 'something went wrong')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(PsyQueueError)
  })

  it('has the correct code and message', () => {
    const err = new PsyQueueError('MY_CODE', 'my message')
    expect(err.code).toBe('MY_CODE')
    expect(err.message).toBe('my message')
  })

  it('stores context when provided', () => {
    const ctx = { jobId: 'abc', attempt: 2 }
    const err = new PsyQueueError('CTX_CODE', 'with context', ctx)
    expect(err.context).toEqual(ctx)
  })

  it('context is undefined when not provided', () => {
    const err = new PsyQueueError('NO_CTX', 'no context')
    expect(err.context).toBeUndefined()
  })

  it('has name set to PsyQueueError', () => {
    const err = new PsyQueueError('X', 'y')
    expect(err.name).toBe('PsyQueueError')
  })
})

describe('PluginError', () => {
  it('is an instance of PsyQueueError and Error', () => {
    const err = new PluginError('my-plugin', 'failed to start')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(PsyQueueError)
    expect(err).toBeInstanceOf(PluginError)
  })

  it('has code PLUGIN_ERROR', () => {
    const err = new PluginError('my-plugin', 'something broke')
    expect(err.code).toBe('PLUGIN_ERROR')
  })

  it('includes the plugin name in the message', () => {
    const err = new PluginError('my-plugin', 'something broke')
    expect(err.message).toContain('my-plugin')
    expect(err.message).toBe('[my-plugin] something broke')
  })

  it('exposes pluginName property', () => {
    const err = new PluginError('auth-plugin', 'token expired')
    expect(err.pluginName).toBe('auth-plugin')
  })

  it('stores optional context', () => {
    const ctx = { reason: 'timeout' }
    const err = new PluginError('test-plugin', 'timed out', ctx)
    expect(err.context).toEqual(ctx)
  })
})

describe('DependencyError', () => {
  it('is an instance of PsyQueueError', () => {
    const err = new DependencyError('scheduler', 'backend')
    expect(err).toBeInstanceOf(PsyQueueError)
  })

  it('has code MISSING_DEPENDENCY', () => {
    const err = new DependencyError('scheduler', 'backend')
    expect(err.code).toBe('MISSING_DEPENDENCY')
  })

  it('message includes plugin name and missing dependency', () => {
    const err = new DependencyError('scheduler', 'backend')
    expect(err.message).toContain('scheduler')
    expect(err.message).toContain('backend')
  })

  it('message includes install suggestion with all backend options', () => {
    const err = new DependencyError('scheduler', 'backend')
    expect(err.message).toContain('@psyqueue/backend-sqlite')
    expect(err.message).toContain('@psyqueue/backend-redis')
    expect(err.message).toContain('@psyqueue/backend-postgres')
  })

  it('stores pluginName and missingDep in context', () => {
    const err = new DependencyError('worker', 'cache')
    expect(err.context).toEqual({ pluginName: 'worker', missingDep: 'cache' })
  })
})

describe('CircularDependencyError', () => {
  it('is an instance of PsyQueueError', () => {
    const err = new CircularDependencyError(['a', 'b', 'a'])
    expect(err).toBeInstanceOf(PsyQueueError)
  })

  it('has code CIRCULAR_DEPENDENCY', () => {
    const err = new CircularDependencyError(['a', 'b', 'a'])
    expect(err.code).toBe('CIRCULAR_DEPENDENCY')
  })

  it('message shows the full dependency chain with arrows', () => {
    const chain = ['plugin-a', 'plugin-b', 'plugin-c', 'plugin-a']
    const err = new CircularDependencyError(chain)
    expect(err.message).toContain('plugin-a → plugin-b → plugin-c → plugin-a')
  })

  it('stores the chain in context', () => {
    const chain = ['x', 'y', 'x']
    const err = new CircularDependencyError(chain)
    expect(err.context).toEqual({ chain })
  })
})

describe('RateLimitError', () => {
  it('is an instance of PsyQueueError', () => {
    const err = new RateLimitError('tenant-123', 5000)
    expect(err).toBeInstanceOf(PsyQueueError)
  })

  it('has code RATE_LIMIT_EXCEEDED', () => {
    const err = new RateLimitError('tenant-123', 5000)
    expect(err.code).toBe('RATE_LIMIT_EXCEEDED')
  })

  it('message includes the tenant id', () => {
    const err = new RateLimitError('tenant-abc', 3000)
    expect(err.message).toContain('tenant-abc')
  })

  it('exposes retryAfter property', () => {
    const err = new RateLimitError('t1', 2500)
    expect(err.retryAfter).toBe(2500)
  })

  it('stores tenantId and retryAfter in context', () => {
    const err = new RateLimitError('t-99', 1000)
    expect(err.context).toEqual({ tenantId: 't-99', retryAfter: 1000 })
  })
})

describe('DuplicateJobError', () => {
  it('is an instance of PsyQueueError', () => {
    const err = new DuplicateJobError('idem-key-1', 'job-001')
    expect(err).toBeInstanceOf(PsyQueueError)
  })

  it('has code DUPLICATE_JOB', () => {
    const err = new DuplicateJobError('idem-key-1', 'job-001')
    expect(err.code).toBe('DUPLICATE_JOB')
  })

  it('message includes the idempotency key', () => {
    const err = new DuplicateJobError('my-unique-key', 'job-002')
    expect(err.message).toContain('my-unique-key')
  })

  it('exposes existingJobId property', () => {
    const err = new DuplicateJobError('key-xyz', 'job-999')
    expect(err.existingJobId).toBe('job-999')
  })

  it('stores idempotencyKey and existingJobId in context', () => {
    const err = new DuplicateJobError('k1', 'j1')
    expect(err.context).toEqual({ idempotencyKey: 'k1', existingJobId: 'j1' })
  })
})

describe('SchemaError', () => {
  it('is an instance of PsyQueueError', () => {
    const err = new SchemaError('send-email', 1, 2, ['missing field: to'])
    expect(err).toBeInstanceOf(PsyQueueError)
  })

  it('has code SCHEMA_MISMATCH', () => {
    const err = new SchemaError('send-email', 1, 2, [])
    expect(err.code).toBe('SCHEMA_MISMATCH')
  })

  it('message includes job name and version numbers', () => {
    const err = new SchemaError('send-email', 1, 2, [])
    expect(err.message).toContain('send-email')
    expect(err.message).toContain('v1')
    expect(err.message).toContain('v2')
  })

  it('exposes jobName, foundVersion, expectedVersion properties', () => {
    const err = new SchemaError('process-payment', 3, 5, [])
    expect(err.jobName).toBe('process-payment')
    expect(err.foundVersion).toBe(3)
    expect(err.expectedVersion).toBe(5)
  })

  it('exposes validationErrors array', () => {
    const errs = ['missing field: amount', 'invalid type: currency']
    const err = new SchemaError('process-payment', 1, 2, errs)
    expect(err.validationErrors).toEqual(errs)
  })

  it('stores all fields in context', () => {
    const validationErrors = ['bad field']
    const err = new SchemaError('job-x', 2, 4, validationErrors)
    expect(err.context).toEqual({
      jobName: 'job-x',
      foundVersion: 2,
      expectedVersion: 4,
      validationErrors,
    })
  })
})
