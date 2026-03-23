import {createUser, readUsers, readMe} from '@directus/sdk'
import {ux} from '@oclif/core'

import {DIRECTUS_PINK} from '../constants.js'
import {api} from '../sdk.js'
import catchError from '../utils/catch-error.js'
import getRoleIds from '../utils/get-role-ids.js'
import readFile from '../utils/read-file.js'

const userIdMapping: Map<string, string> = new Map()

export function getUserIdMapping(): Map<string, string> {
  return userIdMapping
}

export function extractUserIdsFromContent(content: any[]): string[] {
  const userIds = new Set<string>()
  
  function traverse(obj: any): void {
    if (obj === null || obj === undefined) return
    
    if (Array.isArray(obj)) {
      obj.forEach(item => traverse(item))
      return
    }
    
    if (typeof obj === 'object') {
      for (const [key, value] of Object.entries(obj)) {
        if ((key === 'user_created' || key === 'user_updated' || key === 'author') 
            && typeof value === 'string' && value.length > 0) {
          userIds.add(value)
        } else {
          traverse(value)
        }
      }
    }
  }
  
  content.forEach(item => traverse(item))
  return Array.from(userIds)
}

export async function createUserIdMapping(content: any[]): Promise<string> {
  const templateUserIds = extractUserIdsFromContent(content)
  
  if (templateUserIds.length === 0) {
    return ''
  }
  
  try {
    const me = await api.client.request(readMe())
    const adminUserId = me.id
    
    for (const templateUserId of templateUserIds) {
      userIdMapping.set(templateUserId, adminUserId)
    }
    
    return adminUserId
  } catch (error) {
    catchError(error)
    return ''
  }
}

export default async function loadUsers(
  dir: string,
) {
  const users = readFile('users', dir)
  ux.action.start(ux.colorize(DIRECTUS_PINK, `Loading ${users.length} users`))

  if (users && users.length > 0) {
    const {legacyAdminRoleId, newAdminRoleId} = await getRoleIds(dir)
    const existingUsers = await api.client.request(readUsers({
      limit: -1,
    }))

    const filteredUsers = users.map(user => {
    // If the user is an admin, we need to change their role to the new admin role
      const isAdmin = user.role === legacyAdminRoleId
      user.role = isAdmin ? newAdminRoleId : user.role

      // Delete the unneeded fields
      user.last_page = undefined
      user.token = undefined
      user.policies = undefined
      // Delete passwords to prevent setting to *******
      user.password = undefined

      return user
    })

    for await (const user of filteredUsers) {
      const existingUserWithSameId = existingUsers && Array.isArray(existingUsers)
        ? existingUsers.find(existing => existing.id === user.id)
        : undefined

      const existingUserWithSameEmail = existingUsers && Array.isArray(existingUsers)
        ? existingUsers.find(existing => existing.email === user.email)
        : undefined

      if (existingUserWithSameId) {
        // Skip if there's an existing user with the same id
        continue
      }

      if (existingUserWithSameEmail) {
        // Delete email if there's an existing user with the same email but different id
        user.email = undefined
      }

      if (user.email === null) {
        // Delete email if it's null
        user.email = undefined
      }

      try {
        await api.client.request(createUser(user))
      } catch (error) {
        catchError(error)
      }
    }
  }

  ux.action.stop()
}
