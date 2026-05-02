# Phase 3.1 — Tenant Resolution Layer (Read-Only)

**Status:** Planning
**Branch:** `feature/phase-3.1-tenant-resolution-layer` (branched from `staging`)
**Risk:** Low — additive only, no writes change, no DB changes
**Reversible:** Yes (delete the new `TenantContext` block from `app.js`)
**Run after:** Phase 2 complete (which it is, as of 2026-04-30)
**Estimated execution time:** One weekend session, plus a soak period

This document is the execution blueprint for Sub-Deploy 3.1. Read it
end-to-end before starting. Refer to `phase-3-tenant-resolution.md` for
the parent phase scope and to `CLAUDE.md` for the anti-drift rules
governing this session.

---

## Goals

1. Introduce a `TenantContext` module in `app.js` that owns tenant
   resolution as a single source of truth
2. Resolve the active tenant from, in priority order:
   a. The authenticated user's `user_profiles.tenant_id` (when logged in)
   b. The `?t=<slug>` query parameter (for pre-login visitors)
   c. The founding tenant slug `raysandjudys` (default fallback)
3. Persist a resolved-from-query-param tenant in `sessionStorage` so
   subsequent same-tab navigations don't need the param
4. Expose the active tenant to the rest of `app.js` via
   `TenantContext.current()` returning `{ id, slug, display_name }`
