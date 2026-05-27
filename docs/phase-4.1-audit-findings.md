# Phase 4.1 — Audit Findings

**Parent plan:** `docs/phase-4-production-migration.md`
**Sub-deploy plan:** `docs/phase-4.1-pre-cutover-hardening.md`
**Audit run date:** 2026-05-26
**Audit run by:** Claude Code CLI session

This document captures the pre-cutover audit results for three classes of finding: F16-class (multi-PERMISSIVE OR-policy patterns), F34-class (Edge Function tenant resolution), and Finding E (overly-broad table grants). Per the locked decision gate at the parent-plan level, new findings surfaced during the audit are triaged inline with the user as bundle / defer / out-of-scope.

---

## A. F16-Class Audit — Multi-PERMISSIVE OR-Policy Pattern

**Audit input:** `pg_policies` query result (captured below)
**Audit run:** 2026-05-26
**Scope:** every tenant-scoped table in the staging schema

### A.1 Raw policy inventory

```
schemaname | tablename           | policyname                               | permissive | roles           | cmd    | qual                                                                                                                                   | with_check
-----------|---------------------|------------------------------------------|------------|-----------------|--------|----------------------------------------------------------------------------------------------------------------------------------------|----------------
public     | app_settings        | admins delete tenant app_settings        | PERMISSIVE | {public}        | DELETE | ((tenant_id = current_tenant_id()) AND current_user_is_admin())                                                                        | null
public     | app_settings        | admins insert tenant app_settings        | PERMISSIVE | {authenticated} | INSERT | null                                                                                                                                   | ((tenant_id = current_tenant_id()) AND current_user_is_admin())
public     | app_settings        | admins update tenant app_settings        | PERMISSIVE | {public}        | UPDATE | ((tenant_id = current_tenant_id()) AND current_user_is_admin())                                                                        | null
public     | app_settings        | users read tenant app_settings           | PERMISSIVE | {authenticated} | SELECT | (tenant_id = current_tenant_id())                                                                                                      | null
public     | catalog             | users read tenant catalog                | PERMISSIVE | {authenticated} | SELECT | (tenant_id = current_tenant_id())                                                                                                      | null
public     | preorders           | admins manage tenant preorders           | PERMISSIVE | {public}        | ALL    | ((tenant_id = current_tenant_id()) AND (EXISTS (SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (user_profiles.is_admin = true))))) | (same as qual)
public     | preorders           | users manage own preorders               | PERMISSIVE | {public}        | ALL    | ((auth.uid() = user_id) AND (tenant_id = current_tenant_id()))                                                                         | null
public     | reservation_history | admins view all history                  | PERMISSIVE | {public}        | SELECT | (EXISTS (SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (user_profiles.is_admin = true))))                     | null
public     | reservation_history | users view own history                   | PERMISSIVE | {public}        | SELECT | (auth.uid() = user_id)                                                                                                                 | null
public     | settings            | admins update tenant settings            | PERMISSIVE | {public}        | UPDATE | ((tenant_id = current_tenant_id()) AND current_user_is_admin())                                                                        | null
public     | settings            | users read tenant settings               | PERMISSIVE | {authenticated} | SELECT | (tenant_id = current_tenant_id())                                                                                                      | null
public     | subscriptions       | admins view tenant subscriptions         | PERMISSIVE | {public}        | SELECT | ((tenant_id = current_tenant_id()) AND current_user_is_admin())                                                                        | null
public     | subscriptions       | users manage own subscriptions           | PERMISSIVE | {public}        | ALL    | ((auth.uid() = user_id) AND (tenant_id = current_tenant_id()))                                                                         | null
public     | tenants             | admins update own tenant                 | PERMISSIVE | {public}        | UPDATE | ((id = current_tenant_id()) AND current_user_is_admin())                                                                               | null
public     | tenants             | users read own tenant                    | PERMISSIVE | {authenticated} | SELECT | (id = current_tenant_id())                                                                                                             | null
public     | usage_events        | admins read tenant usage events          | PERMISSIVE | {public}        | SELECT | ((tenant_id = current_tenant_id()) AND current_user_is_admin())                                                                        | null
public     | usage_events        | users insert own usage events            | PERMISSIVE | {authenticated} | INSERT | null                                                                                                                                   | (tenant_id = current_tenant_id())
public     | user_profiles       | admins view tenant profiles              | PERMISSIVE | {public}        | SELECT | ((tenant_id = current_tenant_id()) AND current_user_is_admin())                                                                        | null
public     | user_profiles       | users update own profile                 | PERMISSIVE | {public}        | UPDATE | (auth.uid() = id)                                                                                                                      | null
public     | user_profiles       | users view own profile                   | PERMISSIVE | {public}        | SELECT | (auth.uid() = id)                                                                                                                      | null
public     | weekly_shipment     | authenticated users read weekly_shipment | PERMISSIVE | {authenticated} | SELECT | (tenant_id = current_tenant_id())                                                                                                      | null
```

