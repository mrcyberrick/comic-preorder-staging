# Phase 3.3 — Remove `tenant_id` Column Defaults

**Status:** Planning
**Branch:** `feature/phase-3.3-remove-column-defaults` (branched from `staging`)
**Risk:** Medium — removes the safety net established in Phase 1.3
**Reversible:** Yes (SQL migration to put defaults back, documented below)
**Run after:** Phase 3.2 complete and soaked at least 48 hours
**Estimated execution time:** One weekend session, including comprehensive verification

This document is the execution blueprint for Sub-Deploy 3.3. Read it
end-to-end before starting. Refer to `phase-3-tenant-resolution.md` for
the parent phase scope and to `CLAUDE.md` for the anti-drift rules
governing this session.

---

## Goals

1. Remove the `tenant_id` column defaults from all seven tenant-scoped
   tables that had defaults set in Phase 1.3
2. End in a state where every INSERT into a tenant-scoped table must
   pass `tenant_id` explicitly — there is no longer a database-side
   safety net
3. Surface any code path that was silently relying on the default by
   forcing it to fail loudly during verification (NOT NULL constraint
   violation) instead of silently getting the founding tenant ID

**This sub-deploy does NOT change any code.** The app.js writes,
Edge Functions, and import script were all updated in Phases 2 and
3.2 to pass `tenant_id` explicitly. 3.3 is a database-only change
that proves those updates were complete by removing the fallback.

**Out of scope for 3.3 — do NOT do these in this session:**

- Any code changes (`app.js`, HTML, Edge Functions, import script)
- Analytics view changes — sub-deploy 3.4
- `usage_events` purge — sub-deploy 3.5
- Admin operational tooling — sub-deploy 3.6
- Production database changes — Phase 4 (production migration)
- Any new RLS policies or schema changes
- Anything related to the deferred fulfillment bugs (3.7 / 3.8)

If you find a real bug while executing 3.3 that is out of scope, **stop
and ask** per the anti-drift rules in `CLAUDE.md`.

---

## Why This Sub-Deploy Matters and Why It's Riskier

Phases 2 and 3.2 made every code path that writes to a tenant-scoped
table pass `tenant_id` explicitly. The column defaults that were added
in Phase 1.3 became safety nets — if any code forgot, the database
filled in the founding tenant.

That safety net was correct for the migration period but it now hides
information. As long as the defaults exist:

- We don't actually know whether every write path is correct
- New code added later could silently rely on the default
- A second tenant added to staging would silently get founding-tenant
  data on any write that forgot tenant context
- The eventual production migration (Phase 4) will need to make the
  same change — better to validate the approach on staging first

After 3.3 ships:

- Every write that forgets `tenant_id` fails immediately with a
  PostgreSQL `not_null_violation`
- The error surfaces in the browser console (or Edge Function logs)
  immediately, instead of silently corrupting data
- The schema is in its final intended state — multi-tenant by
  construction, no implicit fallbacks

**Why this is the riskiest sub-deploy of Phase 3:**

The risk isn't the SQL itself — that's a 7-line migration. The risk
is that 3.2's explicit-pass changes might have a gap we didn't
catch. If an INSERT path was missed in 3.2, removing the default
makes it visibly broken. That's actually the desired behavior of
3.3, but it means verification has to be thorough enough to find
gaps before they reach production.

The mitigation: detailed per-touchpoint verification (every write
path tested), full rollback SQL ready before execution, and a slow
soak after.

---

## Tables Affected

All seven tenant-scoped tables that had defaults set in Phase 1.3:

| Table | Default removed | Code paths that write to it |
|---|---|---|
| `preorders` | yes | `app.js` (Preorders.reserve), import script (auto-reserve) |
| `subscriptions` | yes | `app.js` (Subscriptions.subscribe), import script (auto-reserve checks) |
| `app_settings` | yes | `app.js` (Settings.set) — maintenance toggle, order deadline |
| `usage_events` | yes | `app.js` (UsageEvents._log) |
| `user_profiles` | yes | Edge Functions (invite-customer, register-customer, create-paper-customer) |
| `weekly_shipment` | yes | Import script only (service role) |
| `reservation_history` | yes | `archive_stale_reservations` RPC (called by import script) |

