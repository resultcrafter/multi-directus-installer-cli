import {createItems, readItems, updateItemsBatch, updateSingleton} from '@directus/sdk'
import {ux} from '@oclif/core'
import path from 'pathe'

import {DIRECTUS_PINK} from '../constants.js'
import {api} from '../sdk.js'
import catchError, {isValidationError, getErrorFields} from '../utils/catch-error.js'
import {chunkArray} from '../utils/chunk-array.js'
import readFile from '../utils/read-file.js'
import {transformReferences} from '../transform/transform-references.js'
import {sanitizeBatch} from '../transform/sanitize-data.js'

const BATCH_SIZE = 50

export default async function loadData(
  dir: string,
  fileIdMapping?: Map<string, string>,
  userIdMapping?: Map<string, string>
) {
  const collections = readFile('collections', dir)
  ux.action.start(ux.colorize(DIRECTUS_PINK, `Loading data for ${collections.length} collections`))

  await prepareUserIdMapping(dir, userIdMapping)

  await loadSkeletonRecords(dir, fileIdMapping, userIdMapping)
  await loadFullData(dir, fileIdMapping, userIdMapping)
  await loadSingletons(dir, fileIdMapping, userIdMapping)

  ux.action.stop()
}

async function prepareUserIdMapping(dir: string, userIdMapping?: Map<string, string>): Promise<void> {
  if (!userIdMapping) return
  
  const contentDir = path.resolve(dir, 'content')
  const collections = readFile('collections', dir) as Array<{collection: string}>
  
  for (const collection of collections) {
    if (collection.collection.startsWith('directus_')) continue
    
    try {
      const data = readFile(collection.collection, contentDir)
      if (Array.isArray(data) && data.length > 0) {
        const extractedIds = extractUserIdsFromContent(data)
        for (const id of extractedIds) {
          if (!userIdMapping.has(id)) {
            userIdMapping.set(id, '') // Placeholder - will be filled when we get admin ID
          }
        }
      }
    } catch {
      // Skip if file doesn't exist
    }
  }
  
  if (userIdMapping.size > 0) {
    try {
      const {readMe} = await import('@directus/sdk')
      const me = await api.client.request(readMe()) as {id: string}
      const adminUserId = me.id
      
      for (const [key] of userIdMapping) {
        userIdMapping.set(key, adminUserId)
      }
    } catch (error) {
      catchError(error)
    }
  }
}