5. End in a state where the app behaves identically to today (one
   tenant, all paths resolve to Ray & Judy's), but the **mechanism**
   for that resolution is now explicit, visible, and ready for a
   second tenant to be added without further code changes

**Out of scope for 3.1 — do NOT do these in this session:**

- Modifying any write paths (preorders, subscriptions, profiles) —
  that's sub-deploy 3.2
- Removing column defaults — that's sub-deploy 3.3
- Touching analytics views — that's sub-deploy 3.4
- Adding a tenant picker UI, branded landing pages, or visual
  per-tenant theming — that's a later phase
- Edge Function changes — Phase 2 already covered tenant scoping there
- Any DB schema or RLS changes — none required for 3.1
- Anything in `import-staging.js` or `import.js`

If you find a real bug while executing 3.1 that is out of scope, **stop
and ask** per the anti-drift rules in `CLAUDE.md`.

---

## Why This Sub-Deploy Is Read-Only

Phase 1 established that RLS scopes every read to the authenticated
user's tenant via `current_tenant_id()`, which reads `user_profiles`.
Phase 2 made the import script and Edge Functions tenant-aware. The app
still works fine with a single tenant because every query implicitly
scopes via the user's profile.

The gap Phase 3.1 closes is **pre-login tenant context**. When a
self-registered visitor clicks their magic-link email and lands on
`catalog.html` before their profile row is fully synced (or before
they're authenticated for that browser session), the app currently
falls back to whatever the database returns. With a second tenant in
the system, this would silently show the wrong catalog.

By adding `TenantContext`, we make the resolution explicit. Today it
returns the founding tenant for everyone because there is only one
tenant. Tomorrow, when a second tenant exists, the same code returns
the correct one based on the URL the visitor arrived from.

This sub-deploy ships a working mechanism with no functional change.
That's the safe place to start.

---

## Files Affected

| File | Type of change |
|---|---|
| `app.js` | Additive — new `TenantContext` module, ~80 lines near top |
| `catalog.html` | One-line addition — capture `?t=` before login redirect logic runs |
| `index.html` | One-line addition — same |
| (no other files) | — |

**Files NOT touched** (verify before commit):
- `mylist.html`, `arrivals.html`, `subscriptions.html`, `admin.html`
- `style.css`, `config.js`
- Any file under `docs/`
- Any Edge Function source
- `import-staging.js`, `import.js`

---

## Pre-Flight Checks

### 1. Confirm staging app currently works

Visit `https://mrcyberrick.github.io/comic-preorder-staging/index.html`
and run the standard customer + admin smoke test (Test Customer login
→ catalog → reserve → my list; Test Admin login → admin dashboard).
Establish a known-good baseline before changing anything.

### 2. Confirm the tenants table is queryable from the anon key

In the staging Supabase SQL editor (run as `postgres`):

```sql
SELECT id, slug, display_name FROM tenants;
-- Expected: 1 row, slug='raysandjudys'
```

Then verify the RLS policy lets an authenticated user read tenants:

```sql
BEGIN;
SET LOCAL role authenticated;
SET LOCAL "request.jwt.claims" TO '{"sub": "0d51fa64-8823-44a6-b390-a34249945a3f", "role": "authenticated"}';
SELECT id, slug, display_name FROM tenants;
ROLLBACK;
-- Expected: 1 row (the user's own tenant, visible via "users read own tenant" policy)
```

If either query fails, **stop**. The TenantContext module depends on
authenticated reads of `tenants` working — if the RLS policy from Phase 1
isn't behaving, fix that first as a separate change.

### 3. Confirm there is no tenant lookup mechanism for unauthenticated users

Currently, an unauthenticated visitor cannot read the `tenants` table —
the policy `"users read own tenant"` requires authentication. This is
intentional and correct.

For 3.1, an unauthenticated visitor with `?t=raysandjudys` in the URL
needs to know which tenant that slug refers to *without* being logged
in. We solve this client-side: we hardcode the founding tenant slug→id
mapping in `app.js` for now. This is acceptable because:

- There is exactly one tenant on staging
- The mapping is a single string pair, not a security boundary
- RLS still gates every actual data read
- This will be replaced with a public RPC in Phase 3.2 or later, once
  there's more than one tenant

Confirm with the user that this approach is acceptable before
proceeding. If not, the alternative is to add a `SECURITY DEFINER`
function `resolve_tenant_by_slug(slug text)` callable by the anon
role — that's an extra DB change that may push 3.1 into a multi-step
sub-deploy.

---

## The Change

### 1. Add the `TenantContext` module to `app.js`

Insert this block in `app.js` immediately after the Supabase client
initialization (look for the line creating the `db` constant) and
before the `Auth` module.

```javascript
// ============================================================================
// TenantContext — resolves the active tenant for the current page load.
//
// Resolution order (highest priority first):
//   1. Authenticated user's user_profiles.tenant_id
//   2. ?t=<slug> query parameter (persisted to sessionStorage for the tab)
//   3. Founding tenant fallback (raysandjudys)
//
// Phase 3.1: read-only — does not affect writes. Phase 3.2 will make
// app.js writes pass tenant_id explicitly using TenantContext.current().
//
// The slug→id mapping for unauthenticated lookup is hardcoded here
// because the tenants table is not readable by anon. Replaced with
// an RPC in a later sub-deploy once a second tenant exists.
// ============================================================================

const FOUNDING_TENANT = {
  id: '72e29f67-39f7-42bc-a4d5-d6f992f9d790',
  slug: 'raysandjudys',
  display_name: "Ray & Judy's Book Stop",
};

const TENANT_SLUG_MAP = {
  // slug → { id, slug, display_name }
  raysandjudys: FOUNDING_TENANT,
};

const TenantContext = {
  // Cached resolved tenant for this page load. Populated by resolve().
  _current: null,

  /**
   * Resolve the active tenant. Should be called once per page load,
   * before any tenant-scoped logic runs. Idempotent — repeated calls
   * return the cached value.
   *
   * Returns: { id, slug, display_name }
   */
  async resolve() {
    if (this._current) return this._current;

    // 1. Check for an authenticated session and try the profile route first
    try {
      const { data: { session } } = await db.auth.getSession();
      if (session?.user?.id) {
        const { data: profile } = await db
          .from('user_profiles')
          .select('tenant_id')
          .eq('id', session.user.id)
          .single();

        if (profile?.tenant_id) {
          // Look up the full tenant row (RLS allows this for authed users)
          const { data: tenant } = await db
            .from('tenants')
            .select('id, slug, display_name')
            .eq('id', profile.tenant_id)
            .single();

          if (tenant) {
            this._current = tenant;
            this._source = 'profile';
            return this._current;
          }
        }
      }
    } catch (err) {
      // Auth or RLS error — fall through to query param / default
      console.warn('TenantContext: profile lookup failed, falling back', err);
    }

    // 2. Check ?t= query parameter (and persist to sessionStorage)
    try {
      const params = new URLSearchParams(window.location.search);
      const fromQuery = params.get('t');
      if (fromQuery) {
        const tenant = TENANT_SLUG_MAP[fromQuery];
        if (tenant) {
          sessionStorage.setItem('pulllist.tenant_slug', fromQuery);
          this._current = tenant;
          this._source = 'query';
          return this._current;
        }
        // Unknown slug — log and fall through. Don't error; we don't
        // want a typo in the URL to break the page.
        console.warn('TenantContext: unknown tenant slug in ?t=', fromQuery);
      }

      // 3. Check sessionStorage (carries query-resolved tenant across nav)
      const fromStorage = sessionStorage.getItem('pulllist.tenant_slug');
      if (fromStorage && TENANT_SLUG_MAP[fromStorage]) {
        this._current = TENANT_SLUG_MAP[fromStorage];
        this._source = 'session';
        return this._current;
      }
    } catch (err) {
      console.warn('TenantContext: query/session lookup failed', err);
    }

    // 4. Default fallback — founding tenant
    this._current = FOUNDING_TENANT;
    this._source = 'default';
    return this._current;
  },

  /**
   * Synchronous accessor — returns the cached tenant or throws.
   * Use this in code paths that run after resolve() has completed.
   */
  current() {
    if (!this._current) {
      throw new Error('TenantContext.current() called before resolve()');
    }
    return this._current;
  },

  /**
   * Diagnostic — reveals which resolution path produced the active
   * tenant. Useful for the smoke test. Not for production logic.
   */
  source() {
    return this._source;
  },

  /**
   * Test hook — clears cached state. Used by automated tests or by
   * the smoke test when toggling between resolution paths in the
   * browser console.
   */
  _reset() {
    this._current = null;
    this._source = null;
  },
};

// Expose on window for debugging and for HTML pages to await
window.TenantContext = TenantContext;
```

### 2. Call `TenantContext.resolve()` early on each page

In each public-facing HTML page (`index.html` and `catalog.html`), the
existing `<script>` that runs page-specific code should `await
TenantContext.resolve()` before doing anything else. Find the existing
page-init block — it usually starts with an `Auth.requireAuth()` or
similar call — and prepend the resolve.

Example for `catalog.html` (illustrative — match the actual structure
when editing):

```javascript
<script>
  (async () => {
    await TenantContext.resolve();
    // ... existing init code ...
  })();
</script>
```

For `index.html`, the resolve happens before any auth redirect logic
so that a `?t=` parameter is captured and persisted before the user is
sent off to log in.

**No other pages need this change in 3.1** — `mylist.html`,
`arrivals.html`, `subscriptions.html`, and `admin.html` all require
auth to load, so by the time their code runs the user is logged in
and the profile route resolves the tenant correctly.

### 3. (Optional) Wire `TenantContext` into the existing nav greeting

If `app.js` has a nav-rendering block that displays the user's name,
you can additionally render the tenant display name there. **This is
optional for 3.1** — adding it now means a tiny visual confirmation
that resolution is working, but it also crosses a line into UI work.

Recommended: skip this. Save it for a later phase that's explicitly
about per-tenant branding.

---

## Verification

### V1 — Module loads without error

Open `catalog.html` in the staging deploy. Open browser DevTools
console. Type:

```javascript
TenantContext.current()
// Expected: { id: '72e29f67-...', slug: 'raysandjudys', display_name: "Ray & Judy's Book Stop" }

TenantContext.source()
// Expected: 'profile' (if logged in) or 'default' (if not)
```

### V2 — Query param resolution works

Log out. Visit
`https://mrcyberrick.github.io/comic-preorder-staging/index.html?t=raysandjudys`.
In console:

```javascript
TenantContext.source()
// Expected: 'query'

sessionStorage.getItem('pulllist.tenant_slug')
// Expected: 'raysandjudys'
```

### V3 — Unknown slug falls through cleanly

Visit `index.html?t=does-not-exist`. In console:

```javascript
TenantContext.source()
// Expected: 'default'

TenantContext.current().slug
// Expected: 'raysandjudys'
```

There should be a console warning about the unknown slug. The page
should otherwise behave identically.

### V4 — Profile resolution wins after login

Log in as Test Customer. In console:

```javascript
TenantContext._reset();
await TenantContext.resolve();
TenantContext.source();
// Expected: 'profile'
```

This confirms that even if `?t=` was in the URL on the previous page,
once authenticated the user's profile is the source of truth.

### V5 — Session persistence across navigation

Log out. Visit `index.html?t=raysandjudys`. Then navigate to
`catalog.html` *without* the query param. In console on `catalog.html`:

```javascript
TenantContext.source()
// Expected: 'session'
```

This confirms `sessionStorage` is carrying the resolution across pages
in the same tab.

---

## Smoke Test

Run all of these on staging after deploying. Expected behavior is
identical to pre-change.

| # | Account | Flow | Expected |
|---|---|---|---|
| 1 | Test Customer | Login at `index.html` | Lands on catalog as before |
| 2 | Test Customer | `catalog.html` browse | Items load, no console errors |
| 3 | Test Customer | Reserve a comic | Persists to my list |
| 4 | Test Customer | `mylist.html` | Reservation visible |
| 5 | Test Customer | `subscriptions.html` | Existing subs visible |
| 6 | Test Customer | `arrivals.html` | This week's items load |
| 7 | Test Admin | Login + admin dashboard | Dashboard loads, stats correct |
| 8 | Test Admin | Impersonate a customer | Other user's data displays |
| 9 | (logged out) | Visit `index.html?t=raysandjudys` | Login page loads, no error |
| 10 | (logged out) | Visit `index.html?t=garbage` | Login page loads, no error, console warn |
| 11 | (logged out) | Magic-link flow from approve-customer email | Lands on catalog, browses successfully |

If any of 1–8 break, the cause is almost certainly a syntax error in
the new `TenantContext` block — `app.js` is shared, so a parse error
breaks everything. Roll back and re-edit.

If 9–11 break, the resolution logic has a bug — the failure should be
isolated to pre-login pages.

---

## Rollback

If anything goes wrong, the rollback is a single revert of the
`feature/phase-3.1-tenant-resolution-layer` branch:

```powershell
git checkout staging
git revert <commit-sha-of-3.1-merge>
git push origin staging
git push staging staging:main
```

Or, if the branch hasn't been merged yet, simply abandon the branch.
No DB changes were made, so there is no SQL rollback to run.

---

## Completion Criteria

Phase 3.1 is complete when **all** of the following are true on staging:

## Completion Criteria

**Status: Complete as of 2026-05-02. All criteria met.**

- [x] `TenantContext` module added to `app.js`, ~80 lines, syntactically valid
- [x] `index.html` and `catalog.html` call `TenantContext.resolve()` at page init
- [x] V1–V5 verification queries all returned the expected results
- [x] Smoke test rows 1–11 all passed
- [x] No other files modified (verify with `git diff --stat`)
- [x] No DB changes made (verify by inspecting recent migrations: there should be none)
- [x] Branch `feature/phase-3.1-tenant-resolution-layer` merged into `staging`
- [x] Staging GitHub Pages deploy succeeded and pages render correctly
- [x] `docs/phase-3-tenant-resolution.md` parent doc updated with sub-deploy 3.1 status
- [x] No out-of-scope work was bundled into this commit

---

## What Phase 3.1 Does NOT Achieve

Calling these out so they aren't surprises later:

- **Writes still don't pass tenant_id explicitly.** Reserves, subscriptions,
  user_profile inserts all still rely on the column defaults established
  in Phase 1. That's sub-deploy 3.2's job.

- **The slug→id mapping is hardcoded.** Adding a second tenant requires
  editing the `TENANT_SLUG_MAP` object in `app.js`. A later sub-deploy
  will replace this with a public RPC, but only when there's a real
  reason to — premature abstraction is worse than the hardcoded map.

- **No UI surfaces the active tenant.** The user has no visual indication
  of which tenant they're in. Fine for now (one tenant). Becomes a
  must-have when there are two.

- **Edge Functions don't read TenantContext.** They get tenant from the
  authenticated user's profile (Phase 2's tenant_id parameters) or from
  the `FOUNDING_TENANT_ID` secret. Phase 3.1 doesn't change that.

- **Admin impersonation behavior is unchanged.** The impersonated
  customer's tenant is implicit (it must match the admin's tenant for
  RLS to allow the data to be read at all). No new logic needed.

