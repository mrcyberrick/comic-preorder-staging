# Phase 3.2 — Explicit `tenant_id` on `app.js` Writes

**Status:** Planning
**Branch:** `feature/phase-3.2-explicit-tenant-writes` (branched from `staging`)
**Risk:** Low — additive change to existing INSERTs, no schema changes, no behavior changes
**Reversible:** Yes (revert the branch — column defaults still in place as safety net)
**Run after:** Phase 3.1 complete and soaked
**Estimated execution time:** One weekend session

This document is the execution blueprint for Sub-Deploy 3.2. Read it
end-to-end before starting. Refer to `phase-3-tenant-resolution.md` for
the parent phase scope and to `CLAUDE.md` for the anti-drift rules
governing this session.

---

## Goals

1. Make every `app.js` write to a tenant-scoped table pass `tenant_id`
   explicitly in the insert payload, sourced from `TenantContext.current()`
2. Make `UsageEvents._log()` defensive — it must continue to work even
   if called before `TenantContext.resolve()` completes, because it's
   fire-and-forget and can run from anywhere
3. End in a state where the column defaults established in Phase 1 are
   no longer load-bearing for normal operation — they remain in place
   as a safety net but the app stops relying on them

**This sub-deploy does NOT remove the column defaults.** That's
sub-deploy 3.3. Keeping the defaults in place during 3.2 means any
write site we accidentally miss still works correctly via the default.
Removing them in a separate sub-deploy is what catches misses.

**Out of scope for 3.2 — do NOT do these in this session:**

- Removing column defaults — sub-deploy 3.3
- Analytics view changes — sub-deploy 3.4
- `usage_events` purge job — sub-deploy 3.5
- Admin operational tooling (Wednesday workflow printouts) — sub-deploy 3.6
- Edge Function changes — covered in Phase 2
- DB schema or RLS changes — none required
- HTML page changes (other than what is documented in the verification section)
- Anything in `import-staging.js` or `import.js`

If you find a real bug while executing 3.2 that is out of scope, **stop
and ask** per the anti-drift rules in `CLAUDE.md`.

---

## Why This Sub-Deploy Matters

Phase 1 added column defaults on `tenant_id` for every app-written
table. Those defaults were a safety net so the app could keep working
without code changes while the schema migration soaked. Phase 3.1
introduced `TenantContext` so the app knows which tenant it's in.

3.2 connects the two: the app now uses `TenantContext` to set
`tenant_id` on every write, instead of relying on the database to fill
it in. After 3.2 ships:

- Adding a second tenant becomes straightforward (the writes already
  pass the right tenant context)
- The column defaults can safely be removed in 3.3 because no app code
  depends on them anymore
- A bug that causes `tenant_id` to be wrong becomes visible at the
  write site, instead of silently being papered over by the default

This is a small change that closes a real gap. It's also the lowest-risk
of the four Phase 3 sub-deploys because the column defaults remain in
place — if the explicit pass fails for any reason, the default still
catches it.

---

## Files Affected

| File | Type of change |
|---|---|
| `app.js` | 4 INSERT/UPSERT call sites updated to pass `tenant_id` |
| (no other files) | — |

**Files NOT touched** (verify before commit):
- All HTML files (`index.html`, `catalog.html`, `mylist.html`, `arrivals.html`, `subscriptions.html`, `admin.html`)
- `style.css`, `config.js`
- Any file under `docs/` (other than this one and the parent)
- Any Edge Function source
- `import-staging.js`, `import.js`

---

## Pre-Flight Checks

### 1. Confirm staging app currently works

Run a quick smoke test on staging — log in as Test Customer, browse,
reserve, log in as Test Admin, see dashboard. Establish a known-good
baseline before changing anything.

### 2. Confirm Phase 3.1 is committed and deployed

Verify `TenantContext` is exposed on `window` in the staging deploy:

In the browser console on staging `catalog.html`:
```javascript
typeof TenantContext     // 'object'
TenantContext.current()  // { id: '72e29f67-...', slug: 'raysandjudys', ... }
```

If `TenantContext` is undefined, 3.1 hasn't fully deployed yet. Wait
for GitHub Pages propagation (1–2 min) before continuing.

### 3. Confirm column defaults are still present

Run this in the staging Supabase SQL editor:

```sql
SELECT table_name, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND column_name = 'tenant_id'
  AND table_name IN ('preorders', 'subscriptions', 'app_settings', 'usage_events')
ORDER BY table_name;
```

