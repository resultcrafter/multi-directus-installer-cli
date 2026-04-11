import {cancel, confirm, isCancel, log as clackLog, note, outro, select, spinner, text} from '@clack/prompts'
import {ux} from '@oclif/core'
import chalk from 'chalk'
import dotenv from 'dotenv'
import {execa} from 'execa'
import {downloadTemplate, type DownloadTemplateResult} from 'giget'
import {glob} from 'glob'
import fs from 'node:fs'
import {randomBytes} from 'node:crypto'
import {detectPackageManager, installDependencies, type PackageManager} from 'nypm'
import path from 'pathe'

import type {InitFlags} from '../../commands/init.js'

import ApplyBackendCommand from '../../commands/import-backend-data.js'
import {createDocker} from '../../services/docker.js'
import {BSL_LICENSE_CTA, BSL_LICENSE_HEADLINE, BSL_LICENSE_TEXT, pinkText} from '../constants.js'
import catchError from '../utils/catch-error.js'
import {createGigetString, parseGitHubUrl} from '../utils/parse-github-url.js'
import {readTemplateConfig} from '../utils/template-config.js'
import {checkAndNotifyPort} from './port-check.js'
import {DOCKER_CONFIG} from './config.js'
import {isSharedPostgresRunning, startSharedPostgres, waitForPostgresReady, getSharedPostgresErrorMessage} from './shared-postgres-manager.js'
import resolvePathAndCheckExistence from '../utils/path.js'

function generateSecurePassword(): string {
  return randomBytes(24).toString('base64').slice(0, 32)
}

function sanitizeProjectName(projectName: string): string {
  return projectName.replace(/[^a-z0-9]/gi, '_').toLowerCase()
}

/**
 * Get GitHub token for API requests.
 * Checks GIGET_AUTH first, then falls back to gh auth token.
 */
export async function getGitHubToken(): Promise<string | undefined> {
  if (process.env.GIGET_AUTH) {
    return process.env.GIGET_AUTH
  }

  try {
    const {stdout} = await execa('gh', ['auth', 'token'], {reject: false})
    return stdout.trim() || undefined
  } catch {
    return undefined
  }
}

async function copyLocalTemplate(localPath: string, targetDir: string): Promise<void> {
  const entries = await fs.promises.readdir(localPath, {withFileTypes: true})

  for (const entry of entries) {
    const srcPath = path.join(localPath, entry.name)
    const destPath = path.join(targetDir, entry.name)

    if (entry.isDirectory()) {
      await fs.promises.mkdir(destPath, {recursive: true})
      await copyLocalTemplate(srcPath, destPath)
    } else {
      await fs.promises.copyFile(srcPath, destPath)
    }
  }
}

function isLocalTemplatePath(templatePath: string): boolean {
  if (!templatePath) return false

  const resolved = resolvePathAndCheckExistence(templatePath, true)
  if (resolved) return true

  if (templatePath.startsWith('/') || templatePath.startsWith('./') || templatePath.startsWith('~')) {
    return fs.existsSync(templatePath)
  }

  return false
}

