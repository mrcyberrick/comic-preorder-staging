# CLAUDE.md — Project Instructions for PULLLIST

This file provides persistent context for Claude when working on the PULLLIST
comic pre-order system. **Read this file in full at the start of every session.**

---

## 🚨 Current Migration Phase

**Active phase:** Phase 3 — Tenant Resolution
**Plan (parent):** `docs/phase-3-tenant-resolution.md`
**Active sub-deploy plan:** `docs/phase-3.3-remove-column-defaults.md`
**Last completed sub-deploy:** 3.2 — see `docs/phase-3.2-explicit-tenant-writes.md`
**Last completed phase:** Phase 2 — see `docs/phase-2-completion.md`
**Phase 1 reference:** `docs/phase-1-schema-migration.md` and `docs/pre-multitenancy-state.md`

**Out of scope this phase:**
- Phase 4+ work (self-service tenant signup, billing, branding rendering)
- Production deploys of any kind
- Edge Function business logic changes beyond passing `tenant_id`
- Any `analytics_*` view changes (deferred to sub-deploy 3.4)

Before proposing any work, read the active phase docs and confirm the proposed
change is in scope. **If something seems related but isn't on the IN scope list
in the active sub-deploy plan, stop and ask** rather than fixing it inline.

---

## 🚨 CRITICAL RULES — READ FIRST

### Staging Only
**All code changes, file generation, and deployment guidance target staging ONLY.**
- Never suggest pushing directly to `origin main`
- Never open PRs to production unless the user explicitly requests a production
  promotion AND confirms staging tests have passed
- Every session assumes work starts on the `staging` branch
- Always remind the user to smoke test on staging before promoting to production

### Credential Safety
**`config.js` must NEVER be committed to any branch.**
- It is listed in `.gitignore` and must stay there
- When merging staging → main, always run `git checkout main -- config.js`
  to restore production credentials before committing
- Never generate or suggest credential values in chat
- The import script credentials live only in the local scripts folder, never in the repo

**`config.js` is per-environment, not per-feature.** If a feature requires
a new key in `config.js`, that key must be added to BOTH staging and prod
`config.js` files manually before the merge. The `git checkout main -- config.js`
step preserves prod's existing values; it does not propagate new keys.

### File Drift Prevention
**Always work from the actual current files, not from memory or earlier sessions.**
- In chat sessions: ask the user to upload any files that will be modified
- In agentic sessions (CLI Claude, Claude in VS Code): re-read files from disk at session start
- Never assume outputs from a previous session match what's currently in the repo
- After generating updated files, remind the user to copy them to the repo before committing
- If a file hasn't been read this session, say so rather than guessing its contents

---

## 🚨 Anti-Drift Rules for Agentic Sessions

These rules apply to any agentic session (CLI Claude, Claude in VS Code, etc.).
They exist because Phase 2 drifted: a session scoped to "make Edge Functions
tenant-aware" ended up also rewriting URL handling and dropping a shared email
template. Both fixes were correct, but bundling them buried scope creep in the
session history. These rules prevent that.

### One sub-deploy per session
A session targets exactly one sub-deploy from the active phase plan.
Do not bundle changes from multiple sub-deploys into one session, even
if they look related.

### Stop and ask, don't fix inline
If you discover a real bug that is out of scope for the active sub-deploy:
1. Stop work
2. Describe the bug to the user
3. Ask whether to (a) fix it now as a separate commit, (b) file it for later, or (c) ignore it
4. Wait for explicit answer before proceeding

This applies even when the bug is blocking your testing. The user
decides whether to expand scope, not the agent.

### End every session with a status update
Before the session closes, the agent must produce:
- What was changed (files and line ranges, or SQL run)
- What was verified (queries run, smoke tests passed)
- What is left for the next session
- Any out-of-scope discoveries that were filed rather than fixed

