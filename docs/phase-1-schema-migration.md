# Phase 1 — Schema Foundation Migration

**Status:** Planning complete, execution pending
**Branch:** `feature/multi-tenancy-foundation` (branched from `staging`)
**Estimated execution time:** 3 sub-deploys over 1–2 weekends
**Customer impact:** None (staging only, production untouched)

This document is the execution blueprint for Phase 1 of the multi-tenancy
migration. Read it end-to-end before starting. Refer back to
`pre-multitenancy-state.md` for the baseline state being modified.

---

## Goals

1. Add `tenants` table to model multi-tenancy at the database level
2. Add `tenant_id` to every existing table that contains tenant-scoped data
3. Migrate all existing data into a single "Ray & Judy's" tenant
4. Update RLS policies so they filter on `tenant_id` in addition to the
   existing user-based checks
5. Update database functions (`purge_stale_catalog`,
   `delete_dropped_catalog_items`, `archive_stale_reservations`) to be
   tenant-scoped
6. Recreate the `admin_preorders` view in staging (drift fix)
7. End in a state where staging is multi-tenant in *structure* but
   functionally identical to before (one tenant exists, behaves as
   single-tenant)

**Out of scope for Phase 1:**

- Application code changes (`app.js`, HTML files) — that's Phase 2
- Edge function updates — also Phase 2
- Tenant resolution from subdomain / hostname — Phase 3
- Self-service tenant signup — Phase 4

---

## Pre-Flight Checks

Run these on staging the same day you start Phase 1 execution.
If anything has drifted since the baseline, address it before proceeding.

### 1. Confirm row counts still match baseline

In the Supabase SQL editor for staging, run:

```sql
SELECT 'user_profiles' AS table_name, COUNT(*) AS row_count FROM user_profiles
UNION ALL SELECT 'catalog', COUNT(*) FROM catalog
UNION ALL SELECT 'preorders', COUNT(*) FROM preorders
UNION ALL SELECT 'subscriptions', COUNT(*) FROM subscriptions
UNION ALL SELECT 'settings', COUNT(*) FROM settings
ORDER BY table_name;
```

Compare against `docs/pre-multitenancy-state.md` Section 2. If counts have
changed materially since baseline (more than ±10% on any table), pause and
investigate — it means staging has had real activity since the baseline.
That's not blocking but you'll want to capture an updated baseline before
proceeding.

### 2. Confirm no in-progress feature branches touching schema

```powershell
git branch -a | findstr "feature/"
```

If there are open feature branches with un-merged schema changes, merge or
abandon them before Phase 1. Multi-tenancy + concurrent schema work is a
recipe for confusing conflicts.

### 3. Verify staging admin user exists

```sql
SELECT id, full_name, is_admin
FROM user_profiles
WHERE is_admin = true;
```

You'll need at least one admin user on staging to verify the RLS changes
work post-migration. Note the user's `id` for use in Sub-Deploy 2 below.

### 4. Confirm code recovery tag is reachable

```powershell
git show pre-multitenancy-v1-staging --stat --no-patch
```

Should return the staging baseline commit. If it errors, restore from
backup before starting.

---

## Sub-Deploy Sequence

Phase 1 is broken into **three sub-deploys** with verification gates
between each. Don't merge them — execute them as separate commits on the
`feature/multi-tenancy-foundation` branch. If something goes wrong, the
boundaries between sub-deploys are natural rollback points.

```
Sub-Deploy 1.1 — Add structure (additive only, breaks nothing)
        │
        ▼  (verify: existing app still works, new structure exists, all tenant_ids filled)
Sub-Deploy 1.2 — Tighten constraints (NOT NULL, foreign keys)
        │
        ▼  (verify: existing app still works, no NULL tenant_ids possible)
Sub-Deploy 1.3 — Update RLS + functions (enforcement)
        │
        ▼  (verify: admin dashboard still works, customer flows still work, RLS sanity checks pass)
       END of Phase 1
```

Each sub-deploy is one SQL file in `db/migrations/phase-1/`. Run via the
Supabase SQL editor against staging only. Production is not touched in
Phase 1.

---

## Sub-Deploy 1.1 — Additive Schema Changes