### A.2 Per-table findings

| Table | Policies | Multi-PERMISSIVE risk? | Decision |
|---|---|---|---|
| app_settings | 4 — DELETE/INSERT/UPDATE on {public}/{authenticated}, SELECT on {authenticated} | No — all distinct (role, cmd) combinations | No action |
| catalog | 1 — SELECT {authenticated} | No | No action |
| preorders | 2 — both PERMISSIVE ALL on {public} | YES — two PERMISSIVE ALL on same (public, ALL) OR-permissively. Tenant cross-risk blocked (both include tenant_id = current_tenant_id()), but admin policy uses EXISTS subquery (A1 new finding) | Bundle C9: replace EXISTS with current_user_is_admin() |
| reservation_history | 2 — both PERMISSIVE SELECT on {public} | YES — two PERMISSIVE SELECT on same (public, SELECT) OR-permissively. F17: admin policy lacks tenant_id. A2 new finding: user policy also lacks tenant_id | Fixed in C2 (both policies) |
| settings | 2 — UPDATE {public}, SELECT {authenticated} | No — distinct (role, cmd) | No action |
| subscriptions | 2 — SELECT {public} + ALL {public} covers SELECT | YES on SELECT, but both properly scoped by tenant_id = current_tenant_id() | No action (correctly scoped) |
| tenants | 2 — UPDATE {public}, SELECT {authenticated} | No — distinct (role, cmd) | No action |
| usage_events | 2 — SELECT {public}, INSERT {authenticated} | No — distinct (role, cmd) | No action |
| user_profiles | 3 — two PERMISSIVE SELECT on {public} + UPDATE {public} | YES on SELECT — two PERMISSIVE SELECT on same (public, SELECT). Admin policy correctly scoped. User policy lacks tenant_id (A3 new finding) | Bundle C9: add tenant_id to user policy |
| weekly_shipment | 1 — SELECT {authenticated} | No | No action |

### A.3 Fixes applied

- **C2** (2026-05-26): Rewrote both `reservation_history` policies — admin policy adds `AND tenant_id = current_tenant_id()` (F17 fix) and converts EXISTS to `current_user_is_admin()`; user policy adds `AND tenant_id = current_tenant_id()` (A2 fix).
- **C9** (2026-05-26): Rewrote `preorders` admin policy — EXISTS replaced with `current_user_is_admin()` (A1 fix). Rewrote `user_profiles` user SELECT policy — added `AND tenant_id = current_tenant_id()` (A3 fix).

---

## B. F34-Class Audit — Edge Function Tenant Resolution

**Audit input:** static read of deployed Edge Function source (via `supabase functions download --project-ref puoaiyezsreowpwxzxhj`)
**Audit run:** 2026-05-26
**Scope:** all 8 Edge Functions
**Source location note:** `approve-customer` and `claim-paper-customer` were not in the repo; downloaded directly from staging via CLI. `approve-customer` staging source differs from Downloads/prod — staging uses staging URLs and has JWT enabled comment. `claim-paper-customer` staging matches Downloads/prod exactly.

### B.1 Per-function findings

