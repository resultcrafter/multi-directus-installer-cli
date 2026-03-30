import {ux} from '@oclif/core'

interface ErrorDetails {
  code: string
  extensions?: any
  message: string
  status: number
}

export function extractErrorDetails(error: unknown): ErrorDetails {
  if (error && typeof error === 'object') {
    const e = error as any
    if (e.errors && Array.isArray(e.errors) && e.errors.length > 0) {
      return {
        code: e.errors[0].extensions?.code || 'UNKNOWN',
        extensions: e.errors[0].extensions,
        message: e.errors[0].message || 'Unknown error',
        status: e.status || 0
      }
    }

    if (e.message) {
      return {
        code: e.code || 'UNKNOWN',
        message: e.message,
        status: e.status || 0
      }
    }
  }

  return { code: 'UNKNOWN', message: String(error), status: 0 }
}

export function logErrorDetails(error: unknown, context: string): void {
  const details = extractErrorDetails(error)
  ux.stdout(ux.colorize('yellow', `-- [${context}] ERROR:`))
  ux.stdout(ux.colorize('yellow', `-- [${context}]   Message: ${details.message}`))
  ux.stdout(ux.colorize('yellow', `-- [${context}]   Status: ${details.status}`))
  ux.stdout(ux.colorize('yellow', `-- [${context}]   Code: ${details.code}`))
  if (details.extensions) {
    ux.stdout(ux.colorize('yellow', `-- [${context}]   Extensions: ${JSON.stringify(details.extensions)}`))
  }
}
