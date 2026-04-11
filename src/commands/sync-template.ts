import {Args, Flags, ux} from '@oclif/core'
import chalk from 'chalk'

import {disableTelemetry} from '../flags/common.js'
import {DIRECTUS_PURPLE} from '../lib/constants.js'
import syncTemplate from '../lib/sync-template/index.js'
import {animatedBunny} from '../lib/utils/animated-bunny.js'
import {shutdown, track} from '../services/posthog.js'
import {BaseCommand} from './base.js'

export interface SyncTemplateFlags {
  disableTelemetry?: boolean
  directusToken?: string
  directusUrl?: string
  frontend?: string
  installDeps?: boolean
  template?: string
}

export default class SyncTemplateCommand extends BaseCommand {
  static description = 'Sync a template to an existing empty project directory and import into running Directus.'
  static examples = [
    '$ directus-template-cli sync-template --template=agency-os --directusUrl="http://localhost:8055" --directusToken="xxx" --frontend="nuxt"',
    '$ directus-template-cli sync-template --template=https://github.com/owner/repo/tree/main/template --directusUrl="https://directus.example.com" --directusToken="xxx"',
  ]
  static flags = {
    disableTelemetry,
    directusToken: Flags.string({
      description: 'Admin access token for Directus',
    }),
    directusUrl: Flags.string({
      description: 'URL of running Directus instance',
    }),
    frontend: Flags.string({
      description: 'Frontend framework to set up (e.g., nuxt, nextjs, astro)',
    }),
    installDeps: Flags.boolean({
      allowNo: true,
      default: true,
      description: 'Install frontend dependencies automatically',
    }),
    template: Flags.string({
      description: 'Template name or GitHub URL',
    }),
  }

  static args = {
    directory: Args.string({
      description: 'Target directory (must exist and be empty)',
      required: false,
    }),
  }

  public async run(): Promise<void> {
    const {flags, args} = await this.parse(SyncTemplateCommand)
    const typedFlags = flags as SyncTemplateFlags
    const typedArgs = args as {directory?: string}

    await this.runInteractive(typedFlags, typedArgs)
  }

  private async runInteractive(flags: SyncTemplateFlags, args: {directory?: string}): Promise<void> {
    await animatedBunny('Let\'s sync a template!')
    const {intro, text, isCancel, log: clackLog} = await import('@clack/prompts')
    intro(`${chalk.bgHex(DIRECTUS_PURPLE).white.bold('Directus Template CLI')} - Sync Template`)

    let directory = args.directory
    if (!directory) {
      const dirResponse = await text({
        message: 'Enter the target directory (must exist and be empty):',
        placeholder: './my-project',
      })
      if (isCancel(dirResponse)) {
        clackLog.info('Cancelled')
        process.exit(0)
      }
      if (typeof dirResponse === 'string' && dirResponse.length > 0) {
        directory = dirResponse
      }
    }

    let template = flags.template
    if (!template) {
      const templateResponse = await text({
        message: 'Enter template name or GitHub URL:',
        placeholder: 'agency-os',
      })
      if (isCancel(templateResponse)) {
        clackLog.info('Cancelled')
        process.exit(0)
      }
      template = (templateResponse as string) || 'agency-os'
    }

    let directusUrl = flags.directusUrl
    if (!directusUrl) {
      const urlResponse = await text({
        message: 'Enter Directus URL:',
        placeholder: 'http://localhost:8055',
      })
      if (isCancel(urlResponse)) {
        clackLog.info('Cancelled')
        process.exit(0)
      }
      if (typeof urlResponse === 'string' && urlResponse.length > 0) {
        directusUrl = urlResponse
      }
    }

    let directusToken = flags.directusToken
    if (!directusToken) {
      const tokenResponse = await text({
        message: 'Enter Directus Admin Token:',
        placeholder: 'admin-token-here',
      })
      if (isCancel(tokenResponse)) {
        clackLog.info('Cancelled')
        process.exit(0)
      }
      if (typeof tokenResponse === 'string' && tokenResponse.length > 0) {
        directusToken = tokenResponse
      }
    }

    let frontend = flags.frontend
    const installDeps = flags.installDeps ?? true

    if (!flags.disableTelemetry) {
      await track({
        command: 'sync-template',
        config: this.config,
        distinctId: this.userConfig.distinctId,
        flags: {
          directory,
          template,
          directusUrl,
          directusToken: directusToken ? '***' : undefined,
          frontend,
          installDeps,
        },
        lifecycle: 'start',
        runId: this.runId,
      })
    }

    ux.stdout(`DEBUG: directory="${directory}" template="${template}" directusUrl="${directusUrl}" directusToken="${directusToken ? '***' : 'undefined'}"`)

    const missing: string[] = []
    if (!directory) missing.push('directory')
    if (!template) missing.push('template')
    if (!directusUrl) missing.push('directusUrl')
    if (!directusToken) missing.push('directusToken')

    if (missing.length > 0) {
      ux.error(`Missing required fields: ${missing.join(', ')}`)
      process.exit(1)
    }

    try {
      await syncTemplate({
        dir: directory!,
        template: template!,
        directusUrl: directusUrl!,
        directusToken: directusToken!,
        frontend,
        installDeps,
      })

      ux.stdout('Template synced successfully!')
    } catch (error) {
      ux.error(`Failed to sync template: ${error instanceof Error ? error.message : error}`)
    }

    if (!flags.disableTelemetry) {
      await track({
        command: 'sync-template',
        config: this.config,
        distinctId: this.userConfig.distinctId,
        flags: {
          directory,
          template,
          directusUrl,
          frontend,
          installDeps,
        },
        lifecycle: 'complete',
        runId: this.runId,
      })
      await shutdown()
    }

    process.exit(0)
  }
}
