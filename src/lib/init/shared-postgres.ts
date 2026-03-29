import {execa} from 'execa'
import fs from 'node:fs'
import path from 'pathe'

export async function startSharedPostgres(projectDir: string): Promise<void> {
  const sharedPostgresPath = path.join(projectDir, '_shared', 'shared-postgres')

  if (!fs.existsSync(sharedPostgresPath)) {
    throw new Error(
      `Shared PostgreSQL not found at ${sharedPostgresPath}\n\n` +
      'To set up shared PostgreSQL:\n' +
      `1. Copy _shared/shared-postgres to your project directory\n` +
      `2. Run: docker compose -f ${sharedPostgresPath}/docker-compose.yaml up -d\n`
    )
  }

  const composeFile = path.join(sharedPostgresPath, 'docker-compose.yaml')
  if (!fs.existsSync(composeFile)) {
    throw new Error(`docker-compose.yaml not found at ${composeFile}`)
  }

  console.log('Starting shared PostgreSQL container...')
  await execa('docker', ['compose', '-f', composeFile, 'up', '-d'], {
    cwd: sharedPostgresPath,
  })

  console.log('Waiting for PostgreSQL to be healthy...')
  await waitForPostgresHealthy()
  console.log('✅ Shared PostgreSQL is ready')
}

async function waitForPostgresHealthy(maxWaitSeconds: number = 60): Promise<void> {
  const startTime = Date.now()
  const checkInterval = 2000

  while (Date.now() - startTime < maxWaitSeconds * 1000) {
    try {
      const {exitCode} = await execa('docker', [
        'inspect',
        '--format',
        '{{.State.Health.Status}}',
        'shared-postgres',
      ], {reject: true})

      if (exitCode === 0) {
        const {stdout} = await execa('docker', [
          'inspect',
          '--format',
          '{{.State.Health.Status}}',
          'shared-postgres',
        ])

        if (stdout.trim() === 'healthy') {
          return
        }
      }
    } catch {
      // Container might not exist yet
    }

    await new Promise(resolve => setTimeout(resolve, checkInterval))
  }

  throw new Error('PostgreSQL container did not become healthy in time')
}
