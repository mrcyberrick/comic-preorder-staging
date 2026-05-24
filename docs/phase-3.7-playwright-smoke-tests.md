# Phase 3.7 — Smoke Test Automation (Playwright)

**Status:** Complete 2026-05-13
**Parent phase:** `docs/phase-3-tenant-resolution.md`
**Branch base:** `staging`
**Branch name:** `feature/3.7-playwright-smoke-tests`
**Estimated duration:** one extended session, splittable into 3.7a (suite skeleton + auth + customer flows) and 3.7b (admin flow + tenant isolation + import regression + docs) if it runs long
**Customer impact:** none — test infrastructure only; all artifacts live in the local scripts folder outside the repo; no app, SQL, or Edge Function changes

---

## Goal

Replace the current pre-promotion smoke pass — manual browser clicking
plus two ad-hoc PowerShell helpers (`test-magic-link.ps1`,
`test-this-week.ps1`) — with a Playwright-driven automated suite that
exercises every customer and admin flow that Phase 3 has touched, asserts
tenant isolation against a synthetic second tenant, and surfaces the two
classes of regression that snuck through Phase 3 soak (`arrivals.html`
orphan-reserved rendering on 2026-05-06; `import-staging.js`
`weekly_shipment` tenant_id gap on 2026-05-08).

Closes the open Phase 3 completion criterion:

> A test second tenant inserted via SQL is fully isolated from Ray &
> Judy's data in every analytics view, every page query, and every admin
> tool.

After 3.7 ships, the **Standard Deployment Workflow** in `CLAUDE.md`
gains a new pre-push step: run the smoke suite from the local scripts
folder before pushing `staging:main` to GitHub Pages.

---

## Approach Summary

Decisions confirmed during planning. Two rows marked **PENDING**
require user confirmation before the runbook is generated.

| Decision | Choice | Rationale |
|---|---|---|
| Test code location | **Local scripts folder, never committed** — same parent directory as `test-magic-link.ps1`, `test-this-week.ps1`, `.env` | User-confirmed: local testing stays local-only. Matches the existing helper-script pattern; same `.env` already holds the keys Playwright needs; nothing to gitignore in the repo because nothing lives in the repo. |
| Run environment | **Local only** — no CI in 3.7 | User-confirmed. The two soak bugs would have been caught by a local pre-push run; CI is incremental value, deferred to a possible future sub-deploy if it earns its keep. |
| Production runs | **None ever** | User-confirmed: production testing is not in scope for 3.7 or any later phase as currently planned. Suite is staging-only by construction. |
| Test runner | Playwright `@playwright/test` (TypeScript) | Tool the user chose. Built-in test runner avoids adding Mocha/Vitest. TypeScript gives type-checked fixtures without a build step. |
| Browser matrix | Chromium only | Single-store tool; no cross-browser obligation. Adding Firefox/WebKit doubles runtime for negligible coverage gain on a static GH-Pages app. |
| Auth strategy | Service-role mints a Supabase magic link; spec navigates the page to the `action_link`; Supabase verify sets the auth cookies and redirects to the post-login URL | Mirrors `test-magic-link.ps1` exactly. Zero app-code changes for testing. No "test mode" auth bypass. |
| Test data lifecycle | Each spec creates its users / catalog rows / preorders in `beforeAll` and tears them down in `afterAll`. No persistent test fixtures in staging Supabase. | Avoids cross-run pollution. Schema's `ON DELETE CASCADE` from `tenants` makes cleanup a single delete in the multi-tenant teardown path. |
| Tenant isolation strategy | Per-run synthetic second tenant inserted via service-role at suite `globalSetup`, deleted at `globalTeardown`. Slug `playwright-test-<short uuid>`. | Matches the precedent set in Phase 3.4 verification (Findings F15, F16, F20 were verified by inserting a synthetic tenant for the duration of the check). Per-run rather than permanent because the second tenant in staging would otherwise drift and become a maintenance liability. Schema cascades make teardown trivial. |
| Import-script regression coverage | Refactor `upsertShipment` row builders in `import-staging.js` into named exported helpers (`buildLunarShipmentRows`, `buildPrhShipmentRows`); guard the script's `main()` call with `if (require.main === module)` so the file can be `require()`'d without auto-running; Node test imports the helpers directly and asserts `tenant_id` on every returned row. | User-chosen scope expansion. Source-grep would have worked but a real unit test catches subtler regressions (typo, conditional skip, parameter shadowing). The script still works exactly the same when run directly; the change is purely structural. |
| Import-script refactor risk | Refactor is pure extract-function — same logic, same call site, same outputs. Verified by re-running the staging import end-to-end (catalog + shipment) after the change. | The script runs every Wednesday; a regression here breaks the weekly workflow. The verification step is non-negotiable. |
| Arrivals orphan-reserved coverage | Browser spec in `04-arrivals-this-week.spec.ts` that seeds a `weekly_shipment` row plus a separate preorder dated for the same Wednesday but with no shipment row, then asserts both render | Direct regression coverage for the 2026-05-06 soak bug. |
| Runner script | PowerShell wrapper `run-smoke.ps1` in `scripts/playwright/` that self-`Unblock-File`s, loads `.env`, runs the Node import-regression test, then runs `npx playwright test`, then prints a single summary | One command for the human. OneDrive-Unblock-File hassle absorbed inside the script. Matches the existing PowerShell-helper UX. |
| Suite size for first cut | **7 Playwright specs + 1 Node test = 8 files** (inventory in § In Scope) | Covers the flows Phase 3 actually changed. Not exhaustive; not a test pyramid. Goal is regression detection on the documented surface, not 100% coverage. |
| `node_modules/` and `playwright-report/` | Local-only, ignored by `.gitignore` *of the scripts folder* (not the repo `.gitignore`) since the scripts folder isn't a git repo today | No repo pollution. If the user later wants the scripts folder under version control as a separate repo, this layout is ready for it. |
| Folder name | `scripts/playwright/` | Matches the tool. |
| CLAUDE.md test infra section | Add a new section **§ Smoke Test Suite (local)** after § Files That Must Stay in Sync, documenting where the suite lives, how to run it, and that it's local-only never committed | Discoverability for the next session. The suite isn't in the repo, but CLAUDE.md is the project's single source of truth for *how to work on the project* — and the new pre-push step is part of how to work on the project. |
| Spec 07 finding coverage | **F15 and F20 only.** F16 and F34 are deferred to the pre-Phase-4 hardening pass already queued in `technical-reference.md` § 13. | F15 and F20 are directly browser-testable (RLS read-side, function output). F16 (admin write OR-permit) and F34 (Edge-Function tenant pinning) need service-role probes that belong with the broader grants/policy audit, not bolted onto a smoke spec. |

---

## In Scope

1. **New local Playwright project** at
   `C:\Users\richa\OneDrive\Documents\(Work)\BookStop\catalogs\scripts\playwright\`
   (path subject to the PENDING folder-name decision). Initialized with
   `npm init`, `@playwright/test` installed, `npx playwright install
   chromium` run once. `playwright.config.ts` configured for
   chromium-only, `baseURL = https://mrcyberrick.github.io/comic-preorder-staging/`,
   timeouts tuned for GitHub Pages latency.