| Function | Writes to tenant-scoped tables? | Where does tenant_id come from? | Reads scoped by tenant? | Risk | Decision |
|---|---|---|---|---|---|
| approve-customer | YES — PATCH `user_profiles.status` | N/A (status-only PATCH, no tenant_id in body) | NO — reads by `user_id` (UUID unique globally); admin check fetches `is_admin` only, no tenant scope | LOW (B1): admin could approve cross-tenant user if they know UUID; JWT enabled protects against unauthenticated calls | Defer — single-tenant production; revisit before second tenant |
| claim-paper-customer | YES — PATCH `preorders.user_id`, PATCH `subscriptions.user_id`, DELETE `user_profiles` | N/A (PATCH existing rows; no tenant_id in write body) | NO — PATCH URLs filter by `user_id=eq.${paper_user_id}` only, no tenant_id | MEDIUM (B2): service-role PATCH could reassign founding-tenant rows from canary admin context | C10 (blocked pending B3 JWT) |
| create-paper-customer | YES — INSERT `user_profiles` with `tenant_id` | `callerTenantId` from caller's profile (`profiles[0]?.tenant_id \|\| FOUNDING_TENANT_ID`) | N/A (INSERT, service role) | LOW — correctly resolved ✓ | No action |
| invite-customer | YES — INSERT `user_profiles` with `tenant_id` | `callerTenantId` from caller's profile (`profiles[0]?.tenant_id \|\| FOUNDING_TENANT_ID`) | N/A (INSERT, service role) | LOW — correctly resolved ✓ | No action |
| notify-customers | NO | N/A | YES — `user_profiles` filtered by `&tenant_id=eq.${FOUNDING_TENANT_ID}`; `app_settings` filtered by `&tenant_id=eq.${FOUNDING_TENANT_ID}` | MEDIUM-HIGH (B3): NO caller authentication check; any request can trigger email blast. Hardcoded FOUNDING_TENANT_ID means canary admin call would still blast founding-tenant customers. JWT verification status TBD (pending B3 investigation) | C10 (blocked pending B3 JWT confirmation) |
| register-customer | YES — INSERT `user_profiles` with `tenant_id` | `FOUNDING_TENANT_ID` (intentional) | N/A (INSERT) | LOW — intentional per F34 documented status; header comment present confirming the decision ✓ | No action |
| reset-password | NO | N/A | NO tenant-scoped reads | NONE — no tenant operations | No action ✓ |
| send-my-list | NO | N/A | PARTIALLY — catalog month via `FOUNDING_TENANT_ID`; preorders via `user_id` only (no tenant filter) | MEDIUM (B4): catalog month query would return founding-tenant month for canary-tenant user | C10 (blocked) |

### B.2 Fixes applied

- **C10** (pending B3 + B5 resolution): patches for `claim-paper-customer` (B2), `notify-customers` (B3), `send-my-list` (B4).

---

## C. Finding E Audit — Table-Level Grants

**Audit input:** `information_schema.role_table_grants` query result (captured below)
**Audit run:** 2026-05-26
**Scope:** every tenant-scoped table

### C.1 Raw grants inventory

All 10 tenant-scoped tables plus `admin_preorders` (VIEW — unexpected, see F49) show identical grant patterns:
- `anon`: DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE (7 of 7)
- `authenticated`: DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE (7 of 7)
- `service_role`: DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE (7 of 7)

Tables in grant output: `admin_preorders`, `app_settings`, `catalog`, `preorders`, `reservation_history`, `settings`, `subscriptions`, `tenants`, `usage_events`, `user_profiles`, `weekly_shipment`.

**Unexpected:** `admin_preorders` VIEW appears in grants. Per `pre-multitenancy-state.md` § 4, this view was not supposed to exist on staging yet (4.3 scope). New finding F49 — see § E below.

### C.2 Per-table findings