**File:** `db/migrations/phase-1/01-add-tenant-structure.sql`
**Risk:** Low — purely additive, no existing functionality affected
**Reversible:** Yes (drop new columns/table)

### What it does

1. Creates the `tenants` table
2. Inserts a single tenant row for "Ray & Judy's Book Stop"
3. Adds nullable `tenant_id` column to `user_profiles`, `catalog`,
   `preorders`, `subscriptions`, `settings`, plus `weekly_shipment` and
   `reservation_history` if they exist
4. Backfills `tenant_id` for every existing row with the Ray & Judy's
   tenant ID

### SQL

```sql
-- ============================================================
-- Phase 1, Sub-Deploy 1.1 — Add tenant structure (additive)
-- ============================================================

BEGIN;

-- 1. Create tenants table
CREATE TABLE tenants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL UNIQUE,           -- e.g. 'raysandjudys' for subdomain
  display_name  text NOT NULL,                  -- e.g. "Ray & Judy's Book Stop"
  contact_email text,
  contact_phone text,
  location      text,
  plan          text NOT NULL DEFAULT 'free',   -- 'free' | 'pro' | 'business'
  branding      jsonb DEFAULT '{}'::jsonb,      -- logo_url, primary_color, etc.
  settings      jsonb DEFAULT '{}'::jsonb,      -- per-tenant config knobs
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);

CREATE INDEX idx_tenants_slug ON tenants(slug);

-- 2. Seed the founding tenant
INSERT INTO tenants (slug, display_name, contact_phone, location, plan)
VALUES (
  'raysandjudys',
  'Ray & Judy''s Book Stop',
  '973-586-9182',
  'Rockaway, NJ',
  'pro'  -- founding tenant gets pro features by default
)
RETURNING id;

-- IMPORTANT: copy the returned UUID and use it in step 4 below.
-- For convenience, capture it as a variable:
DO $$
DECLARE
  founding_tenant_id uuid;
BEGIN
  SELECT id INTO founding_tenant_id
  FROM tenants WHERE slug = 'raysandjudys';

  -- 3. Add nullable tenant_id columns to existing tables
  ALTER TABLE user_profiles  ADD COLUMN tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE;
  ALTER TABLE catalog        ADD COLUMN tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE;
  ALTER TABLE preorders      ADD COLUMN tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE;
  ALTER TABLE subscriptions  ADD COLUMN tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE;
  ALTER TABLE settings       ADD COLUMN tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE;

  -- weekly_shipment and reservation_history (conditional — may not exist
  -- in all environments). Wrap in DO blocks that swallow undefined-table
  -- errors gracefully:
  BEGIN
    ALTER TABLE weekly_shipment ADD COLUMN tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE;
  EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'weekly_shipment table not present, skipping';
  END;

  BEGIN
    ALTER TABLE reservation_history ADD COLUMN tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE;
  EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'reservation_history table not present, skipping';
  END;

  -- 4. Backfill tenant_id on all existing rows
  UPDATE user_profiles  SET tenant_id = founding_tenant_id WHERE tenant_id IS NULL;
  UPDATE catalog        SET tenant_id = founding_tenant_id WHERE tenant_id IS NULL;
  UPDATE preorders      SET tenant_id = founding_tenant_id WHERE tenant_id IS NULL;
  UPDATE subscriptions  SET tenant_id = founding_tenant_id WHERE tenant_id IS NULL;
  UPDATE settings       SET tenant_id = founding_tenant_id WHERE tenant_id IS NULL;

  BEGIN
    UPDATE weekly_shipment SET tenant_id = founding_tenant_id WHERE tenant_id IS NULL;
  EXCEPTION WHEN undefined_table THEN NULL;
  END;

  BEGIN
    UPDATE reservation_history SET tenant_id = founding_tenant_id WHERE tenant_id IS NULL;
  EXCEPTION WHEN undefined_table THEN NULL;
  END;

  RAISE NOTICE 'Founding tenant ID: %', founding_tenant_id;
END $$;

-- 5. Add indexes on tenant_id (every multi-tenant query will filter on this)
CREATE INDEX idx_user_profiles_tenant ON user_profiles(tenant_id);
CREATE INDEX idx_catalog_tenant       ON catalog(tenant_id);
CREATE INDEX idx_preorders_tenant     ON preorders(tenant_id);
CREATE INDEX idx_subscriptions_tenant ON subscriptions(tenant_id);
CREATE INDEX idx_settings_tenant      ON settings(tenant_id);

COMMIT;
```