2. **Fixtures** at `playwright/fixtures/`:
   - `auth.ts` — service-role helpers (`createUser`, `generateMagicLink`,
     `deleteUser`) plus a Playwright `authenticatedPage` fixture that
     creates a fresh user, mints a magic link, navigates the page to it,
     and yields an authenticated page. Cleanup runs in `afterAll`.
   - `tenant.ts` — service-role helpers (`createTestTenant`,
     `deleteTestTenant`) and a suite-level fixture that creates the
     synthetic second tenant once per run and deletes it (cascade) at
     end.
   - `catalog.ts` — `seedCatalogRow(tenantId, opts)`, `seedPreorder(...)`,
     `seedWeeklyShipment(...)`, and prefix-based cleanup helpers
     (`TEST_PW_` prefix on `item_code` so any leftover from a crashed
     run is recoverable by the existing `test-this-week.ps1`
     `CleanupOnly` pattern's logic, mirrored here).

3. **Seven Playwright spec files** at `playwright/tests/`:

   | # | File | What it asserts |
   |---|---|---|
   | 01 | `magic-link-arrival.spec.ts` | A pending user with a valid magic link lands on `catalog.html` authenticated; `TenantContext.source()` evaluates to `'profile'` in DevTools console; user_profiles row exists with founding-tenant id |
   | 02 | `catalog-reserve-mylist.spec.ts` | Authenticated customer reserves a seeded catalog row from `catalog.html`; `mylist.html` shows the row with correct quantity, title, on-sale date; cancel returns it to the catalog state |
   | 03 | `mylist-cancel-guards.spec.ts` | Three rows: (a) unfulfilled past-FOC — cancel works; (b) FOC-locked — qty buttons disabled per existing pattern; (c) `fulfilled = true` — "✓ In hand" chip renders, no cancel control, `Preorders.cancel` API call returns the guard error message |
   | 04 | `arrivals-this-week.spec.ts` | Three seed rows for this Wednesday: (a) catalog + shipment + preorder → renders in shipment-mode; (b) catalog + preorder, **no shipment row** → orphan-reserved merge path renders it; (c) catalog + shipment, **no preorder** → renders as "available this week, not yours". This is the 2026-05-06 regression. |
   | 05 | `subscriptions.spec.ts` | Customer subscribes to a series on `subscriptions.html`; row appears in subscription list with the chosen format; unsubscribe removes it |
   | 06 | `admin-this-week-bagging.spec.ts` | Admin user logs in (separate magic-link fixture with `is_admin = true`); navigates to admin → This Week tab; bagging list renders grouped by customer with checkboxes; Prev/Today/Next week buttons shift the window correctly and re-fetch; the per-customer "Email customer" button is clickable and triggers a non-error toast |
   | 07 | `tenant-isolation.spec.ts` | The big one. Two users — one in founding tenant, one in synthetic second tenant. Seed catalog and preorders for each. Then, while logged in as each: assert each user's `catalog.html` renders only their tenant's catalog; `mylist.html` shows only their preorders; `arrivals.html` shows only their tenant's shipment + preorders; admin-of-tenant-A sees only tenant-A users in `admin.html` user list. Plus two regression-specific subtests for the HIGH findings fixed in Phase 3.4: **F15** (`weekly_shipment` SELECT tenant-scoping) and **F20** (`get_popular_series()` per-tenant counts). F16 and F34 are explicitly out of scope for this spec — see § Out of Scope. |

4. **Refactor `import-staging.js`** (local script, outside repo):
   - Extract the two anonymous row-builder blocks inside
     `upsertShipment()` into named module-scope helpers:
     `buildLunarShipmentRows(lunarShipment, catalogMap, tenantId)` and
     `buildPrhShipmentRows(prhShipment, catalogMap, tenantId)`. Both
     are pure functions — same inputs in, same array of objects out as
     today, including the soak-fix `tenant_id` field.
   - Wrap the script's `main().catch(...)` entry-point call with
     `if (require.main === module)` so requiring the file does not
     auto-execute the import.
   - Append `module.exports = { buildLunarShipmentRows, buildPrhShipmentRows };`
     at the bottom.
   - Behavior on direct invocation (`node import-staging.js ...`)
     unchanged.
   - Same change must be queued for `import.js` (production) — added
     to the existing prod-cutover patch list in CLAUDE.md § Known
     Out-of-Scope Items.

5. **One Node-side regression test** at
   `playwright/node-tests/import-tenant-id.test.mjs` — uses the
   refactor from item 4 to call the helpers directly with synthetic
   inputs and assert `tenant_id` is set on every returned row. No more
   source-grep. Uses Node's built-in `node:test` runner; invoked by
   `run-smoke.ps1` before Playwright kicks off; failure stops the run.

6. **Runner script** at `playwright/run-smoke.ps1`:
   - Self-`Unblock-File`s
   - Loads `.env` (same shape as `test-magic-link.ps1`)
   - Confirms `SUPABASE_URL` is staging (refuses to run otherwise)
   - Runs the Node import-regression test
   - Runs `npx playwright test`
   - Prints a one-line summary: `Smoke: N specs, M passed, K failed`
   - Non-zero exit on any failure

7. **README** at `playwright/README.md` — local docs only, never
   committed. Documents `.env` keys, how to run, how to add a new spec,
   the per-run synthetic-tenant pattern, and the rule that no spec may
   write to the founding tenant outside its own seeded `TEST_PW_*`
   rows.

8. **Documentation updates (in repo)**:
   - `CLAUDE.md` § Current Migration Phase — mark 3.7 active during
     work, Complete on close. Update **Active phase** line to reflect
     Phase 3 complete and Phase 4 queued.
   - `CLAUDE.md` § Standard Deployment Workflow — add a new line above
     the `git push staging staging:main` step:
     ```powershell
     # Run smoke tests before deploying to staging
     cd <local scripts folder>\playwright
     .\run-smoke.ps1
     # Stop if anything fails — do not push.
     ```
   - `CLAUDE.md` — **new § Smoke Test Suite (local)** section inserted
     after § Files That Must Stay in Sync. Contents: (1) where the
     suite lives (`<local scripts folder>\playwright\`); (2) one-line
     how-to (`cd ...\playwright && .\run-smoke.ps1`); (3) what it
     covers in one sentence; (4) explicit "local-only, never committed,
     never runs against production" guard; (5) pointer to
     `docs/phase-3.7-playwright-smoke-tests.md` for canonical detail.
   - `CLAUDE.md` § Known Out-of-Scope Items — the existing `import.js`
     (production) patch checklist gets a new bullet:
     "Match the 3.7 row-builder refactor in `upsertShipment` — extract
     `buildLunarShipmentRows` and `buildPrhShipmentRows`, wrap `main()`
     in `if (require.main === module)`, export the helpers."
   - `docs/phase-3-tenant-resolution.md` Sub-Deploys table — mark 3.7
     Complete with date. Update Phase Completion Criteria checkboxes
     ("No regression in customer or admin smoke tests" and "A test
     second tenant inserted via SQL is fully isolated..." both check
     based on the smoke suite passing).
   - `docs/phase-3-tenant-resolution.md` — write the "Phase 3 complete"
     summary banner at top (the parent plan currently says "In
     progress (3.6 complete, 3.7 plan pending)" — flip to
     "Complete YYYY-MM-DD").
   - `docs/technical-reference.md` — **no schema changes**. The test
     infra is genuinely scripts-folder territory and doesn't belong in
     the canonical schema doc. § 12 (import script) may benefit from a
     one-line note that `upsertShipment` row builders are now exported
     as helpers; CLI session uses judgment on whether that's worth a
     sentence.

---

## Out of Scope

Per anti-drift rules: discover → describe → ask → wait. The following
are real work items but **not** part of 3.7.

- **CI / GitHub Actions integration** — explicit user defer. The suite
  is local-only. A future sub-deploy may add CI; tracked as carry-
  forward.
- **Production testing** — explicit user defer. The suite refuses to
  run against the production Supabase URL by design.
- **Visual regression / screenshot diffing** — Playwright supports it;
  no demand surfaced; would explode the test data setup. Future
  enhancement if the bagging-list print layout starts drifting.
- **Load / performance testing** — not the suite's purpose. The
  Supabase REST endpoints have their own SLA; not a smoke-test concern.
- **Edge Function unit tests** — Deno-side testing of the eight Edge
  Functions is a separate sub-deploy if/when it earns its place. The
  current suite exercises them only via end-to-end browser flows.
- **F16 and F34 deep dives** — explicitly deferred to the pre-Phase-4
  hardening pass already queued in `technical-reference.md` § 13.
  Spec 07 covers F15 and F20 only. F16 (admin write OR-permit on
  `preorders`) and F34 (Edge-Function tenant pinning) need service-
  role-driven probes that belong with the broader grants/policy audit
  rather than a smoke spec.
- **Smoke tests of `analytics.html`** — page is admin-only, not yet
  rewritten under Phase 3. Will warrant coverage once it's been
  reworked or once a finding lands against it. F32 (CLAUDE.md page
  inventory missing `analytics.html` and `forgot-password.html`) is
  tangentially related but doc-only.
- **Tests for the eight `analytics_*` views** — Phase 3.4 rebuilt them
  with `current_tenant_id()` filters; verification was done at the SQL
  level. Adding view-level assertions to the tenant-isolation spec is
  possible but adds setup complexity for marginal gain over the
  page-level checks. Carry-forward.
- **The 27 findings in `technical-reference.md` § 13** beyond the four
  HIGH ones touched by the tenant-isolation spec. The pre-Phase-4
  hardening pass owns the rest.
- **Modifying `test-magic-link.ps1` or `test-this-week.ps1`** — keep
  them. They serve ad-hoc manual scenarios (one-off magic link
  generation; quick This Week seeding for human-driven testing) that
  Playwright doesn't replace. The two helpers stay alongside the new
  suite.

---

## Pre-flight (planning verification, before execution)

Read-only checks. If any fails, the CLI session stops and asks before
proceeding.

### P1 — `.env` in scripts folder is complete

```powershell
Get-Content "<scripts folder>\.env"
```

Expected keys: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`,
`FOUNDING_TENANT_ID`, `STAGING_REDIRECT_URL`. All four match the
staging values documented in `CLAUDE.md`. **Stop if `SUPABASE_URL` is
the production URL** — `plgegklqtdjxeglvyjte` must NOT appear.

### P2 — Node and npm versions

```powershell
node --version    # expect v18+ (Playwright @playwright/test requirement)
npm --version
```

Stop if Node < 18.

### P3 — Greenfield check

```powershell
Test-Path "<scripts folder>\playwright"
```

Expected: **False**. If a `playwright/` folder already exists, **stop**
— some previous session attempted this work; re-read its state before
proceeding rather than overwriting.

### P4 — Staging GitHub Pages reachable

```powershell
curl.exe -s -o $null -w "%{http_code}`n" `
  https://mrcyberrick.github.io/comic-preorder-staging/index.html
```

Expected: 200. Stop if 404 or 5xx — the suite has nothing to test
against.

### P5 — `TenantContext.source()` API still in `app.js`

The magic-link arrival spec asserts on the return value of
`TenantContext.source()` in DevTools console. Confirm the method
exists by reading the deployed `app.js` from staging:

```powershell
curl.exe -s https://mrcyberrick.github.io/comic-preorder-staging/app.js `
  | Select-String "TenantContext"
```

Expected: matches near the `TenantContext` declaration around § 10.1
of the technical reference. Stop if the API surface has drifted.

### P6 — Second-tenant insertion via service role still works

Dry-run probe — insert a one-row test tenant, immediately delete:

```bash
# POST /rest/v1/tenants with a synthetic slug, then DELETE
# (the CLI session generates the curl one-liner during execution)
```

Expected: 201 on insert, 204 on delete, no RLS error. If a policy
change since Phase 3 has restricted service-role writes to `tenants`,
**stop and re-plan** — the synthetic-tenant pattern is load-bearing
for this suite.

### P7 — `import-staging.js` is in the expected pre-refactor state

```powershell
Select-String -Path "<scripts folder>\import-staging.js" `
  -Pattern "tenant_id:\s*TENANT_ID"
```

Expected: at least 4 matches (catalog upsert, auto-reserve, Lunar
shipment row, PRH shipment row). Confirms the 2026-05-08 soak fix is
still in place and the refactor will start from a known-good baseline.
If fewer than 4, **stop** — the script has drifted and Change 6 needs
re-planning before any refactor begins.

Also confirm the script is currently structured as expected for the
refactor:

```powershell
Select-String -Path "<scripts folder>\import-staging.js" `
  -Pattern "^main\(\)\.catch|^async function upsertShipment|^module\.exports"
```

Expected: a `main().catch(...)` line near the bottom; an
`async function upsertShipment` declaration; **no** existing
`module.exports`. If `module.exports` already exists, a previous
session attempted similar work — **stop and re-read** before
overwriting.

### P8 — DevTools-style staging URL has expected page set

```powershell
@(
  'index.html','catalog.html','mylist.html','arrivals.html',
  'subscriptions.html','admin.html'
) | ForEach-Object {
  $url = "https://mrcyberrick.github.io/comic-preorder-staging/$_"
  $code = curl.exe -s -o $null -w "%{http_code}" $url
  "$_  $code"
}
```

Expected: 200 on all six. The specs target page paths directly; a
missing page breaks setup.

---

## Changes

### Change 1 — Initialize Playwright project

**Where:** local scripts folder, new `playwright/` subdirectory (path
per PENDING folder-name decision).

**Commands:**

```powershell
cd <scripts folder>
mkdir playwright
cd playwright
npm init -y
npm install -D @playwright/test typescript @types/node dotenv
npx playwright install chromium
```

**`playwright.config.ts`:**

```ts
import { defineConfig, devices } from '@playwright/test';
import 'dotenv/config';

if (!process.env.SUPABASE_URL?.includes('puoaiyezsreowpwxzxhj')) {
  throw new Error(
    'Refusing to run: SUPABASE_URL is not staging. ' +
    'This suite is staging-only by construction.'
  );
}

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,            // shared seed data; serial is simpler
  workers: 1,
  retries: 1,                      // GH Pages CDN can be flaky
  timeout: 60_000,
  reporter: [['list'], ['html', { open: 'never' }]],
  globalSetup: require.resolve('./fixtures/global-setup'),
  globalTeardown: require.resolve('./fixtures/global-teardown'),
  use: {
    baseURL: 'https://mrcyberrick.github.io/comic-preorder-staging/',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
```

**`.gitignore` (inside `playwright/`, not the repo's):**

```
node_modules/
playwright-report/
test-results/
.env.local
```

**Verification:**

```powershell
npx playwright test --list
# expect: "Listed 0 tests" — config valid, no specs yet
```

### Change 2 — Auth fixture (`fixtures/auth.ts`)

Re-implements the proven pattern from `test-magic-link.ps1` in
TypeScript. Three exported helpers and one Playwright fixture.

```ts
import { test as base, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const SUPABASE_URL    = process.env.SUPABASE_URL!;
const SERVICE_KEY     = process.env.SUPABASE_SERVICE_KEY!;
const REDIRECT_URL    = process.env.STAGING_REDIRECT_URL!;
const FOUNDING_TENANT = process.env.FOUNDING_TENANT_ID!;

const supaHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

export async function createUser(opts: {
  email: string;
  tenantId?: string;
  isAdmin?: boolean;
  fullName?: string;
}) {
  // (1) auth.users
  const authRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: supaHeaders,
    body: JSON.stringify({
      email: opts.email,
      email_confirm: true,
      user_metadata: { full_name: opts.fullName ?? 'Playwright Test' },
    }),
  });
  if (!authRes.ok) {
    throw new Error(`createUser auth: ${authRes.status} ${await authRes.text()}`);
  }
  const { id: userId } = await authRes.json();

  // (2) user_profiles
  const profRes = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles`, {
    method: 'POST',
    headers: { ...supaHeaders, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({
      id: userId,
      full_name: opts.fullName ?? 'Playwright Test',
      email: opts.email,
      status: 'active',
      is_admin: opts.isAdmin ?? false,
      tenant_id: opts.tenantId ?? FOUNDING_TENANT,
    }),
  });
  if (!profRes.ok) {
    await deleteUser(userId);
    throw new Error(`createUser profile: ${profRes.status} ${await profRes.text()}`);
  }
  return { userId, email: opts.email };
}

export async function deleteUser(userId: string) {
  await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${userId}`, {
    method: 'DELETE', headers: supaHeaders,
  });
  await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: 'DELETE', headers: supaHeaders,
  });
}

