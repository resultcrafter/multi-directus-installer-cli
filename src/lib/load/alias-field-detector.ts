import readFile from '../utils/read-file.js'
import {AliasFieldInfo, O2MFieldInfo} from './types.js'

const aliasFieldsCache: AliasFieldInfo[] = []
const o2mFieldsCache: O2MFieldInfo[] = []

export function detectAliasFields(dir: string): AliasFieldInfo[] {
  if (aliasFieldsCache.length > 0) {
    return aliasFieldsCache
  }

  const fields = readFile('fields', dir) as any[]
  const relations = readFile('relations', dir) as any[]

  for (const field of fields) {
    if (field.type !== 'alias' || !field.meta?.special) {
      continue
    }

    const {special} = field.meta
    const {collection} = field
    const fieldName = field.field

    let relationType: 'files' | 'm2m' | 'o2m' | null = null

    if (special.includes('m2m')) {
      relationType = 'm2m'
    } else if (special.includes('o2m')) {
      relationType = 'o2m'
    } else if (special.includes('files')) {
      relationType = 'files'
    } else {
      continue
    }

    if (relationType === 'o2m') {
      continue
    }

    // For each M2M field, find the correct junction table
    // The junction table should have a field that references the M2M target collection
    
    // Find all junction relations where the junction table has a field referencing this collection
    const junctionRelations = relations.filter(
      (r: any) => r.related_collection === collection && r.meta?.junction_field && !r.collection.startsWith('directus_')
    )

    // For each junction relation, check if the junction table has a field that references the target collection
    // The target collection is the collection that the M2M field links to
    for (const jr of junctionRelations) {
      const junctionTable = jr.collection
      const parentJunctionField = jr.field
      const relatedField = jr.meta.junction_field
      const sortField = jr.meta.sort_field || null

      // Find the related relation to get the related collection
      const relatedRelation = relations.find(
        (r: any) => r.collection === junctionTable && r.field === relatedField
      )

      if (relatedRelation) {
        const relatedCollection = relatedRelation.related_collection

        // Check if the junction table has a field that references the target collection
        // The target collection is determined by looking at what the junction table connects to
        // other than the parent collection
        const otherFieldsInJunction = relations.filter(
          (r: any) => r.collection === junctionTable && r.field !== parentJunctionField && !r.collection.startsWith('directus_')
        )

        // The correct junction table is the one where the other field references the target collection
        // We determine the target collection by checking if the field name matches the M2M field name pattern
        const hasMatchingTargetField = otherFieldsInJunction.some(
          (r: any) => {
            const targetCollection = r.related_collection
            // Check if the target collection name matches the M2M field name pattern
            // For example, "contacts" field should link to "contacts" collection
            return targetCollection === fieldName || 
                   (fieldName.endsWith('s') && targetCollection === fieldName.slice(0, -1)) ||
                   (!fieldName.endsWith('s') && targetCollection === fieldName + 's')
          }
        )

        if (hasMatchingTargetField) {
          aliasFieldsCache.push({
            collection,
            field: fieldName,
            junctionField: parentJunctionField,
            junctionTable,
            relatedCollection,
            relatedField,
            relationType,
            sortField
          })
        }
      }
    }
  }

  return aliasFieldsCache
}

export function detectO2MFields(dir: string): O2MFieldInfo[] {
  if (o2mFieldsCache.length > 0) {
    return o2mFieldsCache
  }

  const fields = readFile('fields', dir) as any[]
  const relations = readFile('relations', dir) as any[]

  for (const field of fields) {
    if (field.type !== 'alias' || !field.meta?.special) {
      continue
    }

    const {special} = field.meta
    const parentCollection = field.collection
    const fieldName = field.field

    if (!special.includes('o2m')) {
      continue
    }

    const inverseRelation = relations.find(
      (r: any) =>
        r.related_collection === parentCollection &&
        r.meta?.junction_field === null &&
        !r.collection.startsWith('directus_')
    )

    if (!inverseRelation) {
      continue
    }

    const relatedTable = inverseRelation.collection
    const fkField = inverseRelation.meta?.many_field || fieldName

    o2mFieldsCache.push({
      collection: parentCollection,
      field: fieldName,
      fkField,
      junctionField: fkField,
      junctionTable: relatedTable,
      relatedCollection: parentCollection,
      relatedField: 'id',
      relatedTable,
      relationType: 'o2m',
      sortField: inverseRelation.meta?.sort_field || null
    })
  }

  return o2mFieldsCache
}

export function clearAliasFieldsCache(): void {
  aliasFieldsCache.length = 0
  o2mFieldsCache.length = 0
}