### Verification (after running)

```sql
-- Tenants table exists with one row
SELECT id, slug, display_name, plan FROM tenants;
-- Expected: 1 row, slug='raysandjudys'

-- All existing rows have tenant_id assigned
SELECT 'user_profiles' AS table_name,
       COUNT(*) AS total_rows,
       COUNT(tenant_id) AS with_tenant,
       COUNT(*) - COUNT(tenant_id) AS without_tenant
FROM user_profiles
UNION ALL
SELECT 'catalog', COUNT(*), COUNT(tenant_id), COUNT(*) - COUNT(tenant_id) FROM catalog
UNION ALL
SELECT 'preorders', COUNT(*), COUNT(tenant_id), COUNT(*) - COUNT(tenant_id) FROM preorders
UNION ALL
SELECT 'subscriptions', COUNT(*), COUNT(tenant_id), COUNT(*) - COUNT(tenant_id) FROM subscriptions
UNION ALL
SELECT 'settings', COUNT(*), COUNT(tenant_id), COUNT(*) - COUNT(tenant_id) FROM settings;
-- Expected: without_tenant = 0 for every table
```

### Smoke test gate

After running 1.1 against staging:

1. Open staging app in browser
2. Log in as a customer
3. Browse catalog, view My List, view subscriptions, view This Week
4. Log in as admin, verify dashboard loads
5. Try reserving a comic and confirm it persists

Everything should work identically to before. The new `tenant_id` columns
are present but ignored by RLS and app code — there is **zero functional
change** at this point. If anything is broken at this stage, the issue is
unrelated to your migration; pause and investigate.

### Rollback (if needed)

```sql
-- Drops added columns and the tenants table.
-- Existing data is preserved — only the new structure goes away.
BEGIN;
DROP INDEX IF EXISTS idx_user_profiles_tenant;
DROP INDEX IF EXISTS idx_catalog_tenant;
DROP INDEX IF EXISTS idx_preorders_tenant;
DROP INDEX IF EXISTS idx_subscriptions_tenant;
DROP INDEX IF EXISTS idx_settings_tenant;

ALTER TABLE user_profiles  DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE catalog        DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE preorders      DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE subscriptions  DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE settings       DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE weekly_shipment DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE reservation_history DROP COLUMN IF EXISTS tenant_id;

DROP INDEX IF EXISTS idx_tenants_slug;
DROP TABLE IF EXISTS tenants;
COMMIT;
```

---

## Sub-Deploy 1.2 — Tighten Constraints

**File:** `db/migrations/phase-1/02-tighten-tenant-constraints.sql`
**Risk:** Low (depends on 1.1 succeeding cleanly)
**Reversible:** Yes (drop NOT NULL constraints)
**Run after:** 1.1 verification has passed for at least 24 hours

### What it does

Once we've confirmed every existing row has a `tenant_id`, we promote
the column to NOT NULL. This prevents any new data from being written
without a tenant context — a critical safety property for the rest of
the migration.

We also add the `admin_preorders` view to staging at this point, fixing
the drift identified in `pre-multitenancy-state.md` Section 4.

### SQL

