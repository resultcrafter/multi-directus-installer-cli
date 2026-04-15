import { Args, Flags } from '@oclif/core'
import chalk from 'chalk'
import path from 'pathe'
import { execa } from 'execa'
import fs from 'node:fs'

import { BaseCommand } from './base.js'
import { disableTelemetry } from '../flags/common.js'

export interface CreateDbFlags {
  disableTelemetry?: boolean
  projectName?: string
  host?: string
  port?: string
}

export interface CreateDbArgs {
  projectName?: string
}

export default class CreateDbCommand extends BaseCommand {
  static args = {
    projectName: Args.string({
      description: 'Project name for database and user naming',
      required: false,
    }),
  }

  static description = 'Create a PostgreSQL database and user for a project'

  static examples = [
    '$ multi-directus-installer-cli create-db --project-name myproject',
    '$ multi-directus-installer-cli create-db myproject --host localhost',
    '$ multi-directus-installer-cli create-db --project-name myproject --host pg.example.com --port 5432',
  ]

  static flags = {
    disableTelemetry,
    projectName: Flags.string({
      description: 'Project name (used for database and username)',
      char: 'n',
    }),
    host: Flags.string({
      description: 'PostgreSQL host',
      char: 'h',
      default: 'localhost',
    }),
    port: Flags.string({
      description: 'PostgreSQL port',
      char: 'p',
      default: '5432',
    }),
  }

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(CreateDbCommand)
    const typedFlags = flags as CreateDbFlags
    const typedArgs = args as CreateDbArgs

    const projectName = typedFlags.projectName || typedArgs.projectName

    if (!projectName) {
      this.error('Error: --project-name is required')
      this.log(chalk.yellow('Usage: multi-directus-installer-cli create-db --project-name <name> [--host <host>] [--port <port>]'))
      process.exit(1)
    }

    const scriptPath = path.join(this.config.root as string, 'scripts', 'init-project-db.sh')

    if (!fs.existsSync(scriptPath)) {
      this.error(`Error: init-project-db.sh not found at ${scriptPath}`)
      process.exit(1)
    }

    this.log(chalk.blue(`Creating database for project: ${projectName}`))
    this.log(chalk.blue(`Host: ${typedFlags.host}, Port: ${typedFlags.port}`))
    this.log('')

    try {
      const result = await execa(scriptPath, [
        '--project-name', projectName,
        '--host', typedFlags.host || 'localhost',
        '--port', typedFlags.port || '5432',
      ], {
        stdout: 'inherit',
        stderr: 'inherit',
      })

      this.log('')
      this.log(chalk.green('Database created successfully!'))
    } catch (error: any) {
      this.error(chalk.red(`Failed to create database: ${error.message}`))
      process.exit(1)
    }
  }
}