### Never assume previous-session state matches current state
At session start, re-read the relevant files from disk. Do not infer
file contents from earlier sessions, from this `CLAUDE.md`, or from
the technical reference. Those documents drift; the files are truth.

---

## Session Opening Protocol

At the start of every session Claude must:

1. Read this file (`CLAUDE.md`) in full
2. Read the active phase plan referenced at the top of this file
3. Read the active sub-deploy plan
4. State which sub-deploy is being executed and confirm with the user
5. List any files that will be modified and read them from disk before proposing changes
6. Confirm staging target

If any of steps 2–5 cannot be completed (file missing, plan not yet
written, ambiguous scope), stop and ask the user before proceeding.

At the end of each session Claude should:
- Remind the user to copy output files to the repo
- Remind the user to push to staging and smoke test before promoting to production
- Note any production database changes needed (SQL to run in prod Supabase)
- Note any local script updates needed (`import.js`)
- Produce the status update described in the anti-drift rules

---

## Project Overview

**App**: PULLLIST — comic pre-order system for Ray & Judy's Book Stop
**Phone**: 973-586-9182
**Location**: Rockaway, NJ
**Production URL**: https://mrcyberrick.us/comic-preorder/
**Staging URL**: https://mrcyberrick.github.io/comic-preorder-staging/

---

## Repository Structure

```
comic-preorder/                    ← production repo (github.com/mrcyberrick/comic-preorder)
  catalog.html                     ← monthly catalog browse & reserve
  mylist.html                      ← customer pull list
  arrivals.html                    ← this week's arrivals
  subscriptions.html               ← series subscription management
  admin.html                       ← admin dashboard
  app.js                           ← shared application logic & Supabase API
  style.css                        ← all styles
  config.js                        ← credentials (NEVER COMMIT — gitignored)
  CLAUDE.md                        ← this file
  README.md                        ← project overview
  docs/
    monthly-catalog-refresh.md     ← monthly import SOP
    technical-reference.md         ← canonical schema and architecture reference
    pre-multitenancy-state.md      ← Phase 1 baseline + completion notes
    phase-1-schema-migration.md    ← Phase 1 plan and completion record
    phase-2-completion.md          ← Phase 2 completion notes
    phase-3-tenant-resolution.md   ← Phase 3 parent plan and sub-deploy index
    phase-3.x-*.md                 ← per-sub-deploy plans (written as each one starts)
```

**Git remotes:**
- `origin` → production repo (`github.com/mrcyberrick/comic-preorder`)
- `staging` → staging repo (`github.com/mrcyberrick/comic-preorder-staging`)

**Local scripts folder** (outside repo, never committed):
```
C:\Users\richa\OneDrive\Documents\(Work)\BookStop\catalogs\scripts\
  import.js              ← production import script (with prod credentials)
  import-staging.js      ← staging import script (with staging credentials)
  package.json
  node_modules\
```

**Catalog CSV files** (outside repo):
```
C:\Users\richa\OneDrive\Documents\(Work)\BookStop\catalogs\
  Lunar_Product_Data_MMYY.csv
  YYYY_MM_PRH_metadata_full_active.csv
  normalized_catalog.json          ← generated by import script
```

---

## Tech Stack

- **Frontend**: Vanilla HTML/CSS/JS — no build step, no npm for the web app
- **Backend**: Supabase (PostgreSQL + Auth + Edge Functions + RLS)
- **Hosting**: GitHub Pages (static files only)
- **Email**: MailerSend via Supabase Edge Functions
- **Import**: Node.js script run locally each month

**Key constraint**: GitHub Pages serves static files only. There is no server-side
rendering. All dynamic behavior is client-side JS calling Supabase directly.

---

## Supabase Projects

| Environment | URL | Anon Key Source |
|---|---|---|
| Production | `https://plgegklqtdjxeglvyjte.supabase.co` | `config.js` in prod |
| Staging | `https://puoaiyezsreowpwxzxhj.supabase.co` | `config.js` in staging |