```sql
-- ============================================================
-- Phase 1, Sub-Deploy 1.2 — Tighten tenant_id constraints
-- ============================================================

BEGIN;

-- 1. Make tenant_id NOT NULL on every table
ALTER TABLE user_profiles  ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE catalog        ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE preorders      ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE subscriptions  ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE settings       ALTER COLUMN tenant_id SET NOT NULL;

-- weekly_shipment and reservation_history (conditional)
DO $$ BEGIN
  ALTER TABLE weekly_shipment ALTER COLUMN tenant_id SET NOT NULL;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE reservation_history ALTER COLUMN tenant_id SET NOT NULL;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- 2. Recreate admin_preorders view in staging (drift fix from baseline)
-- This view exists in production but not staging. Pull the definition
-- from backup-prod-pre-multitenancy-20260429.sql and recreate here.
-- Update the view to include tenant_id in its output.
--
-- TODO: Paste actual view definition from production pg_dump and add
-- tenant_id to the SELECT list. Example skeleton:
--
-- CREATE OR REPLACE VIEW admin_preorders AS
-- SELECT
--   p.id,
--   p.user_id,
--   p.catalog_id,
--   p.quantity,
--   p.created_at,
--   p.tenant_id,
--   up.full_name AS customer_name,
--   c.title AS comic_title,
--   c.distributor,
--   c.on_sale_date,
--   c.tenant_id AS catalog_tenant_id  -- sanity check
-- FROM preorders p
-- JOIN user_profiles up ON up.id = p.user_id
-- JOIN catalog c ON c.id = p.catalog_id;

-- 3. Update unique constraints to include tenant_id where appropriate

-- preorders: unique per (user, catalog item) — but since each tenant has
-- its own users and catalog, the existing constraint is already
-- effectively tenant-scoped. No change needed.

-- subscriptions: unique per (user, series_name, distributor). For
-- multi-tenancy, two different tenants might independently subscribe a
-- series with the same name. Drop the old constraint and add a
-- tenant-aware one:
ALTER TABLE subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_user_id_series_name_distributor_key;

ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_tenant_user_series_unique
  UNIQUE (tenant_id, user_id, series_name, distributor);

-- catalog: unique per (item_code, distributor, catalog_month). Two
-- tenants might both order the same item from the same distributor in
-- the same month. Drop the old constraint and add a tenant-aware one:
ALTER TABLE catalog
  DROP CONSTRAINT IF EXISTS catalog_item_code_distributor_month_unique;

ALTER TABLE catalog
  ADD CONSTRAINT catalog_tenant_item_distributor_month_unique
  UNIQUE (tenant_id, item_code, distributor, catalog_month);

-- 4. Tenants slug must be lowercase and URL-safe (enforced by check
-- constraint, not just convention)
ALTER TABLE tenants
  ADD CONSTRAINT tenants_slug_format_check
  CHECK (slug ~ '^[a-z0-9][a-z0-9-]*[a-z0-9]$' OR slug ~ '^[a-z0-9]$');

COMMIT;
```

### Verification

```sql
-- Confirm NOT NULL is enforced
INSERT INTO settings (key, value) VALUES ('test_no_tenant', 'should_fail');
-- Expected: ERROR: null value in column "tenant_id" violates not-null constraint

-- Confirm constraint name updates worked
SELECT conname FROM pg_constraint
WHERE conrelid IN ('subscriptions'::regclass, 'catalog'::regclass)
ORDER BY conname;
-- Expected: subscriptions_tenant_user_series_unique,
--           catalog_tenant_item_distributor_month_unique
```

### Smoke test gate

Same as 1.1 — exercise all major flows. The constraint changes shouldn't
affect normal operation; they only block invalid INSERTs that the app
shouldn't be making anyway.

### Rollback

```sql
BEGIN;
ALTER TABLE user_profiles  ALTER COLUMN tenant_id DROP NOT NULL;
ALTER TABLE catalog        ALTER COLUMN tenant_id DROP NOT NULL;
ALTER TABLE preorders      ALTER COLUMN tenant_id DROP NOT NULL;
ALTER TABLE subscriptions  ALTER COLUMN tenant_id DROP NOT NULL;
ALTER TABLE settings       ALTER COLUMN tenant_id DROP NOT NULL;

ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_tenant_user_series_unique;
ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_user_id_series_name_distributor_key
  UNIQUE (user_id, series_name, distributor);

ALTER TABLE catalog DROP CONSTRAINT catalog_tenant_item_distributor_month_unique;
ALTER TABLE catalog
  ADD CONSTRAINT catalog_item_code_distributor_month_unique
  UNIQUE (item_code, distributor, catalog_month);

ALTER TABLE tenants DROP CONSTRAINT tenants_slug_format_check;
COMMIT;
```

---

## Sub-Deploy 1.3 — RLS Policies and Functions

