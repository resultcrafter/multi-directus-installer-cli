import {execa} from 'execa'

export interface CreatePostgresUserOptions {
  host: string
  user: string
  password: string
  database: string
  adminUser?: string
  adminPassword?: string
}

export async function createPostgresUser(options: CreatePostgresUserOptions): Promise<void> {
  const {
    host,
    user,
    password,
    database,
    adminUser = 'postgres',
    adminPassword = 'postgres',
  } = options

  const pgPassword = adminPassword.replace(/'/g, "'\"'\"'")

  try {
    await execa('psql', [
      '-h', host,
      '-U', adminUser,
      '--no-password',
      '-c', `CREATE USER "${user}" WITH PASSWORD '${password.replace(/'/g, "'\"'\"'")}'`
    ], {
      env: {
        PGPASSWORD: pgPassword,
      },
      reject: true,
    })
    console.log(`Created PostgreSQL user: ${user}`)
  } catch (error: any) {
    if (error.stdout?.includes('already exists') || error.stderr?.includes('already exists')) {
      console.log(`PostgreSQL user ${user} already exists, continuing...`)
    } else {
      throw error
    }
  }

  try {
    await execa('psql', [
      '-h', host,
      '-U', adminUser,
      '--no-password',
      '-c', `CREATE DATABASE "${database}" OWNER "${user}"`
    ], {
      env: {
        PGPASSWORD: pgPassword,
      },
      reject: true,
    })
    console.log(`Created PostgreSQL database: ${database}`)
  } catch (error: any) {
    if (error.stdout?.includes('already exists') || error.stderr?.includes('already exists')) {
      console.log(`PostgreSQL database ${database} already exists, continuing...`)
    } else {
      throw error
    }
  }
}