**Never hardcode credentials in any file that gets committed.**
Service role keys for the import script live only in the local scripts folder.

**Founding tenant UUID (staging):** `72e29f67-39f7-42bc-a4d5-d6f992f9d790`
This is also set as the `FOUNDING_TENANT_ID` Edge Function secret on staging.

---

## Standard Deployment Workflow

```powershell
# Start a new feature
git checkout staging
git pull origin staging
git checkout -b feature/<description>

# Make changes, then commit
git add <files>
git commit -m "<type>: <description>"

# Merge to staging and deploy to staging site
git checkout staging
git merge feature/<description>
git push origin staging
git push staging staging:main    # deploys to staging GitHub Pages

# Test at: mrcyberrick.github.io/comic-preorder-staging/
# When staging tests pass, promote to production:

git checkout main
git pull origin main
git merge staging --no-commit --no-ff
git checkout main -- config.js   # CRITICAL: restore prod credentials
git commit -m "<type>: <description>"
git checkout -b feat/<description>-prod
git push origin feat/<description>-prod
# Open PR: feat/<description>-prod → main
# Verify config.js is NOT in the diff before merging
```

**PowerShell note**: Use separate lines instead of `&&` — PowerShell doesn't support it.

---

## Database Schema

The full current schema lives in `docs/technical-reference.md`. That file is
the canonical source of truth — read it before making any schema-related claim.

**Do not infer schema details from this `CLAUDE.md` or from earlier sessions.**
The schema changed materially in Phase 1 (multi-tenancy) and will continue to
evolve in later phases. A summary here would drift out of date and mislead.

Quick orientation only:
- Multi-tenant via `tenants` table; every tenant-scoped table has `tenant_id`
- RLS enforces tenant isolation via `current_tenant_id()` + `current_user_is_admin()`
- Import script uses **service role key** (bypasses RLS); web app uses anon key
- Founding tenant UUID is documented above under "Supabase Projects"

---

## app.js Structure

Source of truth: read `app.js` directly. The major API objects exposed on
`window` are `Auth`, `Catalog`, `Preorders`, `Subscriptions`, `Settings`,
`AdminContext`, `NavBubble`, and `Maintenance`. Read the file before making
claims about specific method signatures or behavior — this `CLAUDE.md`
intentionally does not duplicate the API surface to avoid drift.

---

## Key Business Logic

### Catalog Month Scoping
- **My List table**: shows only current catalog month reservations
- **Upcoming Arrivals section**: shows all future reservations across all months
- **Admin dashboard**: stats and all tabs scoped to current catalog month
- **This Week page**: shows reservations with `on_sale_date === thisWednesday` (any month)

### Wednesday Calculation
Always use local date parts (not `toISOString()`) to avoid UTC timezone shift.
The pattern is `(3 - today.getDay() + 7) % 7` for days-until-next-Wednesday,
then format `YYYY-MM-DD` from local `getFullYear() / getMonth() / getDate()`.
See `getThisWednesday()` in `app.js` for the canonical implementation.

### Past Item Auto-Hide
Items from previous months where `on_sale_date < today` are hidden from My List.
This is enforced client-side in `mylist.html` after fetching all preorders.

### Series Subscriptions
- Subscribe button appears only on standard covers (`variant_type` is null,
  `'Standard'`, or `'Primary Title'`)
- Subscribe button is hidden in admin impersonation context
- Import script auto-reserves standard covers for subscribers each month

### Variant Type Handling
- Lunar standard cover: `variant_type = 'Standard'` or `null`
- PRH standard cover: `variant_type = 'Primary Title'` or `null`
- All others are variant covers — no subscribe button shown

---

## Monthly Import Script Behavior

The import script (`import.js` / `import-staging.js`) runs locally each month:

