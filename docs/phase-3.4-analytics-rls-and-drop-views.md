# Phase 3.4 — Analytics RLS Verification + Drop Unused Views

**Status:** Planning
**Branch:** `feature/phase-3.4-analytics-rls-and-drop-views` (branched from `staging`)
**Risk:** Low — primarily verification work; mutation surface is a one-transaction DROP of 5 unused views
**Reversible:** Yes (recreate-views SQL captured below)
**Run after:** Phase 3.3 complete and soaked
**Estimated execution time:** One weekend session — verification-heavy, low actual change

This document is the execution blueprint for Sub-Deploy 3.4. Read it
end-to-end before starting. Refer to `phase-3-tenant-resolution.md` for
the parent phase scope and to `CLAUDE.md` for the anti-drift rules
governing this session.

---

## How This Plan Got Here (Important Context)

This plan was significantly re-scoped during planning. The history matters
for understanding why it looks small.

**Initial framing:** Rebuild the five `analytics_*` views to be tenant-
scoped and admin-gated, with `security_invoker = true` and tightened grants.

**First discovery (during pre-flight inventory):** The current views run
without `security_invoker`, so RLS on the underlying tables is bypassed at
view read time. They also grant SELECT to `anon`. Both findings made the
rebuild more important.

**Second discovery (after reading `analytics.html`):** The five views have
**no UI consumer**. `analytics.html` queries `usage_events` and
`user_profiles` directly and aggregates client-side, with a self-explanatory
comment in the code (`// Aggregate client-side (view isn't window-aware)`).
The only consumer of the views is ad-hoc SQL.

This shifted the production-correctness focus from the views to RLS on
the underlying tables — that's the actual data path for `analytics.html`.

**Third discovery (after RLS audit):** Current RLS policies on
`usage_events` and `user_profiles` are already correct for multi-tenant
safety. Admins read only their tenant's rows; non-admins can't SELECT
events at all; INSERT is gated to the user's tenant. No policy fix is
needed.

**Final scope (this plan):**
1. **Verify** RLS holds end-to-end against a real cross-tenant adversarial
   scenario by exercising every `analytics.html` data fetch with a fake
   second tenant in place
2. **Drop** the five unused views (per user decision: revisit if a future
   UI/BI consumer needs them)
3. **Document and defer** a separate finding about overly-broad table
   grants — out of scope for 3.4

The work is small; the verification is what earns the safety claim.

---

## Goals

1. Establish, with evidence, that `analytics.html` is multi-tenant safe
   today. Every chart on the page must show only the active admin's
   tenant's data, even when another tenant has data in the system
2. Remove the five unused `analytics_*` views from staging, with their
   removal documented so a future maintainer doesn't wonder where they went
3. Log a deferred finding (Finding E in the planning discussion) about
   overly-broad table grants on `usage_events` and `user_profiles` so
   it's tracked rather than forgotten

**Out of scope for 3.4 — do NOT do these in this session:**

- Any RLS policy changes on `usage_events`, `user_profiles`, or any other
  table — current policies are correct, no fix needed
- Tightening table-level grants on `usage_events` or `user_profiles` —
  separate sub-deploy or hardening pass, see "Discovered During 3.4" below
- Any application code changes (`app.js`, `analytics.html`, all other
  HTML, Edge Functions, import scripts)
- Recreating the views in a tenant-aware form — explicit user decision was
  to drop and revisit if needed
- `usage_events` purge job or retention — sub-deploy 3.5
- Indexes on `usage_events` — sub-deploy 3.5
- Admin operational tooling — sub-deploy 3.6
- Production database changes — Phase 4
- Anything in `import-staging.js` or `import.js`

If you find a real bug while executing 3.4 that is out of scope, **stop
and ask** per the anti-drift rules in `CLAUDE.md`.

---

## Files Affected

| File | Type of change |
|---|---|
| Database (staging Supabase) | One transaction: `DROP VIEW IF EXISTS` × 5 |
| `docs/phase-3-tenant-resolution.md` | Status update on completion + 3.3 row sync (housekeeping) |
| `docs/phase-3.3-remove-column-defaults.md` | Completion-criteria checkboxes synced (housekeeping) |
| `docs/phase-3.4-analytics-rls-and-drop-views.md` | This file, completion checklist filled in |
| `CLAUDE.md` | Active sub-deploy line updated; "Discovered During 3.4" finding logged |

**Files NOT touched** (verify before considering complete):
- `app.js` — no changes
- `analytics.html` and all other HTML files — no changes
- Any Edge Function — no changes
- `import-staging.js`, `import.js` — no changes
- `style.css`, `config.js` — no changes
- Any other doc file beyond the four listed above