**File:** `db/migrations/phase-1/03-tenant-aware-rls-and-functions.sql`
**Risk:** Medium — this is where enforcement begins
**Reversible:** Yes (drop new policies, restore old ones from baseline)
**Run after:** 1.2 verification has passed for at least 24 hours

### What it does

Replaces the existing user-based RLS policies with tenant-aware versions.
Updates database functions to accept a `tenant_id` parameter so import
scripts can scope their operations correctly.

This is the most invasive sub-deploy. It changes *enforcement*, not just
structure. After 1.3, an authenticated user querying the catalog will
only see rows from their own tenant.

**Important:** Phase 1 still doesn't have tenant resolution in app code.
That's Phase 2. So in Phase 1, we get the RLS to a state where it
*would* enforce tenant isolation if app code passed `tenant_id` — but
since the app code still queries everything, we use a transitional
approach: RLS will check that the user's `tenant_id` (from
`user_profiles`) matches the row's `tenant_id`. Since all data is in
one tenant, all checks pass and nothing breaks.

### SQL

```sql
-- ============================================================
-- Phase 1, Sub-Deploy 1.3 — Tenant-aware RLS and functions
-- ============================================================

BEGIN;

-- Helper function: get the tenant_id of the currently-authenticated user
-- by looking up their user_profiles row. Used by all tenant-aware RLS
-- policies. Stable + security definer means it's cached per-statement
-- and bypasses RLS when reading from user_profiles (avoiding recursion).
CREATE OR REPLACE FUNCTION current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tenant_id FROM user_profiles WHERE id = auth.uid()
$$;

GRANT EXECUTE ON FUNCTION current_tenant_id() TO authenticated;

-- ============================================================
-- USER_PROFILES policies
-- ============================================================
DROP POLICY IF EXISTS "users view own profile" ON user_profiles;
DROP POLICY IF EXISTS "users update own profile" ON user_profiles;
DROP POLICY IF EXISTS "admins view all profiles" ON user_profiles;

CREATE POLICY "users view own profile" ON user_profiles
  FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "users update own profile" ON user_profiles
  FOR UPDATE
  USING (auth.uid() = id);

-- Admins can see all profiles within their tenant only
CREATE POLICY "admins view tenant profiles" ON user_profiles
  FOR SELECT
  USING (
    tenant_id = current_tenant_id()
    AND EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND is_admin = true
    )
  );

-- ============================================================
-- CATALOG policies
-- ============================================================
DROP POLICY IF EXISTS "authenticated users read catalog" ON catalog;

CREATE POLICY "users read tenant catalog" ON catalog
  FOR SELECT
  TO authenticated
  USING (tenant_id = current_tenant_id());

-- ============================================================
-- PREORDERS policies
-- ============================================================
DROP POLICY IF EXISTS "users manage own preorders" ON preorders;
DROP POLICY IF EXISTS "admins view all preorders" ON preorders;

CREATE POLICY "users manage own preorders" ON preorders
  FOR ALL
  USING (
    auth.uid() = user_id
    AND tenant_id = current_tenant_id()
  );

CREATE POLICY "admins view tenant preorders" ON preorders
  FOR SELECT
  USING (
    tenant_id = current_tenant_id()
    AND EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND is_admin = true
    )
  );

-- ============================================================
-- SUBSCRIPTIONS policies
-- ============================================================
DROP POLICY IF EXISTS "users manage own subscriptions" ON subscriptions;
DROP POLICY IF EXISTS "admins view all subscriptions" ON subscriptions;

CREATE POLICY "users manage own subscriptions" ON subscriptions
  FOR ALL
  USING (
    auth.uid() = user_id
    AND tenant_id = current_tenant_id()
  );

CREATE POLICY "admins view tenant subscriptions" ON subscriptions
  FOR SELECT
  USING (
    tenant_id = current_tenant_id()
    AND EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND is_admin = true
    )
  );

-- ============================================================
-- SETTINGS policies
-- ============================================================
DROP POLICY IF EXISTS "authenticated users read settings" ON settings;
DROP POLICY IF EXISTS "admins update settings" ON settings;

CREATE POLICY "users read tenant settings" ON settings
  FOR SELECT
  TO authenticated
  USING (tenant_id = current_tenant_id());

CREATE POLICY "admins update tenant settings" ON settings
  FOR UPDATE
  USING (
    tenant_id = current_tenant_id()
    AND EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND is_admin = true
    )
  );

-- ============================================================
-- TENANTS policies (new table)
-- ============================================================
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;

-- Authenticated users can read their own tenant's row
CREATE POLICY "users read own tenant" ON tenants
  FOR SELECT
  TO authenticated
  USING (id = current_tenant_id());

-- Tenant admins can update their own tenant's settings/branding
CREATE POLICY "admins update own tenant" ON tenants
  FOR UPDATE
  USING (
    id = current_tenant_id()
    AND EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
        AND is_admin = true
        AND tenant_id = tenants.id
    )
  );

-- ============================================================
-- DATABASE FUNCTIONS — make tenant-aware
-- ============================================================

-- purge_stale_catalog: now scoped to a single tenant
CREATE OR REPLACE FUNCTION purge_stale_catalog(
  p_tenant_id uuid,
  cutoff_date date,
  current_month text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  deleted_count integer;
BEGIN
  DELETE FROM catalog
  WHERE tenant_id = p_tenant_id
    AND catalog_month != current_month
    AND on_sale_date < cutoff_date
    AND id NOT IN (SELECT DISTINCT catalog_id FROM preorders WHERE tenant_id = p_tenant_id);
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

-- delete_dropped_catalog_items: tenant-scoped
CREATE OR REPLACE FUNCTION delete_dropped_catalog_items(
  p_tenant_id uuid,
  p_catalog_month text,
  p_item_codes text[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  deleted_count integer;
BEGIN
  DELETE FROM catalog
  WHERE tenant_id = p_tenant_id
    AND catalog_month = p_catalog_month
    AND item_code != ALL(p_item_codes);
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

-- archive_stale_reservations (if this function exists per import script)
-- Same pattern: add p_tenant_id as first parameter, scope all operations.
-- Skipping inline SQL here because the original definition isn't in the
-- baseline pg_dump under a known signature — pull the actual definition
-- from staging's pg_dump and add the tenant_id parameter following the
-- same pattern as above before running this sub-deploy.

COMMIT;
```

