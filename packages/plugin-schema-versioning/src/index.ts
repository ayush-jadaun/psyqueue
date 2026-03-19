import type { PsyPlugin, Kernel, JobHandler, JobContext } from '@psyqueue/core'
import { VersionRegistry } from './registry.js'
import { validatePayload } from './validator.js'
import type { VersionedHandlerConfig, VersionConfig } from './registry.js'

export type { VersionConfig, VersionedHandlerConfig } from './registry.js'
export { validatePayload } from './validator.js'

// The global registry shared between the plugin and the versioned() helper.
// One instance per call to schemaVersioning(), but shared via closure.
let globalRegistry: VersionRegistry | null = null

/**
 * Creates a versioned handler that handles schema migration and validation.
 * The returned JobHandler can be passed directly to q.handle().
 *
 * Usage:
 *   q.handle('email.send', schemaVersioning.versioned({ versions: { ... }, current: 2 }))
 */
function versioned(config: VersionedHandlerConfig): JobHandler {
  // The actual job name is only known at runtime (ctx.job.name), so we register
  // the config lazily under the job name on first invocation.
  const handler: JobHandler = async (ctx: JobContext) => {
    const registry = globalRegistry
    if (!registry) {
      throw new Error(
        'schemaVersioning plugin is not initialised. Call q.use(schemaVersioning()) before registering versioned handlers.',
      )
    }

    const jobName = ctx.job.name

    // Ensure this config is registered under the job name (lazy registration).
    if (!registry.has(jobName)) {
      registry.register(jobName, config)
    }

    const currentVersion = config.current
    const sourceVersion: number = (ctx.job.schemaVersion as number | undefined) ?? 1

    let payload = ctx.job.payload

    // Apply migration chain if needed
    if (sourceVersion !== currentVersion) {
      const chain = registry.buildMigrationChain(jobName, sourceVersion, currentVersion)
      for (const migrate of chain) {
        payload = migrate(payload)
      }
    }

    // Validate against the current version schema
    const currentConfig = config.versions[currentVersion] as VersionConfig | undefined
    if (!currentConfig) {
      throw new Error(
        `No version ${currentVersion} configured for job "${jobName}"`,
      )
    }

    const validation = validatePayload(currentConfig.schema, payload)
    if (!validation.valid) {
      ctx.deadLetter('SCHEMA_MISMATCH')
      return
    }

    // Update the job payload and version in place
    ctx.job.payload = validation.data
    ctx.job.schemaVersion = currentVersion

    // Delegate to the current version's process handler
    return currentConfig.process(ctx)
  }

  return handler
}

/**
 * Schema versioning plugin for PsyQueue.
 *
 * Enables versioned job payloads with automatic migration chains and Zod validation.
 * Attach versioned handlers with `schemaVersioning.versioned({ versions, current })`.
 */
export function schemaVersioning(): PsyPlugin {
  const registry = new VersionRegistry()

  const plugin: PsyPlugin = {
    name: 'schema-versioning',
    version: '0.1.0',
    provides: 'schema-versioning',

    init(kernel: Kernel) {
      // Set the global registry so versioned() handlers can find it.
      globalRegistry = registry

      // Expose the registry via the kernel for advanced use.
      kernel.expose('schemaVersioning', {
        registry,
        registerVersioned: (name: string, config: VersionedHandlerConfig) => {
          registry.register(name, config)
        },
      } as Record<string, unknown>)
    },

    async start() {
      // Nothing to start
    },

    async stop() {
      // Reset the global registry reference on stop so tests don't bleed.
      if (globalRegistry === registry) {
        globalRegistry = null
      }
    },
  }

  return plugin
}

// Attach the static helper to the plugin factory.
schemaVersioning.versioned = versioned