---

## Pre-Flight Checks

### 1. Sync 3.3 status (housekeeping bundled into 3.4 pre-flight)

Two doc updates that should land before any DB work. Both reflect
work already done; not new scope.

**1a.** In `docs/phase-3.3-remove-column-defaults.md` § Completion Criteria,
change all unchecked boxes to checked. The 3.3 plan in the repo still has
`[ ]` for every item; user confirmed clean soak. Mark all checked, add the
completion date `2026-05-05`, update the status line at top from "Planning"
to "Complete".

**1b.** In `docs/phase-3-tenant-resolution.md`:
- Update the **Status** field at the top from
  "In progress (sub-deploy 3.1 active)" to
  "In progress (sub-deploy 3.4 active)"
- In the Sub-Deploys table, update the 3.4 row: status "Planning",
  Plan column references this file (`phase-3.4-analytics-rls-and-drop-views.md`)
- Update the "Last updated" footer to today's date

**1c.** In `CLAUDE.md` § Current Migration Phase:
- Update "Active sub-deploy plan" line to point at this 3.4 file

Commit these together as the first commit on the 3.4 branch with message
"docs: sync 3.3 completion status and start 3.4". Doc state should be
consistent before the DB change runs.

### 2. Re-run the RLS-enabled check

The earlier query 3 returned policy data instead of the `relrowsecurity`
flag. Re-run before proceeding:

```sql
SELECT relname AS table_name, relrowsecurity AS rls_enabled
FROM pg_class
WHERE relname IN ('usage_events', 'user_profiles')
  AND relnamespace = 'public'::regnamespace;
```

Expected: 2 rows, both `rls_enabled = true`. If either is false, **stop**
— Phase 1 was supposed to enable RLS on both tables, and the policies
above are decorative without it. That would be a Phase 1 regression that
needs investigation as a separate change before 3.4 can verify anything.

### 3. Confirm staging app currently works

Standard smoke pass:
- Test Admin login → catalog → reserve → my list
- Test Admin login → analytics.html → all charts populate

If anything is broken now, fix that first as a separate change — don't
bundle into 3.4.

### 4. Re-confirm the views are still unused by code

```bash
grep -rn "analytics_daily_events\|analytics_top_reserved\|analytics_top_cancelled\|analytics_top_subscribed\|analytics_user_activity" \
  *.html *.js
```

Expected: no matches anywhere in the codebase. The planning discussion
established this against the file tree at planning time. If a match
appears now (someone added a UI dependency between planning and execution),
**stop** — the drop becomes a breaking change rather than dead-code
cleanup, and 3.4's framing has to be reconsidered.

### 5. Capture baseline counts on `usage_events`

For V6 cross-tenant isolation to be meaningful, we need to compare
before/after counts. Capture the baseline now:

```sql
SELECT event_type, COUNT(*) AS row_count
FROM usage_events
WHERE tenant_id = '72e29f67-39f7-42bc-a4d5-d6f992f9d790'
GROUP BY event_type
ORDER BY event_type;
```

