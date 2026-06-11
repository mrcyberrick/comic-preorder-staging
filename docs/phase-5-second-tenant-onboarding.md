# Phase 5 — Second-Tenant Onboarding

**Status:** Planning — parent plan written 2026-06-10; sub-deploy 5.0 in Planning
**Predecessor:** Phase 4 — Production Migration (`docs/phase-4-production-migration.md`) — **Complete 2026-06-10**
**Branch base:** `staging` for all staging-side work; prod promotions per `CLAUDE.md` § Standard Deployment Workflow
**Customer impact:** None until 5.5 (founding-tenant behavior is a hard invariant for 5.0–5.4); 5.1 hosting cutover is the one customer-visible infrastructure change before tenant 2 exists

This is the parent plan for Phase 5 of the multi-tenancy migration. Like the Phase 3 and Phase 4 parents, it is intentionally a **thin coordinator** — most detail lives in per-sub-deploy plan files written when each sub-deploy's turn comes. Scope bullets were carried from the Phase 4 parent § Out of Scope and the Phase 4 completion-audit carry-forward list.

---

## Goal

Phase 4 left production at post-Phase-3 staging parity: multi-tenant schema, tenant-scoped RLS, tenant-aware Edge Functions and import script — all serving a single founding tenant. Phase 5 turns that data layer into an actually multi-tenant product: clear the carried findings while they are cheap (5.0), move hosting off GitHub Pages (5.1), make tenant routing data-driven (5.2), render per-tenant branding (5.3), open tenant signup (5.4), and onboard a real second tenant with a two-tenant production soak (5.5).

After Phase 5, two tenants run side by side on production with verified isolation, and onboarding tenant *N+1* is an operational task, not an engineering phase.

---

## Approach Decisions

Sign-off 2026-06-10 (Phase 5 planning session, Rick):

**Housekeeping before features (5.0 first).** F58/F63/F64/F65/F66 are cheap to clear now and compound later — F66 in particular is a latent silent-deletion path on prod that must not survive into a phase that adds import surface. 5.0 ships before any Phase 5 feature work. Scope sign-off: all seven candidate items; F58 is audit → decide → fix in-sub-deploy; F64 item 5 is decided in 5.0 but its DDL is deferred (see § Deferred-DDL Register).

