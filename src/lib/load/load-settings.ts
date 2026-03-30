
import type {DirectusSettings} from '@directus/sdk'

import {readSettings, updateSettings} from '@directus/sdk'
import {ux} from '@oclif/core'
import {defu} from 'defu'

import {DIRECTUS_PINK} from '../constants.js'
import {api} from '../sdk.js'
import catchError from '../utils/catch-error.js'
import readFile from '../utils/read-file.js'

const FILE_ID_FIELDS = ['project_logo', 'public_favicon', 'public_foreground', 'public_background']

function transformFileIds(settings: any, fileIdMapping: Map<string, string>): any {
  if (!settings || typeof settings !== 'object') return settings
  
  const result = { ...settings }
  
  for (const field of FILE_ID_FIELDS) {
    if (result[field] && typeof result[field] === 'string' && fileIdMapping.has(result[field])) {
      const originalId = result[field]
      const mappedId = fileIdMapping.get(originalId)!
      result[field] = mappedId
      ux.stdout(ux.colorize('dim', `-- [loadSettings] Transformed ${field}: ${originalId} -> ${mappedId}`))
    }
  }
  
  return result
}

export default async function loadSettings(dir: string, fileIdMapping?: Map<string, string>) {
  ux.action.start(ux.colorize(DIRECTUS_PINK, 'Loading settings'))
  const settings = readFile('settings', dir)
  
  if (fileIdMapping && fileIdMapping.size > 0) {
    ux.stdout(ux.colorize('dim', `-- [loadSettings] Transforming file ID references...`))
  }
  
  const transformedSettings = fileIdMapping ? transformFileIds(settings, fileIdMapping) : settings
  
  try {
    const currentSettings = await api.client.request(readSettings())
    const mergedSettings = defu(currentSettings, transformedSettings) as DirectusSettings
    await api.client.request(updateSettings(mergedSettings))
  } catch (error) {
    catchError(error)
  }

  ux.action.stop()
}
