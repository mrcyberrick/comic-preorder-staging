# Phase 3 — Tenant Resolution

**Status:** In progress — 3.8 hardening (base 3.1–3.7 complete 2026-05-13)
**Branch base:** `staging`
**Started:** 2026-05-01
**Estimated total duration:** 3–6 weekend sessions across all four sub-deploys
**Customer impact:** None (staging only, production untouched)

This is the parent plan for Phase 3 of the multi-tenancy migration. It is
intentionally a thin coordinator — most detail lives in the per-sub-deploy
plan files. Read this file first to orient, then read the active sub-deploy
plan for the work currently in progress.

---

## Goal

Phase 1 added the multi-tenant schema. Phase 2 made the import script and
Edge Functions tenant-aware. Phase 3 makes the **app code** tenant-aware:
the app explicitly resolves which tenant it is serving on every page load
and passes that context into every write. By the end of Phase 3, the
column-default safety net established in Phase 1 can be removed because
nothing in the system relies on it anymore.

After Phase 3, adding a second real tenant is a configuration change
(insert a row, update a slug map), not a code change.

---

## Approach Decision

Tenant resolution uses a **query parameter** (`?t=<slug>`) for pre-login
visitors, with the authenticated user's `user_profiles.tenant_id` as the
source of truth once logged in. The parameter is persisted to
`sessionStorage` so it survives navigation within a tab.

The slug→id mapping is hardcoded in `app.js` until there is a real second
tenant on the system. Premature abstraction (a public RPC, a database
lookup) is worse than a single-line map for a problem that doesn't yet
exist. Sub-deploy 3.1's plan documents this choice in detail.

When a second real customer joins the platform, revisit subdomain-based
resolution as its own focused project — DNS, Cloudflare, custom domains
all get done together properly. Phase 3 does not attempt that.

---

## Sub-Deploys

Phase 3 is broken into four sub-deploys. Each has its own plan file,
written **after** the previous sub-deploy completes so it can incorporate
what was learned. Plans for sub-deploys not yet started intentionally do
not exist — write them when their turn comes, not before.

| #   | Title                                              | Plan                                          | Status      | Completed   |
|-----|----------------------------------------------------|-----------------------------------------------|-------------|-------------|
| 3.1 | Tenant resolution layer (read-only)                | `phase-3.1-tenant-resolution-layer.md`        | Complete    | 2026-05-02  |
| 3.2 | Explicit tenant_id on app.js writes                | `phase-3.2-explicit-tenant-writes.md`         | Complete    | 2026-05-04  |
| 3.3 | Remove column defaults                             | `phase-3.3-remove-column-defaults.md`         | Complete    | 2026-05-05  |
| 3.4 | Analytics views rebuild                            | `phase-3.4-analytics-rls-and-drop-views.md`   | Complete    | 2026-05-07  |
| 3.5 | Usage events purge job (90-day retention)          | `phase-3.5-usage-events-purge.md`             | Complete    | 2026-05-10  |
| 3.6 | Admin operational tooling — Wednesday workflow     | `phase-3.6-admin-wednesday-tooling.md`        | Complete    | 2026-05-11  |
| 3.7 | Smoke test automation (Playwright)                 | `phase-3.7-playwright-smoke-tests.md`         | Complete    | 2026-05-13  |
| 3.8 | Pre-Phase-4 hardening: "This Week" rule alignment  | `phase-3.8-pre-phase-4-hardening.md`          | Planning    | —           |

Each sub-deploy ends in a working state, smoke-testable, reversible.
**Do not bundle multiple sub-deploys into one session.** See the
anti-drift rules in `CLAUDE.md` for why.

### Status values

| Status        | Meaning                                                                                  |
|---------------|------------------------------------------------------------------------------------------|
| **Planning**  | Plan file exists, not yet executed. Active sub-deploy if it's the only row at this state.|
| **In progress** | Execution started in some session, not yet complete. Carries forward to next session.  |
| **Complete**  | All completion criteria met, merged to staging, smoke-tested. Date filled in.            |
| **Pending**   | Not started, plan not yet written.                                                       |

At any given time, exactly one row is in **Planning** or **In progress** —
that row is the active sub-deploy. If two rows are simultaneously active,
something has gone wrong with sequencing.

### Updating this table

When a sub-deploy completes:
1. Change its status to **Complete** and add the date
2. Write the plan for the next sub-deploy as a new file
3. Update the next row's Plan column to reference the new file
4. Update the next row's status to **Planning**
5. Update the **Active sub-deploy** in `CLAUDE.md` § Current Migration Phase

---

## In Scope for Phase 3

- Reading tenant from URL query parameter and from authenticated user profile
- A `TenantContext` module in `app.js` as the single source of truth
- Making writes (preorders, subscriptions, profile inserts) pass `tenant_id` explicitly
- Removing column defaults from `tenant_id` columns once explicit writes are confirmed working
- Rebuilding the five `analytics_*` views to filter by `current_tenant_id()`

