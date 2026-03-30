import {createItems} from '@directus/sdk'
import {ux} from '@oclif/core'

import {chunkArray} from '../../utils/chunk-array.js'
import {AliasFieldInfo, M2MContext} from '../types.js'
import {logErrorDetails} from '../utils/error-handling.js'

export async function processM2MFields(
  records: any[],
  m2mFields: AliasFieldInfo[],
  context: M2MContext
): Promise<any[]> {
  if (m2mFields.length === 0) {
    return records
  }

  const allJunctionEntries: any[] = []

  const cleanedRecords = records.map((record: any) => {
    const cleanedRecord = {...record}

    for (const m2m of m2mFields) {
      const m2mValue = cleanedRecord[m2m.field]

      if (Array.isArray(m2mValue) && m2mValue.length > 0) {
        const parentId = cleanedRecord.id

        for (const [index, element] of m2mValue.entries()) {
          const relatedId = element as string
          const junctionEntry: Record<string, unknown> = {
            [m2m.junctionField]: parentId,
            [m2m.relatedField]: relatedId
          }

          if (m2m.sortField) {
            junctionEntry[m2m.sortField] = index + 1
          }

          allJunctionEntries.push(junctionEntry)
        }

        delete cleanedRecord[m2m.field]
      }
    }

    return cleanedRecord
  })

  if (allJunctionEntries.length > 0) {
    const junctionBatches = chunkArray(allJunctionEntries, context.BATCH_SIZE)
    const junctionCollection = m2mFields[0].junctionTable

    await Promise.all(junctionBatches.map(async (batch) => {
      await insertJunctionEntries(junctionCollection, batch, context)
    }))
  }

  return cleanedRecords
}

export async function insertJunctionEntries(
  junctionTable: string,
  entries: any[],
  context: M2MContext
): Promise<void> {
  try {
    ux.stdout(ux.colorize('cyan', `-- [m2m-processor] Inserting ${entries.length} junction entries into ${junctionTable}`))
    await context.api.client.request(createItems(junctionTable, entries))
  } catch (error) {
    ux.stdout(ux.colorize('yellow', `-- [m2m-processor] JUNCTION INSERT ERROR on ${junctionTable}:`))
    logErrorDetails(error, 'm2m-processor')
    throw error
  }
}
