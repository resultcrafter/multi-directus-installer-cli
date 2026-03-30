import { createItem, readFiles, updateItem, uploadFiles } from '@directus/sdk'
import { ux } from '@oclif/core'
import { readFileSync } from 'node:fs'
import path from 'pathe'

declare const FormData: typeof globalThis.FormData;

import { DIRECTUS_PINK } from '../constants.js'
import { api } from '../sdk.js'
import catchError from '../utils/catch-error.js'
import readFile from '../utils/read-file.js'

interface TemplateFile {
  description?: string
  filename_disk: string
  filename_download: string
  folder?: string
  id: string
  title?: string
  type: string
  uploaded_by?: string
}

const fileIdMapping: Map<string, string> = new Map()

export function getFileIdMapping(): Map<string, string> {
  return fileIdMapping
}

export default async function loadFiles(dir: string) {
  const files = readFile('files', dir) as TemplateFile[]
  ux.action.start(ux.colorize(DIRECTUS_PINK, `Loading ${files.length} files`))

  if (files && files.length > 0) {
    try {
      const existingFiles = await api.client.request(readFiles({
        fields: ['id', 'filename_disk'],
        limit: -1,
      }))

      const existingFileIds = new Set(existingFiles.map(file => file.id))
      const existingFileNames = new Set(existingFiles.map(file => file.filename_disk))

      const filesToUpload = files.filter(file => {
        if (existingFileIds.has(file.id)) {
          fileIdMapping.set(file.id, file.id)
          return false
        }

        if (existingFileNames.has(file.filename_disk)) {
          const existing = existingFiles.find(f => f.filename_disk === file.filename_disk)
          if (existing) {
            fileIdMapping.set(file.id, existing.id)
          }

          return false
        }

        return true
      })

      const { File } = await import('node:buffer')
      
      ux.stdout(ux.colorize('dim', `-- [loadFiles] Starting file upload of ${filesToUpload.length} files`))
      let uploadCount = 0
      let failCount = 0
      
      for (const asset of filesToUpload) {
        const fileName = asset.filename_disk
        const assetPath = path.resolve(dir, 'assets', fileName)
        const fileStream = new File([readFileSync(assetPath)], fileName, { type: asset.type })

        const form = new FormData()
        form.append('title', asset.title || '')
        if (asset.description) form.append('description', asset.description)
        if (asset.type) form.append('type', asset.type)
        if (asset.folder) form.append('folder', asset.folder)
        form.append('file', fileStream as any, fileName)

        try {
          const result = await api.client.request(uploadFiles(form as any)) as any
          const newId = result.id
          fileIdMapping.set(asset.id, newId)
          uploadCount++
          ux.stdout(ux.colorize('dim', `-- [loadFiles] Uploaded: ${asset.id} -> ${newId}`))
        } catch (error) {
          failCount++
          ux.stdout(ux.colorize('yellow', `-- [loadFiles] FAILED: ${asset.id} (${fileName}) - ${error instanceof Error ? error.message : String(error)}`))
        }
      }
      
      ux.stdout(ux.colorize('dim', `-- [loadFiles] Completed: ${uploadCount} files uploaded, ${failCount} failed`))
    } catch (error) {
      catchError(error)
    }
  }

  ux.action.stop()
}