**Hosting before subdomain routing (5.1 before 5.2's subdomain half).** GitHub Pages cannot do per-subdomain serving; the `?t=<slug>` resolver from 3.1 keeps working throughout. 5.2's slug→id RPC lands independently of hosting, but subdomain-based tenant resolution waits for 5.1.

**Signup before onboarding (5.4 before 5.5), onboarding gated.** Tenant 2 is onboarded only in 5.5, against the finished signup flow. Every sub-deploy 5.1–5.4 carries the invariant "founding tenant behavior unchanged" as a completion criterion; the existing Playwright tenant-isolation specs run at every gate.

---

## Sub-Deploys

Phase 5 is broken into **six sub-deploys**. Each plan file is written **after** the previous sub-deploy completes, per the Phase 3/4 pattern.

| #   | Title                                                                     | Plan                                          | Status   | Completed |
|-----|---------------------------------------------------------------------------|-----------------------------------------------|----------|-----------|
| 5.0 | Pre-Phase-5 housekeeping — F58/F63/F64/F65/F66 + prod `settings` row drop | `phase-5.0-pre-phase-5-housekeeping.md`       | Planning | |
| 5.1 | Hosting migration — GitHub Pages → Cloudflare Pages or Vercel (staging first, then prod) | *(written at 5.0 close)*       | Pending  | |
| 5.2 | Slug→id routing RPC — replace `TENANT_SLUG_MAP`; subdomain resolution; F64 item 8 (`idx_tenants_slug` → prod) | *(written at 5.1 close)* | Pending | |
| 5.3 | Per-tenant branding rendering — UI reads `tenants.branding` jsonb         | *(written at 5.2 close)*                      | Pending  | |
| 5.4 | Tenant signup — `register-customer` un-pinning (F34 residual) + self-service tenant registration | *(written at 5.3 close)* | Pending | |
| 5.5 | Second-tenant onboarding — tenant 2 live on prod + two-tenant production soak | *(written at 5.4 close)*                  | Pending  | |

### Status values

Same vocabulary as the Phase 3/4 plans: **Planning** (plan file exists, not yet executed; active sub-deploy if it's the only row at this state), **In progress**, **Complete**, **Pending** (not started, plan not yet written).

### Updating this table

When a sub-deploy completes:
1. Change its status to **Complete** and add the date
2. Write the plan for the next sub-deploy as a new file
3. Update the next row's Plan column to reference the new file
4. Update the next row's status to **Planning**
5. Update the **Active sub-deploy** in `CLAUDE.md` § Current Migration Phase

---

## Deferred-DDL Register

DDL whose *decision* is made in one sub-deploy but whose *execution* is deliberately deferred. An item leaves this register only by landing in a named sub-deploy plan or by an explicit defer-with-rationale disposition in `technical-reference.md` § 13.

| Item | Decided | DDL owner | Notes |
|---|---|---|---|
| F64 item 5 — `preorders_user_id_fkey` target alignment | 5.0 S3 (2026-06-11) | 5.1-adjacent housekeeping commit — must land before 5.4 | **Decision: Option A (profile-first, NO ACTION canonical).** Prod needs: drop CASCADE FK, re-add → `user_profiles` NO ACTION. Decision + DDL recorded in § 13 F64 item 5. |
| F64 item 8 — `idx_tenants_slug` → prod | Phase 4 completion audit (2026-06-10) | Sub-deploy 5.2 (slug-routing wants the index) | Additive index, trivially safe |

---

## In Scope for Phase 5

- **5.0:** F63 (14 staging policies → `TO authenticated`), F64 items 1–3/6/7 (staging additive constraints + FKs), F58 (staging admin-write audit → decision → fix), F64 item 5 (decision only), F66 + F64 item 4 (preorder guard both envs + prod FK → NO ACTION), F65 (`subscriptions.html` + `mylist.html:1081` confirm modal), vestigial prod `settings.maintenance_mode` row drop
- **5.1:** Static hosting moved to Cloudflare Pages or Vercel for staging and prod; GitHub Pages retired; deploy workflow docs updated; smoke suite re-pointed
- **5.2:** `TENANT_SLUG_MAP` in `app.js` replaced by a slug→id RPC (anon-callable, returns only what an unauthenticated landing page needs); subdomain-based tenant resolution on the new hosting; `idx_tenants_slug` added to prod
- **5.3:** Per-tenant branding read from `tenants.branding` jsonb (name, colors, logo at minimum); founding tenant renders identically to today by default
- **5.4:** `register-customer` Edge Function resolves tenant from request context instead of `FOUNDING_TENANT_ID` pin (F34 residual); self-service tenant registration flow (claim slug, create admin, seed settings)
- **5.5:** Tenant 2 onboarded on production; two-tenant soak with the 4.1/4.7 canary verification surface (every customer page, admin surface, Edge Function path, import cycle — zero cross-tenant leak); onboarding runbook generalized for tenant N+1

## Out of Scope for Phase 5

- **POS integration** — unchanged from Phase 3/4
- **Partial fulfillment representation** — still a product decision
- **F23 `SET search_path` hardening across all SECURITY DEFINER functions** — cross-cutting cleanup; new functions added in Phase 5 must include the hardening, existing ones are not retrofitted here
- **Dead-code catalog** (F19 `is_admin`, F26 `admin_preorders` view, F33 remnants) — catalog separately; not bundled into 5.0
- **Multi-tenant email branding / per-tenant MailerSend identities** — revisit when tenant 2's real requirements exist; 5.5 may file findings against it
- **Billing / plan tiers for tenants** — no requirement exists

If something seems related but isn't on the IN scope list above, **stop and ask** per the anti-drift rules in `CLAUDE.md`.

---

## Phase Completion Criteria

Phase 5 is complete when **all** of the following are true:

- [ ] All sub-deploys 5.0–5.5 in the Sub-Deploys table marked Complete
- [ ] Second tenant live on production: own slug, branding, admin account, customer flows — verified end-to-end
- [ ] Zero cross-tenant leakage across every customer-facing surface, admin surface, analytics view, and Edge Function path, verified with the 4.1-style canary checklist against the *real* second tenant
- [ ] Founding-tenant behavior unchanged: full Playwright suite green against prod; no customer-reported regressions during the 5.5 soak
- [ ] `TENANT_SLUG_MAP` removed from `app.js`; tenant resolution is data-driven (RPC + subdomain)
- [ ] `register-customer` no longer hard-pinned to `FOUNDING_TENANT_ID`
- [ ] Hosting fully migrated; GitHub Pages serving retired; deployment workflow in `CLAUDE.md` rewritten for the new host
- [ ] All carried findings (F58, F63, F64 incl. deferred-DDL items, F65, F66) resolved or explicitly re-dispositioned in § 13
- [ ] Two-tenant production soak passed (duration set in the 5.5 plan; not less than one full import cycle)
- [ ] `CLAUDE.md` § Current Migration Phase updated; Phase 6 stub created if a successor phase exists
- [ ] All sub-deploy plan files committed to `docs/`

---

## Rollback Notes

| Sub-deploy | Rollback complexity | Notes |
|---|---|---|
| 5.0 | Easy | Per-step: policies revertible from pre-capture; constraints droppable; function body restorable from captured definition; F65 is normal code rollback |
| 5.1 | Easy–Medium | DNS/serving switch back to GitHub Pages (kept warm until 5.5 closes); no data surface |
| 5.2 | Easy | RPC is additive; `TENANT_SLUG_MAP` removal is the last commit and revertible; index droppable |
| 5.3 | Easy | Rendering-only; founding tenant default-path identical |
| 5.4 | Medium | Signup writes tenant rows; teardown SQL (FK-ordered, from the 4.1 canary procedure) must exist before the flow opens |
| 5.5 | **One-way once tenant 2 has real customer writes** | Before that point, the 4.1 canary teardown procedure removes the tenant cleanly; after it, forward-fix only (Phase 4 Tier-3 logic applies) |

---

## Carry-Forward From Phase 4

| Item | Source | Addressed by |
|---|---|---|
| F58 — staging `user_profiles` admin-write policy audit | § 13; known symptom: staging Pending-tab Decline silently fails | 5.0 S3 |
| F63 — 14 staging policies missing `TO authenticated` | § 13 (count corrected from 13 at Phase 5 planning) | 5.0 S1 |
| F64 — 8 pre-Phase-4 DDL divergences | § 13 per-item dispositions (Phase 4 completion audit) | items 1–3/6/7 → 5.0 S2; item 4 → 5.0 S4; item 5 → 5.0 S3 decision + Deferred-DDL Register; item 8 → 5.2 |
| F65 — customer-facing `window.confirm()` sites (`subscriptions.html:419`, `mylist.html:1081`) | § 13 (scope extended at Phase 5 planning per F61 deferral) | 5.0 S6 |
| F66 — `delete_dropped_catalog_items` preorder guard | § 13 (filed at completion audit; latent) | 5.0 S4 |
| Vestigial prod `settings.maintenance_mode` row | `CLAUDE.md` § Known Out-of-Scope Items | 5.0 S5 |
| F34 residual — `register-customer` founding-tenant pin | § 13 F34 documented status | 5.4 |
| Hosting / branding / slug-RPC / signup deferrals | Phase 4 parent § Out of Scope | 5.1 / 5.3 / 5.2 / 5.4 |

---

## Reference

- Active sub-deploy plan: see the Sub-Deploys table above
- Anti-drift rules: `CLAUDE.md` § Anti-Drift Rules for Agentic Sessions
- Phase 4 parent plan (shape mirror + rollback-tier logic): `docs/phase-4-production-migration.md`
- Canary tenant spin-up/teardown procedure (reused by 5.4 rollback prep and 5.5): `docs/phase-4.1-pre-cutover-hardening.md`
- Schema reference (canonical): `docs/technical-reference.md`; findings index § 13
- Recovery anchors from Phase 4 close: tags `phase-4-cutover-v1` (origin) / `phase-4-cutover-v1-staging` (origin + staging); full data dumps + schema-only pair in `backups\2026-06-10-phase-4-close\` (see `pre-multitenancy-state.md` § Phase 4 Completion)
- Founding tenant UUID (staging): `72e29f67-39f7-42bc-a4d5-d6f992f9d790`; prod founding tenant UUID in `scripts/phase-4-prod-tenant-uuid.txt` (local-only, gitignored)

---

**Last updated:** 2026-06-10 (parent plan written at Phase 5 planning session; 5.0 plan + runbook created same session)
