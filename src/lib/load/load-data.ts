import {createItems, readItems, updateItemsBatch, updateSingleton} from '@directus/sdk'
import {ux} from '@oclif/core'
import fs from 'node:fs'
import path from 'pathe'

import {DIRECTUS_PINK} from '../constants.js'
import {api} from '../sdk.js'
import {sanitizeBatch} from '../transform/sanitize-data.js'
import {transformReferences} from '../transform/transform-references.js'
import catchError, {getErrorFields, isValidationError} from '../utils/catch-error.js'
import {chunkArray} from '../utils/chunk-array.js'
import readFile from '../utils/read-file.js'
import {clearAliasFieldsCache, detectAliasFields, detectO2MFields} from './alias-field-detector.js'
import {processFilesFields} from './processors/files-processor.js'
import {processM2MFields} from './processors/m2m-processor.js'
import {processO2MFields} from './processors/o2m-processor.js'
import {O2MContext} from './types.js'

const BATCH_SIZE = 50

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

function verifyFileIdMapping(fileIdMapping: Map<string, string> | undefined, dir: string): boolean {
  if (!fileIdMapping || fileIdMapping.size === 0) {
    ux.stdout(ux.colorize('yellow', `-- [loadData] Warning: fileIdMapping is empty`))
    return true
  }

  ux.stdout(ux.colorize('dim', `-- [loadData] Verifying fileIdMapping completeness...`))

  const contentDir = path.resolve(dir, 'content')
  const referencedFileIds = new Set<string>()

  function traverseForFileIds(obj: unknown): void {
    if (obj === null || obj === undefined) return

    if (Array.isArray(obj)) {
      for (const item of obj) traverseForFileIds(item)
      return
    }

    if (typeof obj === 'object') {
      for (const [key, value] of Object.entries(obj)) {
        if (key === 'image' || key === 'file' || key === 'avatar' || key === 'thumbnail' || key === 'logo' || key === 'cover') {
          if (typeof value === 'string' && isUuid(value)) {
            referencedFileIds.add(value)
          }
        } else if (typeof value === 'object' && value !== null) {
          traverseForFileIds(value)
        }
      }
    }
  }

  try {
    const contentFiles = fs.readdirSync(contentDir)
    for (const file of contentFiles) {
      if (!file.endsWith('.json')) continue

      try {
        const data = JSON.parse(fs.readFileSync(path.join(contentDir, file), 'utf8'))
        if (Array.isArray(data)) {
          // eslint-disable-next-line max-depth -- JSON structure validation requires nested checks
          for (const item of data) traverseForFileIds(item)
        } else if (typeof data === 'object') {
          traverseForFileIds(data)
        }
      } catch {
        // Skip invalid JSON files
      }
    }
  } catch {
    // Content directory might not exist
  }

  const unmappedIds: string[] = []
  for (const fileId of referencedFileIds) {
    if (!fileIdMapping.has(fileId)) {
      unmappedIds.push(fileId)
    }
  }

  if (unmappedIds.length > 0) {
    ux.stdout(ux.colorize('red', `-- [loadData] ERROR: Unmapped file IDs detected!`))
    ux.stdout(ux.colorize('red', `-- [loadData] The following file IDs are referenced in content but not mapped:`))
    for (const id of unmappedIds.slice(0, 10)) {
      ux.stdout(ux.colorize('red', `-- [loadData]   - ${id}`))
    }

    if (unmappedIds.length > 10) {
      ux.stdout(ux.colorize('red', `-- [loadData]   ... and ${unmappedIds.length - 10} more`))
    }

    ux.stdout(ux.colorize('red', `-- [loadData] Aborting data load due to incomplete fileIdMapping`))
    return false
  }

  ux.stdout(ux.colorize('dim', `-- [loadData] fileIdMapping verification passed`))
  return true
}

