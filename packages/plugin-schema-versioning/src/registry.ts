import type { z } from 'zod'
import type { JobHandler } from 'psyqueue'

export interface VersionConfig {
  schema: z.ZodSchema
  process: JobHandler
  migrate?: (prevPayload: unknown) => unknown
}

export interface VersionedHandlerConfig {
  versions: Record<number, VersionConfig>
  current: number
}

export class VersionRegistry {
  private handlers = new Map<string, VersionedHandlerConfig>()

  register(name: string, config: VersionedHandlerConfig): void {
    this.handlers.set(name, config)
  }

  /**
   * Build migration chain from sourceVersion to targetVersion.
   * e.g. v1→v3 chains: migrate(v1→v2) then migrate(v2→v3)
   * Each function in the returned array migrates from the prior version to the next.
   */
  buildMigrationChain(
    name: string,
    fromVersion: number,
    toVersion: number,
  ): Array<(payload: unknown) => unknown> {
    const config = this.handlers.get(name)
    if (!config) return []

    const chain: Array<(payload: unknown) => unknown> = []

    for (let v = fromVersion + 1; v <= toVersion; v++) {
      const versionConfig: VersionConfig | undefined = config.versions[v] as VersionConfig | undefined
      if (versionConfig === undefined) {
        throw new Error(
          `Missing version ${v} in migration chain for job "${name}"`,
        )
      }
      if (!versionConfig.migrate) {
        throw new Error(
          `Version ${v} of job "${name}" is missing a migrate function required for migration chain`,
        )
      }
      chain.push(versionConfig.migrate)
    }

    return chain
  }

  getHandler(name: string, version: number): VersionConfig | undefined {
    const config = this.handlers.get(name)
    if (!config) return undefined
    return config.versions[version] as VersionConfig | undefined
  }

  getCurrentVersion(name: string): number | undefined {
    return this.handlers.get(name)?.current
  }

  has(name: string): boolean {
    return this.handlers.has(name)
  }

  getConfig(name: string): VersionedHandlerConfig | undefined {
    return this.handlers.get(name)
  }
}