Note: `settings` (legacy table) was given a default in Phase 1.3 but is
not actively written by the app — `app_settings` superseded it. We
remove its default too for consistency. If something accidentally still
writes to `settings`, we want to find that out now.

---

## Files Affected

| File | Type of change |
|---|---|
| Database (staging Supabase) | SQL migration via SQL editor |
| `docs/phase-3-tenant-resolution.md` | Status update on completion |
| `docs/phase-3.3-remove-column-defaults.md` | This file, completion checklist filled in |

**Files NOT touched** (verify before considering complete):
- `app.js` — no changes
- Any HTML file — no changes
- Any Edge Function — no changes
- `import-staging.js`, `import.js` — no changes
- `style.css`, `config.js` — no changes
- Any other doc file

---

## Pre-Flight Checks

### 1. Confirm Phase 3.2 has soaked at least 48 hours

The whole point of 3.2's soak is to surface any explicit-write gaps
before 3.3 removes the safety net. If 3.2 hasn't soaked enough, defer
3.3 — there is no urgency.

### 2. Confirm staging is currently working

Run a quick smoke test:
- Test Customer login → reserve a comic → check My List
- Test Admin login → toggle maintenance mode on/off → impersonate a customer

All flows must work before starting 3.3. If anything is broken now,
fix that first as a separate change — don't bundle into 3.3.

### 3. Confirm column defaults are still in place (the precondition)

Run in staging Supabase SQL editor:

```sql
SELECT table_name, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND column_name = 'tenant_id'
  AND table_name IN (
    'preorders', 'subscriptions', 'app_settings', 'usage_events',
    'user_profiles', 'weekly_shipment', 'reservation_history',
    'settings'
  )
ORDER BY table_name;
```

Expected: 7 or 8 rows (depending on whether `settings` still exists),
each showing `'72e29f67-39f7-42bc-a4d5-d6f992f9d790'::uuid` as
`column_default`. The `catalog` table intentionally has no default
(import-script-only, service role bypasses RLS).

If any of the seven show NULL, **stop**. Either the defaults were
already removed (someone jumped ahead) or this isn't the staging
project.

### 4. Confirm no NULL tenant_id rows exist anywhere

Removing the default means future inserts must pass `tenant_id`. But
existing rows must already have `tenant_id` set, or they violate the
NOT NULL constraint that's already in place from Phase 1.2.

```sql
SELECT 'preorders'           AS t, COUNT(*) AS null_rows FROM preorders           WHERE tenant_id IS NULL
UNION ALL
SELECT 'subscriptions',      COUNT(*) FROM subscriptions      WHERE tenant_id IS NULL
UNION ALL
SELECT 'app_settings',       COUNT(*) FROM app_settings       WHERE tenant_id IS NULL
UNION ALL
SELECT 'usage_events',       COUNT(*) FROM usage_events       WHERE tenant_id IS NULL
UNION ALL
SELECT 'user_profiles',      COUNT(*) FROM user_profiles      WHERE tenant_id IS NULL
UNION ALL
SELECT 'weekly_shipment',    COUNT(*) FROM weekly_shipment    WHERE tenant_id IS NULL
UNION ALL
SELECT 'reservation_history', COUNT(*) FROM reservation_history WHERE tenant_id IS NULL
UNION ALL
SELECT 'settings',           COUNT(*) FROM settings           WHERE tenant_id IS NULL;
```

Expected: every row shows `null_rows = 0`. If any show a count, those
rows would be orphaned by removing the default + NOT NULL combination.
**Stop and ask** — backfilling is its own consideration that shouldn't
be bundled into 3.3.

### 5. Establish row-count baseline for post-deploy comparison

```sql
SELECT 'preorders'             AS t, COUNT(*) AS row_count FROM preorders
UNION ALL
SELECT 'subscriptions',        COUNT(*) FROM subscriptions
UNION ALL
SELECT 'app_settings',         COUNT(*) FROM app_settings
UNION ALL
SELECT 'usage_events',         COUNT(*) FROM usage_events
UNION ALL
SELECT 'user_profiles',        COUNT(*) FROM user_profiles
UNION ALL
SELECT 'weekly_shipment',      COUNT(*) FROM weekly_shipment
UNION ALL
SELECT 'reservation_history',  COUNT(*) FROM reservation_history;
```

