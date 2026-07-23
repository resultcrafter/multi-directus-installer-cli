# Incident Reports

Post-incident reviews for bugs found and fixed in directus-template-cli.

---

## INC-001: Settings Array Concatenation — Duplicate Navigation Modules

**Date:** 2026-07-23 | **Severity:** High | **Fix Version:** v0.7.9+ | **OpenSpec:** fix-duplicate-data

### Summary

Each template import concatenated the `module_bar` array instead of replacing it, causing navigation icons to multiply exponentially.

### Symptoms

- Sidebar shows 6-10 copies of each navigation icon
- Module bar grows: 7 → 14 → 21 → 28 ...

### Root Cause

`defu` library concatenates arrays instead of replacing them.

### Fix

Extract array fields before `defu` merge, replace after. File: `src/lib/load/load-settings.ts`

---

## INC-002: Bidirectional M2M — Duplicate Junction Entries

**Date:** 2026-07-23 | **Severity:** High | **Fix Version:** v0.7.9+ | **OpenSpec:** fix-duplicate-data

### Summary

Template data stored both sides of M2M relationships, creating duplicate junction entries.

### Symptoms

- Junction tables have 2x expected entries (e.g., 6 instead of 3 in organization_contacts)

### Root Cause

Both `contacts.json` and `organizations.json` stored M2M references to each other. The M2M processor created junction entries from both sides.

### Fix

Added deduplication: in-memory Set + database check. File: `src/lib/load/processors/m2m-processor.ts`

---

## INC-003: Preset Deduplication Failure — Duplicate Bookmarks

**Date:** 2026-07-23 | **Severity:** High | **Fix Version:** v0.7.9+ | **OpenSpec:** fix-preset-deduplication

### Summary

Preset deduplication used `preset.id` as key, but template presets have no `id` field, so every import created a full set of new presets.

### Symptoms

- Sidebar shows 10 copies of "My Accounts"
- 127 presets from ~10 imports (should be 12)

### Root Cause

`existingPresetIds.has(preset.id)` always returned `false` because template presets lack `id` fields.

### Fix

Changed to composite key `(bookmark, collection)`. Added cleanup of existing duplicates. File: `src/lib/load/load-presets.ts`

---

## INC-004: Junction Table Double-Processing — FK Errors

**Date:** 2026-07-23 | **Severity:** Critical | **Fix Version:** v0.7.9+ | **OpenSpec:** fix-cli-m2m-relationship-loading

### Summary

Junction table content files were processed twice (skeleton + full data), causing FK violations.

### Symptoms

`Invalid foreign key "..." for field "contact" in collection "activity_contacts"`

### Root Cause

`loadSkeletonRecords` inserted junction rows, then `loadFullData` also processed junction content files.

### Fix

Added junction table detection via `relations.json` and exclusion from both loading phases. Removed junction table content files from templates.

---

## Related Documents

- [IMPORT_EXPORT_GUIDE.md](./IMPORT_EXPORT_GUIDE.md) — How import/export works
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — Common issues and solutions
- [README.md](./README.md) — CLI usage and command reference