---

## Open Questions for Pre-Execution

Resolve these before starting:

1. **Confirm the hardcoded slug→id map approach is acceptable.** If the
   answer is no, add a step to create a `resolve_tenant_by_slug(slug)`
   `SECURITY DEFINER` RPC and grant `EXECUTE` to anon. This expands
   the sub-deploy by one DB migration.

2. **Where exactly does `TenantContext.resolve()` go in `index.html`'s
   page script?** It needs to run before any auth-redirect-on-load
   logic, so the `?t=` param is captured and persisted before the
   visitor is sent away. Read `index.html` first to identify the right
   insertion point.

3. **Does `app.js` already export anything via `window.X = X`?** The
   plan adds `window.TenantContext = TenantContext`. Confirm that
   pattern matches existing conventions in the file.

---

## Reference

- Parent plan: `docs/phase-3-tenant-resolution.md`
- Phase 2 completion: `docs/phase-2-completion.md`
- Phase 1 schema: `docs/phase-1-schema-migration.md`
- Anti-drift rules: `CLAUDE.md` § Anti-Drift Rules for Agentic Sessions
- Founding tenant UUID: `72e29f67-39f7-42bc-a4d5-d6f992f9d790` (also in `CLAUDE.md`)

---

**Last updated:** 2026-05-01 (initial plan)
