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