# Pre-Multitenancy State Snapshot

**Date captured:** 2026-04-29
**Captured by:** Rick S
**Purpose:** Single-tenant baseline before multi-tenancy refactor.
Use this document to verify post-migration data integrity and to
understand what each environment looked like before changes began.

---

## 1. Recovery Anchors

If anything goes wrong during the migration, restore from these:

| Asset | Location | Notes |
|---|---|---|
| Production code tag | `pre-multitenancy-v1` | Points at commit `e6d05285` on `main` |
| Staging code tag | `pre-multitenancy-v1-staging` | On both `origin` and `staging` remotes |
| Production DB dump | `OneDrive\...\backups\2026-04-29-pre-multitenancy\backup-prod-pre-multitenancy-20260429.sql` | ~6.4 MB, validated `dump complete` footer |
| Staging DB dump | `OneDrive\...\backups\2026-04-29-pre-multitenancy\backup-staging-pre-multitenancy-20260429.sql` | ~6.9 MB, validated |
| CSV exports | `OneDrive\...\backups\2026-04-29-pre-multitenancy\csv-prod\`, `\csv-staging\` | One per table |
| Edge function source | `OneDrive\...\backups\2026-04-29-pre-multitenancy\edge-functions-prod\`, `\edge-functions-staging\` | 8 functions, downloaded as zips |
| Secrets | Password manager entry "PULLLIST — Supabase Edge Function Secrets" | Not in OneDrive |
| Supabase dashboard backups | Not available (free tier) | Documented as a known limitation |

---

## 2. Database Row Counts

> **Phase 4 note (2026-06-10):** superseded for production by
> `production-baseline-2026-05-28.md` § 1.4 (pre-cutover row-count snapshot,
> taken in the live audit immediately before sub-deploy 4.2). The counts
> below describe the 2026-04-29 state only and remain valid as the
> pre-*multitenancy* baseline; use the 2026-05-28 doc for any pre-*cutover*
> integrity comparison.

These numbers are the integrity checksum. Post-migration counts must match
(or differ in known, expected ways).

### Production (`plgegklqtdjxeglvyjte.supabase.co`)

| table_name          | row_count |
| ------------------- | --------- |
| catalog             | 6357      |
| preorders           | 374       |
| reservation_history | 81        |
| settings            | 2         |
| subscriptions       | 3         |
| user_profiles       | 17        |
| weekly_shipment     | 199       |

### Staging (`puoaiyezsreowpwxzxhj.supabase.co`)

| table_name          | row_count |
| ------------------- | --------- |
| catalog             | 7195      |
| preorders           | 35        |
| reservation_history | 10        |
| settings            | 2         |
| subscriptions       | 8         |
| user_profiles       | 5         |
| weekly_shipment     | 199       |

---

## 3. Admin Users

These users should become tenant owners of the "Ray & Judy's" tenant
after migration.

### Production
| id                                   | full_name |
| ------------------------------------ | --------- |
| 734bfd7e-23a6-4c23-ba35-1f64843603c0 | Book Stop |

### Staging
| id                                   | full_name  |
| ------------------------------------ | ---------- |
| b758f573-613f-4342-909d-0914dbedccdc | Test Admin |

---

## 4. Schema Drift Between Environments

> **Phase 4 note (2026-06-10):** superseded by
> `production-baseline-2026-05-28.md` § 2 (per-table state vs post-Phase-3
> staging) and § 4 (findings surfaced by that audit). Current divergence
> tracking lives in `technical-reference.md` § 13 — see F58, F63, F64
> (assessed at the Phase 4 completion audit) and F19. The `admin_preorders`
> item below was resolved during Phase 4 (tenant-aware definition applied
> to production in sub-deploy 4.3).

Differences identified during pre-migration review:

- **`admin_preorders` view** — exists in production, missing in staging.
  Definition captured in `pg_dump`. Either recreate in staging before
  migration, or roll into the migration script for both environments.
- **(add other findings here as you spot them)**

---

## 5. Edge Function Inventory

8 functions in production, captured to `edge-functions-prod/`.
Staging count: TODO (capture and compare).

| Function | Purpose | Needs `tenant_id` post-migration? |
|---|---|---|
| `approve-customer` | Admin approves a registration request | Yes |
| `claim-paper-customer` | Customer claims a paper-based account | Yes |
| `create-paper-customer` | Admin creates account from paper records | Yes |
| `invite-customer` | Sends MailerSend invite email | Yes (also needs tenant branding in template) |
| `notify-customers` | Catalog notification email blast | Yes (must scope to one tenant) |
| `register-customer` | Self-service signup | Yes |
| `reset-password` | Password reset flow | Likely no (Supabase auth handles it) |
| `send-my-list` | Email customer their pull list | Yes |

---

## 6. Known Issues / Pre-Migration Cleanup

- **Production database password rotated on 2026-04-29** because it was
  briefly exposed during backup setup. Old password is documented in
  password manager as "rotated".
- **`admin_preorders` view** missing in staging — see Section 4.
- **(add other items as you find them during migration design)**

---

## Restoration Procedure (Emergency)

If you need to fully roll back to the state captured here:

1. **Code:** `git checkout pre-multitenancy-v1` (production) or
   `pre-multitenancy-v1-staging` (staging).
2. **Database:** restore the `.sql` dump using `psql`:

---

## Phase 1 Completion — 2026-04-30

Status: Complete on staging. Production untouched.
Branch merged: feature/multi-tenancy-foundation → staging

### Founding Tenant
- slug: raysandjudys
- display_name: Ray & Judy's Book Stop
- id: 72e29f67-39f7-42bc-a4d5-d6f992f9d790

### Tables Added
- tenants

### Columns Added (all tables except catalog)
- tenant_id uuid NOT NULL DEFAULT '72e29f67-...' REFERENCES tenants(id)
- catalog.tenant_id has no default (import-script-only, service role bypasses RLS)

### Deviations From Plan

**Extra tables discovered at pre-flight:**
app_settings and usage_events were not in technical-reference.md but existed
on staging. Both received tenant_id, RLS policies, and column defaults.

**analytics views:**
analytics_daily_events, analytics_top_cancelled, analytics_top_reserved,
analytics_top_subscribed, analytics_user_activity are views over real tables.
No tenant_id needed in Phase 1. Will need rebuilding in Phase 2 to filter
by current_tenant_id().

**RLS recursion fix:**
Admin policies originally used EXISTS (SELECT 1 FROM user_profiles WHERE
is_admin = true). This caused infinite recursion → 500 errors on all tables.
Fixed by adding current_user_is_admin() SECURITY DEFINER function. All admin
policies now call this function instead of the inline subquery.

**Missing INSERT policy on app_settings:**
Maintenance mode toggle uses upsert. Original policy set only covered SELECT
and UPDATE. Added INSERT and DELETE policies for admins.

**Column defaults not in original plan:**
All app-written tables received a tenant_id column default set to the
founding tenant UUID. This bridges the Phase 2 gap where app code does not
yet pass tenant_id explicitly. catalog intentionally has no default — it is
only written by the import script using the service role.

### Known Breakage
import-staging.js RPC calls will fail at next monthly run.
Affected functions (old 2-param signatures removed):
- purge_stale_catalog
- delete_dropped_catalog_items
- archive_stale_reservations
All three now require p_tenant_id uuid as first argument.
Do not run the staging import until Phase 2 is complete, or patch the
three RPC calls in import-staging.js manually as a stopgap.

---

## Phase 4 Completion — 2026-06-10

Status: Complete. Production migrated to post-Phase-3 multi-tenant parity
with staging. Sub-deploys 4.0–4.8 plus the completion audit are closed —
see `phase-4-production-migration.md` for the sub-deploy index and ticked
completion criteria.

### Founding Tenant (production)
- id: generated 2026-05-30 during the 4.2 pre-flight; recorded in the local
  scratch file `catalogs\scripts\phase-4-prod-tenant-uuid.txt` (gitignored —
  deliberately never committed)
- Owner admin: `734bfd7e-23a6-4c23-ba35-1f64843603c0` ("Book Stop")

### Recovery Anchors (Phase 4 close)

| Asset | Location | Notes |
|---|---|---|
| Production code tag | `phase-4-cutover-v1` | On `origin`; created at 4.6 closeout |
| Staging code tag | `phase-4-cutover-v1-staging` | On `origin` and `staging` remotes (pushed to `staging` remote 2026-06-10 at the completion audit) |
| Production full DB dump | `OneDrive\...\backups\2026-06-10-phase-4-close\backup-prod-phase-4-close-20260610.sql` | 12.6 MB; taken 2026-06-10 20:41; all 10 tables with data; `dump complete` footer verified. Copy of `catalogs\scripts\schema-prod-full.sql` (original retained; "schema-" prefix is a misnomer — it is a full data dump) |
| Staging full DB dump | `...\2026-06-10-phase-4-close\backup-staging-phase-4-close-20260610.sql` | 9.0 MB; taken 2026-06-10 20:43; same provenance (`schema-staging-full.sql`) |
| Schema-only pair | `...\2026-06-10-phase-4-close\schema-only-prod-20260610.sql`, `schema-only-staging-20260610.sql` | Structural snapshots at Phase 4 close (post-4.8 drops) |
| Mid-window dumps (retained) | `backups\pulllist\dump-postgres-202605302059.backup`, `dump-postgres-202606020906.backup` | 2026-05-30 dump is the F59 recovery source (keep — decided at 4.7 closeout) |

### Notable Events
- **F59:** 330 customer reservations failed to persist during the cutover
  window (merge-base regression in PR #49); fully recovered 2026-06-01 from
  the 2026-05-30 dump. Prevention added to the deployment workflow.
- **F60 / F61 / F62:** surfaced during the 4.7 soak; all resolved
  (notify-customers service-role auth; Brave/iOS confirm modal; send-my-list
  admin 403).
- **4.8 housekeeping:** 5 dead `analytics_*` views (F55) and 2 dead functions
  (F56 `claim_paper_account`, F57 `generate_invite_link`) dropped from prod.

### Open Findings at Phase 4 Close
F58 (intentional prod divergence, staging audit pending), F63 and F64
(assessed at the completion audit — no Phase 4 blocker; reconciliation
scheduled pre-Phase-5), F65 (deferred F61 sibling), F66 (latent, unreachable
today). Dispositions in `technical-reference.md` § 13; carry-forward list in
`phase-5-second-tenant-onboarding.md`.