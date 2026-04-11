import {glob} from 'glob'
import fs from 'node:fs'
import {fileURLToPath} from 'node:url'
import path, {dirname} from 'pathe'

import {downloadTemplate} from 'giget'
import {detectPackageManager, installDependencies} from 'nypm'
import {ux} from '@oclif/core'

import {createGigetString, parseGitHubUrl} from '../utils/parse-github-url.js'
import {readTemplateConfig} from '../utils/template-config.js'
import {getGitHubToken} from '../init/index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

interface SyncTemplateParams {
  dir: string
  template: string
  directusUrl: string
  directusToken: string
  frontend?: string
  installDeps?: boolean
}

export default async function syncTemplate({
  dir,
  template,
  directusUrl,
  directusToken,
  frontend,
  installDeps = true,
}: SyncTemplateParams): Promise<void> {
  if (!fs.existsSync(dir)) {
    ux.stdout(`Creating directory: ${dir}`)
    fs.mkdirSync(dir, {recursive: true})
  }

  const entries = fs.readdirSync(dir)
  if (entries.length > 0) {
    throw new Error(`Directory is not empty. Please provide an empty directory. Found ${entries.length} items.`)
  }

  const isDirectUrl = template.startsWith('http')
  const tempDir = path.join(__dirname, '..', '..', '..', 'tmp', `sync-template-${Date.now()}`)

  try {
    fs.mkdirSync(tempDir, {recursive: true})

    let templateDir: string

    if (isDirectUrl) {
      const parsedUrl = parseGitHubUrl(template)
      const authToken = await getGitHubToken()
      const result = await downloadTemplate(createGigetString(parsedUrl), {
        dir: tempDir,
        force: true,
        auth: authToken,
      })
      templateDir = result.dir
    } else {
      const parsedUrl = parseGitHubUrl(`resultcrafter/directus-starters/${template}`)
      const authToken = await getGitHubToken()
      const result = await downloadTemplate(createGigetString(parsedUrl), {
        dir: tempDir,
        force: true,
        auth: authToken,
      })
      templateDir = result.dir
    }

    await copyDirRecursive(templateDir, dir)

    const templateInfo = await readTemplateConfig(dir)
    let frontendDir: string | undefined

    if (templateInfo && templateInfo.frontendOptions.length > 0) {
      let selectedFrontend = frontend

      if (!selectedFrontend) {
        const {select} = await import('@clack/prompts')
        const response = await select({
          message: 'Which frontend framework do you want to set up?',
          options: templateInfo.frontendOptions.map(f => ({
            label: f.name,
            value: f.id,
          })),
        })
        selectedFrontend = response as string
      }

      const selected = templateInfo.frontendOptions.find(f => f.id === selectedFrontend)
      if (!selected) {
        throw new Error(`Frontend "${selectedFrontend}" not found in template configuration`)
      }

      for (const fe of templateInfo.frontendOptions) {
        if (fe.id !== selectedFrontend) {
          const pathToRemove = path.join(dir, fe.path)
          if (fs.existsSync(pathToRemove)) {
            fs.rmSync(pathToRemove, {recursive: true})
          }
        }
      }

      frontendDir = path.join(dir, selected.path)
      if (frontendDir !== path.join(dir, selectedFrontend)) {
        fs.renameSync(frontendDir, path.join(dir, selectedFrontend))
        frontendDir = path.join(dir, selectedFrontend)
      }
    }

    const envFiles = glob.sync(path.join(dir, '**', '.env.example'))
    for (const file of envFiles) {
      const envFile = file.replace('.env.example', '.env')
      fs.copyFileSync(file, envFile)
    }

    await runImportBackendData(dir, directusUrl, directusToken)

    if (frontendDir) {
      await setupFrontendEnv(dir, frontendDir, directusUrl)
    }

    if (installDeps && frontendDir) {
      const s = (await import('@clack/prompts')).spinner()
      s.start('Installing dependencies')
      const packageManager = await detectPackageManager(frontendDir)
      try {
        await installDependencies({
          cwd: frontendDir,
          packageManager,
          silent: true,
        })
      } catch (error) {
        ux.warn('Failed to install dependencies')
      }
      s.stop('Dependencies installed!')
    }
  } finally {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, {force: true, recursive: true})
    }
  }
}

async function copyDirRecursive(src: string, dest: string): Promise<void> {
  await fs.promises.mkdir(dest, {recursive: true})
  const entries = await fs.promises.readdir(src, {withFileTypes: true})

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)

    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, destPath)
    } else {
      await fs.promises.copyFile(srcPath, destPath)
    }
  }
}

async function runImportBackendData(dir: string, directusUrl: string, directusToken: string): Promise<void> {
  const templateInfo = await readTemplateConfig(dir)
  const templatePath = path.join(dir, templateInfo?.config?.template as string)

  if (!templatePath || !fs.existsSync(templatePath)) {
    ux.warn('No template path found, skipping backend import')
    return
  }

  const {api} = await import('../sdk.js')
  api.initialize(directusUrl)

  try {
    await api.loginWithToken(directusToken)
    const {readMe} = await import('@directus/sdk')
    const response = await api.client.request(readMe()) as any
    ux.stdout(`Logged in as ${response.first_name} ${response.last_name}`)
  } catch (error) {
    throw new Error('Failed to authenticate with Directus. Please check your token.')
  }

  const applyFlags = {
    schema: true,
    permissions: true,
    content: true,
    users: true,
    files: true,
    flows: true,
    dashboards: true,
    settings: true,
    extensions: true,
    directusToken,
    directusUrl,
    templateLocation: templatePath,
    templateType: 'local' as const,
    partial: false,
    programmatic: true,
    userEmail: '',
    userPassword: '',
  }

  const {default: importBackendData} = await import('../load/index.js')
  await importBackendData(templatePath, applyFlags)
}

async function setupFrontendEnv(dir: string, frontendDir: string, directusUrl: string): Promise<void> {
  const frontendEnvFile = path.join(frontendDir, '.env')
  if (fs.existsSync(frontendEnvFile)) {
    updateEnvFile(frontendEnvFile, 'DIRECTUS_URL', directusUrl)
  }

  await replaceFrontendPlaceholders(dir, '8055')
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
