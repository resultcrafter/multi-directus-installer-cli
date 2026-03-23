import {ux} from '@oclif/core'

import catchError, {isValidationError, getErrorFields} from './catch-error.js'
import {sanitizeBatch, logSanitization} from '../transform/sanitize-data.js'

interface RetryOptions {
  maxRetries?: number
  initialDelayMs?: number
  onSanitize?: (collection: string, id: unknown, fields: string[]) => void
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {maxRetries = 3, initialDelayMs = 1000, onSanitize} = options
  
  let lastError: unknown
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      
      if (attempt === maxRetries) {
        break
      }
      
      if (isValidationError(error)) {
        break
      }
      
      const delay = initialDelayMs * Math.pow(2, attempt)
        console.log(`Retry ${attempt + 1}/${maxRetries} after ${delay}ms...`)
        await sleep(delay)
    }
  }
  
  throw lastError
}

export async function withSanitization<T>(
  fn: () => Promise<T>,
  record: Record<string, unknown>,
  collection: string,
  options: RetryOptions & {idField?: string} = {}
): Promise<T> {
  const {maxRetries = 3, initialDelayMs = 1000, onSanitize, idField = 'id'} = options
  
  let lastError: unknown
  let currentRecord = {...record}
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      
      if (attempt === maxRetries) {
        break
      }
      
      if (!isValidationError(error)) {
        const delay = initialDelayMs * Math.pow(2, attempt)
        console.log(`Retry ${attempt + 1}/${maxRetries} after ${delay}ms...`)
        await sleep(delay)
        continue
      }
      
      const invalidFields = getErrorFields(error)
      
      if (invalidFields.length === 0) {
        break
      }
      
      currentRecord = sanitizeRecord(currentRecord, invalidFields)
      onSanitize?.(collection, record[idField], invalidFields)
    }
  }
  
  throw lastError
}

function sanitizeRecord(
  record: Record<string, unknown>,
  fields: string[]
): Record<string, unknown> {
  const sanitized = {...record}
  for (const field of fields) {
    if (field in sanitized) {
      sanitized[field] = null
    }
  }
  return sanitized
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function withSanitizationAndRetry(
  collection: string,
  data: Record<string, unknown>[],
  uploadFn: (data: Record<string, unknown>[]) => Promise<void>,
  options: RetryOptions = {}
): Promise<void> {
  const {maxRetries = 3, initialDelayMs = 1000} = options
  
  return withRetry(async () => {
    try {
      await uploadFn(data)
    } catch (error) {
      if (!isValidationError(error)) {
        throw error
      }
      
      const invalidFields = getErrorFields(error)
      
      if (invalidFields.length === 0) {
        throw error
      }
      
      const sanitized = sanitizeBatch(data, invalidFields)
      const recordId = data[0]?.id ?? 'batch'
      
      for (const field of invalidFields) {
        console.log(`[SANITIZED] ${collection} (${recordId}): set ${field} to null`)
      }
      
      await uploadFn(sanitized)
    }
  }, {maxRetries, initialDelayMs})
}