function extractUserIdsFromContent(content: any[]): string[] {
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

async function loadSkeletonRecords(
  dir: string,
  fileIdMapping?: Map<string, string>,
  userIdMapping?: Map<string, string>
) {
  ux.action.status = 'Loading skeleton records'
  const collections = readFile('collections', dir)
  const primaryKeyMap = await getCollectionPrimaryKeys(dir)
  const userCollections = collections
  .filter(item => !item.collection.startsWith('directus_', 0))
  .filter(item => item.schema !== null)
  .filter(item => !item.meta.singleton)

  const mappings: Map<string, string>[] = []
  if (fileIdMapping && fileIdMapping.size > 0) mappings.push(fileIdMapping)
  if (userIdMapping && userIdMapping.size > 0) mappings.push(userIdMapping)

  await Promise.all(userCollections.map(async collection => {
    const name = collection.collection
    const primaryKeyField = getPrimaryKey(primaryKeyMap, name)
    const sourceDir = path.resolve(dir, 'content')
    let data = readFile(name, sourceDir)

    if (mappings.length > 0) {
      data = data.map((entry: any) => transformReferences(entry, mappings))
    }

    // Fetch existing primary keys
    const existingPrimaryKeys = await getExistingPrimaryKeys(name, primaryKeyField)

    // Filter out existing records
    const newData = data.filter((entry: any) => !existingPrimaryKeys.has(entry[primaryKeyField]))

    if (newData.length === 0) {
      // ux.stdout(`${ux.colorize('dim', '--')} Skipping ${name}: No new records to add`)
      return
    }

    const batches = chunkArray(newData, BATCH_SIZE).map((batch: any[]) =>
      batch.map((entry: any) => ({[primaryKeyField]: entry[primaryKeyField]})),
    )

    await Promise.all(batches.map(batch => uploadBatch(name, batch, createItems)))
    // ux.stdout(`${ux.colorize('dim', '--')} Added ${newData.length} new skeleton records to ${name}`)
  }))

  ux.action.status = 'Loaded skeleton records'
}

async function getExistingPrimaryKeys(collection: string, primaryKeyField: string): Promise<Set<any>> {
  const existingKeys = new Set()
  let page = 1
  const limit = 1000 // Adjust based on your needs and API limits

  while (true) {
    try {
      // @ts-ignore
      const response = await api.client.request(readItems(collection, {
        fields: [primaryKeyField],
        limit,
        page,
      }))

      if (response.length === 0) break

      for (const item of response) existingKeys.add(item[primaryKeyField])

      if (response.length < limit) break
      page++
    } catch (error) {
      catchError(error)
      break
    }
  }

  return existingKeys
}

async function uploadBatch(collection: string, batch: any[], method: Function) {
  try {
    await api.client.request(method(collection, batch))
  } catch (error) {
    catchError(error)
  }
}

async function uploadBatchWithSanitization(collection: string, batch: any[]) {
  try {
    await api.client.request(updateItemsBatch(collection, batch))
  } catch (error) {
    if (isValidationError(error)) {
      const invalidFields = getErrorFields(error)
      
      if (invalidFields.length > 0) {
        const sanitized = sanitizeBatch(batch, invalidFields)
        console.log(`[SANITIZED] ${collection}: set ${invalidFields.join(', ')} to null`)
        
        try {
          await api.client.request(updateItemsBatch(collection, sanitized))
          return
        } catch (retryError) {
          catchError(retryError)
          return
        }
      }
    }
    
    catchError(error)
  }
}

async function loadFullData(
  dir: string,
  fileIdMapping?: Map<string, string>,
  userIdMapping?: Map<string, string>
) {
  ux.action.status = 'Updating records with full data'
  const collections = readFile('collections', dir)
  const userCollections = collections
  .filter(item => !item.collection.startsWith('directus_', 0))
  .filter(item => item.schema !== null)
  .filter(item => !item.meta.singleton)

  const mappings: Map<string, string>[] = []
  if (fileIdMapping && fileIdMapping.size > 0) mappings.push(fileIdMapping)
  if (userIdMapping && userIdMapping.size > 0) mappings.push(userIdMapping)

  await Promise.all(userCollections.map(async collection => {
    const name = collection.collection
    const sourceDir = path.resolve(dir, 'content')
    let data = readFile(name, sourceDir)

    if (mappings.length > 0) {
      data = data.map((entry: any) => transformReferences(entry, mappings))
    }

    const batches = chunkArray(data, BATCH_SIZE).map((batch: any[]) =>
      batch.map(({user_created, user_updated, ...cleanedRow}: any) => cleanedRow),
    )

    await Promise.all(batches.map(batch => uploadBatchWithSanitization(name, batch)))
  }))

  ux.action.status = 'Updated records with full data'
}

async function loadSingletons(
  dir: string,
  fileIdMapping?: Map<string, string>,
  userIdMapping?: Map<string, string>
) {
  ux.action.status = 'Loading data for singleton collections'
  const collections = readFile('collections', dir)
  const singletonCollections = collections
  .filter(item => !item.collection.startsWith('directus_', 0))
  .filter(item => item.meta.singleton)

  const mappings: Map<string, string>[] = []
  if (fileIdMapping && fileIdMapping.size > 0) mappings.push(fileIdMapping)
  if (userIdMapping && userIdMapping.size > 0) mappings.push(userIdMapping)

  await Promise.all(singletonCollections.map(async collection => {
    const name = collection.collection
    const sourceDir = path.resolve(dir, 'content')
    let data = readFile(name, sourceDir)
    try {
      let cleanedData = data
      if (mappings.length > 0) {
        cleanedData = transformReferences(data, mappings)
      }
      const {user_created, user_updated, ...rest} = cleanedData as any

      await api.client.request(updateSingleton(name, rest))
    } catch (error) {
      catchError(error)
    }
  }))

  ux.action.status = 'Loaded data for singleton collections'
}

async function getCollectionPrimaryKeys(dir: string) {
  const fields = readFile('fields', dir)
  const primaryKeys = {}
  for (const field of fields) {
    if (field.schema && field.schema?.is_primary_key) {
      primaryKeys[field.collection] = field.field
    }
  }

  return primaryKeys
}

function getPrimaryKey(collectionsMap: any, collection: string) {
  if (!collectionsMap[collection]) {
    catchError(`Collection ${collection} not found in collections map`)
  }

  return collectionsMap[collection]
}
