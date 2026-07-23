# Import & Export Guide

How `directus-template-cli` imports and exports templates — the full pipeline, what each step does, and best practices.

---

## Table of Contents

- [Overview](#overview)
- [Export Pipeline (Extract)](#export-pipeline-extract)
- [Import Pipeline (Apply)](#import-pipeline-apply)
- [Template Structure](#template-structure)
- [M2M Relationship Handling](#m2m-relationship-handling)
- [Settings Merge Behavior](#settings-merge-behavior)
- [Idempotent Imports](#idempotent-imports)
- [Best Practices](#best-practices)
- [Common Issues](#common-issues)

---

## Overview

The CLI has two core operations:

| Command | Purpose | Direction |
|---------|---------|-----------|
| `extract` | Snapshot a running Directus instance into a portable template | Directus → Files |
| `import-backend-data` | Apply a template to a running Directus instance | Files → Directus |

Both operations work through the Directus REST API. The CLI never touches the database directly.

---

## Export Pipeline (Extract)

The `extract` command reads from a running Directus and writes template files.

### Step-by-Step

```
1. Authenticate with Directus API
2. Read schema (collections, fields, relations)
3. Read permissions, roles, policies
4. Read content (all user collections)
5. Read settings (project config, module bar, theme)
6. Read flows, dashboards, panels
7. Read presets (bookmarks, default views)
8. Read translations
9. Upload/download files (assets)
10. Write everything to template directory
```

### What Gets Extracted

| Component | File(s) | Notes |
|-----------|---------|-------|
| Schema | `collections.json`, `fields.json`, `relations.json` | Full schema definition |
| Content | `src/content/<collection>.json` | One file per user collection |
| Settings | `src/settings.json` | Project settings, module bar, theme |
| Permissions | `src/permissions.json` | Role-based access rules |
| Roles | `src/roles.json` | Custom roles (not Public/Admin) |
| Policies | `src/policies.json` | Policy definitions |
| Users | `src/users.json` | Admin and regular users |
| Flows | `src/flows.json` | Automation flows |
| Dashboards | `src/dashboards.json` | Dashboard layouts |
| Presets | `src/presets.json` | Bookmarks and default views |
| Translations | `src/translations.json` | i18n entries |
| Files | `src/files/<uuid>-<name>` | Downloaded assets |

### Extraction Gotchas

1. **No partial extraction** — The entire template is extracted. You can't extract just schema or just content.
2. **Sensitive data** — Clean up real emails, passwords, and API keys before sharing templates.
3. **Hardcoded IDs** — All UUIDs are preserved. If you apply the same template twice, the IDs will collide (handled by the CLI).

---

## Import Pipeline (Apply)

The `import-backend-data` command reads template files and writes to a running Directus.

### Step-by-Step

```
1. Authenticate with Directus API
2. Upload files first (creates fileIdMapping for reference updates)
3. Load schema (collections, fields, relations)
4. Load roles and policies
5. Load permissions
6. Load users
7. Load content (data for each collection)
   ├── loadSkeletonRecords: Insert primary keys only
   ├── loadFullData: Insert full records with reference transformation
   └── M2M processor: Create junction table entries from M2M arrays
8. Load settings (merge with existing)
9. Load flows and operations
10. Load dashboards and panels
11. Load presets (bookmarks, default views)
12. Load translations
```

### Data Loading Phases

#### Phase 1: Skeleton Records (`loadSkeletonRecords`)

Inserts only primary keys (`{id: "..."}`) for each collection. This:
- Reserves all IDs upfront (prevents FK violations during full data load)
- Skips junction tables (handled by M2M processor later)
- Uses `UPSERT` semantics — existing IDs are skipped

#### Phase 2: Full Data (`loadFullData`)

Inserts complete records with all fields. For each collection:
- Reads the content JSON file
- Detects M2M/O2M/Files fields via `alias-field-detector`
- Strips M2M arrays from records (they become junction entries)
- Transforms references (file IDs, user IDs)
- Batch-inserts records

#### Phase 3: M2M Processing (`m2m-processor`)

Creates junction table entries from M2M arrays in parent collections:
- Reads `relations.json` to find junction tables
- For each parent record's M2M field, creates junction entries
- Deduplicates entries (in-memory Set + database check)
- Batch-inserts into junction tables

#### Phase 4: Settings Merge (`loadSettings`)

Merges template settings with existing Directus settings:
- Non-array fields: Deep merge using `defu` (existing values preserved, template values fill gaps)
- Array fields (e.g., `module_bar`): **Replaced** entirely (not concatenated)
- File ID references (logo, favicon): Remapped to uploaded file IDs

---

## Template Structure

```
my-template/
├── package.json              # Template metadata (name, description, frontends)
├── directus/
│   └── template/
│       ├── src/
│       │   ├── collections.json
│       │   ├── fields.json
│       │   ├── relations.json
│       │   ├── settings.json
│       │   ├── permissions.json
│       │   ├── roles.json
│       │   ├── policies.json
│       │   ├── users.json
│       │   ├── flows.json
│       │   ├── dashboards.json
│       │   ├── presets.json
│       │   ├── translations.json
│       │   ├── extensions.json
│       │   └── content/
│       │       ├── contacts.json
│       │       ├── organizations.json
│       │       └── ... (one file per collection)
│       └── files/
│           └── ... (downloaded assets)
└── nextjs/ (or nuxt/, astro/, etc.)
    └── ... (frontend code)
```

---

## M2M Relationship Handling

Many-to-Many (M2M) relationships are the most complex part of template import.

### How It Works

Template content files store M2M relationships as arrays of IDs:

```json
// contacts.json
{
  "id": "abc-123",
  "name": "Sarah Johnson",
  "organizations": ["org-1", "org-2"]  // M2M field
}
```

The M2M processor:
1. Detects `organizations` is an M2M field (via `relations.json`)
2. Extracts the array: `["org-1", "org-2"]`
3. Creates junction entries:
   ```json
   { "contact": "abc-123", "organization": "org-1", "sort": 1 }
   { "contact": "abc-123", "organization": "org-2", "sort": 2 }
   ```
4. Inserts into `organization_contacts` junction table

### Bidirectional M2M

Templates often store **both sides** of an M2M relationship:

```json
// contacts.json
{ "id": "contact-1", "organizations": ["org-1"] }

// organizations.json
{ "id": "org-1", "contacts": ["contact-1"] }
```

This creates the same junction entry twice. The M2M processor deduplicates:
- **In-memory**: `Set<string>` tracks processed junction keys
- **Database**: Checks if junction entry already exists before inserting

### Junction Table Detection

The CLI identifies junction tables by reading `relations.json`:
- A table is a junction if it has `meta.junction_field` on its relations
- Junction tables are skipped during skeleton loading
- Only the M2M processor creates junction entries

### Common M2M Issues

| Issue | Cause | Fix |
|-------|-------|-----|
| `INVALID_FOREIGN_KEY` | Template references non-existent entity | Fix template data to use correct IDs |
| Duplicate junction entries | Bidirectional M2M in template | CLI deduplicates automatically (v0.7.9+) |
| Junction entries not created | M2M field not detected | Verify `relations.json` has junction metadata |

---

## Settings Merge Behavior

Settings are merged, not replaced. This preserves your customizations.

### Merge Rules

| Field Type | Behavior | Example |
|------------|----------|---------|
| Objects | Deep merge (template fills gaps) | `project_name`, `public_url` |
| Arrays | **Replaced** entirely | `module_bar` |
| File references | Remapped to uploaded IDs | `project_logo`, `public_favicon` |

### Module Bar

The `module_bar` array defines sidebar navigation items. When applying a template:
- Template's `module_bar` **replaces** the existing one (not appends)
- This prevents duplicate navigation items on re-import

### Why Arrays Are Replaced

The `defu` library (used for deep merge) concatenates arrays by default. This caused a critical bug where `module_bar` grew with each import:

```
Import 1: [content, users, files, settings]          → 4 items
Import 2: [content, users, files, settings, content, users, files, settings] → 8 items
Import 3: [content, users, files, settings × 3]       → 12 items
```

The fix extracts array fields before merge and replaces them after.

---

## Idempotent Imports

As of v0.7.9, template imports are **idempotent** — running the same import multiple times produces the same result.

### What's Idempotent

| Component | Behavior |
|-----------|----------|
| Schema | Collections/fields/relations: skip if exist |
| Content | Records: overwrite if same primary key |
| M2M Junctions | Deduplicated by (entity1, entity2) pair |
| Settings | Arrays replaced, objects deep-merged |
| Presets | Deduplicated by (bookmark, collection) |
| Files | Skip if same filename exists |
| Flows | Skip if same ID exists |
| Permissions | Skip if same ID exists |

### What's NOT Idempotent

| Component | Behavior |
|-----------|----------|
| Users | Created if not exist, but existing are NOT updated |
| Roles | Created if not exist |

### Verifying Idempotency

After importing, run the same import again and verify counts:

```bash
# First import
directus-cli import-backend-data -p --directusUrl=... --directusToken=... --templateType=local --templateLocation=...

# Check counts
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/items/contacts?limit=-1&fields=id" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['data']))"

# Second import (should not change counts)
directus-cli import-backend-data -p --directusUrl=... --directusToken=... --templateType=local --templateLocation=...

# Verify same counts
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/items/contacts?limit=-1&fields=id" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['data']))"
```

---

## Best Practices

### Before Importing

1. **Back up your database** — Always backup before applying templates to existing instances
2. **Use a clean instance** — For new projects, start with a blank Directus
3. **Check Node.js version** — Use Node.js 20–23 (v24 has file upload issues)
4. **Verify token permissions** — Use an admin token with full access

### Template Design

1. **Don't include junction table content files** — Let the M2M processor create them from parent collection M2M arrays
2. **Use correct entity IDs in M2M fields** — Reference actual entity IDs, not junction record IDs
3. **One side only** — Store M2M references on one side only (e.g., in `contacts.json` OR `organizations.json`, not both)
4. **Avoid hardcoded IDs** — If you need deterministic IDs, use the template's built-in UUID generation

### After Importing

1. **Verify data counts** — Check that collections have the expected number of records
2. **Check sidebar** — Verify no duplicate bookmarks or navigation items
3. **Test M2M relationships** — Open records and verify related items are linked correctly
4. **Review settings** — Check that project name, logo, and theme are correct

### Programmatic Imports (CI/CD)

```bash
# Use -p flag for non-interactive mode
directus-cli import-backend-data -p \
  --directusUrl="https://your-instance.directus.cloud" \
  --directusToken="your-admin-token" \
  --templateType=local \
  --templateLocation="./my-template"

# Partial apply (only content and schema)
directus-cli import-backend-data -p \
  --directusUrl="https://your-instance.directus.cloud" \
  --directusToken="your-admin-token" \
  --templateType=local \
  --templateLocation="./my-template" \
  --partial --schema --content --no-users --no-permissions
```

---

## Common Issues

### "File not found" Warnings

```
Warning: File not found: crm.json
Warning: File not found: crm_settings.json
```

**Normal** — These are frontend content files (Nuxt, Next.js) that don't exist in backend-only templates. Safe to ignore.

### Foreign Key Errors on Junction Tables

```
Invalid foreign key "xxx" for field "contact" in collection "activity_contacts"
```

**Cause** — Template data references entity IDs that don't exist. The M2M processor tries to create junction entries pointing to non-existent records.

**Fix** — Verify that M2M arrays in content files reference correct entity IDs.

### Duplicate Presets/Bookmarks

```
Sidebar shows 10 copies of "My Accounts"
```

**Cause** — Each import created new presets because deduplication was broken.

**Fix** — Update to v0.7.9+ which deduplicates by `(bookmark, collection)` key. Clean up existing duplicates by deleting them from the Directus admin UI.

### Settings Array Growth

```
Module bar shows 6 copies of each navigation icon
```

**Cause** — The `defu` library concatenated `module_bar` arrays instead of replacing them.

**Fix** — Update to v0.7.9+ which replaces array fields instead of concatenating.

---

## Related Documents

- [README.md](./README.md) — CLI usage and command reference
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — Common issues and solutions
- [INCIDENTS.md](./INCIDENTS.md) — Incident reports for known bugs