function updateEnvFile(envFilePath: string, key: string, value: string): void {
  if (!fs.existsSync(envFilePath)) return

  let content = fs.readFileSync(envFilePath, 'utf8')
  const regex = new RegExp(`^${key}=.*`, 'm')

  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`)
  } else {
    content += `\n${key}=${value}`
  }

  fs.writeFileSync(envFilePath, content)
}

function backupEnvFile(envFilePath: string): void {
  if (!fs.existsSync(envFilePath)) return

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const backupPath = `${envFilePath}.backup-${timestamp}`
  fs.copyFileSync(envFilePath, backupPath)
}

function parseConnectionString(connStr: string): {host: string, port: string, database: string, user: string, password: string} | null {
  try {
    const match = connStr.match(/^postgresql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)$/)
    if (match) {
      return {
        user: match[1],
        password: match[2],
        host: match[3],
        port: match[4],
        database: match[5],
      }
    }
  } catch {
    // Invalid connection string
  }
  return null
}

export async function init({dir, flags, cliRoot}: {dir: string, flags: InitFlags, cliRoot: string}) {
  // Check target directory
  const shouldForce: boolean = flags.overwriteDir

  if (fs.existsSync(dir) && !shouldForce) {
    throw new Error('Directory already exists. Use --overwrite-dir to override.')
  }

  // If template is a URL, we need to handle it differently
  const isDirectUrl = flags.template?.startsWith('http')
  const directusDir = path.join(dir, 'directus')
  let template: DownloadTemplateResult
  let packageManager: null | PackageManager = null
  let sourceTemplatePath: string | null = null

  try {
    // Check if template is a local path
    sourceTemplatePath = isLocalTemplatePath(flags.template || '')
      ? resolvePathAndCheckExistence(flags.template || '', true)
      : null

    if (sourceTemplatePath) {
      // Copy local template instead of downloading
      console.log(`Copying template from local path: ${sourceTemplatePath}`)
      await copyLocalTemplate(sourceTemplatePath, dir)
      // Create a mock template result for consistency
      template = {dir, template: {name: path.basename(sourceTemplatePath)}, downloaded: false} as unknown as DownloadTemplateResult
    } else {
      // Download the template from GitHub
      const parsedUrl = parseGitHubUrl(flags.template)
      const authToken = await getGitHubToken()

      // If it's a direct URL, we download the entire repository
      // Otherwise, we use the template from the starters repo
      template = await downloadTemplate(createGigetString(parsedUrl), {
        dir,
        force: shouldForce,
        auth: authToken,
      })

      // For direct URLs, we need to check if there's a directus directory
      // If not, assume the entire repo is a directus template
      if (isDirectUrl && !fs.existsSync(directusDir)) {
          // Move all files to directus directory
          fs.mkdirSync(directusDir, {recursive: true})
          const files = fs.readdirSync(dir)
          for (const file of files) {
            if (file !== 'directus') {
              fs.renameSync(path.join(dir, file), path.join(directusDir, file))
            }
          }
        }
    }

    // Read template configuration
    const templateInfo = readTemplateConfig(dir)
    let frontendDir: string | undefined

    // Handle frontends based on template configuration
    if (flags.frontend && templateInfo) {
      // Find the selected frontend in the configuration
      const selectedFrontend = templateInfo.frontendOptions.find(f => f.id === flags.frontend)

      if (!selectedFrontend) {
        throw new Error(`Frontend "${flags.frontend}" not found in template configuration`)
      }

      // Remove all frontend directories except the selected one
      for (const frontend of templateInfo.frontendOptions) {
        if (frontend.id !== flags.frontend) {
          const pathToRemove = path.join(dir, frontend.path)
          if (fs.existsSync(pathToRemove)) {
            fs.rmSync(pathToRemove, {recursive: true})
          }
        }
      }

      // Move the selected frontend to the correct location if needed
      frontendDir = path.join(dir, selectedFrontend.path)
      if (frontendDir !== path.join(dir, flags.frontend)) {
        fs.renameSync(frontendDir, path.join(dir, flags.frontend))
        frontendDir = path.join(dir, flags.frontend)
      }
    }

    const directusInfo = {
      email: '',
      password: '',
      url: '',
    }

    // Find and copy all .env.example files
    const envFiles = glob.sync(path.join(dir, '**', '.env.example'))

    // Process all env files first
    for (const file of envFiles) {
      const envFile = file.replace('.env.example', '.env')
      fs.copyFileSync(file, envFile)
    }

    // Ask user about database configuration
    // Present three options regardless of port status
    const dbOption = await select({
      message: 'Which database configuration would you like to use?',
      options: [
        {
          label: 'Embedded PostgreSQL',
          hint: 'PostgreSQL runs in Docker alongside Directus',
          value: 'embedded',
        },
        {
          label: 'External PostgreSQL (auto-create user)',
          hint: 'Create project-specific DB in existing PostgreSQL',
          value: 'external-auto',
        },
        {
          label: 'External PostgreSQL (enter credentials)',
          hint: 'Use existing database with provided credentials',
          value: 'external-manual',
        },
      ],
    })

    if (isCancel(dbOption)) {
      cancel('Project creation cancelled.')
      process.exit(0)
    }

    // Determine DB host based on platform and option
    let dbHost = 'database'

    if (dbOption !== 'embedded') {
      dbHost = process.platform === 'darwin' || process.platform === 'win32'
        ? 'host.docker.internal'
        : '172.17.0.1'
    }

    // Generate unique database name for this project
    const projectName = path.basename(dir)

    // Variables to be set based on dbOption
    let dbName = ''
    let dbUser = ''
    let dbPassword = ''

    // Handle database option
    if (dbOption === 'embedded') {
      // Embedded: use template's default database
      // Copy standalone docker-compose if it exists
      const standaloneCompose = path.join(directusDir, 'docker-compose.standalone.yaml')
      const targetCompose = path.join(directusDir, 'docker-compose.yaml')
      if (fs.existsSync(standaloneCompose)) {
        fs.copyFileSync(standaloneCompose, targetCompose)
        clackLog.info('Copied docker-compose.standalone.yaml for embedded PostgreSQL')
      }
      dbName = projectName.replace(/[^a-z0-9]/gi, '_').toLowerCase() + '_directus'
      dbUser = 'directus'
      dbPassword = 'directus'
    } else if (dbOption === 'external-auto') {
      // External with auto-create: run init-project-db.sh
      const externalHost = await text({
        message: 'Enter PostgreSQL host:',
        placeholder: 'localhost',
        initialValue: 'localhost',
      })
      if (isCancel(externalHost)) {
        cancel('Project creation cancelled.')
        process.exit(0)
      }

      const hostToUse = (externalHost as string) || 'localhost'

      clackLog.info(`Creating database for project ${projectName} on ${hostToUse}...`)

      try {
        const status = await isSharedPostgresRunning(cliRoot)

        if (!status.running && status.canAutoStart) {
          clackLog.info('Shared PostgreSQL is not running. Starting it automatically...')
          const startResult = await startSharedPostgres(cliRoot)

          if (!startResult.success) {
            clackLog.error(getSharedPostgresErrorMessage(startResult))
            clackLog.info('Please try a different database option or start PostgreSQL manually.')
            process.exit(1)
          }

          clackLog.info('Shared PostgreSQL started. Waiting for it to be ready...')
          const ready = await waitForPostgresReady(cliRoot)
          if (!ready) {
            clackLog.error('Shared PostgreSQL failed to become ready in time.')
            clackLog.info('Please try a different database option or start PostgreSQL manually.')
            process.exit(1)
          }

          clackLog.info('Shared PostgreSQL is ready.')
        } else if (!status.running && !status.canAutoStart) {
          clackLog.error(status.error || 'Cannot auto-start PostgreSQL')
          clackLog.info('Please try a different database option or start PostgreSQL manually.')
          process.exit(1)
        }

        const scriptPath = path.join(cliRoot, 'scripts', 'init-project-db.sh')
        await execa(scriptPath, [
          '--project-name', projectName,
          '--host', hostToUse,
          '--output', dir,
        ], {
          stdout: 'inherit',
          stderr: 'inherit',
        })

        // Read credentials from new-project-db-env
        const envPath = path.join(dir, 'new-project-db-env')
        if (fs.existsSync(envPath)) {
          const envContent = fs.readFileSync(envPath, 'utf8')
          const dbEnvMatch = (key: string) => {
            const match = envContent.match(new RegExp(`^${key}=(.+)$`, 'm'))
            return match ? match[1] : ''
          }
          dbName = dbEnvMatch('DB_DATABASE')
          dbUser = dbEnvMatch('DB_USER')
          dbPassword = dbEnvMatch('DB_PASSWORD')
          // For external DB, use host.docker.internal on macOS/windows to reach host's PostgreSQL
          if (process.platform === 'darwin' || process.platform === 'win32') {
            dbHost = 'host.docker.internal'
          } else {
            dbHost = dbEnvMatch('DB_HOST') || hostToUse
          }
        }
      } catch (error: any) {
        clackLog.error(`Failed to create database: ${error.message}`)
        clackLog.info('Please try a different database option or start PostgreSQL and try again.')
        process.exit(1)
      }
    } else if (dbOption === 'external-manual') {
      // External with manual credentials: prompt for connection string or fields
      const credsOption = await select({
        message: 'How would you like to enter credentials?',
        options: [
          { label: 'Connection string', value: 'connstr' },
          { label: 'Individual fields', value: 'fields' },
        ],
      })

      if (isCancel(credsOption)) {
        cancel('Project creation cancelled.')
        process.exit(0)
      }

      if (credsOption === 'connstr') {
        const connStr = await text({
          message: 'Enter PostgreSQL connection string:',
          placeholder: 'postgresql://user:password@host:5432/database',
        })
        if (isCancel(connStr)) {
          cancel('Project creation cancelled.')
          process.exit(0)
        }

        const parsed = parseConnectionString(connStr as string)
        if (parsed) {
          dbUser = parsed.user
          dbPassword = parsed.password
          dbHost = parsed.host
          dbName = parsed.database
          // dbPort is not in connection string, keep default or ask
        } else {
          clackLog.error('Invalid connection string format')
          process.exit(1)
        }
      } else {
        // Individual fields
        const manualHost = await text({
          message: 'Enter PostgreSQL host:',
          placeholder: 'localhost',
          initialValue: 'localhost',
        })
        const manualPort = await text({
          message: 'Enter PostgreSQL port:',
          placeholder: '5432',
          initialValue: '5432',
        })
        const manualDb = await text({
          message: 'Enter database name:',
        })
        const manualUser = await text({
          message: 'Enter database user:',
        })
        const manualPass = await text({
          message: 'Enter database password:',
        })

        if (isCancel(manualHost) || isCancel(manualPort) || isCancel(manualDb) || isCancel(manualUser) || isCancel(manualPass)) {
          cancel('Project creation cancelled.')
          process.exit(0)
        }

        dbHost = manualHost as string
        dbName = manualDb as string
        dbUser = manualUser as string
        dbPassword = manualPass as string
      }
    }

    // Check and assign available ports for Directus and Nuxt (not DB - it's shared or fixed)
    const directusEnvFile = path.join(directusDir, '.env')
    let directusPort = 8055
    let nuxtPort = 3000

    // Backup .env before modification
    backupEnvFile(directusEnvFile)

    // Check Directus port
    if (fs.existsSync(directusEnvFile)) {
      const {port} = await checkAndNotifyPort('Directus', 8055)
      directusPort = port
      console.log(`✅ Free Directus port: ${port}`)
      updateEnvFile(directusEnvFile, 'DIRECTUS_PORT', String(port))
      updateEnvFile(directusEnvFile, 'PUBLIC_URL', `http://localhost:${port}`)
      updateEnvFile(directusEnvFile, 'DB_DATABASE', dbName)
      updateEnvFile(directusEnvFile, 'DB_USER', dbUser)
      updateEnvFile(directusEnvFile, 'DB_PASSWORD', dbPassword)
      updateEnvFile(directusEnvFile, 'DB_HOST', dbHost)
    }

    // Check frontend port if frontend directory exists
    if (frontendDir) {
      const frontendEnvFile = path.join(frontendDir, '.env')
      if (fs.existsSync(frontendEnvFile)) {
        const {port} = await checkAndNotifyPort('Frontend', 3000)
        nuxtPort = port
        updateEnvFile(frontendEnvFile, 'NUXT_PUBLIC_SITE_URL', `http://localhost:${port}`)
        updateEnvFile(frontendEnvFile, 'NITRO_PORT', String(port))
        updateEnvFile(frontendEnvFile, 'DIRECTUS_URL', `http://localhost:${directusPort}`)
        updateEnvFile(frontendEnvFile, 'CONTENT_SECURITY_POLICY_DIRECTIVES__FRAME_SRC',
          `http://localhost:${port},http://localhost:4321,http://localhost:5173,https://*.youtube.com,https://*.vimeo.com,https://*.wistia.net,https://*.loom.com`)
      }
    }

    // Replace placeholders in frontend config files
    await replaceFrontendPlaceholders(dir, String(directusPort))

    // Then read Directus-specific info only from the Directus env file
    if (fs.existsSync(directusEnvFile)) {
      const parsedEnv = dotenv.parse(fs.readFileSync(directusEnvFile, 'utf8'))
      directusInfo.email = parsedEnv.ADMIN_EMAIL
      directusInfo.password = parsedEnv.ADMIN_PASSWORD
      directusInfo.url = parsedEnv.PUBLIC_URL
    }

    // Start Directus and apply template only if directus directory exists
    if (fs.existsSync(directusDir)) {
      const dockerService = createDocker(DOCKER_CONFIG)

      const dockerStatus = await dockerService.checkDocker()
      if (!dockerStatus.installed || !dockerStatus.running) {
        throw new Error(dockerStatus.message)
      }

      await dockerService.startContainers(directusDir)
      const healthCheckUrl = `${directusInfo.url}${DOCKER_CONFIG.healthCheckEndpoint}`

      const isHealthy = await dockerService.waitForHealthy(healthCheckUrl)

      if (!isHealthy) {
        throw new Error('Directus failed to become healthy')
      }

      const templatePath = path.join(dir, templateInfo?.config?.template as string)

      // Skip template application if blank mode is enabled
      if (flags.blank) {
        ux.stdout('Skipping template application (blank mode).')
      } else if (templatePath && fs.existsSync(templatePath)) {
        ux.stdout(`Applying template from: ${templatePath}`)
        await ApplyBackendCommand.run([
          `--directusUrl=${directusInfo.url}`,
          '-p',
          '--noExit',
          `--userEmail=${directusInfo.email}`,
          `--userPassword=${directusInfo.password}`,
          `--templateLocation=${templatePath}`,
        ])
      } else {
        ux.stdout('Skipping backend template application.')
      }
    }

    // Detect package manager even if not installing dependencies
    packageManager = await detectPackageManager(frontendDir)

    // Install dependencies if requested
    if (flags.installDeps) {
      const s = spinner()
      s.start('Installing dependencies')
      try {
        if (fs.existsSync(frontendDir)) {
          await installDependencies({
            cwd: frontendDir,
            packageManager,
            silent: true,
          })
        }
      } catch (error) {
        ux.warn('Failed to install dependencies')
        throw error
      }

      s.stop('Dependencies installed!')
    }

    // Initialize Git repo
    if (flags.gitInit) {
      const s = spinner()
      s.start('Initializing git repository')
      await initGit(dir)
      s.stop('Git repository initialized!')
    }

    // Finishing up
    const relativeDir = path.relative(process.cwd(), dir)

    const directusUrl = directusInfo.url ?? 'http://localhost:8055'
    const directusDirRelative = path.join(relativeDir, 'directus')
    const frontendDirRelative = flags.frontend ? path.join(relativeDir, flags.frontend) : ''

    const backendStartText = `- To start Directus: ${pinkText(`cd ${directusDirRelative} && docker compose up -d`)}\n`
    const directusLoginText = directusInfo.email && directusInfo.password
      ? `- Login at ${pinkText(directusUrl)} with ${pinkText(directusInfo.email)} / ${pinkText(directusInfo.password)}\n`
      : `- Complete onboarding at ${pinkText(directusUrl)}\n`
    const frontendUrlText = frontendDir && fs.existsSync(frontendDir)
      ? `- Frontend UI: ${pinkText(`http://localhost:${nuxtPort}`)}\n`
      : ''
    const frontendStartCmd = flags.frontend
      ? `- To start frontend: ${pinkText(`cd ${frontendDirRelative} && ${packageManager?.name ?? 'pnpm'} install && ${packageManager?.name ?? 'pnpm'} run dev`)}\n`
      : ''
    const projectText = `- Project files: ${pinkText(relativeDir)}\n`
    const readmeText = `- See ${pinkText(`./README.md`)} for more details`

    let nextSteps: string
    if (flags.blank) {
      const importText = pinkText('directus-template-cli import-backend-data')
      nextSteps = `${directusLoginText}${frontendUrlText}${frontendStartCmd}${projectText}${readmeText}\n- Directus is already running\n- To apply a template: ${importText}`
      note(nextSteps, 'Blank Directus Ready')
    } else {
      nextSteps = `${backendStartText}${directusLoginText}${frontendUrlText}${frontendStartCmd}${projectText}${readmeText}`
      note(nextSteps, 'Quick Start')
    }

    clackLog.warn(BSL_LICENSE_HEADLINE)
    clackLog.info(BSL_LICENSE_TEXT)
    clackLog.info(BSL_LICENSE_CTA)

    outro(`Problems or questions? Hop into the community at ${pinkText('https://directus.chat')}`)
  } catch (error) {
    catchError(error, {
      context: {dir, flags, function: 'init'},
      fatal: true,
      logToFile: true,
    })
  }

  return {
    directusDir,
    frontendDir: flags.frontend ? path.join(dir, flags.frontend) : undefined,
    template,
  }
}

/**
 * Replace placeholders in frontend config files with actual values
 * Handles {{DIRECTUS_PORT}} placeholder in next.config.ts, astro.config.ts, etc.
 */
async function replaceFrontendPlaceholders(dir: string, port: string): Promise<void> {
  const configFiles = glob.sync(path.join(dir, '**', 'next.config.*'))
  configFiles.push(...glob.sync(path.join(dir, '**', 'astro.config.*')))
  configFiles.push(...glob.sync(path.join(dir, '**', 'nuxt.config.*')))

  for (const file of configFiles) {
    try {
      const content = fs.readFileSync(file, 'utf8')
      const updated = content.replace(/\{\{DIRECTUS_PORT\}\}/g, port)
      if (updated !== content) {
        fs.writeFileSync(file, updated)
      }
    } catch {
      // Skip files that can't be read/written
    }
  }
}

/**
 * Initialize a git repository
 * @param targetDir - The directory to initialize the git repository in
 * @returns void
 */
async function initGit(targetDir: string): Promise<void> {
  try {
    await execa('git', ['init'], {cwd: targetDir})
  } catch (error) {
    catchError(error, {
      context: {function: 'initGit', targetDir},
      fatal: false,
      logToFile: true,
    })
  }
}
