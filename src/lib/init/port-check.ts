import {execa} from 'execa'

export interface PortCheckResult {
  port: number
  available: boolean
}

export async function isPortAvailable(port: number): Promise<boolean> {
  try {
    const {exitCode} = await execa('nc', ['-z', '-w', '1', 'localhost', String(port)])
    return exitCode !== 0
  } catch {
    return true
  }
}

export async function isPostgresAvailable(): Promise<boolean> {
  try {
    const {exitCode} = await execa('nc', ['-z', '-w', '1', 'localhost', '5432'])
    return exitCode === 0
  } catch {
    return false
  }
}

export async function findAvailablePort(
  startPort: number,
  maxAttempts: number = 10
): Promise<{port: number; attempts: number}> {
  let port = startPort

  for (let i = 0; i < maxAttempts; i++) {
    const available = await isPortAvailable(port)
    if (available) {
      return {port, attempts: i + 1}
    }
    port++
  }

  throw new Error(
    `No available port found in range ${startPort}-${startPort + maxAttempts - 1}. Please close unused applications.`
  )
}

export async function checkAndNotifyPort(
  serviceName: string,
  defaultPort: number,
  maxAttempts: number = 10
): Promise<{port: number; usedDefault: boolean}> {
  const {port, attempts} = await findAvailablePort(defaultPort, maxAttempts)
  const usedDefault = port === defaultPort

  if (!usedDefault) {
    console.log(`Port ${defaultPort} is in use, using port ${port} for ${serviceName}`)
  }

  return {port, usedDefault}
}
