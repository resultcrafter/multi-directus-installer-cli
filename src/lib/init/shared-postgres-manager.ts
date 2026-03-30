import {execa} from 'execa'
import path from 'pathe'

export interface SharedPostgresStatus {
  running: boolean
  canAutoStart: boolean
  error?: string
}

export interface AutoStartResult {
  success: boolean
  error?: string
  errorType?: 'docker-not-installed' | 'docker-not-running' | 'port-in-use' | 'unknown'
}

/**
 * Get the path to the embedded shared-postgres docker-compose file
 */
export function getSharedPostgresComposePath(cliRoot: string): string {
  return path.join(cliRoot, 'scripts', 'shared-postgres', 'docker-compose.yaml')
}

/**
 * Check if Docker is available on the system
 */
export async function isDockerAvailable(): Promise<boolean> {
  try {
    await execa('docker', ['--version'], {reject: false})
    return true
  } catch {
    return false
  }
}

/**
 * Check if Docker daemon is running
 */
export async function isDockerRunning(): Promise<boolean> {
  try {
    await execa('docker', ['info'], {reject: false})
    return true
  } catch {
    return false
  }
}

/**
 * Check if shared-postgres container is running
 */
export async function isSharedPostgresRunning(cliRoot: string): Promise<SharedPostgresStatus> {
  const composePath = getSharedPostgresComposePath(cliRoot)

  const dockerAvailable = await isDockerAvailable()
  if (!dockerAvailable) {
    return {
      running: false,
      canAutoStart: false,
      error: 'Docker is not installed. Please install Docker to use the auto-create database feature.',
    }
  }

  const dockerRunning = await isDockerRunning()
  if (!dockerRunning) {
    return {
      running: false,
      canAutoStart: false,
      error: 'Docker daemon is not running. Please start Docker.',
    }
  }

  try {
    const {exitCode, stdout} = await execa('docker', [
      'compose',
      '-f', composePath,
      'ps',
      '--status=running',
    ], {
      reject: false,
    })

    const isRunning = exitCode === 0 && stdout.includes('shared-postgres')
    return {
      running: isRunning,
      canAutoStart: true,
    }
  } catch (error: any) {
    return {
      running: false,
      canAutoStart: false,
      error: error.message || 'Failed to check shared-postgres status',
    }
  }
}

/**
 * Wait for PostgreSQL to be ready to accept connections
 */
export async function waitForPostgresReady(cliRoot: string, timeoutMs: number = 30000): Promise<boolean> {
  const startTime = Date.now()
  const host = 'localhost'
  const port = '5432'

  while (Date.now() - startTime < timeoutMs) {
    try {
      const result = await execa('psql', [
        '-h', host,
        '-p', port,
        '-U', 'postgres',
        '-c', 'SELECT 1',
      ], {
        reject: false,
        env: {PGPASSWORD: 'postgres'},
      })

      if (result.exitCode === 0) {
        return true
      }
    } catch {
      // Connection failed, wait and retry
    }

    await new Promise(resolve => setTimeout(resolve, 1000))
  }

  return false
}

/**
 * Start shared-postgres container using the embedded docker-compose
 */
export async function startSharedPostgres(cliRoot: string): Promise<AutoStartResult> {
  const composePath = getSharedPostgresComposePath(cliRoot)

  const dockerAvailable = await isDockerAvailable()
  if (!dockerAvailable) {
    return {
      success: false,
      error: 'Docker is not installed. Please install Docker to use the auto-create database feature.',
      errorType: 'docker-not-installed',
    }
  }

  const dockerRunning = await isDockerRunning()
  if (!dockerRunning) {
    return {
      success: false,
      error: 'Docker daemon is not running. Please start Docker.',
      errorType: 'docker-not-running',
    }
  }

  try {
    await execa('docker', [
      'compose',
      '-f', composePath,
      'up',
      '-d',
    ], {
      stdout: 'inherit',
      stderr: 'pipe',
    })

    return {success: true}
  } catch (error: any) {
    const errorMessage = error.message || ''

    if (errorMessage.includes('port is already allocated') || errorMessage.includes('Bind for 0.0.0.0:5432 failed')) {
      return {
        success: false,
        error: 'Port 5432 is already in use. Please stop the service using this port or use a different database option.',
        errorType: 'port-in-use',
      }
    }

    return {
      success: false,
      error: `Failed to start shared-postgres: ${errorMessage}`,
      errorType: 'unknown',
    }
  }
}

/**
 * Get a user-friendly error message for shared-postgres auto-start failures
 */
export function getSharedPostgresErrorMessage(result: AutoStartResult): string {
  switch (result.errorType) {
    case 'docker-not-installed':
      return 'Docker is required but not found. Please install Docker: https://docs.docker.com/get-docker/'

    case 'docker-not-running':
      return 'Docker daemon is not running. Please start Docker and try again.'

    case 'port-in-use':
      return 'Port 5432 is already in use by another service. Please stop the conflicting service or use a different database option.'

    default:
      return result.error || 'Failed to start shared-postgres automatically. Please start it manually or use a different database option.'
  }
}
