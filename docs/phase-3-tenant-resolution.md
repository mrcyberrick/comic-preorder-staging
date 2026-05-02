# Phase 3 — Tenant Resolution

**Status:** In progress (sub-deploy 3.1 active)
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

| #   | Title                                | Plan                                          | Status      | Completed   |
|-----|--------------------------------------|-----------------------------------------------|-------------|-------------|
| 3.1 | Tenant resolution layer (read-only)  | `phase-3.1-tenant-resolution-layer.md`        | Complete    | 2026-05-02  |
| 3.2 | Explicit tenant_id on app.js writes  | (not yet written — pending soak)              | Pending     | —           |
| 3.3 | Remove column defaults               | (not yet written — pending 3.2 completion)    | Pending     | —           |
| 3.4 | Analytics views rebuild              | (not yet written — pending 3.3 completion)    | Pending     | —           |

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

- [ ] All four sub-deploys (3.1, 3.2, 3.3, 3.4) marked Complete in the table above
- [ ] `app.js` writes all pass `tenant_id` explicitly (verifiable by `grep`)
- [ ] All `tenant_id` column defaults removed from the database (verifiable by `\d <table>`)
- [ ] Analytics views all filter by `current_tenant_id()` (verifiable by `pg_get_viewdef`)
- [ ] A test second tenant inserted via SQL is fully isolated from Ray & Judy's
      data in every analytics view, every page query, and every admin tool
- [ ] No regression in customer or admin smoke tests
- [ ] `CLAUDE.md` § Current Migration Phase updated to reflect Phase 3 complete
      and the next phase queued
- [ ] All sub-deploy plan files committed to `docs/`

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

## Reference

- Active sub-deploy plan: see the Sub-Deploys table above
- Anti-drift rules: `CLAUDE.md` § Anti-Drift Rules for Agentic Sessions
- Phase 2 completion notes: `docs/phase-2-completion.md`
- Phase 1 plan and completion: `docs/phase-1-schema-migration.md`
- Pre-multitenancy baseline: `docs/pre-multitenancy-state.md`
- Schema reference (canonical): `docs/technical-reference.md`
- Founding tenant UUID: `72e29f67-39f7-42bc-a4d5-d6f992f9d790` (also in `CLAUDE.md`)

---

**Last updated:** 2026-05-01 (initial parent plan + sub-deploy 3.1 active)