import {glob} from 'glob'
import fs from 'node:fs'
import path from 'pathe'

import {detectPackageManager, installDependencies, type PackageManager} from 'nypm'
import {ux} from '@oclif/core'

import {readTemplateConfig} from '../utils/template-config.js'
import {checkAndNotifyPort} from '../init/port-check.js'

interface ApplyFrontendParams {
  dir: string
  frontend: string
  installDeps: boolean
}

export default async function applyFrontend({dir, frontend, installDeps}: ApplyFrontendParams): Promise<void> {
  const templateInfo = await readTemplateConfig(dir)
  let frontendDir: string | undefined

  if (templateInfo) {
    const selectedFrontend = templateInfo.frontendOptions.find(f => f.id === frontend)

    if (!selectedFrontend) {
      throw new Error(`Frontend "${frontend}" not found in template configuration`)
    }

    for (const fe of templateInfo.frontendOptions) {
      if (fe.id !== frontend) {
        const pathToRemove = path.join(dir, fe.path)
        if (fs.existsSync(pathToRemove)) {
          fs.rmSync(pathToRemove, {recursive: true})
        }
      }
    }

    frontendDir = path.join(dir, selectedFrontend.path)
    if (frontendDir !== path.join(dir, frontend)) {
      fs.renameSync(frontendDir, path.join(dir, frontend))
      frontendDir = path.join(dir, frontend)
    }
  }

  const directusEnvFile = path.join(dir, 'directus', '.env')
  let directusPort = 8055

  if (fs.existsSync(directusEnvFile)) {
    const dotenv = await import('dotenv')
    const parsedEnv = dotenv.parse(fs.readFileSync(directusEnvFile, 'utf8'))
    directusPort = parseInt(parsedEnv.DIRECTUS_PORT || '8055', 10)
  }

  if (frontendDir) {
    const frontendEnvFile = path.join(frontendDir, '.env')
    if (fs.existsSync(frontendEnvFile)) {
      const {port} = await checkAndNotifyPort('Frontend', 3000)
      updateEnvFile(frontendEnvFile, 'NUXT_PUBLIC_SITE_URL', `http://localhost:${port}`)
      updateEnvFile(frontendEnvFile, 'NITRO_PORT', String(port))
      updateEnvFile(frontendEnvFile, 'DIRECTUS_URL', `http://localhost:${directusPort}`)
      updateEnvFile(frontendEnvFile, 'CONTENT_SECURITY_POLICY_DIRECTIVES__FRAME_SRC',
        `http://localhost:${port},http://localhost:4321,http://localhost:5173,https://*.youtube.com,https://*.vimeo.com,https://*.wistia.net,https://*.loom.com`)
    }
  }

  await replaceFrontendPlaceholders(dir, String(directusPort))

  const packageManager = await detectPackageManager(frontendDir)

  if (installDeps && frontendDir) {
    const s = (await import('@clack/prompts')).spinner()
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
