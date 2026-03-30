import {updateItem} from '@directus/sdk'
import {ux} from '@oclif/core'

import {O2MContext, O2MFieldInfo} from '../types.js'
import {logErrorDetails} from '../utils/error-handling.js'

interface O2MUpdateParams {
  fkField: string
  parentId: string
  relatedIds: string[]
  relatedTable: string
}

export async function processO2MFields(
  records: any[],
  o2mFields: O2MFieldInfo[],
  context: O2MContext
): Promise<any[]> {
  if (o2mFields.length === 0) {
    return records
  }

  const cleanedRecords = records.map((record: any) => {
    const cleanedRecord = {...record}

    for (const o2m of o2mFields) {
      const o2mValue = cleanedRecord[o2m.field]

      if (Array.isArray(o2mValue) && o2mValue.length > 0) {
        const parentId = cleanedRecord.id
        const relatedIds = o2mValue

        const params: O2MUpdateParams = {
          fkField: o2m.fkField,
          parentId,
          relatedIds,
          relatedTable: o2m.relatedTable
        }

        updateRelatedTableFK(params, context)
          .catch(error => {
            ux.stdout(ux.colorize('yellow', `-- [o2m-processor] Error updating ${o2m.relatedTable}:`))
            logErrorDetails(error, 'o2m-processor')
          })

        delete cleanedRecord[o2m.field]
      }
    }

    return cleanedRecord
  })

  return cleanedRecords
}

async function updateRelatedTableFK(
  params: O2MUpdateParams,
  context: O2MContext
): Promise<void> {
  const {fkField, parentId, relatedIds, relatedTable} = params

  try {
    ux.stdout(ux.colorize('cyan',
      `-- [o2m-processor] UPDATE ${relatedTable} SET ${fkField}=${parentId} WHERE id IN (${relatedIds.length} ids)`))

    await Promise.all(relatedIds.map(async (id) => {
      await context.api.client.request(updateItem(relatedTable, id, { [fkField]: parentId }))
    }))
  } catch (error) {
    ux.stdout(ux.colorize('yellow', `-- [o2m-processor] UPDATE ERROR on ${relatedTable}:`))
    logErrorDetails(error, 'o2m-processor')
    throw error
  }
}
