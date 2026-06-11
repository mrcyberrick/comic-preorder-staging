# Phase 4 — Production Migration

**Status:** **Complete** — 4.0–4.8 complete; completion audit closed 2026-06-10; all Phase Completion Criteria ticked
**Branch base:** `staging` (4.0, 4.1) → `feat/phase-4-prod-cutover` off `main` in the production repo (4.2–4.7)
**Started:** 2026-05-24 (planning)
**Estimated total duration:** 4–6 weekend sessions for 4.0/4.1 staging prep; one coordinated weekend window for 4.2–4.6 cutover; one calendar week of post-cutover soak (4.7)
**Customer impact:** None during 4.0/4.1 (staging only). Production customers see the maintenance banner for the duration of the cutover window. Post-cutover behavior is unchanged (single founding tenant, no second-tenant features yet)

This is the parent plan for Phase 4 of the multi-tenancy migration. Phase 4 is the first customer-visible deploy in the migration: it takes everything Phase 1–3 built on staging and lands it on production. Like the Phase 3 parent, this is intentionally a thin coordinator — most detail lives in per-sub-deploy plan files written when each sub-deploy's turn comes.

---

## Goal

Phase 1 added the multi-tenant schema on staging. Phase 2 made the import script and Edge Functions tenant-aware on staging. Phase 3 made the app code tenant-aware and removed the column defaults so nothing in the system relies on implicit tenant resolution.

Phase 4 brings production to parity with the post-Phase-3 staging state in a single coordinated weekend window, fronted by `app_settings.maintenance_mode = true` and the existing maintenance banner. Before the window, two staging-only sub-deploys close the remaining cross-tenant correctness gaps (4.1 hardening) and the bidirectional script drift production has accumulated independently (4.0 backfill parity).

After Phase 4, production runs the same schema, same RLS, same Edge Function tenant-awareness, same import script, and same app code as staging. Adding a second tenant becomes a Phase 5 effort that touches infrastructure (hosting / subdomain routing / branding / self-service signup), not the core data layer.

---

## Approach Decision

Three structural choices anchor the plan; each is the result of D1–D7 sign-off on 2026-05-24.

**Hardening before cutover.** Two staging-only sub-deploys (4.0 backfill parity, 4.1 pre-cutover hardening) ship before any production touch. This keeps known-dormant cross-tenant bugs out of production and validates the hardening under real two-tenant conditions via a canary tenant on staging. Replicating dormant bugs into production "because they don't activate until tenant 2" is exactly the compounding debt the anti-drift rules exist to prevent.

**Single coordinated weekend window for 4.2–4.6.** Production has real customers; the Phase-1-style multi-weekend soak between schema sub-deploys is not viable on production because the import script breaks the moment the additive schema lands. The Phase 1 sub-deploy structure (additive → constraints → RLS) is preserved as **internal milestones** within one window, providing rollback granularity, but soak between them is minutes, not weeks. Maintenance mode is on for the entire window.

**Canary tenant on staging during 4.1's soak.** The Playwright synthetic-tenant fixture is binary (does isolation work?). A real second tenant living alongside founding-tenant data for the 4.1 soak catches what binary tests miss — cumulative state, recurring imports, email flows, Edge Functions operating with a non-founding caller. The canary is torn down before 4.2 starts so the production cutover runs against a clean single-tenant staging mirror.

Hosting migration (GitHub Pages → Cloudflare/Vercel), per-tenant branding rendering, and self-service tenant signup are explicitly **deferred to Phase 5**. Phase 4's scope is "production reaches staging parity"; second-tenant-onboarding becomes its own phase when there is a real second tenant to onboard.

---

## Sub-Deploys

Phase 4 is broken into **eight sub-deploys**. The first two (4.0, 4.1) ship on staging in normal-cadence weekend sessions. Sub-deploys 4.2–4.6 ship inside a single coordinated weekend cutover window. 4.7 is the post-cutover soak observation period. 4.8 is the post-cutover housekeeping pass (added at 4.7 closeout per `phase-4.6-edge-functions-cutover.md` Appendix A). Each plan file is written **after** the previous sub-deploy completes, per the Phase 3 pattern.