export default async function loadData(
  dir: string,
  fileIdMapping?: Map<string, string>,
  userIdMapping?: Map<string, string>
) {
  const collections = readFile('collections', dir)
  ux.action.start(ux.colorize(DIRECTUS_PINK, `Loading data for ${collections.length} collections`))

  await prepareUserIdMapping(dir, userIdMapping)

  if (!verifyFileIdMapping(fileIdMapping, dir)) {
    ux.action.stop()
    return
  }

  clearAliasFieldsCache()

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
         
        const extractedIds = extractUserIdsFromContent(data, collection.collection)
        for (const id of extractedIds) {
          // eslint-disable-next-line max-depth -- ID mapping validation requires nested checks
          if (!userIdMapping.has(id)) {
            userIdMapping.set(id, '')
          }
        }
      }
    } catch {
      // Skip if file doesn't exist
    }
  }
  
  if (userIdMapping.size > 0) {
    try {
      ux.stdout(ux.colorize('dim', `-- [loadData] Calling readMe() to get admin ID`))
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

function isUserCollection(collectionName: string): boolean {
  const name = collectionName.toLowerCase()
  return name === 'users' || name === 'directus_users' || name.includes('user')
}

function extractUserIdsFromContent(content: any[], collectionName: string): string[] {
  const userIds = new Set<string>()
  const isUserColl = isUserCollection(collectionName)
  
  function traverse(obj: any): void {
    if (obj === null || obj === undefined) return
    
    if (Array.isArray(obj)) {
      for (const item of obj) traverse(item)
      return
    }
    
    if (typeof obj === 'object') {
      for (const [key, value] of Object.entries(obj)) {
        if (key === 'id') continue
        if (key === 'user_created' || key === 'user_updated') {
          if (typeof value === 'string' && value.length > 0) {
            userIds.add(value)
          }
        } else if (key === 'author' && isUserColl) {
          if (typeof value === 'string' && value.length > 0) {
            userIds.add(value)
          }
        } else {
          traverse(value)
        }
      }
    }
  }
  
  for (const item of content) traverse(item)
  return [...userIds]
}

async function loadSkeletonRecords(
  dir: string,
  fileIdMapping?: Map<string, string>,
  userIdMapping?: Map<string, string>
) {
  ux.action.status = 'Loading skeleton records'
  const collections = readFile('collections', dir)
  const primaryKeyMap = await getCollectionPrimaryKeys(dir)
  const junctionTables = getJunctionTables(dir)
  
  if (junctionTables.size > 0) {
    ux.stdout(ux.colorize('dim', `-- [loadData] Skipping ${junctionTables.size} junction tables (handled by M2M processor)`))
  }
  
  const userCollections = collections
  .filter(item => !item.collection.startsWith('directus_', 0))
  .filter(item => item.schema !== null)
  .filter(item => !item.meta.singleton)
  .filter(item => !junctionTables.has(item.collection))

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

    const existingPrimaryKeys = await getExistingPrimaryKeys(name, primaryKeyField)

    const newData = data.filter((entry: any) => !existingPrimaryKeys.has(entry[primaryKeyField]))

    if (newData.length === 0) {
      return
    }

    ux.stdout(ux.colorize('cyan', `-- [loadData] Processing ${name}: ${newData.length} new records`))
    
    const batches = chunkArray(newData, BATCH_SIZE).map((batch: any[]) =>
      batch.map((entry: any) => ({[primaryKeyField]: entry[primaryKeyField]})),
    )

    await Promise.all(batches.map(batch => uploadBatch(name, batch, createItems)))
  }))

  ux.action.status = 'Loaded skeleton records'
}