export async function generateMagicLink(email: string, redirectTo = REDIRECT_URL) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: supaHeaders,
    body: JSON.stringify({ type: 'magiclink', email, redirect_to: redirectTo }),
  });
  if (!res.ok) throw new Error(`generateMagicLink: ${res.status} ${await res.text()}`);
  const { action_link } = await res.json();
  return action_link as string;
}

type AuthFixtures = {
  authenticatedPage: Page;
  adminPage: Page;
};

export const test = base.extend<AuthFixtures>({
  authenticatedPage: async ({ page }, use) => {
    const email = `pw-${randomUUID().slice(0,8)}@example.test`;
    const { userId } = await createUser({ email });
    const link = await generateMagicLink(email);
    await page.goto(link);
    await page.waitForURL(/catalog\.html/);
    await use(page);
    await deleteUser(userId);
  },
  adminPage: async ({ page }, use) => {
    const email = `pw-admin-${randomUUID().slice(0,8)}@example.test`;
    const { userId } = await createUser({ email, isAdmin: true });
    const link = await generateMagicLink(email);
    await page.goto(link);
    await page.waitForURL(/(catalog|admin)\.html/);
    await use(page);
    await deleteUser(userId);
  },
});
export { expect };
```

**Verification:** a smoke spec that uses `authenticatedPage` and
asserts the page URL ends in `catalog.html` and
`window.TenantContext.source()` returns `'profile'`. Runs green
before any other spec.

### Change 3 — Tenant fixture (`fixtures/tenant.ts`, `global-setup.ts`, `global-teardown.ts`)

```ts
// tenant.ts
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY!;
const supaHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
};