### Verification

```sql
-- 1. Confirm helper function works
SELECT current_tenant_id();
-- Expected (when authenticated): the tenant UUID for your user
-- Expected (when not authenticated): NULL

-- 2. Confirm RLS policies are in place
SELECT schemaname, tablename, policyname, cmd
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;
-- Expected: list includes all the new "tenant" policies

-- 3. Functional check — log in as a customer and run:
SELECT COUNT(*) FROM catalog;
-- Expected: same count as before (since all data is in one tenant)

-- 4. RLS isolation pre-check (artificial but useful)
-- Create a second test tenant and a test row, confirm it's invisible:
INSERT INTO tenants (slug, display_name, plan)
VALUES ('test-isolation', 'Test Isolation Tenant', 'free')
RETURNING id;
-- Note returned ID, then:
INSERT INTO catalog (tenant_id, distributor, item_code, title, catalog_month)
VALUES ('<test-tenant-id>', 'Test', 'TEST001', 'Test Comic', '2026-04');

-- Now run as your normal authenticated user:
SELECT COUNT(*) FROM catalog WHERE item_code = 'TEST001';
-- Expected: 0 (RLS is hiding the test tenant's row from you)

-- Cleanup:
DELETE FROM catalog WHERE item_code = 'TEST001';
DELETE FROM tenants WHERE slug = 'test-isolation';
```

### Smoke test gate (the big one)

After 1.3, all critical flows must still work:

| Flow | Test | Expected |
|---|---|---|
| Customer login | Sign in as a normal user | Success |
| Browse catalog | Visit `catalog.html` | Sees current month items |
| Reserve comic | Click reserve on an item | Item appears in My List |
| View My List | Visit `mylist.html` | Reservations displayed |
| Subscribe to series | Subscribe button on a standard cover | Subscription added |
| This Week | Visit `arrivals.html` | This week's reservations show |
| Admin login | Sign in as admin user | Success |
| Admin dashboard | Visit `admin.html` | Stats and tabs load |
| Admin impersonation | Use impersonation feature | Other user's data displays |

