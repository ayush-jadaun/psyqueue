/**
 * PsyQueue preset configurations.
 *
 * These are descriptive configs that list which plugins each preset requires.
 * Users reference them when setting up their PsyQueue instance and install
 * the corresponding plugin packages themselves.
 */

export interface PresetConfig {
  plugins: string[]
}

export const presets: Record<string, PresetConfig> = {
  lite: {
    plugins: ['backend-sqlite', 'scheduler', 'crash-recovery'],
  },
  saas: {
    plugins: [
      'backend-redis',
      'tenancy',
      'workflows',
      'saga',
      'circuit-breaker',
      'backpressure',
      'dashboard',
      'metrics',
    ],
  },
  enterprise: {
    plugins: [
      'backend-postgres',
      'tenancy',
      'workflows',
      'saga',
      'exactly-once',
      'audit-log',
      'otel-tracing',
      'schema-versioning',
      'circuit-breaker',
      'backpressure',
      'dashboard',
      'metrics',
    ],
  },
}
