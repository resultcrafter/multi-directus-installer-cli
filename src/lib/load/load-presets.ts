import {createPresets, deletePresets, readPresets} from '@directus/sdk'
import {ux} from '@oclif/core'

import {DIRECTUS_PINK} from '../constants.js'
import {api} from '../sdk.js'
import catchError from '../utils/catch-error.js'
import readFile from '../utils/read-file.js'

/**
 * Generate a deterministic dedup key for a preset.
 * Uses bookmark name + collection to identify unique presets.
 * Non-bookmark presets (default views) are deduplicated by collection alone.
 */
function getPresetKey(preset: any): string {
  return `${preset.bookmark || ''}|${preset.collection}`
}

export default async function loadPresets(dir: string) {
  const presets = readFile('presets', dir)
  ux.action.start(ux.colorize(DIRECTUS_PINK, `Loading ${presets.length} presets`))

  if (presets && presets.length > 0) {
    // Fetch existing presets
    const existingPresets = await api.client.request(readPresets({
      limit: -1,
    }))

    // Build dedup key map: key -> newest preset ID
    // Presets without IDs in template are deduplicated by (bookmark, collection)
    const existingPresetKeys = new Map<string, any>()
    for (const p of existingPresets) {
      const key = getPresetKey(p)
      if (!existingPresetKeys.has(key)) {
        existingPresetKeys.set(key, p.id)
      }
    }

    // Clean up duplicates: keep only the newest preset per key
    const keyToIds = new Map<string, any[]>()
    for (const p of existingPresets) {
      const key = getPresetKey(p)
      const ids = keyToIds.get(key) || []
      ids.push(p.id)
      keyToIds.set(key, ids)
    }

    const duplicateIdsToDelete: any[] = []
    for (const [, ids] of keyToIds) {
      if (ids.length > 1) {
        // Keep the first (newest, since API returns newest first), delete the rest
        duplicateIdsToDelete.push(...ids.slice(1))
      }
    }

    if (duplicateIdsToDelete.length > 0) {
      ux.stdout(ux.colorize('yellow', `-- [loadPresets] Cleaning up ${duplicateIdsToDelete.length} duplicate presets`))
      try {
        await api.client.request(deletePresets(duplicateIdsToDelete))
        ux.stdout(ux.colorize('dim', `-- [loadPresets] Deleted ${duplicateIdsToDelete.length} duplicate presets`))
      } catch (error) {
        catchError(error)
      }
    }

    // Filter out presets that already exist by semantic key
    const presetsToAdd = presets.filter(preset => {
      const key = getPresetKey(preset)
      return !existingPresetKeys.has(key)
    }).map(preset => {
      const cleanPreset = {...preset}
      cleanPreset.user = null
      return cleanPreset
    })

    const skipped = presets.length - presetsToAdd.length
    if (skipped > 0) {
      ux.stdout(ux.colorize('dim', `-- [loadPresets] Skipped ${skipped} presets (already exist)`))
    }

    if (presetsToAdd.length > 0) {
      try {
        await api.client.request(createPresets(presetsToAdd))
        ux.stdout(ux.colorize('dim', `-- [loadPresets] Created ${presetsToAdd.length} new presets`))
      } catch (error) {
        catchError(error)
      }
    }
  }

  ux.action.stop()
}