**If anything breaks, check first:** does the user have a `tenant_id`?
The most common failure mode is a user being authenticated but having
`tenant_id IS NULL` somehow. Run:

```sql
SELECT u.id, u.full_name, u.tenant_id
FROM user_profiles u
WHERE u.id = auth.uid();
```

If `tenant_id` is null for any real user, it's a data issue, not a
policy bug — likely Sub-Deploy 1.1's backfill missed something.

### Rollback

```sql
-- Restore baseline RLS policies (matches docs/technical-reference.md
-- "Row Level Security" section)
BEGIN;

-- Drop tenant-aware policies
DROP POLICY IF EXISTS "admins view tenant profiles" ON user_profiles;
DROP POLICY IF EXISTS "users read tenant catalog" ON catalog;
DROP POLICY IF EXISTS "users manage own preorders" ON preorders;
DROP POLICY IF EXISTS "admins view tenant preorders" ON preorders;
DROP POLICY IF EXISTS "users manage own subscriptions" ON subscriptions;
DROP POLICY IF EXISTS "admins view tenant subscriptions" ON subscriptions;
DROP POLICY IF EXISTS "users read tenant settings" ON settings;
DROP POLICY IF EXISTS "admins update tenant settings" ON settings;
DROP POLICY IF EXISTS "users read own tenant" ON tenants;
DROP POLICY IF EXISTS "admins update own tenant" ON tenants;

-- Restore original policies (paste from technical-reference.md)
CREATE POLICY "users view own profile" ON user_profiles
  FOR SELECT USING (auth.uid() = id);
CREATE POLICY "users update own profile" ON user_profiles
  FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "admins view all profiles" ON user_profiles
  FOR SELECT
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND is_admin = true));

CREATE POLICY "authenticated users read catalog" ON catalog
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "users manage own preorders" ON preorders
  FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "admins view all preorders" ON preorders
  FOR SELECT
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND is_admin = true));

CREATE POLICY "users manage own subscriptions" ON subscriptions
  FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "admins view all subscriptions" ON subscriptions
  FOR SELECT
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND is_admin = true));

CREATE POLICY "authenticated users read settings" ON settings
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "admins update settings" ON settings
  FOR UPDATE
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND is_admin = true));

ALTER TABLE tenants DISABLE ROW LEVEL SECURITY;

-- Restore original function signatures
CREATE OR REPLACE FUNCTION purge_stale_catalog(cutoff_date date, current_month text)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE deleted_count integer;
BEGIN
  DELETE FROM catalog
  WHERE catalog_month != current_month
    AND on_sale_date < cutoff_date
    AND id NOT IN (SELECT DISTINCT catalog_id FROM preorders);
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

CREATE OR REPLACE FUNCTION delete_dropped_catalog_items(
  p_catalog_month text,
  p_item_codes text[]
)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE deleted_count integer;
BEGIN
  DELETE FROM catalog
  WHERE catalog_month = p_catalog_month
    AND item_code != ALL(p_item_codes);
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

DROP FUNCTION IF EXISTS current_tenant_id();
COMMIT;
```

---

## Phase 1 Completion Criteria

Phase 1 is complete when **all** of the following are true on staging:

- [ ] Sub-Deploy 1.1, 1.2, and 1.3 all executed successfully
- [ ] All verification queries return expected results
- [ ] Smoke test gate after 1.3 passed without issues
- [ ] Row counts match baseline (no data lost)
- [ ] RLS isolation pre-check confirmed: a second test tenant's data is
      invisible to the founding tenant's users
- [ ] Customer flows (catalog browse, reserve, my list, subscriptions,
      this week) all work
- [ ] Admin flows (dashboard, impersonation, settings) all work
- [ ] Email notifications still send (test via admin "send invite" or
      "notify customers" if available on staging)
- [ ] Monthly import script (`import-staging.js`) **WILL BREAK at the
      next monthly run** because the database functions now require
      `p_tenant_id`. This is expected and addressed in Phase 2.
