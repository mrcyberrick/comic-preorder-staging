# Phase 4.1 — Canary Soak Log

**Parent plan:** `docs/phase-4-production-migration.md`
**Sub-deploy plan:** `docs/phase-4.1-pre-cutover-hardening.md`
**Soak duration:** 3 days (decision locked 2026-05-26)
**Canary tenant spun up:** 2026-05-27
**Canary tenant teardown:** scheduled for Session 3 of 4.1

---

## Day 1 — 2026-05-27

### Spin-up

- Canary tenant `canary` / `Canary Bookshop` inserted, UUID `5f2ad21a-a1f6-47e6-a683-a3906fca0eb2`
- Canary admin created via GoTrue admin API (Path B). Direct SQL insert into auth.users failed — GoTrue returned "Database error loading user" because modern GoTrue requires columns the manual INSERT didn't populate. Resolution: delete bad row via SQL, recreate via `POST /auth/v1/admin/users` with explicit UUID. user_profiles row was unaffected (same UUID retained).
- Canary customers 1 + 2 created via `create-paper-customer` Edge Function (post-C13 JWT-off + post-F34 in-body auth). Both tagged to canary tenant by callerTenantId. Actual UUIDs: `23a04253-2ae9-4b73-9f1a-6f427830fa3a` (Cust 1), `8cfd756b-16d1-4b48-a24f-d3469673a3d2` (Cust 2).
- Synthetic canary catalog import: **deferred** — initial soak validates user_profiles tenant tagging and cross-tenant RLS; catalog import not required for V7 probes.

### V7 cross-tenant probes

| Probe | Expected | Actual | Pass/Fail |
|---|---|---|---|
| V7.1 founding admin → canary preorders | 0 | 0 | PASS |
| V7.1 founding admin → canary user_profiles | 0 | 0 | PASS |
| V7.1 founding admin → canary subscriptions | 0 | 0 | PASS |
| V7.2 canary admin → founding preorders | 0 | 0 | PASS |
| V7.2 canary admin → founding user_profiles | 0 | 0 | PASS |
| V7.2 canary admin → founding subscriptions | 0 | 0 | PASS |
| V7.3 get_popular_series — founding admin | > 0 | 16 | PASS |
| V7.3 get_popular_series — canary admin | 0 | 0 | PASS |
| V7.4 admin_preorders — founding admin → canary rows | 0 | 0 | PASS |
| V7.4 admin_preorders — canary admin → founding rows | 0 | 0 | PASS |
| V7.5 notify-customers as canary admin | canary-scoped only; sent=0 (paper filter) | sent=0, failed=0 | PASS |

### Notes

- All V7 probes pass on Day 1.
- V7.5: canary customers have `@paper.pulllist.local` emails, which the recipient filter excludes. `sent=0` is the correct result — confirms the function scoped to canary tenant rather than falling through to founding-tenant customers.
- GoTrue direct SQL insert limitation documented above; admin API path confirmed working for canary spin-up.
- Deploy workflow: Supabase CLI uses `C:\Users\richa` as project root (config.toml location); repo `supabase/functions/` files must be copied to `C:\Users\richa\supabase\functions\` before deploying. All three C10 functions now in both locations.

---

## Day 2 — pending

Observation checklist for Day 2 (2026-05-28):
- Re-run V7.1 and V7.2 SQL probes to confirm no state drift
- Verify canary tenant rows still intact in user_profiles
- Verify founding-tenant smoke tests still pass (catalog reserve, admin bagging list)

## Day 3 — pending

Observation checklist for Day 3 (2026-05-29):
- Re-run V7.1 and V7.2 SQL probes
- Session 3: canary teardown + final doc updates + PR merge to staging
