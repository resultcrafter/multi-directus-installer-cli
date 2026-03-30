import {api} from '../sdk.js'

export interface AliasFieldInfo {
  collection: string
  field: string
  junctionField: string
  junctionTable: string
  relatedCollection: string
  relatedField: string
  relationType: 'files' | 'm2m' | 'o2m'
  sortField: null | string
}

export interface O2MFieldInfo extends AliasFieldInfo {
  fkField: string
  relatedTable: string
}

export interface M2MContext {
  api: typeof api
  BATCH_SIZE: number
  dir: string
}

export interface O2MContext {
  api: typeof api
  BATCH_SIZE: number
  dir: string
}

export interface FilesContext {
  api: typeof api
  BATCH_SIZE: number
  dir: string
  fileIdMapping?: Map<string, string>
}
