import {createItems} from '@directus/sdk'
import {ux} from '@oclif/core'

import {chunkArray} from '../../utils/chunk-array.js'
import {AliasFieldInfo, FilesContext} from '../types.js'
import {logErrorDetails} from '../utils/error-handling.js'

function isJunctionEntryId(id: string, context: FilesContext): boolean {
  if (!context.fileIdMapping) return false
  return !context.fileIdMapping.has(id)
}

export async function processFilesFields(
  records: any[],
  filesFields: AliasFieldInfo[],
  context: FilesContext
): Promise<any[]> {
  if (filesFields.length === 0) {
    return records
  }

  const allJunctionEntries: any[] = []

  const cleanedRecords = records.map((record: any) => {
    const cleanedRecord = {...record}

    for (const files of filesFields) {
      const filesValue = cleanedRecord[files.field]

      if (Array.isArray(filesValue) && filesValue.length > 0) {
        const parentId = cleanedRecord.id
        const skippedIds: string[] = []

        for (const [index, element] of filesValue.entries()) {
          const fileId = element as string

          if (context.fileIdMapping && isJunctionEntryId(fileId, context)) {
            skippedIds.push(fileId)
            continue
          }

          const junctionEntry: Record<string, unknown> = {
            [files.junctionField]: parentId,
            [files.relatedField]: fileId
          }

          if (files.sortField) {
            junctionEntry[files.sortField] = index + 1
          }

          allJunctionEntries.push(junctionEntry)
        }

        if (skippedIds.length > 0) {
          ux.stdout(ux.colorize('yellow', `-- [files-processor] WARNING: Skipping ${skippedIds.length} IDs that look like junction entry IDs (not file IDs) in ${files.field} for ${files.collection}`))
        }

        delete cleanedRecord[files.field]
      }
    }

    return cleanedRecord
  })

  if (allJunctionEntries.length > 0) {
    const junctionBatches = chunkArray(allJunctionEntries, context.BATCH_SIZE)
    const junctionCollection = filesFields[0].junctionTable

    await Promise.all(junctionBatches.map(async (batch) => {
      await insertJunctionEntries(junctionCollection, batch, context)
    }))
  }

  return cleanedRecords
}

export async function insertJunctionEntries(
  junctionTable: string,
  entries: any[],
  context: FilesContext
): Promise<void> {
  try {
    ux.stdout(ux.colorize('cyan', `-- [files-processor] Inserting ${entries.length} junction entries into ${junctionTable}`))
    await context.api.client.request(createItems(junctionTable, entries))
  } catch (error) {
    ux.stdout(ux.colorize('yellow', `-- [files-processor] JUNCTION INSERT ERROR on ${junctionTable}:`))
    logErrorDetails(error, 'files-processor')
    throw error
  }
}