Every row should show the founding tenant UUID as `column_default`. If
any show NULL, **stop** — 3.2 assumes defaults are still in place as a
safety net. Removing them is 3.3, not now.

---

## The Change

Four call sites in `app.js` need updating. Each is a small, mechanical
edit: add `tenant_id: TenantContext.current().id` to the existing insert
payload object. No other logic changes.

The fifth change is to `UsageEvents._log()` to make it defensive (the
Option A pattern from the planning discussion).

### 1. `Preorders.reserve()` — line ~530

**Current code:**
```javascript
async reserve(userId, catalogId, quantity = 1) {
  const { data, error } = await db
    .from('preorders')
    .insert({ user_id: userId, catalog_id: catalogId, quantity })
    .select()
    .single();
  return { data, error };
},
```

**Change to:**
```javascript
async reserve(userId, catalogId, quantity = 1) {
  const { data, error } = await db
    .from('preorders')
    .insert({
      user_id: userId,
      catalog_id: catalogId,
      quantity,
      tenant_id: TenantContext.current().id,
    })
    .select()
    .single();
  return { data, error };
},
```

### 2. `Subscriptions.subscribe()` — line ~597

**Current code:**
```javascript
async subscribe(userId, seriesName, distributor, format = null) {
  const { data, error } = await db
    .from('subscriptions')
    .insert({ user_id: userId, series_name: seriesName, distributor, format })
    .select()
    .single();
  if (!error) UsageEvents.subscribe(userId, seriesName, distributor);
  return { data, error };
},
```

**Change to:**
```javascript
async subscribe(userId, seriesName, distributor, format = null) {
  const { data, error } = await db
    .from('subscriptions')
    .insert({
      user_id: userId,
      series_name: seriesName,
      distributor,
      format,
      tenant_id: TenantContext.current().id,
    })
    .select()
    .single();
  if (!error) UsageEvents.subscribe(userId, seriesName, distributor);
  return { data, error };
},
```

### 3. `Settings.set()` — line ~421

**Current code:**
```javascript
async set(key, value) {
  const { error } = await db
    .from('app_settings')
    .upsert({ key, value, updated_at: new Date().toISOString() });
  return { error };
},
```

**Change to:**
```javascript
async set(key, value) {
  const { error } = await db
    .from('app_settings')
    .upsert({
      key,
      value,
      updated_at: new Date().toISOString(),
      tenant_id: TenantContext.current().id,
    });
  return { error };
},
```

**Note on `app_settings` upsert behavior:** the existing UPSERT uses
`key` as the conflict target (implicit primary key). When a row already
exists, the UPDATE branch runs and `tenant_id` will not change because
the existing row's `tenant_id` is unaffected by the new payload's
`tenant_id` field — UPSERT updates only the columns named in the
conflict resolution. Adding `tenant_id` to the payload is therefore
safe: it sets the column on inserts and is ignored on updates.

### 4. `UsageEvents._log()` — line ~466

This is the defensive Option A change. The function is fire-and-forget
and may be called from anywhere in the app, possibly before
`TenantContext.resolve()` has completed. We must not throw, must not
block, and must not surface errors.

**Current code:**
```javascript
_log(userId, eventType, metadata = {}) {
  if (!userId) return;
  // Do not log events triggered while admin is impersonating a customer
  if (AdminContext.isActive()) return;
  db.from('usage_events')
    .insert({ user_id: userId, event_type: eventType, metadata })
    .then(() => {})   // suppress unhandled-promise warnings
    .catch(() => {});  // fail silently — never surface to UI
},
```

**Change to:**
```javascript
_log(userId, eventType, metadata = {}) {
  if (!userId) return;
  // Do not log events triggered while admin is impersonating a customer
  if (AdminContext.isActive()) return;

  // Resolve tenant_id defensively — UsageEvents may be called before
  // TenantContext.resolve() completes (it's fire-and-forget from anywhere).
  // Fall back to the founding tenant constant if TenantContext isn't ready.
  // The DB column default is the final safety net.
  let tenantId;
  try {
    tenantId = TenantContext.current().id;
  } catch {
    tenantId = FOUNDING_TENANT.id;
  }

  db.from('usage_events')
    .insert({
      user_id: userId,
      event_type: eventType,
      metadata,
      tenant_id: tenantId,
    })
    .then(() => {})
    .catch(() => {});
},
```

This is the only call site that needs the try/catch fallback because
it's the only one that can run before `TenantContext.resolve()`. The
other three (`Preorders.reserve`, `Subscriptions.subscribe`,
`Settings.set`) are all called in response to user actions on pages that
have already awaited `TenantContext.resolve()` in `initNav()`.

