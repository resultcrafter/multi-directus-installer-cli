import {execSync} from 'node:child_process'
import {execa} from 'execa'

export interface PortCheckResult {
  port: number
  available: boolean
}

export async function isPortAvailable(port: number): Promise<boolean> {
  try {
    if (process.platform === 'darwin') {
      const {stdout} = await execa('lsof', ['-i', `:${port}`, '-sTCP:LISTEN'])
      return stdout.trim() === ''
    } else if (process.platform === 'linux') {
      const {stdout} = await execa('ss', ['-tlpn', `-p:${port}`])
      return stdout.trim() === ''
    } else {
      const {stdout} = await execa('netstat', ['-ano', `-p: ${port}`])
      return stdout.trim() === ''
    }
  } catch {
    return true
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