| #   | Title                                                                    | Plan                                                  | Status   | Completed |
|-----|--------------------------------------------------------------------------|-------------------------------------------------------|----------|-----------|
| 4.0 | Backfill parity — port prod's older-month features into staging          | `phase-4.0-backfill-parity.md`                        | Complete | 2026-05-26 |
| 4.1 | Pre-cutover hardening — RLS/EF/script cross-tenant audit + canary tenant | `phase-4.1-pre-cutover-hardening.md`                  | Complete | 2026-05-29 |
| 4.2 | Prod schema — additive (`tenants` table, `tenant_id` cols + backfill on all 9 existing tables) | `phase-4.2-prod-schema-additive.md`   | Complete | 2026-05-30 |
| 4.3 | Prod schema — constraints + view recreation + RLS recursion fix          | `phase-4.3-prod-schema-constraints.md`                | Complete | 2026-05-31 |
| 4.4 | Prod schema — RLS + functions + analytics views + default removal        | `phase-4.4-prod-schema-rls.md`                        | Complete | 2026-05-31 |
| 4.5 | Prod `import.js` — bidirectional merge with staging                      | `phase-4.5-prod-import-merge.md`                      | Complete | 2026-05-31 |
| 4.6 | Edge Functions redeploy + first prod import dry-run + smoke + maintenance off | `phase-4.6-edge-functions-cutover.md`            | Complete | 2026-05-31 |
| 4.7 | One-week post-cutover soak observation                                   | `phase-4.7-post-cutover-soak.md`                      | Complete | 2026-06-10 |
| 4.8 | Post-cutover housekeeping — F55/F56/F57 structural-diff clear + F61 modal | `phase-4.8-post-cutover-housekeeping.md`              | Complete | 2026-06-10 |

### Status values