---

## Verification

### V1 — Reserve a comic, confirm tenant_id is set explicitly

1. Log in as Test Customer on staging
2. Open DevTools → Network tab, filter to `preorders`
3. Reserve any comic
4. Inspect the POST request to `/rest/v1/preorders` — the request body
   should contain `"tenant_id":"72e29f67-..."` along with the other fields

If the request body has `tenant_id` set, the explicit-pass is working.
If not, the change didn't deploy or wasn't applied.

### V2 — Subscribe to a series, confirm tenant_id is set explicitly

1. Same setup — Test Customer, Network tab
2. Find a standard cover, click Subscribe
3. Inspect the POST to `/rest/v1/subscriptions` — body should include
   `"tenant_id":"72e29f67-..."`

### V3 — Toggle maintenance mode, confirm tenant_id is set explicitly

1. Log in as Test Admin
2. DevTools open, Network tab, filter to `app_settings`
3. Toggle maintenance mode on, then off
4. The POST request body for the upsert should include
   `"tenant_id":"72e29f67-..."`

### V4 — Confirm usage events still log under normal flow

1. Log in as Test Customer
2. Open DevTools → Network tab, filter to `usage_events`
3. Browse the catalog (this triggers `UsageEvents.catalogView`)
4. Confirm a POST to `/rest/v1/usage_events` fires with
   `"tenant_id":"72e29f67-..."` in the body

### V5 — Confirm usage events still log if TenantContext fails

This verifies the defensive fallback. Hard to trigger naturally, but
testable from the browser console:

1. Log in as Test Customer on staging
2. Open DevTools console
3. Run: `TenantContext._reset()` — this clears the cached tenant
4. Without calling `resolve()` again, run:
   ```javascript
   UsageEvents._log('test-user-id-not-real', 'test_event', { test: true });
   ```
5. Check the Network tab — the POST should still fire with the founding
   tenant UUID as `tenant_id` (the fallback path)
6. Note: this will create a junk row in `usage_events` because the
   user_id doesn't match a real user. Clean it up with:
   ```sql
   DELETE FROM usage_events WHERE event_type = 'test_event';
   ```