| Table | anon grants | authenticated grants | service_role grants | Tightening decision |
|---|---|---|---|---|
| app_settings | ALL (7) | ALL (7) | ALL (7) | REVOKE ALL anon; REVOKE TRUNCATE/REFERENCES/TRIGGER authenticated; service_role unchanged |
| catalog | ALL (7) | ALL (7) | ALL (7) | Same |
| preorders | ALL (7) | ALL (7) | ALL (7) | Same |
| reservation_history | ALL (7) | ALL (7) | ALL (7) | Same |
| settings | ALL (7) | ALL (7) | ALL (7) | Same |
| subscriptions | ALL (7) | ALL (7) | ALL (7) | Same |
| tenants | ALL (7) | ALL (7) | ALL (7) | Same |
| usage_events | ALL (7) | ALL (7) | ALL (7) | Same |
| user_profiles | ALL (7) | ALL (7) | ALL (7) | Same |
| weekly_shipment | ALL (7) | ALL (7) | ALL (7) | Same |
| admin_preorders (VIEW) | ALL (7) | ALL (7) | ALL (7) | Handled by C11 (DROP + recreate with security_invoker); post-recreation: GRANT SELECT to authenticated and service_role only; anon gets nothing |

No exceptions: no table where service_role lacks any privilege; no non-tenant-scoped tables with unexpected grants beyond admin_preorders (which is addressed by C11).

### C.3 Fixes applied

- **C9** (2026-05-26): REVOKE ALL from `anon` on all 10 tenant-scoped tables; REVOKE TRUNCATE, REFERENCES, TRIGGER from `authenticated` on all 10 tenant-scoped tables. `service_role` unchanged.
- **C11** (2026-05-26): DROP + recreate `admin_preorders` VIEW with `security_invoker = true`; GRANT SELECT to `authenticated` and `service_role`; no grant to `anon`.

---

## D. DEFINER Function Inventory (F23 input)

**Audit input:** `pg_proc` query result for SECURITY DEFINER functions
**Audit run:** 2026-05-26

```
proname                      | pronargs | prosecdef | proconfig
-----------------------------|----------|-----------|------------------------
auto_fulfill_past_on_sale    | 1        | true      | ["search_path=public"]
current_tenant_id            | 0        | true      | ["search_path=public"]
current_user_is_admin        | 0        | true      | ["search_path=public"]
delete_dropped_catalog_items | 3        | true      | null
get_popular_series           | 1        | true      | null
is_admin                     | 0        | true      | null
purge_old_usage_events       | 2        | true      | ["search_path=public"]
purge_stale_catalog          | 3        | true      | null
```

**Missing from DEFINER inventory (SECURITY INVOKER):**
- `archive_stale_reservations(uuid, date, text)` — present in pg_proc but prosecdef = false. New finding F45 — see § E. Fix: C12 (promote to SECURITY DEFINER + search_path).
- `claim_paper_account(uuid, uuid)` — present in pg_proc but SECURITY INVOKER (expected per F21 notes). Fix: C3 (DROP).

**get_popular_series signature confirmed:** `p_catalog_month text` (pronargs=1). C5 ALTER uses `ALTER FUNCTION get_popular_series(text)`, not `get_popular_series()`.

### D.1 search_path hardening status

| Function | Current proconfig | Action |
|---|---|---|
| auto_fulfill_past_on_sale(uuid) | search_path=public | Already hardened ✓ |
| current_tenant_id() | search_path=public | Already hardened ✓ |
| current_user_is_admin() | search_path=public | Already hardened ✓ |
| delete_dropped_catalog_items(uuid, text, text[]) | null | C5: ALTER SET search_path |
| get_popular_series(text) | null | C5: ALTER SET search_path (corrected signature) |
| is_admin() | null | C4: DROP |
| purge_old_usage_events(uuid, integer) | search_path=public | Already hardened ✓ |
| purge_stale_catalog(uuid, date, text) | null | C5: ALTER SET search_path |
| archive_stale_reservations(uuid, date, text) | SECURITY INVOKER — not in DEFINER query | C12: SECURITY DEFINER + search_path (new finding F45) |
| claim_paper_account(uuid, uuid) | SECURITY INVOKER — not in DEFINER query | C3: DROP |

---

## E. New Findings Surfaced During Audit