Save these counts. After verification, they should be unchanged or
incremented (no data lost).

### 6. Have the rollback SQL ready before running the change

The rollback section below has the exact SQL to restore defaults. Open
it in a separate browser tab or copy it into a notepad before running
the migration. If the migration succeeds but verification fails, the
rollback needs to happen quickly and accurately — not researched on the
fly.

---

## The Change

A single SQL migration removes the defaults from all seven (or eight)
tables in one transaction. Run this in the staging Supabase SQL editor:

```sql
-- ============================================================
-- Phase 3.3 — Remove tenant_id column defaults
-- Target: STAGING only (puoaiyezsreowpwxzxhj.supabase.co)
-- ============================================================

BEGIN;

ALTER TABLE preorders            ALTER COLUMN tenant_id DROP DEFAULT;
ALTER TABLE subscriptions        ALTER COLUMN tenant_id DROP DEFAULT;
ALTER TABLE app_settings         ALTER COLUMN tenant_id DROP DEFAULT;
ALTER TABLE usage_events         ALTER COLUMN tenant_id DROP DEFAULT;
ALTER TABLE user_profiles        ALTER COLUMN tenant_id DROP DEFAULT;
ALTER TABLE weekly_shipment      ALTER COLUMN tenant_id DROP DEFAULT;
ALTER TABLE reservation_history  ALTER COLUMN tenant_id DROP DEFAULT;

-- settings (legacy table — drop if it exists, ignore if it doesn't)
DO $$ BEGIN
  ALTER TABLE settings ALTER COLUMN tenant_id DROP DEFAULT;
EXCEPTION
  WHEN undefined_table THEN NULL;
  WHEN undefined_column THEN NULL;
END $$;

COMMIT;
```

That's the entire change. Do not bundle anything else with this
migration.

---

## Verification

Verification is the bulk of the work for 3.3. Each writing code path
must be exercised after the defaults are removed, and each must
succeed without producing a NOT NULL violation.

### V1 — Confirm defaults are actually gone

```sql
SELECT table_name, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND column_name = 'tenant_id'
  AND table_name IN (
    'preorders', 'subscriptions', 'app_settings', 'usage_events',
    'user_profiles', 'weekly_shipment', 'reservation_history',
    'settings'
  )
ORDER BY table_name;
```

Expected: every row shows `column_default = NULL`. The default has
been removed. If any row still shows the founding tenant UUID, the
migration didn't apply to that table.

### V2 — Confirm NOT NULL is still enforced (negative test)

This proves the safety net is genuinely gone — an INSERT without
`tenant_id` should now fail.

```sql
-- This INSERT must fail with a NOT NULL violation
INSERT INTO settings (key, value) VALUES ('test_no_default', 'should_fail');
-- Expected error:
--   ERROR: null value in column "tenant_id" of relation "settings"
--   violates not-null constraint
```

If this INSERT succeeds, the default is still in place somewhere or
NOT NULL was removed. **Stop and investigate.**

### V3 — `app.js` writes still work

This exercises the four 3.2 write paths through the actual UI:

1. Log in as Test Customer on staging
2. **Reserve a comic** — should succeed. Confirm in DevTools Network
   that the POST to `/rest/v1/preorders` returns 201, body contains
   the inserted row including the correct `tenant_id`
3. **Subscribe to a series** — same flow. POST to `/rest/v1/subscriptions`
   should return 201
4. **Browse the catalog** — passive `usage_events` log should fire.
   POST to `/rest/v1/usage_events` should return 201
5. Log in as Test Admin
6. **Toggle maintenance mode** — Settings.set on `app_settings` should
   succeed. POST/PATCH to `/rest/v1/app_settings` should return 2xx
7. Toggle it back off — same

All four code paths must succeed. **If any returns a 400 with
`null value in column "tenant_id" violates not-null constraint`,
that's a code path 3.2 missed.** Stop, document the gap, fix the
missing explicit-pass in `app.js`, then re-verify.

### V4 — Edge Function writes still work

The three Edge Functions that write to `user_profiles` were updated
in Phase 2 to pass `tenant_id` from the `FOUNDING_TENANT_ID` secret.
Verify each:

