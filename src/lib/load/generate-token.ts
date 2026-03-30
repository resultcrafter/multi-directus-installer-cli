import {readUsers, updateUser} from '@directus/sdk'
import {ux} from '@oclif/core'

import {DIRECTUS_PINK} from '../constants.js'
import {api} from '../sdk.js'
import catchError from '../utils/catch-error.js'

function generateRandomToken(length = 32): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let result = ''
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }

  return result
}

export interface TokenResult {
  token: string
  userEmail: string
  userId: string
}

export async function generateStaticToken(): Promise<null | TokenResult> {
  try {
    const users = await api.client.request(readUsers({limit: -1})) as any[]

    if (!users || users.length === 0) {
      ux.warn('No users found to generate token for')
      return null
    }

    const adminUser = users.find(u => u.email === 'admin@example.com') || users[0]

    const staticToken = generateRandomToken()

    await api.client.request(updateUser(adminUser.id, {token: staticToken}))

    return {
      token: staticToken,
      userEmail: adminUser.email,
      userId: adminUser.id,
    }
  } catch (error) {
    catchError(error, {context: {operation: 'generateStaticToken'}})
    return null
  }
}

export async function loadGenerateToken() {
  ux.action.start(ux.colorize(DIRECTUS_PINK, 'Generating static token'))

  const result = await generateStaticToken()

  ux.action.stop()

  if (result) {
    ux.stdout(`Generated static token for user: ${result.userEmail}`)
    ux.stdout(`Token: ${result.token}`)
    ux.warn('Add this token to your frontend .env file as DIRECTUS_SERVER_TOKEN')
  }

  return result
}