| ID | Finding | Source | Triage decision | Notes |
|---|---|---|---|---|
| F45 | `archive_stale_reservations` deployed as SECURITY INVOKER — inconsistent with sibling tenant-aware DEFINER functions (`auto_fulfill_past_on_sale`, `current_tenant_id`, etc.) | C1.D pg_proc inventory | Bundle 4.1 (C12): ALTER to SECURITY DEFINER + SET search_path | Plausible Phase 1.3 or Phase 3.3 inline-patch oversight. Fix: two-step ALTER. |
| F46 | `preorders` `admins manage tenant preorders` policy uses `EXISTS (SELECT 1 FROM user_profiles ...)` instead of `current_user_is_admin()` — latent RLS recursion risk per CLAUDE.md | C1.A policy audit | Bundle 4.1 (C9): replace EXISTS with `current_user_is_admin()` | The 2026-05-10 F16 hot-fix added tenant_id scoping but did not convert the EXISTS pattern. Not currently recursive (user_profiles' own policies don't reference preorders), but violates documented convention. |
| F47 | `notify-customers` Edge Function has no caller authentication check — any HTTP request triggers email blast to founding-tenant customers | C1.B EF audit | Bundle 4.1 (C10): add caller auth verification — blocked pending B3 JWT confirmation | Severity: MEDIUM if platform JWT is enabled (any authenticated user can trigger); HIGH if JWT disabled. Staged download confirms no auth check in source. |
| F48 | `reservation_history` and `user_profiles` user-facing SELECT policies lack `tenant_id = current_tenant_id()` filter — defense-in-depth gap | C1.A policy audit | Bundle 4.1: reservation_history fixed in C2 (alongside F17); user_profiles fixed in C9 | Low risk in single-tenant production (auth UUIDs are globally unique). Correct for multi-tenant hygiene. |
| F49 | `admin_preorders` VIEW exists on staging contrary to `pre-multitenancy-state.md` § 4 claim that staging lacks this view. View is SECURITY DEFINER by default (no RLS), no tenant WHERE clause — full grants to anon/authenticated | C1.C grants audit + E2 view definition | Bundle 4.1 (C11): DROP + recreate with `security_invoker = true` | 4.3 plan must also handle this recreation on production. Pre-multitenancy-state.md doc discrepancy flagged for review during 4.2 pre-flight. |
| F50 | `claim-paper-customer` PATCH operations (`preorders`, `subscriptions`) filter by `user_id` only — no tenant_id scope. Service-role key bypasses RLS. Cross-tenant reassignment risk in two-tenant context | C1.B EF audit | Bundle 4.1 (C10): add `&tenant_id=eq.${callerTenantId}` to both PATCH URLs — blocked pending B5 confirm | B5 confirmed: staging source = Downloads/prod. Staging source confirmed as audit baseline. |
| F51 | `send-my-list` catalog month query uses hardcoded `FOUNDING_TENANT_ID` — canary-tenant user pull list email would reflect founding-tenant catalog month | C1.B EF audit | Bundle 4.1 (C10): resolve callerTenantId from user profile; use for catalog and preorders queries — blocked | Medium risk; activates only with second tenant. |
| F52 | 5 of 8 Edge Functions not committed to repo (`approve-customer`, `claim-paper-customer`, `notify-customers`, `reset-password`, `send-my-list`). 4.6 plan requires tagged-commit redeploy of all 8 — not currently executable | C1.B source location investigation | **RESOLVED** (Session 2 opening): all 5 committed to repo. All 8 EFs now tracked. 4.6 tagged-redeploy prerequisite met. | Sources confirmed via CLI download during B5. Staging-deployed source ≠ Downloads/prod for approve-customer (different BASE_URL, JWT comment). |
| B1 | `approve-customer` admin check not tenant-scoped — a canary admin with a founding-tenant user_id could approve that user | C1.B EF audit | Defer — single-tenant production; only activates with second tenant | JWT is enabled for approve-customer (confirmed from staging source). Practical risk is low. |
| F54 | `send-my-list` auth check uses service key to verify `user_id` exists in auth.users but does not verify the caller's JWT matches `user_id` — any authenticated user can trigger a pull-list email for any other user | Surfaced during C10c Option A read (Session 2) | **FIXED** (Session 2, separate commit before F51): add `/auth/v1/user` call with caller's JWT + `callerUser.id !== user_id` 403 guard | Email goes to target user's address so data not exposed to caller, but authorization model was wrong. Fix: verify caller's JWT and assert callerUser.id === user_id before proceeding. |