#### V4a — `invite-customer` Edge Function

1. Log in as Test Admin on staging
2. Use the admin invite UI to invite a fresh test email
   (e.g. `invite-test-3-3@example.com`)
3. Confirm the function returns success and a profile row is created:

```sql
SELECT id, email, tenant_id, status
FROM user_profiles
WHERE email = 'invite-test-3-3@example.com';
-- Expected: 1 row with tenant_id = '72e29f67-...'
```

4. Clean up:

```sql
-- This will cascade-delete the profile via FK
DELETE FROM auth.users WHERE email = 'invite-test-3-3@example.com';
```

#### V4b — `create-paper-customer` Edge Function

1. As Test Admin, use the paper customer UI to create a test paper user
   (any name will do; the function generates the email)
2. Verify the row was created with the correct `tenant_id`:

```sql
SELECT id, full_name, email, tenant_id, is_paper
FROM user_profiles
WHERE email LIKE '%@paper.pulllist.local'
  AND created_at > now() - interval '5 minutes'
ORDER BY created_at DESC
LIMIT 1;
-- Expected: tenant_id = '72e29f67-...', is_paper = true
```

3. Clean up:

```sql
DELETE FROM auth.users
WHERE email = '<the test paper email from above>';
```

#### V4c — `register-customer` Edge Function

This one is harder to test naturally because it's triggered by a
MailerLite webhook. Use the magic-link script's underlying flow as a
proxy — the script creates a user_profiles row directly via the admin
API, which exercises the same NOT NULL constraint:

```powershell
.\test-magic-link.ps1
```

If the script completes successfully (creates a user, generates a
link, prints it), the `user_profiles` insert path works. The script
does its own cleanup.

### V5 — Import script writes still work

This is the riskiest verification because the import script writes to
multiple tables (catalog, preorders via auto-reserve, weekly_shipment,
reservation_history). All except `catalog` had defaults removed in
this sub-deploy.

#### V5a — Test import without shipments (catalog refresh only)

If you have access to the staging CSV files used in previous import
testing, run a same-month catalog refresh:

```powershell
node .\import-staging.js "..\catalog-LUNAR.csv" "..\catalog-PRH.csv"
```

When prompted, confirm the catalog month (it should detect the current
staging month). Answer 'n' to the shipment prompt. Answer 'n' to the
notification prompt.

Watch the script output. Any line saying:
- `❌ Catalog batch ... failed`
- `Could not fetch subscriptions`
- `Auto-reserve batch failed`

…with a body mentioning `null value in column "tenant_id"` indicates
the import script missed a code path. **Stop and fix the script** —
that's a Phase 2 gap that needs patching.

The expected output is the same as previous successful runs:
- "Catalog upsert complete — N records"
- "Auto-reserved N item(s) for subscribers" (or "No new auto-reserves")

#### V5b — Test full import with shipments (optional, only if shipment files are available)

If you have shipment CSVs from the most recent staging test:

```powershell
node .\import-staging.js "..\catalog-LUNAR.csv" "..\catalog-PRH.csv" "..\delivery-detail-LUNAR.csv" "..\delivery-detail-PRH.csv"
```

This exercises the `weekly_shipment` writes. Same pass/fail criteria
as V5a — any tenant_id NOT NULL violation indicates a script gap.

### V6 — `archive_stale_reservations` RPC (only triggered on new month)

This RPC is called by the import script when the catalog month
changes. On staging, the catalog month doesn't change every day, so
this is hard to trigger naturally. To exercise it manually:

```sql
SELECT archive_stale_reservations(
  '72e29f67-39f7-42bc-a4d5-d6f992f9d790'::uuid,  -- p_tenant_id
  CURRENT_DATE,                                    -- cutoff_date
  '2099-01'                                        -- current_month (fake future)
);
-- Expected: returns an integer (count of archived rows). May be 0
-- if no preorders match the criteria. The important thing is no error.
```

If this errors with `null value in column "tenant_id" violates not-null
constraint`, the function is writing to `reservation_history` without
passing `tenant_id`. That would be a Phase 1.3 gap that needs the
function definition updated.

### V7 — Row counts unchanged