Save this output. After V6 setup but before V6 verification, the same
query should still produce identical numbers (the fake tenant's events
should not affect the founding tenant's counts). After V6 cleanup,
likewise identical.

Also record Test Admin's count of recent events as a single number
for V6.4 comparison:

```sql
SELECT
  user_id,
  COUNT(*)               AS total_events,
  COUNT(*) FILTER (WHERE event_type = 'reserve')      AS reserves,
  COUNT(*) FILTER (WHERE event_type = 'cancel')       AS cancels,
  COUNT(*) FILTER (WHERE event_type = 'subscribe')    AS subscribes,
  COUNT(*) FILTER (WHERE event_type = 'login')        AS logins,
  COUNT(*) FILTER (WHERE event_type = 'catalog_view') AS catalog_views,
  COUNT(*) FILTER (WHERE event_type = 'page_view')    AS page_views,
  MAX(created_at)        AS last_seen
FROM usage_events
WHERE user_id = 'b758f573-613f-4342-909d-0914dbedccdc'
  AND tenant_id = '72e29f67-39f7-42bc-a4d5-d6f992f9d790'
GROUP BY user_id;
```

Save the row. Used for comparison in V6.4.

### 6. Confirm there is no existing fake-tenant data from earlier testing

```sql
SELECT id, slug FROM tenants
WHERE id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'::uuid
   OR slug = 'verify-3-4-tenant';
-- Expected: 0 rows

SELECT id, full_name FROM user_profiles
WHERE id = 'cccccccc-dddd-eeee-ffff-000000000000'::uuid
   OR full_name = 'V3.4 Fake Customer';
-- Expected: 0 rows
```

Both should be empty. If either has rows, V6 setup will fail with
unique-constraint violations. Pick different sentinel UUIDs and update
the V6 SQL accordingly before proceeding.

### 7. Capture exact current state for accurate rollback

The rollback SQL below recreates the five views with their original
bodies (the ones captured in the planning discussion against
`pg_get_viewdef` on staging). Re-run that capture once more to confirm
the bodies haven't drifted between planning and execution:

```sql
SELECT
  table_name AS view_name,
  pg_get_viewdef(('public.' || table_name)::regclass, true) AS definition
FROM information_schema.views
WHERE table_schema = 'public'
  AND table_name LIKE 'analytics_%'
ORDER BY table_name;
```

If the bodies differ from the captured baseline, update the rollback SQL
in this plan to match the actual current state before running the change.

---

## The Change

The verification work happens *before* any mutation. Mutation is a single
one-transaction DROP at the end, only after verification passes.

### Step A — Establish the cross-tenant adversary (V6 setup)

Run as `postgres` in the SQL editor. Creates a fake second tenant and a
fake non-admin customer in that tenant, then seeds usage_events that an
attacker-tenant user would generate.

```sql
-- ============================================================
-- Phase 3.4 V6 setup — seed cross-tenant adversary
-- ============================================================

BEGIN;

INSERT INTO tenants (id, slug, display_name)
VALUES (
  'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'::uuid,
  'verify-3-4-tenant',
  'V3.4 Verify Tenant'
);

-- Fake non-admin customer in the fake tenant. Used as the user_id for
-- seeded events AND as the actor for the V4 (non-admin) verification —
-- the planning discussion established no permanent Test Customer exists
-- in raysandjudys, so this fake-tenant non-admin doubles as the
-- non-admin authenticated test subject.
INSERT INTO user_profiles (id, full_name, is_admin, tenant_id, status, email, created_by_admin)
VALUES (
  'cccccccc-dddd-eeee-ffff-000000000000'::uuid,
  'V3.4 Fake Customer',
  false,
  'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'::uuid,
  'active',
  'v34-fake@example.local',
  true
);

-- Seed events covering every event_type that analytics.html aggregates.
-- All tagged with the fake tenant_id and the fake user_id.
INSERT INTO usage_events (user_id, event_type, metadata, tenant_id, created_at)
VALUES
  -- Reserves (analytics.html loadTopReserved + loadSummary)
  ('cccccccc-dddd-eeee-ffff-000000000000'::uuid, 'reserve',
   jsonb_build_object('title', 'V34 LEAK BOOK A',
                      'series_name', 'V34 LEAK SERIES A',
                      'publisher', 'V34LEAK PUB',
                      'distributor', 'Lunar',
                      'catalog_month', '2026-05'),
   'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'::uuid, now()),
  ('cccccccc-dddd-eeee-ffff-000000000000'::uuid, 'reserve',
   jsonb_build_object('title', 'V34 LEAK BOOK A',
                      'series_name', 'V34 LEAK SERIES A',
                      'publisher', 'V34LEAK PUB',
                      'distributor', 'Lunar',
                      'catalog_month', '2026-05'),
   'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'::uuid, now()),
  -- Cancel (loadTopCancelled)
  ('cccccccc-dddd-eeee-ffff-000000000000'::uuid, 'cancel',
   jsonb_build_object('title', 'V34 LEAK BOOK B',
                      'series_name', 'V34 LEAK SERIES B',
                      'publisher', 'V34LEAK PUB',
                      'distributor', 'PRH'),
   'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'::uuid, now()),
  -- Subscribe (loadTopSubscribed, loadSummary)
  ('cccccccc-dddd-eeee-ffff-000000000000'::uuid, 'subscribe',
   jsonb_build_object('series_name', 'V34 LEAK SUB SERIES',
                      'distributor', 'Lunar'),
   'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'::uuid, now()),
  -- Login (loadSummary, loadUserActivity)
  ('cccccccc-dddd-eeee-ffff-000000000000'::uuid, 'login',
   '{}'::jsonb,
   'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'::uuid, now()),
  -- catalog_view (loadSummary, loadUserActivity, loadEventBreakdown)
  ('cccccccc-dddd-eeee-ffff-000000000000'::uuid, 'catalog_view',
   jsonb_build_object('catalog_month', '2026-05'),
   'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'::uuid, now()),
  -- page_view (loadSummary, loadUserActivity)
  ('cccccccc-dddd-eeee-ffff-000000000000'::uuid, 'page_view',
   jsonb_build_object('page', 'mylist'),
   'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'::uuid, now());

COMMIT;
```

After this commits, every category that `analytics.html` aggregates has
at least one cross-tenant row to leak. Verification (V1–V8) runs against
this state.

### Step B — Drop the unused views (only run after Step A verification passes)

```sql
-- ============================================================
-- Phase 3.4 — Drop unused analytics views
-- Target: STAGING only (puoaiyezsreowpwxzxhj.supabase.co)
-- Decision: views have no UI consumer; ad-hoc SQL can write
-- tenant-aware predicates directly. Revisit if a future UI/BI
-- consumer requires them.
-- ============================================================

BEGIN;

DROP VIEW IF EXISTS public.analytics_user_activity;
DROP VIEW IF EXISTS public.analytics_top_subscribed;
DROP VIEW IF EXISTS public.analytics_top_reserved;
DROP VIEW IF EXISTS public.analytics_top_cancelled;
DROP VIEW IF EXISTS public.analytics_daily_events;

COMMIT;
```

`DROP VIEW` (no `CASCADE`). If anything depends on these views that
wasn't found in pre-flight check 4, this surfaces it as an error rather
than silently destroying it.

### Step C — Cleanup the V6 adversary (mandatory before completion)

```sql
-- ============================================================
-- Phase 3.4 V6 cleanup — remove fake tenant and seeded events
-- ============================================================

BEGIN;

DELETE FROM usage_events
WHERE tenant_id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'::uuid;

DELETE FROM user_profiles
WHERE tenant_id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'::uuid;

DELETE FROM tenants
WHERE id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'::uuid;

COMMIT;
```

Confirm cleanup with three counts, all expected to be 0:

```sql
SELECT 'tenants' AS t, COUNT(*) FROM tenants WHERE id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
UNION ALL
SELECT 'profiles', COUNT(*) FROM user_profiles WHERE tenant_id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
UNION ALL
SELECT 'events',   COUNT(*) FROM usage_events  WHERE tenant_id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
```

---

## Verification

The bulk of 3.4 is verification. Each test exercises a specific path
that `analytics.html` actually uses, with the fake-tenant adversary in
place from Step A.

### V1 — Confirm RLS is enabled and policies are intact

Re-run the policy and flag queries from pre-flight. Expected unchanged
from the audit:

```sql
SELECT relname, relrowsecurity FROM pg_class
WHERE relname IN ('usage_events', 'user_profiles')
  AND relnamespace = 'public'::regnamespace;

SELECT tablename, policyname, cmd, qual
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('usage_events', 'user_profiles')
ORDER BY tablename, policyname;
```

Expected: both flags TRUE. Five policies total (2 on usage_events, 3 on
user_profiles), bodies as documented in the audit. If anything has
changed since the audit, **stop** — that's a side-effect of some other
session that needs to be understood before 3.4 continues.

### V2 — Test Admin sees only own-tenant data via direct table reads

Log in as Test Admin on staging. Open browser DevTools console. Run:

```javascript
const { data, error } = await db
  .from('usage_events')
  .select('event_type, tenant_id')
  .eq('event_type', 'reserve');
console.log({
  total: data?.length,
  fakeLeaks: data?.filter(r => r.tenant_id === 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee').length,
  error,
});
```

Expected: `fakeLeaks` is 0. If `fakeLeaks` is non-zero, RLS is failing
and 3.4 cannot proceed — stop, log a Severity-1 finding, do NOT drop
the views.

Repeat the same shape with `event_type = 'cancel'`, `'subscribe'`,
`'login'`, `'catalog_view'`, `'page_view'`. Each should show
`fakeLeaks: 0`.

Repeat once more for `user_profiles`:

```javascript
const { data, error } = await db
  .from('user_profiles')
  .select('id, tenant_id, full_name');
console.log({
  total: data?.length,
  fakeLeaks: data?.filter(r => r.tenant_id === 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee').length,
});
```

Expected: `fakeLeaks: 0`. The fake non-admin customer's profile must not
be visible to Test Admin in the founding tenant.

### V3 — Test Admin's view of analytics.html shows zero leaks

This is the user-facing acceptance test. Visit
`https://mrcyberrick.github.io/comic-preorder-staging/analytics.html`
as Test Admin. For each chart, confirm no `V34 LEAK …` strings appear:

| Chart | Look for | Expected |
|---|---|---|
| Reserves pill (loadSummary) | Numerical comparison vs pre-flight baseline | Same number, fake reserves did not contribute |
| Cancels pill | Same | Same as baseline |
| New Subscriptions pill | Same | Same as baseline |
| Logins pill | Same | Same as baseline |
| Catalog Views pill | Same | Same as baseline |
| Other Page Views pill | Same | Same as baseline |
| Active Users pill | Should not have ticked up by 1 | Same as baseline |
| Most Reserved Titles | "V34 LEAK BOOK A" | Absent |
| Most Subscribed Series | "V34 LEAK SUB SERIES" | Absent |
| Most Cancelled Titles | "V34 LEAK BOOK B" | Absent |
| Event Breakdown | Counts per event type | Each unchanged from baseline |
| Customer Activity | "V3.4 Fake Customer" row | Absent |
| Recent Events (last 50) | Any `V34 LEAK …` strings | Absent |

If any cell shows a leak, **stop**. The combination of "RLS policies
say one thing, the live UI shows another" indicates a deeper bug —
possibly with `current_tenant_id()` returning the wrong value, or a
PostgREST request bypassing RLS, or admin impersonation context
leaking. Document and investigate before any further 3.4 work.

### V4 — Non-admin authenticated session sees nothing

Per the planning discussion: there is no permanent Test Customer in
raysandjudys, so the V4 non-admin test uses the fake-tenant fake
customer seeded in V6 setup. This person is `is_admin = false` in
the fake tenant — exactly the threat model "another tenant's regular
user trying to read our analytics."

Use the Supabase admin API to generate a magic link for the fake
customer (the same machinery the existing `test-magic-link.ps1`
script uses), or sign them in via password reset → set password.
Either path produces an authenticated session for `'V3.4 Fake
Customer'`.

Once authenticated as the fake customer, in the browser console run:

```javascript
// Probe each event_type the analytics page aggregates
for (const t of ['reserve','cancel','subscribe','unsubscribe','login','catalog_view','page_view']) {
  const { data, error } = await db
    .from('usage_events')
    .select('id', { head: true, count: 'exact' })
    .eq('event_type', t);
  console.log(t, '→', data?.length ?? 0, 'rows visible, count =', error || 'ok');
}
```

Expected: every probe shows 0 rows visible. The fake customer is
non-admin, so the `admins read tenant usage events` policy doesn't
admit them, and there's no policy that admits non-admins.

Also probe `user_profiles`:

```javascript
const { data } = await db
  .from('user_profiles')
  .select('id, full_name, tenant_id');
console.log('profiles visible:', data?.map(p => p.full_name));
```

Expected: only the fake customer's own profile (via `users view own
profile`). Should be exactly one row, full_name = "V3.4 Fake Customer".
If Test Admin's profile or any raysandjudys profile is visible, RLS is
failing.

After V4, sign back out of the fake customer.

### V5 — anon session is denied

In a fresh incognito window with no auth session:

```javascript
const supabase = window.supabase.createClient(
  '<staging URL>',
  '<staging anon key>'  // from config.js
);
const { data, error } = await supabase.from('usage_events').select('id').limit(1);
console.log({ data, error });
```

Expected: `error` is null and `data` is an empty array. anon has
table-level SELECT (Finding E from the audit) but no RLS policy admits
anon, so RLS evaluates and zero rows pass. **Note this is not the same
as a permission denial** — the table grant lets anon attempt the read,
RLS reduces the result set to zero. That's fine for safety; it's the
same result anon-attacker would see.

### V6 — Baseline counts unchanged after Step A seed

This proves the seed itself didn't somehow modify founding-tenant data.
Re-run pre-flight check 5's count query:

```sql
SELECT event_type, COUNT(*) AS row_count
FROM usage_events
WHERE tenant_id = '72e29f67-39f7-42bc-a4d5-d6f992f9d790'
GROUP BY event_type
ORDER BY event_type;
```

Expected: identical to the baseline saved in pre-flight 5.

Re-run the Test Admin event count from pre-flight 5. Expected: identical.

### V7 — Drop the views (Step B), confirm gone

After Steps A and V1–V6 pass, run Step B. Verify:

```sql
SELECT table_name
FROM information_schema.views
WHERE table_schema = 'public'
  AND table_name LIKE 'analytics_%';
```

Expected: zero rows. All five views are gone.

### V8 — analytics.html still works after drop

Reload `analytics.html` as Test Admin. Confirm every chart still
populates exactly as in V3 (the page never used the views, so dropping
them should change nothing). No console errors. No 4xx responses in
Network tab.

If anything broke, the pre-flight check 4 (grep) missed a consumer
somewhere. Roll back via the recreate-views SQL in the Rollback section
and investigate.

### V9 — Cleanup verified

After Step C runs:

```sql
SELECT 'tenants' AS t, COUNT(*) FROM tenants WHERE id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
UNION ALL
SELECT 'profiles', COUNT(*) FROM user_profiles WHERE tenant_id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
UNION ALL
SELECT 'events',   COUNT(*) FROM usage_events  WHERE tenant_id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
```

Expected: all 0. No fake-tenant orphans left in the database.

Also confirm Test Admin's count (pre-flight 5 again) is unchanged after
cleanup.

---

## Smoke Test

After V1–V9 pass and cleanup is verified, run a condensed smoke pass to
confirm no regression in normal usage:

| # | Account | Flow | Expected |
|---|---|---|---|
| 1 | Test Admin | Login, browse catalog | Items load |
| 2 | Test Admin | Reserve a comic | Persists, appears in My List |
| 3 | Test Admin | Cancel a reservation | Removed from My List |
| 4 | Test Admin | Subscribe to a series | Subscription appears |
| 5 | Test Admin | View analytics.html | All charts populate, exactly as before 3.4 |
| 6 | Test Admin | Toggle maintenance mode on, off | Both work |
| 7 | Test Admin | Impersonate a customer (if any non-admin users exist) | Banner appears, customer's data loads |

The reserve / cancel / subscribe flows confirm `app.js` writes still
work — these were verified at length in 3.2 and 3.3, but smoke them once
more because 3.4 touched the same tables.

---

## Rollback

Two distinct rollback paths depending on what fails.

### Rollback A — Step A (V6 setup) seeded but verification revealed RLS issue

If V2 or V4 shows fake-tenant data leaking, RLS is broken. Do **not**
run Step B. Instead, run Step C cleanup to remove the seeded data,
leaving the views intact and the database in its original state.
Then file the RLS finding for separate investigation; 3.4 cannot
proceed until that's fixed.

### Rollback B — Step B (drop views) ran but V8 revealed a consumer

If `analytics.html` (or any other surface) breaks after Step B, recreate
the views. Use the bodies captured in pre-flight check 7 (the freshest
copy). If captured bodies match the planning baseline, the SQL below
restores them.

```sql
-- ============================================================
-- Phase 3.4 — ROLLBACK B: recreate the dropped analytics views
-- (with their original, pre-3.4 definitions and grants)
-- ============================================================

BEGIN;

CREATE VIEW public.analytics_daily_events AS
SELECT
  (date_trunc('day'::text, (created_at AT TIME ZONE 'America/New_York'::text)))::date AS day,
  event_type,
  count(*) AS event_count
FROM public.usage_events
WHERE created_at >= (now() - '90 days'::interval)
GROUP BY
  ((date_trunc('day'::text, (created_at AT TIME ZONE 'America/New_York'::text)))::date),
  event_type
ORDER BY
  ((date_trunc('day'::text, (created_at AT TIME ZONE 'America/New_York'::text)))::date) DESC,
  event_type;

CREATE VIEW public.analytics_top_cancelled AS
SELECT
  (metadata ->> 'title'::text)       AS title,
  (metadata ->> 'series_name'::text) AS series_name,
  (metadata ->> 'publisher'::text)   AS publisher,
  (metadata ->> 'distributor'::text) AS distributor,
  count(*) AS cancel_count
FROM public.usage_events
WHERE event_type = 'cancel'::text
  AND (metadata ->> 'title'::text) IS NOT NULL
GROUP BY (metadata ->> 'title'::text), (metadata ->> 'series_name'::text),
         (metadata ->> 'publisher'::text), (metadata ->> 'distributor'::text)
ORDER BY (count(*)) DESC;

CREATE VIEW public.analytics_top_reserved AS
SELECT
  (metadata ->> 'title'::text)         AS title,
  (metadata ->> 'series_name'::text)   AS series_name,
  (metadata ->> 'publisher'::text)     AS publisher,
  (metadata ->> 'distributor'::text)   AS distributor,
  (metadata ->> 'catalog_month'::text) AS catalog_month,
  count(*) AS reserve_count
FROM public.usage_events
WHERE event_type = 'reserve'::text
  AND (metadata ->> 'title'::text) IS NOT NULL
GROUP BY (metadata ->> 'title'::text), (metadata ->> 'series_name'::text),
         (metadata ->> 'publisher'::text), (metadata ->> 'distributor'::text),
         (metadata ->> 'catalog_month'::text)
ORDER BY (count(*)) DESC;

CREATE VIEW public.analytics_top_subscribed AS
SELECT
  (metadata ->> 'series_name'::text) AS series_name,
  (metadata ->> 'distributor'::text) AS distributor,
  count(*) FILTER (WHERE event_type = 'subscribe'::text)   AS subscribe_count,
  count(*) FILTER (WHERE event_type = 'unsubscribe'::text) AS unsubscribe_count,
  (count(*) FILTER (WHERE event_type = 'subscribe'::text)
   - count(*) FILTER (WHERE event_type = 'unsubscribe'::text)) AS net_subscribers
FROM public.usage_events
WHERE event_type = ANY (ARRAY['subscribe'::text, 'unsubscribe'::text])
  AND (metadata ->> 'series_name'::text) IS NOT NULL
GROUP BY (metadata ->> 'series_name'::text), (metadata ->> 'distributor'::text)
ORDER BY
  (count(*) FILTER (WHERE event_type = 'subscribe'::text)
   - count(*) FILTER (WHERE event_type = 'unsubscribe'::text)) DESC;

CREATE VIEW public.analytics_user_activity AS
SELECT
  ue.user_id,
  up.full_name,
  count(*) FILTER (WHERE ue.event_type = 'reserve'::text)      AS reserves,
  count(*) FILTER (WHERE ue.event_type = 'cancel'::text)       AS cancels,
  count(*) FILTER (WHERE ue.event_type = 'subscribe'::text)    AS subscribes,
  count(*) FILTER (WHERE ue.event_type = 'login'::text)        AS logins,
  count(*) FILTER (WHERE ue.event_type = 'catalog_view'::text) AS catalog_views,
  max(ue.created_at) AS last_seen
FROM public.usage_events ue
LEFT JOIN public.user_profiles up ON up.id = ue.user_id
GROUP BY ue.user_id, up.full_name
ORDER BY (max(ue.created_at)) DESC;

-- Restore the prior overly-broad grants. The whole point of the
-- planning discussion's Finding E was that these grants are
-- inappropriate, but rollback returns to the documented baseline so
-- investigation can proceed cleanly. Tightening grants is a separate
-- exercise.
DO $$
DECLARE v text;
BEGIN
  FOREACH v IN ARRAY ARRAY[
    'analytics_daily_events',
    'analytics_top_cancelled',
    'analytics_top_reserved',
    'analytics_top_subscribed',
    'analytics_user_activity'
  ] LOOP
    EXECUTE format('GRANT ALL ON public.%I TO anon, authenticated, service_role', v);
  END LOOP;
END $$;

COMMIT;
```

After rollback, re-run pre-flight check 4 (grep for view names) and the
view-existence check from V7 (counts should be 5 again, not 0).
Investigate whatever consumer was missed, then re-attempt 3.4.

---

## Completion Criteria

Phase 3.4 is complete when **all** of the following are true on staging:

- [ ] Pre-flight 3.3 status sync committed (housekeeping)
- [ ] Pre-flight 2 confirmed RLS enabled on `usage_events` and `user_profiles`
- [ ] Pre-flight 4 confirmed no code references the views
- [ ] V1 confirmed RLS policies and flags unchanged from audit baseline
- [ ] V2 confirmed Test Admin sees zero fake-tenant rows in any
      direct-table probe (events × all 6 types, plus user_profiles)
- [ ] V3 confirmed `analytics.html` shows zero leaks across all 13
      chart-cell observations
- [ ] V4 confirmed fake-tenant non-admin sees zero rows in
      `usage_events` and only own-profile in `user_profiles`
- [ ] V5 confirmed anon's `usage_events` query returns empty (not
      denied — empty by RLS)
- [ ] V6 confirmed founding-tenant counts unchanged after seed
- [ ] V7 confirmed all five views are dropped
- [ ] V8 confirmed `analytics.html` still works post-drop
- [ ] V9 confirmed fake tenant cleanup is complete
- [ ] Smoke test rows 1–7 all pass
- [ ] Branch `feature/phase-3.4-analytics-rls-and-drop-views` merged
      into `staging`
- [ ] Staging GitHub Pages deploy succeeded (no code changes — just
      doc commits — so this is mainly verifying the deploy didn't
      regress)
- [ ] `docs/phase-3-tenant-resolution.md` updated with 3.4 status set
      to "Complete" and the date
- [ ] `docs/phase-3-tenant-resolution.md` "Status" line updated to
      "In progress (sub-deploy 3.5 active)" or
      "soak in progress" if 3.5 plan not yet started
- [ ] `CLAUDE.md` § Current Migration Phase line updated
- [ ] `CLAUDE.md` "Discovered During Phase 3 Soak" or equivalent
      section updated with Finding E (overly-broad grants)
- [ ] No code changes made (verify with `git diff --stat` —
      should show only `docs/` files and `CLAUDE.md`)
- [ ] No out-of-scope work bundled in

---

## Discovered, Deferred (Finding E)

During the Phase 3.4 RLS audit, both `usage_events` and `user_profiles`
were observed to grant the full table-level privilege set (DELETE,
INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE) to all three of
`anon`, `authenticated`, and `service_role`. This is the Supabase
default; many Phase 1 / Phase 2 tables likely have the same shape.

RLS prevents these grants from causing actual data exposure today
(verified in V1–V5). But in defense-in-depth terms, the table-level
grants are wider than they need to be — `anon` and `authenticated`
should have only `SELECT, INSERT` (and even those gated by RLS), with
`DELETE, UPDATE, TRUNCATE, REFERENCES, TRIGGER` revoked.

**Why it's not in 3.4:** Tightening grants on `usage_events` and
`user_profiles` affects every app code path that touches those tables
(every reserve, cancel, login, page nav, profile read). That's a much
wider blast radius than 3.4's analytics framing should carry. Other
tables (`preorders`, `subscriptions`, `app_settings`, `weekly_shipment`,
etc.) likely have the same shape and would benefit from a single
focused hardening pass that fixes them all at once.

**Recommended follow-up:** A dedicated hardening sub-deploy (could be
3.7+ in this phase, or its own Phase 4 prerequisite) that audits and
tightens table-level grants across every tenant-scoped table. RLS
remains the primary safety mechanism; tighter grants close the
defense-in-depth gap.

This deferral has been logged in `CLAUDE.md` under "Known Out-of-Scope
Items" so it isn't forgotten.

---

## What Phase 3.4 Does NOT Achieve

- **Production is unchanged.** All 3.4 work applies only to staging.
  Phase 4 (production migration) replicates as needed.
- **No new analytics surfaces.** `analytics.html` is unchanged.
- **No table-grant tightening.** See Finding E above.
- **No supporting indexes on `usage_events`.** Deferred to 3.5.
- **No retention/purge job.** Deferred to 3.5.
- **The metadata jsonb is not normalized.** Title / series_name still
  live in the metadata blob. Schema cleanup is its own future work.
- **The five views are gone, not "tenant-aware."** If a future BI/UI
  consumer needs them, they'll be re-introduced as part of that
  consumer's design — likely in a tenant-aware shape, but that's a
  decision for then.

---

## Open Questions for Pre-Execution

Resolve these before starting:

1. **Confirm V4 magic-link / sign-in path is feasible.** Generating a
   working session for the fake customer requires either the
   admin-API magic-link path (the existing `test-magic-link.ps1`
   pattern) or a password set via admin tools. If neither path is
   easily exercisable for an arbitrary user, V4 needs an alternative —
   for example, simulating an authenticated session via raw JWT
   crafting in the SQL editor with `SET LOCAL "request.jwt.claims"`.
   That pattern is documented in `CLAUDE.md` and was used in 3.1
   pre-flight. Decide which approach before starting and capture in
   the session log.

2. **Confirm there are no non-admin users currently in raysandjudys
   to use as a non-fake control.** Pre-flight discussion established
   no permanent Test Customer exists, but other real customers may.
   If any exist, V4 could optionally also test with one of them as
   a sanity check — non-admin in the right tenant should still see
   zero events. (This is a "nice to have" not a "must have.")

3. **Decide whether to run V5 (anon test) at all.** anon's behavior
   is determined by RLS, which we've already established works in
   V2 and V4. V5 is partial duplication. Including it because
   completeness > brevity here, but if time-pressed, V2+V4 covers
   the main exposure.

---

## Reference

- Parent plan: `docs/phase-3-tenant-resolution.md`
- Phase 3.3 plan: `docs/phase-3.3-remove-column-defaults.md`
- Phase 3.2 plan: `docs/phase-3.2-explicit-tenant-writes.md`
- Phase 3.1 plan: `docs/phase-3.1-tenant-resolution-layer.md`
- Phase 2 completion: `docs/phase-2-completion.md`
- Phase 1 schema: `docs/phase-1-schema-migration.md`
- Anti-drift rules: `CLAUDE.md` § Anti-Drift Rules for Agentic Sessions
- Founding tenant UUID: `72e29f67-39f7-42bc-a4d5-d6f992f9d790`
- Test Admin user_id: `b758f573-613f-4342-909d-0914dbedccdc`

---

**Last updated:** 2026-05-07 (initial plan, post re-scope to RLS verify + drop)