---

## F. Audit Run Log

| Time | Step | Result | Notes |
|---|---|---|---|
| 2026-05-26 | P1–P8 pre-flight | All passed (P1 required clean-up: restore phase-4-production-migration.md from committed state; commit phase-4.1-pre-cutover-hardening.md and .gitignore) | config.js isolation rule: enforced manually via merge procedure, not via .gitignore; CLAUDE.md doc discrepancy flagged for C15 |
| 2026-05-26 | P7 import-staging.js anchor check | All three lines at expected numbers (671, 515, 532) | No drift from 4.0 |
| 2026-05-26 | P8 baseline row counts | user_profiles=38, preorders=26, subscriptions=3, weekly_shipment=443; founding tenant only | Baseline captured for Session 3 canary teardown verification |
| 2026-05-26 | C1.A pg_policies query | 21 policies across 10 tenant-scoped tables; findings A1/A2/A3 surfaced | admin_preorders absent from policies (VIEW — expected) |
| 2026-05-26 | C1.C role_table_grants query | All 10 tables + admin_preorders VIEW show full grants to anon/authenticated/service_role | Finding F49 (admin_preorders unexpected on staging) surfaced |
| 2026-05-26 | C1.D pg_proc DEFINER inventory | 8 SECURITY DEFINER functions; archive_stale_reservations absent (INVOKER); get_popular_series pronargs=1 not 0 | Finding F45 surfaced; C5 ALTER signature corrected to get_popular_series(text) |
| 2026-05-26 | D1 verification | archive_stale_reservations confirmed SECURITY INVOKER (prosecdef=false) | Bundled as C12 |
| 2026-05-26 | D2 re-investigation | get_popular_series(p_catalog_month text) — pronargs=1, text arg | C5 ALTER updated: get_popular_series(text) |
| 2026-05-26 | E2 view definition | admin_preorders: JOINs preorders/user_profiles/catalog, no tenant WHERE, ORDER BY full_name/on_sale_date | C11 SQL prepared: DROP + CREATE WITH (security_invoker = true) preserving same column list and JOINs |
| 2026-05-26 | C1.B F34 EF audit | 8 functions read (3 from repo, 3 from edge-functions-phase2/, 2 from staging CLI download) | approve-customer staging ≠ Downloads/prod; claim-paper-customer staging = Downloads/prod. B3 JWT status pending Supabase dashboard check |
| 2026-05-26 | C6/C7/C8 applied | import-staging.js: three tenant_id=eq.${TENANT_ID} patches applied (lines 671, 515, 532) | Verified via Select-String |
| 2026-05-26 | C2 SQL | Both reservation_history policies dropped and recreated: admin uses `current_user_is_admin() AND tenant_id = current_tenant_id()`; user uses `auth.uid() = user_id AND tenant_id = current_tenant_id()` | Verified via pg_policies SELECT |
| 2026-05-26 | C3 SQL | DROP FUNCTION claim_paper_account(uuid, uuid) — success; 0 rows in pg_proc verify | No policy references confirmed pre-drop |
| 2026-05-26 | C4 SQL | DROP FUNCTION is_admin() — success; 0 rows in pg_proc verify | No policy references confirmed pre-drop |
| 2026-05-26 | C5 SQL | search_path=public set on delete_dropped_catalog_items, get_popular_series(text), purge_stale_catalog — all 3 verified via pg_proc proconfig | get_popular_series signature corrected to (text) from earlier D2 re-investigation |
| 2026-05-26 | C9 SQL | A1: preorders admin policy recreated with `current_user_is_admin() AND tenant_id = current_tenant_id()`; A3: user_profiles SELECT policy adds `tenant_id = current_tenant_id()`; Finding E: anon revoked from all 9 tables, authenticated TRUNCATE/REFERENCES/TRIGGER revoked from all 9 tables — all verified | canary_tenants absent on staging; scope is 9 tables not 10. Production C9 must include canary_tenants if present. |
| 2026-05-26 | C11 SQL | DROP + CREATE admin_preorders WITH (security_invoker=true) — reloptions confirmed; grants: anon revoked, authenticated SELECT only, service_role SELECT only, postgres owner all 7 | Supabase auto-granted ALL to all roles on CREATE; required follow-up REVOKE pass to strip excess. |
| 2026-05-26 | C12 SQL | archive_stale_reservations promoted to SECURITY DEFINER + search_path=public — prosecdef=true, proconfig=["search_path=public"] verified | Two-step ALTER (SECURITY DEFINER then SET search_path) |
| 2026-05-26 | V1–V5 verification | ALL PASS: V1 all 8 DEFINER functions prosecdef=true + search_path=public; V2 claim_paper_account and is_admin absent; V3 all 3 touched-table policies correct; V4 admin_preorders security_invoker=true, authenticated+service_role SELECT only; V5 anon 0 grants on preorders/user_profiles/catalog | C10 remains blocked pending B3 JWT confirmation |
| 2026-05-27 | Session 2 pre-flight | P1 failed: register-customer had unstaged comment-only edits (F34 note removal not committed); 5 EF dirs untracked (approve-customer, claim-paper-customer, notify-customers, reset-password, send-my-list); commit count 11 vs expected 12. Resolved: register-customer restored via git restore; 5 EF dirs committed. supabase/.temp/ added to .gitignore. Post-resolution: P1–P7 all pass; P8 requires Supabase SQL Editor (manual verify). |
| 2026-05-27 | Deploy workflow discovery | Supabase CLI workdir is `C:\Users\richa` (project root with config.toml), NOT the repo root. Deploying from the repo directory uploads from `C:\Users\richa\supabase\functions\` not `repo/supabase/functions/`. Correct deploy workflow: (1) patch file in repo, (2) copy to `C:\Users\richa\supabase\functions\<fn>/`, (3) deploy from `C:\Users\richa`. For `send-my-list`, the target directory did not exist and was created. All three C10 functions now exist in both locations. |
| 2026-05-27 | Canary spin-up (C14) | Tenant inserted (slug=canary, UUID=5f2ad21a-...). Admin created via GoTrue admin API (direct SQL path failed — modern GoTrue requires columns not populated by manual INSERT; bad row deleted, recreated via POST /auth/v1/admin/users with same UUID). Customers 1+2 created via create-paper-customer EF. All 3 rows confirmed tenant_id=5f2ad21a-... in user_profiles. |
| 2026-05-27 | V7 cross-tenant probes (all pass) | V7.1: founding admin sees 0 canary rows across preorders/user_profiles/subscriptions. V7.2: canary admin sees 0 founding rows across same tables. V7.3: get_popular_series — founding=16, canary=0. V7.4: admin_preorders cross-tenant counts both 0. V7.5: notify-customers as canary admin → sent=0 (canary customers are paper-filtered); crucially did NOT reach founding-tenant customers. All probes PASS. |
| 2026-05-27 | B5 resolution | All 8 Edge Function source directories present under `supabase/functions/` as of 2026-05-27, now all tracked in git (5 previously-untracked functions committed in Session 2 opening). C10 patches apply directly to in-repo files. |
| 2026-05-27 | B6 resolution | Structural blocker for 4.6 cutover plan resolved by the same Edge Function consolidation. All 8 functions can be tagged together at the cutover commit. 4.6 plan no longer needs a "consolidate Edge Function source" prerequisite sub-deploy. F52 status updated: resolved. |
| 2026-05-27 | F53 confirmation | `create-paper-customer` has full in-body auth check (authHeader read at line 42, /auth/v1/user verification at lines 43–44, callerTenantId resolution at line 68, tenant_id written at line 135). C13 confirmed as dashboard-toggle-only; no source changes needed. F53 stays LOW. |
| 2026-05-27 | C13 applied | `create-paper-customer` JWT verification flipped OFF via Supabase dashboard. In-body auth confirmed intact (6 hits: lines 42–68). Negative test: unauthenticated POST with valid body → 401 {"error":"Unauthorized"} from our code (not platform). Positive test: paper customer creation via admin.html succeeded. F53 closed. |