1. Reads Lunar + PRH CSV files
2. Normalizes records to a common schema (post-Phase-1 includes `tenant_id`)
3. Detects new vs same catalog month
4. On new month only: archives reservation history, purges stale unreserved rows
5. **Upserts** catalog records (preserving UUIDs — critical for preorder integrity)
6. On new month only: removes items dropped from distributor catalog since last import
7. Auto-reserves standard covers for subscribers
8. Optionally imports weekly shipment invoices into `weekly_shipment`
9. Prompts to send customer notification emails

**Post-Phase-1**: the staging script passes `tenant_id` everywhere — in the
`tenants_id` upsert key, in normalized records, in auto-reserve inserts, and as
`p_tenant_id` to the three RPC calls (`purge_stale_catalog`,
`delete_dropped_catalog_items`, `archive_stale_reservations`).

**Production `import.js` is not yet patched.** Do not run it until production
gets the Phase 1 schema migration, or it will fail with "function does not exist."

Re-running the staging script on the same month is safe — upsert updates in
place, auto-reserve detects existing reservations and skips them.

---

## Edge Functions (Staging)

Tenant-aware as of Phase 2:
- `notify-customers` — tenant-scoped recipients, paper email filter
- `create-paper-customer` — explicit `tenant_id` on profile insert
- `invite-customer` — explicit `tenant_id` + inline HTML email (replaced shared template)
- `register-customer` — explicit `tenant_id`, MailerLite group filter
- `send-my-list` — tenant-scoped catalog month query

Unchanged in Phase 2 (PATCH/DELETE on existing rows only):
- `approve-customer`, `claim-paper-customer`, `reset-password`

The `FOUNDING_TENANT_ID` secret must be set in Supabase staging → Edge
Functions → Secrets for the tenant-aware functions to work.

---

## Known Out-of-Scope Items

The following are pending work that should NOT be touched in agentic sessions
without explicit user approval:

- **Production deploys** — staging only until phases complete
- **Analytics views** (`analytics_*`) — pending sub-deploy 3.4
- **Column defaults removal** — pending sub-deploy 3.3 (defaults are still
  load-bearing because app code doesn't yet pass `tenant_id` explicitly)
- **Edge Function business logic** — only `tenant_id` changes are in scope
  until a later phase
- **Per-tenant branding rendering** — `tenants.branding` column exists, but
  no UI reads it yet; do not render
- **import.js (production)** — DO NOT modify until production gets Phase 1
  schema. The staging script (`import-staging.js`) is the only patched copy.

If a session needs to touch any of the above, stop and confirm with the user first.

---

## Known Issues & Gotchas

- **PowerShell**: Doesn't support `&&` — run git commands on separate lines
- **Supabase `range()`**: Returns 416 on empty result sets — use count-first approach
- **UTC timezone shift**: Never use `toISOString()` for date display — use local date parts
- **`config.js`**: Must be restored after every staging→main merge
- **Import script service key**: Must be `service_role` key, NOT anon key — RLS blocks anon
- **`nav-hamburger`**: Must be present in every HTML file's nav — easy to lose on file updates
- **Supabase SQL editor bypasses RLS**: It runs as `postgres` superuser. To
  test RLS isolation, simulate an authenticated user inside a transaction with
  `SET LOCAL role authenticated` and `SET LOCAL "request.jwt.claims" = ...`
- **RLS recursion**: Admin policies that reference `user_profiles` via
  `EXISTS (SELECT ... FROM user_profiles)` cause infinite recursion → 500
  errors. Use the `current_user_is_admin()` `SECURITY DEFINER` function
  instead. This is already in place post-Phase-1.

---

## Files That Must Stay in Sync

The nav block must be identical across `catalog.html`, `mylist.html`,
`arrivals.html`, `subscriptions.html`, and `admin.html`. When updating
nav, copy from the most recently-updated file rather than typing from
memory — the canonical version is whichever HTML file was last touched.

The footer block must also be identical across all five pages, placed
immediately before `<div id="toast-container"></div>`.

The `<script>` load order must be the same on every page:
Supabase UMD bundle → `config.js` → `app.js` → page-specific code.