## Out of Scope for Phase 3

These are real work items but not part of this phase. Each becomes its own phase later.

- **Self-service tenant signup** — Phase 4 builds the public flow for a new
  bookstore to register, claim a slug, and configure their account
- **Per-tenant branding rendering** — `tenants.branding` jsonb column exists
  but no UI reads it. Adding logo / primary color / store name display is a
  separate phase that depends on real-tenant content to design against
- **Subdomain-based routing** — Revisit when there's a second tenant. DNS,
  wildcard certs, Cloudflare, custom domains are infrastructure work that
  doesn't belong mixed into a code refactor
- **Production deploys** — Production still has the pre-multitenancy schema.
  All Phase 1, 2, and 3 work has been staging-only. Production migration
  becomes its own phase once Phase 3 has soaked on staging
- **Edge Function business logic changes** — Phase 2 made them tenant-aware.
  No further Edge Function work in Phase 3. URL fixes or other changes are
  out of scope unless they block a sub-deploy
- **`import.js` (production)** — Do NOT modify until production gets Phase 1.
  The staging script (`import-staging.js`) is the only patched copy

If something seems related but isn't on the IN scope list above, **stop and
ask** per the anti-drift rules in `CLAUDE.md`. Phase 2 ended with two
inline URL fixes that were correct but bundled scope creep into a session
that should have been pure tenant-awareness work. Don't repeat that.

---

## Phase Completion Criteria

Phase 3 is complete when **all** of the following are true on staging:

- [x] All sub-deploys in the Sub-Deploys table above marked Complete
- [x] `app.js` writes all pass `tenant_id` explicitly (verifiable by `grep`)
- [x] All `tenant_id` column defaults removed from the database (verifiable by `\d <table>`)
- [x] Analytics views all filter by `current_tenant_id()` (verifiable by `pg_get_viewdef`)
- [x] A test second tenant inserted via SQL is fully isolated from Ray & Judy's
      data in every analytics view, every page query, and every admin tool
      (verified by Playwright spec 07 — F15 and F20 subtests green 2026-05-13)
- [x] No regression in customer or admin smoke tests
      (Playwright suite 13/13 green 2026-05-13)
- [x] `CLAUDE.md` § Current Migration Phase updated to reflect Phase 3 complete
      and the next phase queued
- [x] All sub-deploy plan files committed to `docs/`

---

## Carry-Forward From Phase 2

These items were noted in `phase-2-completion.md` as deferred to Phase 3:

1. **Analytics views un-scoped** — Addressed by sub-deploy 3.4
2. **App code writes don't pass tenant_id explicitly** — Addressed by sub-deploy 3.2
3. **Admin preorders DB-side month filter** — Still deferred. Not part of Phase 3
   per the user's earlier decision. Carry forward to whichever phase chooses to
   pick up small-cleanup work
4. **Column defaults still load-bearing** — Addressed by sub-deploy 3.3 (removal
   happens after 3.2 makes them unnecessary)

---

## Discovered During Soak

**2026-05-06 — arrivals.html: orphan-reserved preorders silently dropped (post-3.3 soak)**

Bug discovered via `test-this-week.ps1` during 3.3 soak. When a user has
preorders for "this Wednesday" whose catalog rows have no corresponding
row in `weekly_shipment`, the page silently dropped them — even though
the nav bubble, mylist.html "Upcoming Arrivals", and admin "This Week"
tab all showed them correctly.

Root cause: `arrivals.html` enters "full shipment mode" if any rows
exist in `weekly_shipment` for thisWednesday, then iterates over
shipment rows to find user-reserved matches. Preorders whose catalog
isn't represented in shipment had no match path.

This pre-dates Phase 3 and isn't a regression from 3.3. It surfaced
because the new test tooling created the first scenario where a user
reserved items dated for thisWednesday that weren't in shipment.

Fix applied inline as part of 3.3 soak (same precedent as 3.1
`initNav()` resolve and 3.3 `archive_stale_reservations` patches).
Added `orphanReserved` computation in arrivals.html that finds
preorders not represented in shipment and merges them with shipment-
matched reservations into `myRowsCombined`. Five touchpoints in
arrivals.html updated to render from the combined list.

**2026-05-08 — import-staging.js: weekly_shipment writes missing tenant_id (post-3.4 soak)**

Bug discovered during routine staging import after Phase 3.3 removed
`tenant_id` column defaults. Running
`node import-staging.js <lunar.csv> <prh.csv> <ship1> <ship2>` fails
in the shipment-upsert step with `null value in column "tenant_id"
of relation "weekly_shipment" violates not-null constraint` for both
the Lunar and PRH batches.

Root cause: when Phase 2 made the import script tenant-aware, the two
row builders in `upsertShipment()` were missed. Catalog upsert and
auto-reserve writes were correctly patched (they pass `tenant_id`),
but the two `weekly_shipment` row-object literals — one for Lunar
shipment rows (around line 425), one for PRH (around line 442) —
were never updated. The Phase 1 column default masked the gap; Phase
3.3's removal of that default exposed it.