async function getExistingPrimaryKeys(collection: string, primaryKeyField: string): Promise<Set<any>> {
  const existingKeys = new Set()
  let page = 1
  const limit = 1000

  ux.stdout(ux.colorize('dim', `-- [getExistingPrimaryKeys] Reading existing keys for ${collection}`))
  while (true) {
    try {
      ux.stdout(ux.colorize('dim', `-- [getExistingPrimaryKeys] API call for ${collection} page ${page}`))
      // eslint-disable-next-line no-await-in-loop -- Pagination requires sequential await
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

async function uploadBatch(collection: string, batch: any[], method: any) {
  try {
    ux.stdout(ux.colorize('dim', `-- [uploadBatch] Uploading ${batch.length} items to ${collection}`))
    await api.client.request(method(collection, batch))
  } catch (error) {
    const errorDetails = extractErrorDetails(error)
    ux.stdout(ux.colorize('yellow', `-- [uploadBatch] ERROR on ${collection}:`))
    ux.stdout(ux.colorize('yellow', `-- [uploadBatch]   Message: ${errorDetails.message}`))
    ux.stdout(ux.colorize('yellow', `-- [uploadBatch]   Status: ${errorDetails.status}`))
    ux.stdout(ux.colorize('yellow', `-- [uploadBatch]   Code: ${errorDetails.code}`))
    if (errorDetails.extensions) {
      ux.stdout(ux.colorize('yellow', `-- [uploadBatch]   Extensions: ${JSON.stringify(errorDetails.extensions)}`))
    }

    ux.stdout(ux.colorize('dim', `-- [uploadBatch]   Batch data: ${JSON.stringify(batch).slice(0, 200)}`))
    catchError(error)
  }
}

function extractErrorDetails(error: unknown): {code: string, extensions?: any; message: string, status: number,} {
  if (error && typeof error === 'object') {
    const e = error as any
    if (e.errors && Array.isArray(e.errors) && e.errors.length > 0) {
      return {
        code: e.errors[0].extensions?.code || 'UNKNOWN',
        extensions: e.errors[0].extensions,
        message: e.errors[0].message || 'Unknown error',
        status: e.status || 0
      }
    }

    if (e.message) {
      return {
        code: e.code || 'UNKNOWN',
        message: e.message,
        status: e.status || 0
      }
    }
  }

  return { code: 'UNKNOWN', message: String(error), status: 0 }
}

async function uploadBatchWithSanitization(collection: string, batch: any[]) {
  try {
    await api.client.request(updateItemsBatch(collection, batch))
  } catch (error) {
    const errorDetails = extractErrorDetails(error)
    ux.stdout(ux.colorize('yellow', `-- [uploadBatchWithSanitization] ERROR on ${collection}:`))
    ux.stdout(ux.colorize('yellow', `-- [uploadBatchWithSanitization]   Message: ${errorDetails.message}`))
    ux.stdout(ux.colorize('yellow', `-- [uploadBatchWithSanitization]   Status: ${errorDetails.status}`))
    ux.stdout(ux.colorize('yellow', `-- [uploadBatchWithSanitization]   Code: ${errorDetails.code}`))
    if (errorDetails.extensions) {
      ux.stdout(ux.colorize('yellow', `-- [uploadBatchWithSanitization]   Extensions: ${JSON.stringify(errorDetails.extensions)}`))
    }

    ux.stdout(ux.colorize('dim', `-- [uploadBatchWithSanitization]   Batch data: ${JSON.stringify(batch).slice(0, 200)}`))
    
    if (isValidationError(error)) {
      const invalidFields = getErrorFields(error)
      
      if (invalidFields.length > 0) {
        const sanitized = sanitizeBatch(batch, invalidFields)
        console.log(`[SANITIZED] ${collection}: set ${invalidFields.join(', ')} to null`)
        
        try {
          await api.client.request(updateItemsBatch(collection, sanitized))
          return
        } catch (retryError) {
          const retryDetails = extractErrorDetails(retryError)
          ux.stdout(ux.colorize('yellow', `-- [uploadBatchWithSanitization] RETRY ERROR on ${collection}:`))
          ux.stdout(ux.colorize('yellow', `-- [uploadBatchWithSanitization]   Message: ${retryDetails.message}`))
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
  const junctionTables = getJunctionTables(dir)
  const userCollections = collections
  .filter(item => !item.collection.startsWith('directus_', 0))
  .filter(item => item.schema !== null)
  .filter(item => !item.meta.singleton)
  .filter(item => !junctionTables.has(item.collection))

  const mappings: Map<string, string>[] = []
  if (fileIdMapping && fileIdMapping.size > 0) mappings.push(fileIdMapping)
  if (userIdMapping && userIdMapping.size > 0) mappings.push(userIdMapping)

  const aliasFields = detectAliasFields(dir)
  const o2mFields = detectO2MFields(dir)

  if (aliasFields.length > 0 || o2mFields.length > 0) {
    ux.stdout(ux.colorize('cyan', `-- [loadFullData] Detected ${aliasFields.length} M2M/Files fields, ${o2mFields.length} O2M fields`))
  }

  const o2mContext: O2MContext = { api, BATCH_SIZE, dir }

  await Promise.all(userCollections.map(async collection => {
    const name = collection.collection
    const sourceDir = path.resolve(dir, 'content')
    let data = readFile(name, sourceDir)

    if (mappings.length > 0) {
      data = data.map((entry: any) => transformReferences(entry, mappings))
    }

    const m2mFields = aliasFields.filter(f => f.collection === name && f.relationType === 'm2m')
    const filesFields = aliasFields.filter(f => f.collection === name && f.relationType === 'files')
    const collectionO2MFields = o2mFields.filter(f => f.collection === name)

    if (m2mFields.length > 0) {
      ux.stdout(ux.colorize('cyan', `-- [loadFullData] Processing M2M fields for ${name}`))
      data = await processM2MFields(data, m2mFields, { api, BATCH_SIZE, dir })
    }

    if (filesFields.length > 0) {
      ux.stdout(ux.colorize('cyan', `-- [loadFullData] Processing Files fields for ${name}`))
      data = await processFilesFields(data, filesFields, { api, BATCH_SIZE, dir, fileIdMapping })
    }

    if (collectionO2MFields.length > 0) {
      ux.stdout(ux.colorize('cyan', `-- [loadFullData] Processing O2M fields for ${name}`))
      data = await processO2MFields(data, collectionO2MFields, o2mContext)
    }

    const batches = chunkArray(data, BATCH_SIZE).map((batch: any[]) =>
      batch.map(({user_created: _user_created, user_updated: _user_updated, ...cleanedRow}: any) => cleanedRow),
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
    const data = readFile(name, sourceDir)
    try {
      let cleanedData = data
      if (mappings.length > 0) {
        cleanedData = transformReferences(data, mappings)
      }

      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Directus system fields excluded from singleton updates
      const {user_created: _user_created, user_updated: _user_updated, ...rest} = cleanedData as any

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

function getJunctionTables(dir: string): Set<string> {
  const relations = readFile('relations', dir) as any[]
  const junctionTables = new Set<string>()
  
  for (const relation of relations) {
    if (relation.meta?.junction_field && !relation.collection.startsWith('directus_')) {
      junctionTables.add(relation.collection)
    }
  }
  
  return junctionTables
}