If V5 fails (the request doesn't fire, or fires without `tenant_id`),
the defensive fallback isn't working.

### V6 — Confirm column defaults still in place

Re-run the pre-flight check:

```sql
SELECT table_name, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND column_name = 'tenant_id'
  AND table_name IN ('preorders', 'subscriptions', 'app_settings', 'usage_events');
```

All four should still show the founding tenant UUID. If anyone removed
defaults during this sub-deploy, that's out of scope and needs to be
reverted.

---

## Smoke Test

Run all of these on staging after deploying. Behavior should be
identical to pre-change.

| # | Account | Flow | Expected |
|---|---|---|---|
| 1 | Test Customer | Login, browse catalog | Items load |
| 2 | Test Customer | Reserve a comic | Persists, appears in My List |
| 3 | Test Customer | Cancel a reservation | Removed from My List |
| 4 | Test Customer | Update quantity on a reservation | Saves correctly |
| 5 | Test Customer | Subscribe to a series | Subscription appears |
| 6 | Test Customer | Unsubscribe | Removed |
| 7 | Test Admin | View dashboard | Loads, stats correct |
| 8 | Test Admin | Toggle maintenance mode on | Activates correctly |
| 9 | Test Admin | Toggle maintenance mode off | Deactivates correctly |
| 10 | Test Admin | Impersonate customer | Banner appears, customer's data loads |
| 11 | Test Admin (impersonating) | Reserve on behalf of customer | Saves correctly |
| 12 | Test Admin | Mark a preorder fulfilled | Toggles correctly |

If any of 1–12 fails with a 400 error mentioning `tenant_id`, that's
a sign the explicit-pass is sending an invalid value. Check
`TenantContext.current().id` in the browser console — it should match
`72e29f67-39f7-42bc-a4d5-d6f992f9d790`.

If any of 1–12 fails for any other reason, the change has a syntax bug.
Check the browser console for JavaScript errors.

### Magic-link flow (smoke test row 11 from 3.1)

The `test-magic-link.ps1` script also exercises a write path
(`user_profiles` insert by the script + `usage_events` log on first
catalog view by the test user). After deploying 3.2, run the magic-link
script once and confirm no errors.

---

## Rollback

If anything goes wrong, the rollback is a single revert:

```powershell
git checkout staging
git revert <commit-sha-of-3.2-merge>
git push origin staging
git push staging staging:main
```

No DB rollback needed — column defaults remain in place throughout 3.2.

---

## Completion Criteria

**Status: Complete as of 2026-05-04. All criteria met.**

- [X] All 4 INSERT/UPSERT call sites in `app.js` pass `tenant_id` explicitly
- [X] `UsageEvents._log()` has the defensive try/catch fallback to `FOUNDING_TENANT.id`
- [X] V1–V6 verification checks all return expected results
- [X] Smoke test rows 1–12 all pass
- [X] Magic-link flow tested via `test-magic-link.ps1` with no errors
- [X] No other files modified (verify with `git diff --stat`)
- [X] No DB changes made (verify column defaults still present)
- [X] Branch `feature/phase-3.2-explicit-tenant-writes` merged into `staging`
- [X] Staging GitHub Pages deploy succeeded
- [X] `docs/phase-3-tenant-resolution.md` parent doc updated with sub-deploy 3.2 status set to "Complete" and the date
- [X] No out-of-scope work was bundled into this commit (verify by reading
      the diff — it should be limited to `app.js` and the parent phase doc)

---

## What Phase 3.2 Does NOT Achieve

Calling these out so they aren't surprises later:

- **Column defaults still in place.** They will be removed in
  sub-deploy 3.3. Until then they remain a safety net for any write
  path we accidentally missed.
- **Edge Function writes are unchanged.** Phase 2 already made them
  tenant-aware. They use the `FOUNDING_TENANT_ID` env secret, not
  `TenantContext` (which is a browser-side concept).
- **Import script writes are unchanged.** Same reason as above —
  Phase 2 covered them.
- **Analytics views still un-scoped.** Sub-deploy 3.4.
- **No new functionality.** This sub-deploy is invisible to end users.
  Customers and admins should see zero behavior change.

---

## Open Questions for Pre-Execution

Resolve these before starting:

1. **Confirm `app.js` has not been modified since the planning inventory.**
   The line numbers in this plan reference the file as it existed at
   the time of writing. If any other commits to `app.js` have landed
   since, re-locate each call site by searching for the function name
   rather than by line number.

2. **Confirm `FOUNDING_TENANT` constant is in scope at the
   `UsageEvents._log()` call site.** It's defined at the top of
   `app.js` (line ~28) and `UsageEvents` is defined later (line ~440),
   so the const is in scope by the time `_log()` runs. No imports or
   refactoring required.

---

## Reference

- Parent plan: `docs/phase-3-tenant-resolution.md`
- Phase 3.1 plan: `docs/phase-3.1-tenant-resolution-layer.md`
- Phase 2 completion: `docs/phase-2-completion.md`
- Phase 1 schema: `docs/phase-1-schema-migration.md`
- Anti-drift rules: `CLAUDE.md` § Anti-Drift Rules for Agentic Sessions
- Founding tenant UUID: `72e29f67-39f7-42bc-a4d5-d6f992f9d790`

---

---

## Execution Notes

### Hot-fix applied after V3 failure (2026-05-04)

**Discovered gap:** `TenantContext.resolve()` was only awaited on `index.html`
and `catalog.html` (added in Phase 3.1). The other four authenticated pages —
`admin.html`, `mylist.html`, `arrivals.html`, `subscriptions.html` — share a
common boot path through `initNav()` but `initNav()` never called
`TenantContext.resolve()`. Any write triggered from those pages (e.g., toggling
maintenance mode on `admin.html`) threw `TenantContext.current() called before
resolve()` because the context was never resolved on that page load.

**Root cause:** Phase 3.1 resolved the context inline on each page that needed
it, rather than in the shared `initNav()` function. The pages that were tested
(catalog flow) worked; the admin page was not in the Phase 3.1 verification
matrix.

**Fix applied:** Added `await TenantContext.resolve()` as the first action in
`initNav()` in `app.js`, immediately after the early-return guard on the missing
nav element and before `await Auth.getUser()`. This means every authenticated
page that calls `initNav()` now resolves the tenant context before any user
action can trigger a write.

**Files changed:**
- `app.js` line 190 — one `await TenantContext.resolve()` call added to `initNav()`

**Re-verification required:** Re-run V3 (admin maintenance mode toggle) to
confirm the error is resolved. Re-run smoke test rows 7–9.

**Last updated:** 2026-05-04 (hot-fix execution notes added)
