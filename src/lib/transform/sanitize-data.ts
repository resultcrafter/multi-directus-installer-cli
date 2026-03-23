import {ux} from '@oclif/core'

export interface ValidationError {
  message: string
  extensions?: {
    code: string
    field?: string
  }
}

export function isValidationError(error: unknown): error is ValidationError {
  if (error && typeof error === 'object' && 'extensions' in error) {
    const ext = (error as ValidationError).extensions
    return ext?.code === 'INVALID_PAYLOAD' || ext?.code === 'FORBIDDEN'
  }
  return false
}

export function extractInvalidFields(error: unknown): string[] {
  if (!isValidationError(error)) return []
  
  const errorMessage = error instanceof Error ? error.message : String(error)
  
  const fieldMatch = errorMessage.match(/field['"`]?\s*:\s*['"`]?(\w+)/gi)
  if (fieldMatch) {
    return fieldMatch.map(match => {
      const fieldMatchInner = match.match(/['"`]?(\w+)['"`]?\s*$/i)
      return fieldMatchInner ? fieldMatchInner[1] : ''
    }).filter(Boolean)
  }
  
  return []
}

export function sanitizeRecord(record: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const sanitized = {...record}
  
  for (const field of fields) {
    if (field in sanitized) {
      sanitized[field] = null
    }
  }
  
  return sanitized
}

export function sanitizeBatch(
  records: Record<string, unknown>[],
  fields: string[]
): Record<string, unknown>[] {
  return records.map(record => sanitizeRecord(record, fields))
}

export function logSanitization(
  collection: string, 
  recordId: unknown, 
  fields: string[]
): void {
  console.log(`[SANITIZED] ${collection}${recordId ? ` (${recordId})` : ''}: set ${fields.join(', ')} to null`)
}