Re-run the row-count baseline query from pre-flight check 5. Counts
should be unchanged or incremented (from V3, V4, V5 test data). No
data should have been lost.

### V8 — Defensive fallback in UsageEvents._log() still works

This was V5 in the 3.2 plan. Re-verify it after 3.3:

1. Log in as Test Customer
2. In browser console:

```javascript
TenantContext._reset()
let captured = null;
try {
  let tenantId;
  try { tenantId = TenantContext.current().id; }
  catch { tenantId = FOUNDING_TENANT.id; }
  captured = tenantId;
} catch (e) {
  captured = `THREW: ${e.message}`;
}
console.log('Fallback resolved to:', captured);
```

Expected: `Fallback resolved to: 72e29f67-39f7-42bc-a4d5-d6f992f9d790`

The fallback is no longer a "safety net behind a safety net" — it's
now the actual mechanism that prevents `usage_events` inserts from
failing if `_log()` is called before `TenantContext.resolve()`. If
this fallback fails after 3.3, the next time it's exercised in
production, the database will reject the insert.

---

## Smoke Test

After V1–V8 pass, run a condensed smoke pass to confirm nothing
regressed in normal usage:

| # | Account | Flow | Expected |
|---|---|---|---|
| 1 | Test Customer | Login, browse catalog | Items load, no console errors |
| 2 | Test Customer | Reserve a comic | Persists, appears in My List |
| 3 | Test Customer | Cancel a reservation | Removed |
| 4 | Test Customer | Subscribe to a series | Subscription appears |
| 5 | Test Customer | Unsubscribe | Removed |
| 6 | Test Admin | View dashboard | Loads correctly |
| 7 | Test Admin | Toggle maintenance mode on, then off | Both work |
| 8 | Test Admin | Impersonate a customer | Banner appears |
| 9 | Test Admin (impersonating) | Reserve on behalf of customer | Saves correctly |
| 10 | Test Admin | View pending users (if any) | Loads |
| 11 | Test Customer (logout, fresh) | Login flow | Standard auth flow works |

Watch the browser console throughout. Any `null value in column
"tenant_id"` error means a write path was missed and needs investigation.

---

## Rollback

If verification reveals a problem that can't be fixed quickly, restore
the defaults. Run this in the staging Supabase SQL editor:

```sql
-- ============================================================
-- Phase 3.3 — ROLLBACK: restore tenant_id column defaults
-- ============================================================

BEGIN;

ALTER TABLE preorders
  ALTER COLUMN tenant_id SET DEFAULT '72e29f67-39f7-42bc-a4d5-d6f992f9d790';

ALTER TABLE subscriptions
  ALTER COLUMN tenant_id SET DEFAULT '72e29f67-39f7-42bc-a4d5-d6f992f9d790';

ALTER TABLE app_settings
  ALTER COLUMN tenant_id SET DEFAULT '72e29f67-39f7-42bc-a4d5-d6f992f9d790';

ALTER TABLE usage_events
  ALTER COLUMN tenant_id SET DEFAULT '72e29f67-39f7-42bc-a4d5-d6f992f9d790';

ALTER TABLE user_profiles
  ALTER COLUMN tenant_id SET DEFAULT '72e29f67-39f7-42bc-a4d5-d6f992f9d790';

ALTER TABLE weekly_shipment
  ALTER COLUMN tenant_id SET DEFAULT '72e29f67-39f7-42bc-a4d5-d6f992f9d790';

ALTER TABLE reservation_history
  ALTER COLUMN tenant_id SET DEFAULT '72e29f67-39f7-42bc-a4d5-d6f992f9d790';

-- settings (legacy)
DO $$ BEGIN
  ALTER TABLE settings
    ALTER COLUMN tenant_id SET DEFAULT '72e29f67-39f7-42bc-a4d5-d6f992f9d790';
EXCEPTION
  WHEN undefined_table THEN NULL;
  WHEN undefined_column THEN NULL;
END $$;

COMMIT;
```

After rollback, re-run V1 from this plan to confirm defaults are
back. The system is now in its pre-3.3 state. Investigate whatever
gap was found, fix it (either in `app.js`, an Edge Function, or the
import script), then attempt 3.3 again.

The most common rollback cause: a write path that was missed in 3.2.
Fix the missing explicit-pass, ship it as a small fix, soak briefly,
then re-attempt 3.3.

