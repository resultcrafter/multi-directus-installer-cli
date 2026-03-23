import { readFiles, uploadFiles, createItem, updateItem } from '@directus/sdk'
import { ux } from '@oclif/core'
import { readFileSync } from 'node:fs'
import path from 'pathe'

declare const FormData: typeof globalThis.FormData;

import { DIRECTUS_PINK } from '../constants.js'
import { api } from '../sdk.js'
import catchError from '../utils/catch-error.js'
import readFile from '../utils/read-file.js'

interface TemplateFile {
  id: string
  filename_disk: string
  filename_download: string
  title?: string
  description?: string
  type: string
  folder?: string
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

      await Promise.all(filesToUpload.map(async asset => {
        const fileName = asset.filename_disk
        const assetPath = path.resolve(dir, 'assets', fileName)
        const fileStream = new Blob([readFileSync(assetPath)], { type: asset.type })

        const form = new FormData()
        form.append('title', asset.title || '')
        if (asset.description) form.append('description', asset.description)
        if (asset.type) form.append('type', asset.type)
        form.append('file', fileStream, fileName)

        try {
          const result = await api.client.request(uploadFiles(form as any)) as any
          const newId = result.id
          fileIdMapping.set(asset.id, newId)
          ux.action.status = `Mapped ${asset.filename_disk} -> ${newId}`
        } catch (error) {
          catchError(error)
        }
      }))
    } catch (error) {
      catchError(error)
    }
  }

  ux.action.stop()
}
