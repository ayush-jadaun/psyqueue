import type { z } from 'zod'

export function validatePayload(
  schema: z.ZodSchema,
  payload: unknown,
): { valid: true; data: unknown } | { valid: false; errors: string[] } {
  const result = schema.safeParse(payload)
  if (result.success) {
    return { valid: true, data: result.data }
  }
  const errors = result.error.errors.map(
    (e) => `${e.path.join('.')} — ${e.message}`,
  )
  return { valid: false, errors }
}