export async function createTestTenant(slug: string, name: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/tenants`, {
    method: 'POST', headers: supaHeaders,
    body: JSON.stringify({ slug, name }),
  });
  if (!res.ok) throw new Error(`createTestTenant: ${res.status} ${await res.text()}`);
  const [row] = await res.json();
  return row.id as string;
}

export async function deleteTestTenant(id: string) {
  // ON DELETE CASCADE from tenants cleans up every dependent row.
  await fetch(`${SUPABASE_URL}/rest/v1/tenants?id=eq.${id}`, {
    method: 'DELETE', headers: supaHeaders,
  });
}
```

```ts
// global-setup.ts
import { createTestTenant } from './tenant';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

export default async function () {
  const slug = `pw-${randomUUID().slice(0,8)}`;
  const tenantId = await createTestTenant(slug, 'Playwright Test Tenant');
  writeFileSync('.pw-tenant.json', JSON.stringify({ id: tenantId, slug }));
}
```

```ts
// global-teardown.ts
import { deleteTestTenant } from './tenant';
import { readFileSync, unlinkSync, existsSync } from 'node:fs';

export default async function () {
  if (!existsSync('.pw-tenant.json')) return;
  const { id } = JSON.parse(readFileSync('.pw-tenant.json', 'utf8'));
  await deleteTestTenant(id);
  unlinkSync('.pw-tenant.json');
}
```

Specs that need the secondary tenant read `.pw-tenant.json` in a
`beforeAll` block. Simpler than a Playwright-fixture-level propagation
because globalSetup runs out-of-band from worker context.

**Verification:** run the empty suite once
(`npx playwright test --grep nothing-matches`); confirm
`.pw-tenant.json` is created and deleted, and that the tenant row
appears and disappears in the staging `tenants` table during the run.

### Change 4 — Catalog / shipment seed helpers (`fixtures/catalog.ts`)

```ts
const TEST_PREFIX = 'TEST_PW_';

export async function seedCatalogRow(tenantId: string, opts: {
  itemCode?: string;
  title?: string;
  distributor?: 'Lunar' | 'PRH';
  catalogMonth?: string;
  onSaleDate?: string;
  focDate?: string;
  priceUsd?: number;
  variantType?: string | null;
}) {
  const code = opts.itemCode ?? `${TEST_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/catalog`, {
    method: 'POST',
    headers: { ...supaHeaders, Prefer: 'return=representation' },
    body: JSON.stringify({
      item_code:     code,
      title:         opts.title ?? `Playwright Test Title ${code}`,
      distributor:   opts.distributor ?? 'Lunar',
      catalog_month: opts.catalogMonth ?? thisCatalogMonth(),
      on_sale_date:  opts.onSaleDate ?? null,
      foc_date:      opts.focDate ?? null,
      price_usd:     opts.priceUsd ?? 4.99,
      variant_type:  opts.variantType ?? 'Standard',
      tenant_id:     tenantId,
    }),
  });
  // ... error handling, return [row]
}

export async function seedPreorder(tenantId: string, userId: string, catalogId: string, qty = 1) { /* ... */ }
export async function seedWeeklyShipment(tenantId: string, catalogId: string, opts: { quantity?: number; onSaleDate?: string }) { /* ... */ }

export async function cleanupTestRows(tenantId?: string) {
  // delete preorders, weekly_shipment rows, catalog rows where item_code starts with TEST_PREFIX
  // tenantId filter optional — when present, scopes cleanup to a single tenant
}
```

**Verification:** seed three rows, fetch them back via REST, delete
them; run a count query, confirm zero TEST_PW_-prefixed rows in the
DB.

### Change 5 — Spec files (`tests/`)

Inventory listed in § In Scope item 3. Each spec follows a consistent
shape:

```ts
import { test, expect } from '../fixtures/auth';
import { seedCatalogRow, seedPreorder, cleanupTestRows } from '../fixtures/catalog';

test.describe('<flow name>', () => {
  test.beforeAll(async () => { /* seed shared rows */ });
  test.afterAll(async () => { await cleanupTestRows(); });

  test('<scenario>', async ({ authenticatedPage }) => {
    await authenticatedPage.goto('/catalog.html');
    // ... assertions
  });
});
```

The CLI session generates each file in numerical order. After each
spec is added, run **just that spec** (`npx playwright test
01-magic-link-arrival`) and confirm green before moving on. **If any
spec is red and the cause is a real bug in the app rather than a test
bug, stop and ask** per anti-drift rules — Phase 3.7 is test
infrastructure, not bug fixing.

The **tenant-isolation spec (07)** is the largest. Its outline:

```ts
test.describe('tenant isolation', () => {
  let tenantA: string;          // founding
  let tenantB: string;          // synthetic
  let userA: { id: string; email: string };
  let userB: { id: string; email: string };
  let catalogA: string;         // catalog row in tenant A
  let catalogB: string;         // catalog row in tenant B

  test.beforeAll(async () => {
    tenantA = process.env.FOUNDING_TENANT_ID!;
    tenantB = JSON.parse(readFileSync('.pw-tenant.json','utf8')).id;
    userA = await createUser({ email: '...', tenantId: tenantA });
    userB = await createUser({ email: '...', tenantId: tenantB });
    catalogA = (await seedCatalogRow(tenantA, { /* ... */ })).id;
    catalogB = (await seedCatalogRow(tenantB, { /* ... */ })).id;
    await seedPreorder(tenantA, userA.id, catalogA);
    await seedPreorder(tenantB, userB.id, catalogB);
  });

  test.afterAll(async () => {
    await deleteUser(userA.id);
    await deleteUser(userB.id);
    // tenantB and its data deleted in globalTeardown
    await cleanupTestRows(tenantA);
  });

  test('user A sees only tenant A catalog rows', async ({ page }) => {
    // log in as A via magic link; navigate catalog.html
    // assert seeded tenantA row visible; tenantB row not
  });

  test('user B sees only tenant B catalog rows', async ({ page }) => { /* mirror */ });

  test('user A mylist excludes tenant B preorders', async ({ page }) => { /* ... */ });

  test('weekly_shipment SELECT respects tenant (F15 regression)', async ({ page }) => {
    // seed a shipment row in tenantB; log in as A; arrivals.html shows nothing from it
  });

  test('get_popular_series returns only same-tenant counts (F20 regression)', async () => {
    // service-role RPC call simulating an authenticated session for each tenant;
    // assert returned counts only reflect that tenant's preorders
  });

  test('admin of tenant A cannot list tenant B users (F16/F34 surface)', async ({ adminPage }) => {
    // admin from tenant A navigates admin.html; user list contains userA, not userB
  });
});
```

### Change 6 — Refactor `upsertShipment` row builders + unit test

This change has two parts: a refactor of `import-staging.js` (local
script, outside repo), and a Node test that imports the refactored
helpers directly. The refactor lands first; the test depends on it.

#### 6a. Refactor `import-staging.js`

**Where:** local script at
`C:\Users\richa\OneDrive\Documents\(Work)\BookStop\catalogs\scripts\import-staging.js`.
CLI session emits the diff for the user to apply manually (same
pattern as 3.6 Change 2).

**Refactor target (current shape inside `upsertShipment`):**
- A `Map`-based Lunar row builder that dedupes by `(upc, on_sale_date)`
  and sums quantity for split shipment lines
- A straight `prhShipment.map(...)` PRH row builder
- Both reference the module-level `TENANT_ID` constant directly

**Refactor result:** two pure, exportable helpers at module scope.

**Diff (illustrative — CLI session re-reads file to pin exact line numbers):**

```javascript
// ── Shipment row builders (extracted for unit testing) ────────
//
// Both helpers are pure functions: same inputs in, same outputs out.
// tenantId is passed in explicitly rather than read from the module-
// level TENANT_ID, so tests can exercise them without monkey-patching.
// Production callers continue to pass TENANT_ID.

function buildLunarShipmentRows(lunarShipment, catalogMap, tenantId) {
  // Format A delivery invoices sometimes list the same ISBN on multiple
  // lines (split shipment entries). Postgres rejects two rows targeting
  // the same constraint key within a single batch, so we collapse here
  // before sending.
  const lunarMap = new Map();
  for (const r of lunarShipment) {
    if (!r.on_sale_date || !r.upc) continue;
    const key = `${r.upc}||${r.on_sale_date}`;
    const cat = catalogMap.get(`lunar:${r.upc}`);
    if (lunarMap.has(key)) {
      lunarMap.get(key).quantity += r.quantity;
    } else {
      lunarMap.set(key, {
        distributor:  r.distributor,
        item_code:    r.item_code,
        upc:          r.upc,
        catalog_id:   cat?.id || null,
        title:        r.title,
        price_usd:    r.price_usd ?? cat?.price_usd ?? null,
        quantity:     r.quantity,
        cover_url:    r.cover_url,
        on_sale_date: r.on_sale_date,
        tenant_id:    tenantId,
      });
    }
  }
  return [...lunarMap.values()];
}

function buildPrhShipmentRows(prhShipment, catalogMap, tenantId) {
  return prhShipment.map(r => {
    const cat = catalogMap.get(`prh:${r.item_code}`);
    return {
      distributor:  r.distributor,
      item_code:    r.item_code,
      upc:          r.upc,
      catalog_id:   cat?.id || null,
      title:        r.title,
      price_usd:    r.price_usd,
      quantity:     r.quantity,
      cover_url:    r.cover_url,
      on_sale_date: r.on_sale_date,
      tenant_id:    tenantId,
    };
  }).filter(r => r.on_sale_date && r.item_code);
}
```

Inside `upsertShipment`, the two inline blocks collapse to:

```javascript
async function upsertShipment(lunarShipment, prhShipment, catalogMap) {
  const lunarRows = buildLunarShipmentRows(lunarShipment, catalogMap, TENANT_ID);
  const prhRows   = buildPrhShipmentRows(prhShipment,   catalogMap, TENANT_ID);

  const totalRows = lunarRows.length + prhRows.length;
  console.log(`\n📦 Upserting ${totalRows} shipment rows ...`);
  // ... rest of the function unchanged: Lunar upsert loop, PRH
  //     delete-then-insert loop, summary stats
}
```

At the bottom of the file:

```javascript
// Guard the entry-point call so the file can be required() without
// auto-running the import (needed for unit tests).
if (require.main === module) {
  main().catch(err => {
    console.error('❌ Fatal error:', err.message);
    process.exit(1);
  });
}

module.exports = { buildLunarShipmentRows, buildPrhShipmentRows };
```

**Verification:**

1. **Direct invocation still works.** Re-run the script as the user
   normally would, with the most recent catalog and shipment files:
   ```powershell
   node import-staging.js "..\Lunar_Product_Data_MMYY.csv" "..\YYYY_MM_PRH_metadata_full_active.csv" "..\delivery-detail-LUNAR.csv" "..\Shipment_XXXXXX.csv"
   ```
   Expected: identical output to the pre-refactor run. All steps
   execute, including the new auto-fulfill from 3.6. No new errors.
2. **Shipment rows still carry tenant_id.** Quick post-run query:
   ```sql
   SELECT tenant_id, COUNT(*) FROM weekly_shipment
    WHERE created_at > now() - interval '5 minutes'
    GROUP BY tenant_id;
   -- Expected: one row, founding-tenant UUID, count > 0.
   ```
3. **`require()` does not auto-run.** Quick smoke:
   ```bash
   node -e "const m = require('./import-staging.js'); console.log(Object.keys(m));"
   # Expected: [ 'buildLunarShipmentRows', 'buildPrhShipmentRows' ]
   # The script must NOT print its "📂 Reading catalog files..." banner.
   ```

#### 6b. Unit test (`node-tests/import-tenant-id.test.mjs`)

```js
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildLunarShipmentRows, buildPrhShipmentRows } =
  require('../../import-staging.js');

const TENANT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

test('buildLunarShipmentRows: every row carries tenant_id', () => {
  const input = [
    { distributor: 'Lunar', item_code: null, upc: '9781234567890',
      on_sale_date: '2026-05-13', quantity: 2, title: 'A', cover_url: 'x',
      price_usd: null },
    { distributor: 'Lunar', item_code: null, upc: '9789876543210',
      on_sale_date: '2026-05-13', quantity: 1, title: 'B', cover_url: 'y',
      price_usd: null },
  ];
  const rows = buildLunarShipmentRows(input, new Map(), TENANT);
  assert.equal(rows.length, 2);
  for (const r of rows) assert.equal(r.tenant_id, TENANT,
    'Lunar row missing tenant_id — 2026-05-08 soak regression');
});

test('buildLunarShipmentRows: split shipment lines collapse and sum quantity', () => {
  // Two rows with same upc + on_sale_date should collapse into one
  // with summed quantity. Regression guard for the dedup behavior.
  const input = [
    { distributor: 'Lunar', item_code: null, upc: '9781111111111',
      on_sale_date: '2026-05-13', quantity: 2, title: 'C', cover_url: 'z',
      price_usd: null },
    { distributor: 'Lunar', item_code: null, upc: '9781111111111',
      on_sale_date: '2026-05-13', quantity: 3, title: 'C', cover_url: 'z',
      price_usd: null },
  ];
  const rows = buildLunarShipmentRows(input, new Map(), TENANT);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].quantity, 5);
  assert.equal(rows[0].tenant_id, TENANT);
});

test('buildPrhShipmentRows: every row carries tenant_id', () => {
  const input = [
    { distributor: 'PRH', item_code: 'AUG260001', upc: '12345',
      on_sale_date: '2026-05-13', quantity: 1, title: 'D', cover_url: 'w',
      price_usd: 4.99 },
  ];
  const rows = buildPrhShipmentRows(input, new Map(), TENANT);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tenant_id, TENANT,
    'PRH row missing tenant_id — 2026-05-08 soak regression');
});

test('buildPrhShipmentRows: rows without item_code or on_sale_date are filtered', () => {
  // Defensive filter regression guard — existing behavior of the helper.
  const input = [
    { distributor: 'PRH', item_code: null,         upc: 'a', on_sale_date: '2026-05-13', quantity: 1, title: 'E' },
    { distributor: 'PRH', item_code: 'AUG260002',  upc: 'b', on_sale_date: null,         quantity: 1, title: 'F' },
    { distributor: 'PRH', item_code: 'AUG260003',  upc: 'c', on_sale_date: '2026-05-13', quantity: 1, title: 'G', price_usd: 4.99 },
  ];
  const rows = buildPrhShipmentRows(input, new Map(), TENANT);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].item_code, 'AUG260003');
});

test('buildLunarShipmentRows: catalog_id is wired in when catalogMap has a match', () => {
  // Cross-check the catalogMap lookup behavior survives the refactor.
  const input = [
    { distributor: 'Lunar', item_code: null, upc: '9782222222222',
      on_sale_date: '2026-05-13', quantity: 1, title: 'H' },
  ];
  const map = new Map([[`lunar:9782222222222`, { id: 'catalog-uuid-here' }]]);
  const rows = buildLunarShipmentRows(input, map, TENANT);
  assert.equal(rows[0].catalog_id, 'catalog-uuid-here');
});
```

**Verification:**

1. `node --test node-tests/` from the playwright folder — expect 5
   passing tests.
2. **Mutated-script red check:** temporarily edit
   `import-staging.js` to remove `tenant_id: tenantId` from the Lunar
   builder. Re-run `node --test`. Expect failure with the documented
   error message ("Lunar row missing tenant_id — 2026-05-08 soak
   regression"). Restore.
3. **Mutated-script red check, PRH side:** same but on the PRH
   builder. Restore.


### Change 7 — Runner script (`run-smoke.ps1`)

```powershell
param([switch]$Headed)

# OneDrive marks synced .ps1 files as "downloaded from internet" -
# self-unblock so we don't have to remember to do it manually.
try { Unblock-File $PSCommandPath -ErrorAction SilentlyContinue } catch {}

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $ScriptDir

try {
  # Load .env (one folder up - shared with test-magic-link.ps1)
  $envFile = Join-Path (Split-Path -Parent $ScriptDir) '.env'
  if (-not (Test-Path $envFile)) {
    Write-Host "ERROR: .env not found at $envFile" -ForegroundColor Red
    exit 1
  }
  Get-Content $envFile | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
      $parts = $line -split '=', 2
      [Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim(), 'Process')
    }
  }

  if ($env:SUPABASE_URL -match 'plgegklqtdjxeglvyjte') {
    Write-Host "ERROR: SUPABASE_URL points at production. Aborting." -ForegroundColor Red
    exit 1
  }

  Write-Host ""
  Write-Host "=== PULLLIST smoke suite ===" -ForegroundColor Cyan

  Write-Host "`n[1/2] Import script regression tests..." -ForegroundColor Cyan
  & node --test node-tests/
  if ($LASTEXITCODE -ne 0) { Write-Host "Node tests failed - skipping Playwright" -ForegroundColor Red; exit 1 }

  Write-Host "`n[2/2] Playwright suite..." -ForegroundColor Cyan
  $args = @()
  if ($Headed) { $args += '--headed' }
  & npx playwright test @args
  $pwExit = $LASTEXITCODE

  Write-Host "`n=== Done ===" -ForegroundColor Cyan
  if ($pwExit -eq 0) {
    Write-Host "All smoke tests passed. Safe to push." -ForegroundColor Green
  } else {
    Write-Host "Playwright failures. Inspect playwright-report\index.html before pushing." -ForegroundColor Red
  }
  exit $pwExit
}
finally {
  Pop-Location
}
```

**Verification:** run `.\run-smoke.ps1` after the suite is fully
populated; expect green output and exit code 0. Run with `-Headed`
once to confirm the browser actually appears (sanity check that the
runner isn't lying about success).

### Change 8 — Local README (`playwright/README.md`)

Lives in scripts folder; never committed. Documents:
- `.env` keys (point at the shared `.env`, same one
  `test-magic-link.ps1` uses)
- How to run (`.\run-smoke.ps1`)
- How to run a single spec (`npx playwright test 04-arrivals`)
- The per-run synthetic-tenant pattern, including how to clean up
  manually if a globalTeardown is skipped (the `.pw-tenant.json`
  fallback)
- Rule: no spec writes to founding-tenant rows outside its own
  TEST_PW_-prefixed seed data
- Pointer back to `docs/phase-3.7-playwright-smoke-tests.md` in the
  repo for the canonical spec inventory

### Change 9 — Repo documentation updates

Listed in § In Scope item 7. CLI session generates these as the final
commit pass on the `feature/3.7-playwright-smoke-tests` branch.

The repo commit contains **only** the docs updates:
- `CLAUDE.md` (Current Migration Phase + Standard Deployment Workflow
  + optional new § Smoke Test Suite section per PENDING decision)
- `docs/phase-3-tenant-resolution.md` (Sub-Deploys table + Phase
  Completion Criteria)
- `docs/phase-3.7-playwright-smoke-tests.md` (this plan, marked
  Complete at the end of the session)

**No code files are committed.** The Playwright suite, fixtures,
specs, runner script, and node_modules all live in the local scripts
folder per the local-only decision.

---

## Execution Sequence

Strict order. The CLI session does not skip ahead. **If the session is
running long after Change 5 spec 04, it is safe to stop, commit the
docs scaffolding as 3.7a, and continue with specs 05–07 + Node test +
runner + final docs as 3.7b in a follow-up session.** The auth and
catalog/mylist coverage (specs 01–03) plus the import regression test
are independently valuable and can ship without the tenant-isolation
spec if needed — though tenant isolation is the criterion gate, so
**3.7b must ship to close Phase 3**.

1. **Pre-flight P1–P8.** Stop if any fails.
2. Change 1: scaffold the Playwright project. Run `npx playwright test
   --list` to confirm config is valid.
3. Change 2: write `fixtures/auth.ts`. Write a one-off
   `tests/00-fixture-sanity.spec.ts` that uses `authenticatedPage` and
   asserts the URL ends in `catalog.html`. Run it. Delete the sanity
   spec after green.
4. Change 3: write `fixtures/tenant.ts`, `global-setup.ts`,
   `global-teardown.ts`. Run an empty test (`npx playwright test
   --grep zzz`) to confirm the synthetic tenant is created and
   destroyed.
5. Change 4: write `fixtures/catalog.ts`. Add a sanity spec that seeds
   and cleans up a single row. Run. Confirm green.
6. Change 5 spec 01 (magic-link-arrival). Run alone. Green or stop.
7. Change 5 spec 02 (catalog-reserve-mylist). Run alone. Green or stop.
8. Change 5 spec 03 (mylist-cancel-guards). Run alone. Green or stop.
9. Change 5 spec 04 (arrivals-this-week — the 5/6 regression). Run
   alone. **Green confirms the regression coverage works.**
10. Change 6a: refactor `import-staging.js`. CLI session generates
    the diff; user applies to local script. **User runs the script
    end-to-end against staging** with the most recent catalog + at
    least one shipment file. Confirm output matches the pre-refactor
    run and `weekly_shipment` rows still carry `tenant_id`. Confirm
    `node -e "require('./import-staging.js')"` does not auto-run main.
    **If the script behaves any differently than before, stop — the
    refactor is supposed to be pure structural.**
11. Change 6b: write the Node unit test. Run with
    `node --test node-tests/`. Confirm 5 green. Run the two mutated-
    script red checks (Lunar side, PRH side) to prove the suite
    catches the regression it's designed to catch. Restore.
12. **(Optional 3.7a/3.7b split point.)** If session is at capacity,
    commit docs scaffolding (CLAUDE.md note that 3.7a is partial,
    parent plan unchanged), push, stop. Continue in fresh session.
    3.7a-shippable surface: fixtures + specs 01–04 + the refactor +
    Node test. 3.7b owns: specs 05–07, runner, README, final docs.
13. Change 5 spec 05 (subscriptions). Run alone. Green or stop.
14. Change 5 spec 06 (admin-this-week-bagging). Run alone. Green or
    stop.
15. Change 5 spec 07 (tenant-isolation, F15 + F20 subtests only). Run
    alone. **Green here is the Phase 3 completion gate.** Stop and
    ask if any sub-test surfaces a real isolation bug — that's a
    finding for the pre-Phase-4 hardening pass, not something 3.7
    fixes inline.
16. Change 7: runner script. Run full suite via `.\run-smoke.ps1`.
    Expect all green, exit 0.
17. Change 8: README in scripts folder.
18. Change 9: repo docs commit on `feature/3.7-playwright-smoke-tests`.
    Suggested commit message:
    ```
    feat(3.7): document Playwright smoke suite; mark Phase 3 complete

    Suite itself lives in the local scripts folder per the
    local-testing-stays-local convention; only docs touch the repo.
    The 3.7 import-staging.js refactor (extracted upsertShipment row
    builders) is queued for production in CLAUDE.md § Known Out-of-
    Scope Items as a Phase 4 cutover prerequisite.
    ```
19. Merge to `staging`, push to GitHub Pages staging. No site
    behavior change expected — this is a docs-only repo commit.
20. Status update per anti-drift rules; update CLAUDE.md § Current
    Migration Phase to "Phase 3 complete; Phase 4 queued (production
    migration)".

---

## Post-execution verification

After the session closes, on the developer's local workstation:

1. **Full suite green from runner**
   ```powershell
   cd <scripts folder>\playwright
   .\run-smoke.ps1
   ```
   Expected: `All smoke tests passed. Safe to push.` Exit code 0.

2. **Suite refuses to run against production**
   Temporarily edit `.env` to point `SUPABASE_URL` at the prod URL.
   Re-run `.\run-smoke.ps1`. Expected: aborts with
   "ERROR: SUPABASE_URL points at production." Restore `.env`.

3. **Suite catches a deliberate regression** (one-time confidence
   check, not part of normal runs)
   - Mutate `app.js` locally so `Preorders.cancel` skips the fulfilled
     guard. Spec 03 should fail. Restore.
   - Mutate `import-staging.js` locally to remove the PRH
     `tenant_id: TENANT_ID` from `upsertShipment`. Node test should
     fail with the documented error message. Restore.
   - Mutate the F15 RLS policy back to `qual = true` in a staging-
     only SQL editor session. Spec 07 weekly_shipment subtest should
     fail. **Restore the policy.**
   If all three regressions are caught, the suite is doing its job.

4. **Synthetic tenant teardown verified clean**
   ```sql
   SELECT COUNT(*) FROM tenants WHERE slug LIKE 'pw-%';
   -- Expected: 0 after a clean run.
   SELECT COUNT(*) FROM catalog WHERE item_code LIKE 'TEST_PW_%';
   -- Expected: 0.
   SELECT COUNT(*) FROM user_profiles WHERE email LIKE 'pw-%@example.test';
   -- Expected: 0.
   ```
   If any are non-zero after a green run, a teardown is leaking.
   File as a follow-up; don't try to fix inline.

5. **Documentation grep**
   ```bash
   grep -n "3.7" CLAUDE.md docs/phase-3-tenant-resolution.md
   grep -n "Phase 3 complete\|Phase 4" CLAUDE.md
   ```
   Confirm both 3.7 status flips and the Phase 3 → Phase 4 transition
   wording landed.

---

## Completion Criteria

Phase 3.7 is complete when **all** of the following are true:

- [ ] Playwright project exists at `<scripts folder>\playwright\` with
      `playwright.config.ts`, `package.json`, `node_modules/`
      installed, chromium installed.
- [ ] All four fixture files exist and pass their own sanity checks.
- [ ] All seven Playwright specs exist and pass individually.
- [ ] Spec 07 (tenant isolation) passes including the F15 and F20
      subtests. F16 and F34 explicitly deferred — not asserted here.
- [ ] `import-staging.js` refactored: `buildLunarShipmentRows` and
      `buildPrhShipmentRows` are named, exported helpers;
      `main()` is wrapped in `if (require.main === module)`;
      `module.exports` is present at the bottom of the file.
- [ ] Refactored `import-staging.js` runs end-to-end against staging
      with identical observable output to the pre-refactor run; new
      `weekly_shipment` rows carry `tenant_id` correctly.
- [ ] The Node unit test exists with 5 cases (Lunar tenant_id, Lunar
      split-line dedup, PRH tenant_id, PRH filter, Lunar catalog_id
      wiring) and all pass; both mutated-script red checks have been
      demonstrated.
- [ ] `CLAUDE.md` § Known Out-of-Scope Items updated with a new bullet
      under the `import.js` (production) cutover patch list, queueing
      the same row-builder refactor for prod.
- [ ] `run-smoke.ps1` runs the full suite end-to-end, refuses to run
      against production, exits 0 on green, non-zero on red.
- [ ] `playwright/README.md` exists in the local scripts folder.
- [ ] Synthetic tenant cleanup verified: zero `pw-%` rows in
      `tenants`, zero `TEST_PW_%` rows in `catalog`, zero `pw-%`
      profiles, after a clean run.
- [ ] `CLAUDE.md` § Current Migration Phase reflects Phase 3 complete
      and Phase 4 queued.
- [ ] `CLAUDE.md` § Standard Deployment Workflow includes the new
      `run-smoke.ps1` pre-push step.
- [ ] `docs/phase-3-tenant-resolution.md` Sub-Deploys table marks 3.7
      Complete with date.
- [ ] `docs/phase-3-tenant-resolution.md` Phase Completion Criteria
      reflects the smoke suite passing and tenant isolation verified.
- [ ] `docs/phase-3.7-playwright-smoke-tests.md` committed (this
      file), with Status updated to Complete at the end.
- [ ] Repo commit on `feature/3.7-playwright-smoke-tests` merged to
      `staging`; `staging:main` pushed to GitHub Pages staging; smoke
      suite run one more time against the freshly deployed staging
      site and green.
- [ ] Status update produced per anti-drift rules.

---

## Carry-forward / Notes

Items observed during planning that are intentionally **not**
addressed in 3.7. Recorded so they don't get lost.

- **CI integration** — a future sub-deploy could add a GitHub Actions
  workflow that runs the same suite. Considerations: secret storage
  for the service-role key (GitHub Actions secrets are adequate),
  staging-only enforcement at the runner level, run cadence (on PR to
  `staging`? on push? scheduled nightly?). Not blocking Phase 4.
- **F16 and F34 hardening** — explicitly deferred from spec 07. F16
  needs a focused look at the `preorders` admin write policies (OR-
  permit pattern); F34 needs an audit of Edge-Function tenant
  resolution across all eight functions. Both belong with the broader
  grants-and-policies audit already queued in `technical-reference.md`
  § 13 as a pre-Phase-4 prerequisite.
- **Analytics views smoke tests** — Phase 3.4 rebuilt the eight
  `analytics_*` views with `current_tenant_id()` filters; spec 07
  could be extended to assert each view returns zero rows for the
  synthetic tenant after that tenant is logged in. Carry-forward.
- **Visual regression on the bagging-list print layout** — once the
  print stylesheet shipped in 3.6 has been used in anger for a few
  weeks, snapshot regression testing might be worth adding. Not
  earned its place yet.
- **`analytics.html` and `forgot-password.html` coverage** — F32 in
  `technical-reference.md` flags both pages as missing from CLAUDE.md
  page inventory. They're real pages; specs would be welcome. Not in
  3.7 because Phase 3 didn't touch either of them.
- **Production smoke suite** — explicit non-goal. If the production
  story ever changes, the suite's `SUPABASE_URL` guard would be the
  first thing to revisit.

---

## Reference

- Parent: `docs/phase-3-tenant-resolution.md`
- Schema canonical: `docs/technical-reference.md` — § 3 (multi-
  tenancy model), § 4 (tables and constraints), § 7 (RLS policy
  summary; spec 07 asserts behavior described here), § 10
  (`app.js` API surface; specs assert on observable behavior of
  these objects), § 13 (findings F15, F16, F20, F34 — the HIGH set
  spec 07 exercises).
- Auth pattern reused from `<scripts folder>\test-magic-link.ps1`.
- Catalog/preorder seeding pattern adapted from
  `<scripts folder>\test-this-week.ps1`.
- Sibling sub-deploy template: `docs/phase-3.6-admin-wednesday-
  tooling.md` (this plan adopts its shape).
- `CLAUDE.md` § Anti-Drift Rules — followed throughout this plan.
- `CLAUDE.md` § Known Issues & Gotchas — OneDrive Unblock-File rule
  honored in `run-smoke.ps1`.
- 2026-05-06 soak entry in parent plan § Discovered During Soak
  (arrivals.html orphan-reserved) — regression covered by spec 04.
- 2026-05-08 soak entry in parent plan § Discovered During Soak
  (`weekly_shipment` tenant_id) — regression covered by the Node
  test.

---

**Plan written:** 2026-05-12
**Plan author session:** chat (Opus)
**Execution session target:** Claude Code CLI on local workstation
(both the staging repo for docs commits AND the local scripts folder
for the suite itself + the `import-staging.js` refactor)
**Decisions locked:** folder name `scripts/playwright/`; CLAUDE.md gets
a new § Smoke Test Suite (local) section; spec 07 covers F15 + F20
only (F16, F34 deferred to pre-Phase-4 hardening); `upsertShipment`
row builders refactored into exported helpers as part of 3.7.
**Scope expansion note:** the import-script refactor is a code change
to a load-bearing local script. The user explicitly chose to bundle
it with 3.7 rather than queue it as a follow-up. Mitigations: refactor
is pure extract-function (no behavior change); CLI session must run
the script end-to-end against staging post-refactor before the Node
test is written; 3.7a/3.7b split point in Execution Sequence sits
after the refactor + Node test land, so the refactor is part of the
minimum-shippable 3.7a if a split is needed.

---

**2026-05-15 update (post 3.8 hardening):** Spec 04 was rewritten in
3.8 to assert Mon-Sun calendar-week semantics (boundary days +
badge↔arrivals consistency), replacing the original Wed-only assertion
documented in the spec table above. `test-this-week.ps1` was refactored
in parallel and gained a `-BoundaryTest` mode that seeds the same
boundary scenarios manually. The Playwright spec is the CI gate; the
PowerShell helper is the manual exploration tool — they cover the
same ground from two angles. No other 3.7 deliverables were affected.