Same vocabulary as the Phase 3 plan: **Planning** (plan file exists, not yet executed; active sub-deploy if it's the only row at this state), **In progress**, **Complete**, **Pending** (not started, plan not yet written).

### Cutover window sequencing (4.2 → 4.6)

Indicative, not authoritative. Actual elapsed time per gate depends on smoke verification; treat the timeline as a max-budget, not a schedule.

```
Fri evening  ──→  pre-flight: generate prod founding tenant UUID; write to
                  local scripts folder scratch file (gitignored); confirm
                  4.5 patch list references the scratch file path
                  maintenance mode ON; fresh prod DB snapshot
                  apply 4.2 (additive schema, reading UUID from scratch) + smoke gate
Sat morning  ──→  apply 4.3 (constraints + admin_preorders view + RLS recursion fix) + smoke gate
Sat afternoon ─→  apply 4.4 (RLS + functions + analytics views + default removal) + smoke gate
Sat evening  ──→  4.5 (import.js merge, dry-run --no-write gate per § 4.6 spec)
                  4.6 part 1 — Edge Functions redeploy from staging tagged commit
Sun morning  ──→  Full Playwright suite against prod (headed); manual smoke
                  4.6 part 2 — **first real prod import** with current-week catalog data,
                  maintenance mode still ON, verification queries pass
                  Maintenance mode OFF only after import write verified
Sun afternoon ─→  4.7 begins — on-call observation
                  Next monthly import follows normal Tuesday cadence
```

Each smoke gate is a hard stop. If the gate fails, the rollback decision tree at the bottom of this document governs the next move.

### Rollback complexity per sub-deploy

| Sub-deploy | Rollback complexity | Notes |
|---|---|---|
| 4.0 | Easy | Script-only, no schema |
| 4.1 | Easy | RLS policy + Edge Function source changes; all reversible from baseline |
| 4.2 | Easy | `DROP COLUMN` reverses additive schema; loses tenant_id backfill (re-runnable) |
| 4.3 | Easy | `DROP NOT NULL`, `DROP CONSTRAINT`; `admin_preorders` view drop |
| 4.4 | Medium | Restore baseline RLS policies; data written under new policies needs spot-check |
| 4.5 | Easy | Revert script changes; production untouched until 4.6 part 2 import runs |
| 4.6 part 1 | Easy | Edge Function redeploy reversible by re-deploying prior tagged version |
| 4.6 part 2 | **One-way after first successful prod import write** | Customer-visible writes exist under new schema; forward-fix only beyond this point |

### Updating this table

When a sub-deploy completes:
1. Change its status to **Complete** and add the date
2. Write the plan for the next sub-deploy as a new file
3. Update the next row's Plan column to reference the new file
4. Update the next row's status to **Planning**
5. Update the **Active sub-deploy** in `CLAUDE.md` § Current Migration Phase

For 4.2–4.6, the table is updated continuously during the cutover window — one row per checkpoint as it lands.

---

## Dry-Run Validation Gate (used by 4.6 part 1)

The 4.5 dry-run is the last opportunity to catch script-side issues before a real prod import write. The gate is a hard stop: any failed check aborts the window. The full spec lives in `phase-4.6-edge-functions-cutover.md`; the minimum gate, locked in the parent plan so the sub-deploy cannot weaken it, is:

- All three RPC calls (`archive_stale_reservations`, `purge_stale_catalog`, `delete_dropped_catalog_items`) resolve their function signatures successfully — no "function does not exist" errors
- Catalog upsert path resolves without auth, RLS, or `on_conflict` constraint errors
- Auto-reserve subscription fetch returns expected count matching `subscriptions` table count from pre-cutover snapshot, scaled to current month
- `auto_fulfill_past_on_sale` and `purge_old_usage_events` RPC calls resolve
- Shipment upsert paths (Lunar via `(distributor, upc, on_sale_date)`, PRH via delete-then-insert) resolve without errors
- Zero unexpected warnings to stderr (known expected warnings — e.g. unmatched-shipment-row warnings — documented in the sub-deploy plan)
- Exit code 0

A failing gate is Tier 1 rollback per § Rollback Decision Tree. Maintenance mode stays on; cutover window aborts; post-mortem before retry.

---

## In Scope for Phase 4

### Staging-only prep (4.0, 4.1)

- Port production's `--skip-autoreserve` flag, `isOlderMonth` detection, auto-skip-auto-reserve-for-backfills, and older-month notification warning into `import-staging.js` so staging covers the backfill scenarios production already exercises (4.0)
- Deep audit of F16 (preorders multi-PERMISSIVE OR-policy pattern) across every RLS-protected tenant-scoped table (4.1)
- Deep audit of F34 (Edge Function tenant resolution) across every user-creation and user-mutation Edge Function (4.1)
- Finding E grants audit: tighten `anon` / `authenticated` / `service_role` table-level grants on `usage_events`, `user_profiles`, and other tenant-scoped tables to the minimum required (4.1)
- F17 fix: add `AND tenant_id = current_tenant_id()` to `reservation_history` admin SELECT policy (4.1)
- `claim_paper_account` SQL function: add tenant-filter check before re-pointing rows (4.1)
- `upsertShipment` PRH delete: scope the service-role `DELETE` by `tenant_id` so a future second tenant's PRH shipment for the same date is not collateral damage (4.1)
- `buildCatalogIdMap` catalog lookups: scope by tenant (4.1)
- Spin up a `'canary'` tenant on staging during 4.1's soak with one canary admin and two canary customers; run a synthetic monthly catalog import scoped to canary; verify zero cross-tenant leak across every customer-facing surface, every admin surface, every analytics view, every Edge Function call path (4.1)
- Tear down canary tenant **before 4.2 starts** (final task of 4.1)

### Production cutover (4.2 – 4.6)

- Fresh backup snapshot of production database immediately before 4.2 (in addition to existing `pre-multitenancy-v1` backup from 2026-04-29)
- **Generate production founding tenant UUID** as Friday-evening pre-flight before any SQL runs. Write to a scratch file in the local scripts folder (gitignored, like `config.js`); every subsequent sub-deploy in the window reads from there. The scratch file's existence and contents are a hard pre-flight gate for 4.2 SQL execution (4.2 pre-flight)
- Apply Phase 1.1 additive schema to production: `tenants` table, founding tenant row using the UUID from the scratch file, nullable `tenant_id` columns on every existing prod table, backfill (4.2)
- **`app_settings` and `usage_events` already exist on production** — confirmed by live audit 2026-05-28; the "create these tables" item does not apply. 4.2 adds `tenant_id` to all 9 existing tables (incl. `app_settings`, `usage_events`). See `production-baseline-2026-05-28.md` PB1. (4.2)
- Apply Phase 1.2 constraints: `NOT NULL` promotion on every `tenant_id` column, tenant-aware unique constraints on `subscriptions` and `catalog`, `tenants` slug format check, and ×9 `tenant_id → tenants(id) ON DELETE CASCADE` FKs (4.3) — FKs confirmed in `production-baseline-2026-05-28.md` § 2.1 and applied in 4.3
- Update the existing production `admin_preorders` view with the post-Phase-1 tenant-aware definition (4.3)
- Apply RLS recursion fix: replace any `EXISTS (SELECT 1 FROM user_profiles ...)` admin policies with `current_user_is_admin()` `SECURITY DEFINER` calls (4.3)
- Apply Phase 1.3 RLS + functions: tenant-aware policies on every tenant-scoped table; `current_tenant_id()` and `current_user_is_admin()` helpers; updated function signatures for `purge_stale_catalog`, `delete_dropped_catalog_items`, `archive_stale_reservations` with `p_tenant_id uuid` first parameter (4.4)
- Apply Phase 3.3 column-default removal — must be paired with app code that passes `tenant_id` explicitly. The app code is deployed via the staging→prod merge bundled with 4.6 (4.4)
- Apply Phase 3.4 analytics view retrofits (filter by `current_tenant_id()`): `analytics_daily_events`, `analytics_top_cancelled`, `analytics_top_reserved`, `analytics_top_subscribed`, `analytics_user_activity` — **all 5 views already exist on production** (confirmed 2026-05-28); 4.4 retrofits them with tenant filtering rather than creating them. See `production-baseline-2026-05-28.md` PB2. (4.4) **CARVED OUT 2026-05-31 (F55): no staging counterpart exists; retrofit target undefined. Re-scoped 2026-05-31: deferred to post-cutover housekeeping (F55 disposition in 4.6 plan).**
- Apply Phase 3.5 `purge_old_usage_events(p_tenant_id, p_retention_days)` function (4.4)
- Apply Phase 3.6 `auto_fulfill_past_on_sale(p_tenant_id)` function with `SECURITY DEFINER`, `search_path = public`, `EXECUTE` granted to `service_role` only (4.4)
- Apply 3.8-era hot-fix RLS / function changes: F4, F15, F16, F20, F34 fixes from 2026-05-10 (4.4) **Status 2026-05-31: F15 + F16 subsumed by RLS rewrite; F20 applied via `get_popular_series` replace. F34 → 4.6 (Edge Function redeploy). F4 → 4.6 app-code deploy + post-cutover data drop.**
- Bidirectional merge of `import.js` (production) with `import-staging.js` using **Strategy B**: prod is the base; each of the **16** staging→prod patches (P1–P16, per `phase-4.5-prod-import-merge.md` § 4 — the `CLAUDE.md` line-431–449 carry-forward list was stale; the 4.5 runbook file diff is authoritative) is applied as a discrete reviewable diff with its own verification step. The four prod→staging features identified in 2026-05-24 drift analysis (`--skip-autoreserve`, `isOlderMonth`, auto-skip-auto-reserve-for-backfills, older-month warning) are explicit no-op preservation checks ("# already present, preserve at lines X–Y") rather than re-introductions (4.5)
- Force a `git log -p import-staging.js | grep foc_date` step in the 4.5 plan to recover the history of the `r.foc_date >= today` notify-customers filter and decide whether to propagate to prod (4.5)
- Set production founding tenant UUID as `import.js`'s `TENANT_ID` constant — UUID generated during 4.2 insertion, not reused from staging (4.5)
- Redeploy all 8 Edge Functions to production from the staging tagged commit; set `FOUNDING_TENANT_ID` Supabase secret on the production project (4.6 part 1)
- Dry-run production import script in `--no-write` mode before any real catalog touch; dry-run must pass the validation gate spec defined in sub-deploy 4.6's plan (4.6 part 1)
- Full Playwright suite against production with headed mode (4.6 part 2 — runs after Edge Functions deployed but before maintenance mode off)
- **First real production import using current-week catalog data**, with maintenance mode still on. Verify: auto-fulfill count printed; `usage_events` purged with prod tenant scope; catalog upserted with `tenant_id`; auto-reserve inserts carry `tenant_id`; shipment rows carry `tenant_id`; zero unexpected stderr; exit code 0 (4.6 part 2)
- Toggle `app_settings.maintenance_mode = false` **only after** first real import verification passes (4.6 part 2)
- Tag production repo `phase-4-cutover-v1` and staging repo `phase-4-cutover-v1-staging` at the end of the window for clean rollback anchors (4.6 part 2)
- Re-spin canary tenant on **staging** (never production) during the 4.7 soak week to maintain two-tenant signal while production soaks single-tenant. Re-use teardown procedure from 4.1 at end of 4.7 (4.7)
- One-week post-cutover soak observation on production; Tuesday-cadence imports run normally; daily check-in on logs, error rates, customer-reported issues (4.7)

## Out of Scope for Phase 4

These are real work items but explicitly not part of Phase 4. Each becomes its own future phase.

- **Hosting migration (GitHub Pages → Cloudflare Pages or Vercel)** — Required before subdomain-based tenant routing. The `?t=<slug>` resolver established in 3.1 keeps working in single-tenant production. Defer to Phase 5
- **Per-tenant branding rendering** — `tenants.branding` jsonb column exists; no UI reads it. Building branding UI without a real second-tenant content set is premature. Defer to Phase 5
- **Self-service tenant signup** — Public flow for a second bookstore to register, claim a slug, configure their account. Defer to Phase 5
- **Slug→id mapping via RPC** — Currently hardcoded `TENANT_SLUG_MAP` in `app.js`. Premature abstraction until a second tenant exists. Defer to Phase 5
- **`register-customer` Edge Function tenant resolution** — Intentionally hard-pinned to `FOUNDING_TENANT_ID` (webhook, no admin context) per F34's documented status. Revisit before tenant 2 onboards, not in Phase 4
- **Partial fulfillment representation** — Still a product decision (unchanged from Phase 3)
- **Dead-code cleanup** (F19 `is_admin`, F26 `admin_preorders` view if confirmed unused post-cutover, F33 `claim_paper_account` if redundant after 4.1 audit) — Catalog separately; not in scope
- **F23 `SET search_path` hardening across all `SECURITY DEFINER` functions** — Cross-cutting cleanup that does not block Phase 4. Defer (but new functions added in 4.4 must include the hardening)
- **`mylist.html` Upcoming Arrivals filter rule change** — Phase 3.8 left it on the existing `>= today` rule. No change
- **POS integration** — Out of scope (unchanged from 3.6)
- **Free-tier Supabase upgrade for dashboard backups** — Unrelated infrastructure question; not blocking

If something seems related but isn't on the IN scope list above, **stop and ask** per the anti-drift rules in `CLAUDE.md`. Phase 4 has higher stakes for inline scope creep than any prior phase because the production cutover is one shot.

---

## Phase Completion Criteria

Phase 4 is complete when **all** of the following are true:

- [x] All sub-deploys 4.0–4.7 in the Sub-Deploys table above marked Complete — done; 4.8 (added at 4.7 closeout) also Complete 2026-06-10
- [x] Production schema mirrors post-Phase-3 staging schema (verifiable by structural diff: `pg_dump --schema-only` on each, normalize, compare) — F55 cleared 4.8 H1; **known intentional differences remaining:** F58 `user_profiles` policy (prod has `admins manage tenant profiles` ALL; staging lacks it); F19 `is_admin()` function prod-only (pre-existing deferred dead code) — *ticked 2026-06-10 (completion audit): F64's 8 pre-Phase-4 DDL divergences assessed per-item; none touches the migrated multi-tenant surface or blocks closure; reconciliation scheduled pre-Phase-5 (dispositions in `technical-reference.md` § 13 F64). F66 filed during the assessment (latent, unreachable today).*
- [x] Production RLS policies match staging RLS policies for every tenant-scoped table (verifiable by `pg_policies` query diff) — **known intentional difference:** `admins manage tenant profiles` (ALL) on `user_profiles` retained on prod (Decision B / F58) — *ticked 2026-06-10 (completion audit): F63 assessed — prod is the correct (stricter) side; staging-only `TO authenticated` fix is safe and scheduled pre-Phase-5 (see § 13 F63).*
- [x] All production Edge Functions match staging Edge Functions at the cutover tag (verifiable by source diff against tagged commit) — verified at 4.6 part 1; post-cutover EF changes during the soak (F60 `notify-customers`, F62 `send-my-list`) were committed to the repo and deployed to prod from repo source
- [x] Production `import.js` has all Phase 2 + 3.x staging patches **and** preserves all production-side backfill features (verifiable by Sub-Deploy 4.5 verification queries) — 4.5 closed 2026-05-31, P1–P16 each verified
- [x] Full Playwright suite runs green against production — 4.6 part 2, headed run, 2026-05-31
- [x] First real production import (4.6 part 2) completed inside the cutover window with all verification queries green — 2026-05-31
- [x] Subsequent Tuesday-cadence imports during the 4.7 soak week run cleanly with no schema-related errors — 2026-06-02 June month roll, 2333 records, exit 0, zero foreign/null tenant_id (4.7 closeout)
- [x] Production database row counts post-cutover match the pre-cutover snapshot (delta = customer-driven writes during the open window only — must be auditable) — *audited with one documented exception: F59 (330 cutover-window reservations initially lost to a merge-base regression) — fully recovered 2026-06-01 from the 2026-05-30 dump with per-row audit trail; post-recovery deltas all customer-driven (4.7 ledger)*
- [x] One-week post-cutover soak (4.7) passes with no customer-reported issues — closed 2026-06-10 after 10 calendar days; one customer-reported issue (F61 Brave/iOS confirm) was deferred-with-owner per the 4.7 gate and resolved in 4.8 H5
- [x] `CLAUDE.md` § Current Migration Phase updated to reflect Phase 4 complete and Phase 5 queued — 2026-06-10 (completion audit)
- [x] Phase 5 entry stub created in `CLAUDE.md` § Current Migration Phase with status `Not started — Phase 4 must complete first` and a one-line scope ("Second-tenant onboarding: hosting migration, branding rendering, slug→id routing, self-service signup") — present in `CLAUDE.md`; full stub doc created at `docs/phase-5-second-tenant-onboarding.md` (2026-06-10)
- [x] All sub-deploy plan files committed to `docs/` — verified 2026-06-10: 4.0–4.8 plans + parent all tracked
- [x] `pre-multitenancy-state.md` updated with Phase 4 completion notes following the Phase 1 completion pattern — 2026-06-10 (completion audit); § 2/§ 4 also annotated as superseded by `production-baseline-2026-05-28.md`
- [x] Recovery anchors documented: `phase-4-cutover-v1` (prod) and `phase-4-cutover-v1-staging` tags reachable; post-cutover DB dump stored alongside the 2026-04-29 snapshot — tags verified on remotes 2026-06-10 (`-staging` tag pushed to the `staging` remote at the audit); full data dumps of both envs taken 2026-06-10 and stored in `backups\2026-06-10-phase-4-close\` (see `pre-multitenancy-state.md` § Phase 4 Completion for the anchor table)

---

## Carry-Forward From Phase 3

These items were noted in Phase 3 docs as carrying into Phase 4:

1. **`import.js` (production) — required patches before first prod run** (`CLAUDE.md` line 431–449) — Addressed by sub-deploy 4.5 (bidirectional merge). The `CLAUDE.md` list is staging→prod only; this plan adds the prod→staging direction discovered 2026-05-24
2. **F16 / F34 deep audit** (`phase-3.8-pre-phase-4-hardening.md` § Carry-Forward item 3) — Addressed by sub-deploy 4.1
3. **Finding E (overly-broad table grants on `usage_events` and `user_profiles`)** (`CLAUDE.md` § Known Out-of-Scope Items) — Addressed by sub-deploy 4.1
4. **`claim_paper_account` doesn't filter by tenant** (`CLAUDE.md` § Deferred — architectural concerns) — Addressed by sub-deploy 4.1
5. **`upsertShipment` PRH delete cross-tenant risk + `buildCatalogIdMap` cross-tenant risk** (`phase-3-tenant-resolution.md` § Discovered During Soak 2026-05-08, architectural notes for later) — Addressed by sub-deploy 4.1
6. **F17 admin SELECT scoping** (`technical-reference.md` § 13) — Addressed by sub-deploy 4.1
7. **`auto_fulfill_past_on_sale` production call site** (`phase-3.6-admin-wednesday-tooling.md` § Carry-forward) — Addressed by sub-deploys 4.4 (function deploy) and 4.5 (script call site)
8. **Notify-customers `foc_date >= today` filter** (staging-only as of 2026-05-24; provenance unknown) — Addressed by sub-deploy 4.5 with explicit `git log -p` history-recovery step before merge decision
9. ~~**Production has 7 tables, staging has 9**~~ — **Corrected (2026-05-28):** production has 9 base tables; `app_settings` and `usage_events` predate the 2026-04-29 snapshot. Documentation-accuracy failure, not undocumented drift. See `production-baseline-2026-05-28.md` PB6. The real gap is `tenants` + `tenant_id` columns — addressed by sub-deploy 4.2.

---

## Discovered During Soak

(Populated as sub-deploys ship and issues surface. Same template as `phase-3-tenant-resolution.md` § Discovered During Soak.)

| # | Discovered | Sub-deploy | Description | Resolution |
|---|---|---|---|---|
| 1 | 2026-05-31 | 4.6 (soak) | 250 April + 8 March preorders had `fulfilled=false` at cutover; bulk-UPDATE attempted, immediately rolled back (all 258 were future-dated). Correct final state: 258 future items remain `fulfilled=false`; 65 past-on-sale items already `fulfilled=true`. | Resolved inline; see 4.6 deploy log § 14. |
| 2 | 2026-06-01 | 4.7 (soak) | **F59 — cutover-window reservation data loss.** PR #49 three-way merge kept regressed `app.js`; 330 reservations across 9 customers (2026-04-29 → 2026-05-28) failed to persist. Hotfix `554aec1` corrected app.js; data recovered from 5/30 DBeaver dump via ItemCode re-resolution. | Recovered 2026-06-01 (330 rows restored; Brian Moss spot-check ✓). F59 filed in `technical-reference.md` § 13. Prevention committed in `7c5e4cb`. |
| 3 | 2026-06-02 | 4.7 (soak) | **F60 — `notify-customers` rejects service-role callers from import script.** First post-recovery Tuesday import answered `y` to notifications; `{"error":"Invalid auth"}` returned. Root cause: function calls `/auth/v1/user` to verify caller; service-role key is not a user session JWT. Path was never exercised (4.6 first import answered `n`). | Fixed 2026-06-02: JWT role-claim bypass added to `notify-customers/index.ts` (decode `payload.role === 'service_role'`). Redeployed to prod. Verified: 8/0 notifications sent on re-run. F60 filed in `technical-reference.md` § 13. |
| 4 | 2026-06-02 | 4.7 (soak) | **F61 — Brave/iOS suppresses `window.confirm()` on mylist.html Remove button.** Customers on Brave/iOS cannot cancel reservations — the native confirm dialog is silently blocked, so the guard returns false and the removal never proceeds. | Deferred to 4.8 post-cutover housekeeping. Fix: replace `window.confirm()` with a custom in-page modal on `mylist.html`. F61 filed in `technical-reference.md` § 13. |

---

## Rollback Decision Tree

Schema migrations are hard to reverse — once customer writes land under the new schema, rollback becomes destructive. The decision tree is keyed on **when** the issue is discovered, not which sub-deploy.

### Tier 1 — Fails to apply

**Scope:** SQL execution error during 4.2, 4.3, or 4.4 — or smoke gate immediately after the apply, before any customer traffic.

**Action:** Roll back the in-flight sub-deploy SQL only. Prior sub-deploys stay applied. Maintenance mode stays on. Abort the window. Post-mortem before retry.

**Recoverability:** Full. No customer writes happened (maintenance mode on, no customer traffic).

### Tier 2 — Applies but smoke fails (inside the cutover window)

**Scope:** Sub-deploy applies cleanly but a smoke test (manual or Playwright) fails before maintenance mode is toggled off.

**Action:** Assess severity.
- **Customer-blocking** (any customer-facing flow broken): roll back the offending sub-deploy and any later ones that depend on it. Abort window. Resume next weekend.
- **Admin or edge-case** (admin flow broken, rare customer path broken): forward-fix in the window if a fix is straightforward. Otherwise hot-patch the failing flow and document; full forward-fix in the following weekend's window.

**Recoverability:** Feasible but the time pressure is real. Maintenance mode buys hours, not days.

### Tier 3 — Discovered after maintenance mode off

**Scope:** Issue surfaces during the 4.7 soak or later. Customer writes exist under the new schema.

**Action:** Forward-fix only. Rollback at this tier is destructive because:
- Customer preorders, subscriptions, and `usage_events` written under new RLS may not satisfy old RLS policies
- The new column defaults are gone (Phase 3.3 removal); rolling back the app code means writes will fail with `null value in column "tenant_id" violates not-null constraint`
- Restoring the schema-only backup loses the customer writes since cutover

Hot-patch via the same Discovered During Soak pattern Phase 3 used. Document inline; promote to a finding in `technical-reference.md` § 13.

---

## Reference

- Active sub-deploy plan: see the Sub-Deploys table above
- Anti-drift rules: `CLAUDE.md` § Anti-Drift Rules for Agentic Sessions
- Phase 3 parent plan (shape mirror): `docs/phase-3-tenant-resolution.md`
- Phase 2 completion notes: `docs/phase-2-completion.md`
- Phase 1 plan and completion (closest prior art for schema migration sequencing and rollback SQL): `docs/phase-1-schema-migration.md`
- Pre-multitenancy baseline (recovery anchors, prod row counts, prod admin UUID): `docs/pre-multitenancy-state.md`
- Schema reference (canonical): `docs/technical-reference.md`
- Findings index (5 HIGH closed during the 2026-05-10 hot-fix; F16/F34 deep audit queued for 4.1): `docs/technical-reference.md` § 13
- Founding tenant UUID (staging): `72e29f67-39f7-42bc-a4d5-d6f992f9d790`
- Production founding tenant UUID: to be generated during 4.2 (will tie to admin user `734bfd7e-23a6-4c23-ba35-1f64843603c0` — "Book Stop")
- Phase 3.6 origin doc (`auto_fulfill_past_on_sale` spec): `docs/phase-3.6-admin-wednesday-tooling.md`
- Phase 3.8 origin doc (this-week rule alignment; defers F16/F34 deep audit to 4.1): `docs/phase-3.8-pre-phase-4-hardening.md`
- Recovery anchor tags created by Phase 4 closeout: `phase-4-cutover-v1` (prod), `phase-4-cutover-v1-staging`

---

**Last updated:** 2026-06-10 (Phase 4 completion audit closed — all completion criteria ticked; F63/F64 assessed, F66 filed; recovery anchors verified and stored; Phase 4 **Complete**)
