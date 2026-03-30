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

    const junctionRelations = relations.filter(
      (r: any) => r.related_collection === collection && r.meta?.junction_field && !r.collection.startsWith('directus_')
    )

    for (const jr of junctionRelations) {
      const junctionTable = jr.collection
      const parentJunctionField = jr.field
      const relatedField = jr.meta.junction_field
      const sortField = jr.meta.sort_field || null

      const relatedRelation = relations.find(
        (r: any) => r.collection === junctionTable && r.field === relatedField
      )

      if (relatedRelation) {
        const relatedCollection = relatedRelation.related_collection

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