---

## Completion Criteria

Phase 3.3 is complete when **all** of the following are true on staging:

- [ ] All 7 (or 8) tables have `column_default = NULL` for `tenant_id`
      (V1 confirmed)
- [ ] V2 negative test confirmed: INSERT without `tenant_id` fails
- [ ] V3 — all four `app.js` write paths still succeed
- [ ] V4a — invite-customer Edge Function still creates profiles
- [ ] V4b — create-paper-customer Edge Function still creates profiles
- [ ] V4c — magic-link script still creates profiles successfully
- [ ] V5 — import script catalog refresh succeeds
- [ ] V6 — `archive_stale_reservations` RPC succeeds when called manually
- [ ] V7 — row counts unchanged
- [ ] V8 — UsageEvents defensive fallback still resolves correctly
- [ ] Smoke test rows 1–11 all pass
- [ ] No code changes made (verify with `git diff --stat`)
- [ ] `docs/phase-3-tenant-resolution.md` updated with 3.3 status set
      to "Complete" and the date
- [ ] `CLAUDE.md` active sub-deploy line updated
- [ ] No out-of-scope work bundled in

---

## What Phase 3.3 Does NOT Achieve

- **Production is unchanged.** Production still has the pre-Phase-1
  schema. The defaults removal applies only to staging. Phase 4 (the
  production migration) will replicate this work against production
  using the same plan structure.
- **Catalog table still has no default.** Intentional — it never had
  one. The import script always passes `tenant_id` explicitly.
- **Analytics views still un-scoped.** Sub-deploy 3.4.
- **Usage events still grow unbounded.** Sub-deploy 3.5.
- **Admin tooling unchanged.** Sub-deploy 3.6.

---

## Open Questions for Pre-Execution

Resolve these before starting:

1. **Confirm staging shipment CSV files are available** (for V5b). If
   not available, V5b is skipped — V5a alone is sufficient evidence
   the import script works post-3.3.

2. **Confirm there is at least one subscription on staging** (so V5a
   exercises the auto-reserve path that writes to `preorders` from
   the import script). If no subscriptions exist, create one as Test
   Customer before running V5a, or accept that auto-reserve won't be
   exercised by V5a.

3. **Confirm someone (you) can be present in the browser console
   during verification.** V3, V4, V8 require checking Network tab
   responses and console output. This is not something CLI Claude
   can do — it's a manual browser task.

---

## Execution Notes

**2026-05-05** — During V6 verification, `archive_stale_reservations`
RPC failed with `null value in column "tenant_id" of relation
"reservation_history" violates not-null constraint`. Root cause:
Phase 1.3 added `p_tenant_id` as a parameter to the function and
filtered by it in the SELECT, but the INSERT into reservation_history
didn't include `tenant_id` in the column list. The column default
established in Phase 1.3 had been masking this gap.

Fix applied inline as part of 3.3 (same pattern as 3.1's hot-fix):
`CREATE OR REPLACE FUNCTION archive_stale_reservations` with
`tenant_id` added to both the INSERT column list and the SELECT
projection (using `p_tenant_id` as the source).

V6 passed on retry. No other functions had similar gaps:
`claim_paper_account` was inspected and only does UPDATE/DELETE on
existing rows — no INSERT, no NOT NULL exposure.

Architectural note for later: `claim_paper_account` doesn't filter
preorder/subscription reassignment by tenant. Not a 3.3 concern
(no NOT NULL violation possible) but worth revisiting when paper-
customer flows are exercised cross-tenant in a future phase.

---

## Reference

- Parent plan: `docs/phase-3-tenant-resolution.md`
- Phase 3.2 plan: `docs/phase-3.2-explicit-tenant-writes.md`
- Phase 1 schema (where defaults were added): `docs/phase-1-schema-migration.md`
- Phase 2 completion (Edge Function tenant-awareness): `docs/phase-2-completion.md`
- Anti-drift rules: `CLAUDE.md` § Anti-Drift Rules for Agentic Sessions
- Founding tenant UUID: `72e29f67-39f7-42bc-a4d5-d6f992f9d790`

---

**Last updated:** 2026-05-04 (initial plan)