This should have been caught by Phase 3.3's V5b verification ("Test
full import with shipments"). V5b was marked optional in the 3.3
plan because shipment files weren't readily available at verification
time, so the test was skipped. The cost of skipping was a soak-period
regression that surfaced when shipment files next arrived.

Fix applied inline as part of soak hot-fix (same precedent as the
arrivals.html and archive_stale_reservations 3.3 patches): added
`tenant_id: TENANT_ID` to both row-object literals in
`upsertShipment()`. The `TENANT_ID` constant was already defined at
the top of the file from earlier Phase 2 work — no new constants
introduced.

Files changed:
- `import-staging.js` (local scripts folder, not in repo) — two
  one-line additions, same lexical position relative to the existing
  fields, no other changes

Verification: re-ran the failing import command with the same CSVs
and shipment files; both Lunar and PRH batches succeeded; sanity
check on `weekly_shipment` confirmed all new rows have
`tenant_id = '72e29f67-...'`.

Architectural notes for later (logged here, not actioned in 3.4):

- The PRH delete-then-insert path in `upsertShipment()` issues a
  service-role DELETE filtered only by `distributor=eq.PRH` and
  `on_sale_date=eq.<date>`. With service role the DELETE bypasses
  RLS; with a second tenant on the system, this would silently
  delete the other tenant's PRH shipment for the same date. Same
  issue exists in `buildCatalogIdMap()` — service-role catalog
  lookups don't filter by tenant, so cross-tenant rows could match.
  Both belong in the same future hardening pass as Finding E from
  the 3.4 plan (overly-broad table grants). One sentence each
  noted; no action this session.

- `import.js` (production) has the same `weekly_shipment` gap baked
  in. Per the existing rule "DO NOT modify until production gets
  Phase 1 schema," the prod script is not patched. When production
  migration begins (Phase 4), prod `import.js` needs the same two-
  line patch before its first run.

## Reference

- Active sub-deploy plan: see the Sub-Deploys table above
- Anti-drift rules: `CLAUDE.md` § Anti-Drift Rules for Agentic Sessions
- Phase 2 completion notes: `docs/phase-2-completion.md`
- Phase 1 plan and completion: `docs/phase-1-schema-migration.md`
- Pre-multitenancy baseline: `docs/pre-multitenancy-state.md`
- Schema reference (canonical): `docs/technical-reference.md`
- Founding tenant UUID: `72e29f67-39f7-42bc-a4d5-d6f992f9d790` (also in `CLAUDE.md`)

---

**2026-05-11 — Phase 3.6 hot-fixes bundled at sub-deploy boundary**

Two bugs documented in CLAUDE.md as deferred to 3.6 were fixed as part
of the admin operational tooling sub-deploy. Promoted from "Known Out-
of-Scope" to fixed findings in `docs/technical-reference.md`:

1. **Customer can DELETE a fulfilled preorder via `Preorders.cancel`** —
   added a pre-DELETE fulfilled-check in `app.js` plus a defensive
   `.eq('fulfilled', false)` filter on the DELETE itself. `mylist.html`
   replaces the per-row Remove button with an "✓ In hand" chip when
   `fulfilled = true`, mirroring the existing FOC-lock pattern. Both
   layers — UI and API — protect the audit trail. (F37)

2. **admin.html label/input a11y warning** — six inputs (`deadline-input`,
   `admin-search`, `paper-new-name`, `paper-catalog-search`,
   `invite-name`, `invite-email`) now have `<label for="...">`
   associations. Inputs whose visible text was rendered as `<span>` now
   render as `<label>`; placeholder-only inputs received hidden labels.
   `.visually-hidden` utility class added to `style.css`. (F38)

Phase 3.6 also introduced `auto_fulfill_past_on_sale(uuid)`, a new
SECURITY DEFINER SQL function called by `import-staging.js` at the end
of each weekly run. It marks preorders fulfilled when their on-sale
date has passed, treating them as in-hand at the store. The manual
bulk-fulfill-by-title path remains for pre-FOC rush orders.

The admin.html This Week tab was rewritten as a bagging list with
per-customer cards, checkboxes, week navigation (Prev/Today/Next), a
Print Bagging List button, and per-customer "your books are in" email.

Files changed:
- `docs/sql/auto_fulfill_past_on_sale.sql` (new)
- `app.js` (`Preorders.cancel` guard)
- `mylist.html` (cancel UI mirrors FOC-lock pattern, adds "In hand" chip)
- `admin.html` (This Week tab rewrite + a11y labels + week nav + print)
- `style.css` (print rules + `.visually-hidden` utility)
- `import-staging.js` (local scripts folder; new Step 9 added by user)

**Last updated:** 2026-05-11 (sub-deploy 3.6 complete)