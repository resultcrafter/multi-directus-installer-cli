import {createItems, readItems} from '@directus/sdk'
import {ux} from '@oclif/core'

import {chunkArray} from '../../utils/chunk-array.js'
import {AliasFieldInfo, M2MContext} from '../types.js'
import {logErrorDetails} from '../utils/error-handling.js'

// Track processed junctions to prevent duplicates from bidirectional M2M processing
const processedJunctions = new Set<string>()

/**
 * Generate a deterministic key for a junction entry.
 * Sorts entity IDs to ensure {a,b} and {b,a} produce the same key.
 */
function getJunctionKey(junctionTable: string, entityId1: string, entityId2: string): string {
  const sorted = [entityId1, entityId2].sort()
  return `${junctionTable}:${sorted[0]}:${sorted[1]}`
}

export async function processM2MFields(
  records: any[],
  m2mFields: AliasFieldInfo[],
  context: M2MContext
): Promise<any[]> {
  if (m2mFields.length === 0) {
    return records
  }

  // Group junction entries by their junction table
  const junctionEntriesByTable = new Map<string, any[]>()

  const cleanedRecords = records.map((record: any) => {
    const cleanedRecord = {...record}

    for (const m2m of m2mFields) {
      const m2mValue = cleanedRecord[m2m.field]

      if (Array.isArray(m2mValue) && m2mValue.length > 0) {
        const parentId = cleanedRecord.id

        // Get or create array for this junction table
        if (!junctionEntriesByTable.has(m2m.junctionTable)) {
          junctionEntriesByTable.set(m2m.junctionTable, [])
        }
        const junctionEntries = junctionEntriesByTable.get(m2m.junctionTable)!

        for (const [index, element] of m2mValue.entries()) {
          const relatedId = element as string
          const junctionEntry: Record<string, unknown> = {
            [m2m.junctionField]: parentId,
            [m2m.relatedField]: relatedId
          }

          if (m2m.sortField) {
            junctionEntry[m2m.sortField] = index + 1
          }

          junctionEntries.push(junctionEntry)
        }

        delete cleanedRecord[m2m.field]
      }
    }

    return cleanedRecord
  })

  // Insert junction entries grouped by their junction table
  for (const [junctionTable, entries] of junctionEntriesByTable) {
    if (entries.length > 0) {
      const junctionBatches = chunkArray(entries, context.BATCH_SIZE)
      await Promise.all(junctionBatches.map(async (batch) => {
        await insertJunctionEntries(junctionTable, batch, context)
      }))
    }
  }

  return cleanedRecords
}

export async function insertJunctionEntries(
  junctionTable: string,
  entries: any[],
  context: M2MContext
): Promise<void> {
  const uniqueEntries: any[] = []

  for (const entry of entries) {
    const entityId1 = String(entry[Object.keys(entry)[0]])
    const entityId2 = String(entry[Object.keys(entry)[1]])
    const junctionKey = getJunctionKey(junctionTable, entityId1, entityId2)

    // Check in-memory first (O(1) lookup for bidirectional dedup)
    if (processedJunctions.has(junctionKey)) {
      ux.stdout(ux.colorize('dim', `-- [m2m-processor] Skipping duplicate junction: ${junctionKey}`))
      continue
    }

    // Check database for re-import scenarios
    try {
      const field1 = Object.keys(entry)[0]
      const field2 = Object.keys(entry)[1]
      const existing = await context.api.client.request(
        readItems(junctionTable, {
          filter: { [field1]: entityId1, [field2]: entityId2 },
          limit: 1,
        })
      )
      if (existing.length > 0) {
        processedJunctions.add(junctionKey)
        ux.stdout(ux.colorize('dim', `-- [m2m-processor] Skipping existing junction: ${junctionKey}`))
        continue
      }
    } catch {
      // If readItems fails (e.g., collection doesn't exist yet), proceed with insert
    }

    // Track and collect for insertion
    processedJunctions.add(junctionKey)
    uniqueEntries.push(entry)
  }

  if (uniqueEntries.length === 0) {
    ux.stdout(ux.colorize('dim', `-- [m2m-processor] All ${entries.length} junction entries in ${junctionTable} were duplicates, skipping`))
    return
  }

  try {
    ux.stdout(ux.colorize('cyan', `-- [m2m-processor] Inserting ${uniqueEntries.length} junction entries into ${junctionTable} (${entries.length - uniqueEntries.length} duplicates skipped)`))
    await context.api.client.request(createItems(junctionTable, uniqueEntries))
  } catch (error) {
    ux.stdout(ux.colorize('yellow', `-- [m2m-processor] JUNCTION INSERT ERROR on ${junctionTable}:`))
    logErrorDetails(error, 'm2m-processor')
    throw error
  }
}