- [ ] Updated `docs/pre-multitenancy-state.md` with a section noting
      Phase 1 completion date and any deviations from this plan
- [ ] Branch `feature/multi-tenancy-foundation` merged into `staging`
- [ ] Staging GitHub Pages deploy is unchanged (no app code changes
      needed for Phase 1)

---

## What Phase 1 Does NOT Address

Calling these out so they aren't surprises later:

- **App code is still single-tenant.** `app.js` and the HTML files all
  query Supabase without specifying a tenant. They get away with it
  because `current_tenant_id()` figures it out from the user's profile.
  Phase 2 makes this explicit.

- **Edge functions are unchanged.** `invite-customer`, `notify-customers`,
  and the other 6 functions still operate without tenant awareness.
  They'll continue working for the founding tenant because all customers
  are in it. Phase 2 updates them.

- **Import script will break next month.** The `purge_stale_catalog` and
  `delete_dropped_catalog_items` RPC calls in `import-staging.js` use
  the old signatures (no `p_tenant_id`). After Phase 1, these calls will
  fail with "function does not exist" errors. Update the import script
  in Phase 2, or hold the next monthly import on staging until Phase 2
  is complete.

- **No new tenants can be created via app.** The only way to add a tenant
  in Phase 1 is to manually `INSERT INTO tenants` via SQL. Phase 4
  builds the self-service signup flow.

- **No tenant-aware branding yet.** The `branding` jsonb column exists
  on the `tenants` table but nothing in the UI reads it. Phase 2 adds
  branding rendering; Phase 3 hooks it up to subdomain-resolved tenants.

---

## Execution Plan (Day-by-Day)

A suggested sequence for executing Phase 1, assuming you work part-time
on this.

| Day | Task | Sub-deploy |
|---|---|---|
| Sat AM | Pre-flight checks, branch creation | — |
| Sat PM | Run 1.1, verify, smoke test | 1.1 |
| Sun | Let staging soak; do nothing migration-related | — |
| Mon–Wed | Use staging normally as a customer; watch for anomalies | — |
| Thu | If all good, run 1.2, verify, smoke test | 1.2 |
| Fri–Sat | Soak | — |
| Sun AM | Run 1.3, verify, smoke test (the big one) | 1.3 |
| Sun PM | If all good, merge `feature/multi-tenancy-foundation` → `staging` | — |
| Mon | Update `pre-multitenancy-state.md` with completion notes | — |

If anything fails, **stop and rollback** rather than push through. The
sub-deploys are sized small enough that a rollback is a 30-second SQL
script. Diagnose, fix, retry — don't accumulate problems across
sub-deploys.

---

## Open Questions for Pre-Execution

Resolve these before running Sub-Deploy 1.1:

1. **What is the exact definition of `admin_preorders` view in production?**
   Need the SQL from production's `pg_dump` to recreate in staging.
   Action: extract from `backup-prod-pre-multitenancy-20260429.sql`
   before running Sub-Deploy 1.2.

2. **Does staging have `weekly_shipment` and `reservation_history` tables?**
   The import script references them. The migration handles them
   conditionally, but knowing in advance avoids surprises.
   Action: confirm via `\dt public.*` in staging SQL editor.

3. **Is there an `archive_stale_reservations` function in staging?**
   The import script calls it but it's not in `technical-reference.md`.
   Action: confirm via `\df public.*` in staging SQL editor and pull its
   definition before running Sub-Deploy 1.3 to add tenant_id parameter.

4. **What user account will be the testing customer for the smoke test?**
   Need a non-admin account on staging to test customer flows.
   Action: identify or create one before starting.

---

## Reference

- Baseline state: `docs/pre-multitenancy-state.md`
- Schema reference: `docs/technical-reference.md`
- Recovery anchors: tags `pre-multitenancy-v1` (production) and
  `pre-multitenancy-v1-staging` (staging)
- Database backups: `OneDrive\...\backups\2026-04-29-pre-multitenancy\`
- Roadmap: see "Multi-Tenancy Migration Roadmap" in chat history

---

**Last updated:** 2026-04-29 (initial plan)
