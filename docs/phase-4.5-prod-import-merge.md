# Phase 4.5 — Production `import.js` Bidirectional Merge

**Status:** Planning (flip to **Complete** on execution)
**Sub-deploy:** 4.5 of Phase 4 — see `docs/phase-4-production-migration.md`
**Branch:** none — **[LOCAL] script-only.** No commits to `feat/phase-4-prod-cutover`. No production DB writes.
**Strategy:** B — production `import.js` is the base; each staging→prod patch is applied as a discrete, individually-verified diff. The four prod→staging backfill features are preservation checks, not re-introductions.
**Plan written:** 2026-05-31
**Authoritative inputs read during planning:** `CLAUDE.md`, `docs/phase-4-production-migration.md`, `docs/technical-reference.md` § 13, current `scripts/import.js` (prod), current `scripts/import-staging.js` (staging).

---

## 1. Goal

Bring the local production import script (`scripts/import.js`) to functional parity with the post-Phase-3.8 / post-4.1 staging script (`scripts/import-staging.js`) so it can run against the post-4.4 production schema without failing. After 4.4, production's `archive_stale_reservations`, `purge_stale_catalog`, and `delete_dropped_catalog_items` require a `p_tenant_id uuid` first argument and RLS filters on `current_tenant_id()`; the current prod script calls the old signatures and writes no `tenant_id`, so it would fail the moment it touches the post-4.4 schema. 4.5 closes that gap. No prod data is touched until the 4.6 part-1 dry-run and 4.6 part-2 first real import.

## 2. Why this is local-only

`import.js` and `import-staging.js` live in `scripts/` outside any repo (they hold the service-role key). They are never committed. All change verification is `Select-String` + a `node` syntax/unit check — never `git diff`. The only tracked artifacts from 4.5 are this plan and the runbook (doc-only commits to `staging`). The dry-run that exercises the patched script against the prod DB is the **4.6 part-1** gate, not 4.5 — 4.5 has zero production-database steps.

## 3. Strategy B — three buckets

The merge surface was derived by direct diff of the two current files (authoritative over the stale "14-patch" reference in parent-plan line 152 and its `CLAUDE.md` line-431–449 pointer — see § 8).

**Bucket 1 — ADD (16 patches).** Tenant-awareness and post-3.x features absent from prod. Applied as discrete diffs P1–P16.

**Bucket 2 — PRESERVE (4 checks).** `--skip-autoreserve`, `isOlderMonth` detection, `skipAutoReserve = flag || isOlderMonth`, older-month notify warning. Confirmed present and functionally equivalent in current prod. **Verify-equivalence only; do not rewrite.** Prod's copies differ cosmetically (column-0 banner comments at Steps 3/5/7, a "new vs same month" comment that omits "vs older"); these are left as-is — normalizing them is out-of-scope churn.

**Bucket 3 — DO NOT INTRODUCE.** Staging's whitespace quirks (e.g. the oddly-indented `foc_date` block, trailing-space line before Step 9). Where an ADD patch sits near these, the patch uses **prod's** bytes/indentation, not staging's.

## 4. Patch inventory (Bucket 1)

| ID | Location | Change | Origin |
|----|----------|--------|--------|
| P1 | Config block | Add `TENANT_ID` const = **prod** founding UUID, sourced from `scripts/phase-4-prod-tenant-uuid.txt` (never the staging literal, never pasted in the runbook) | Phase 2 / parent line 154 |
| P2 | `normalizeLunarCatalog` | Add `tenant_id: TENANT_ID,` | Phase 2 |
| P3 | `normalizePRHCatalog` | Add `tenant_id: TENANT_ID,` | Phase 2 |
| P4 | `archiveReservationsBeforePurge` body | Add `p_tenant_id: TENANT_ID,` | Phase 2 / 4.4 sig |
| P5 | `refreshCatalog` → `purge_stale_catalog` body | Add `p_tenant_id: TENANT_ID,` | Phase 2 / 4.4 sig |
| P6 | `refreshCatalog` catalog upsert | `on_conflict=item_code,…` → `on_conflict=tenant_id,item_code,…` | Phase 2 |
| P7 | `refreshCatalog` → `delete_dropped_catalog_items` body | Add `p_tenant_id: TENANT_ID,` | Phase 2 / 4.4 sig |
| P8 | `autoReserveSubscriptions` insert | Add `tenant_id: TENANT_ID` to `toInsert.push` | Phase 2 |
| P9 | `buildCatalogIdMap` Lunar lookup | Append `&tenant_id=eq.${TENANT_ID}` | 4.1 (cross-tenant scoping) |
| P10 | `buildCatalogIdMap` PRH lookup | Append `&tenant_id=eq.${TENANT_ID}` | 4.1 |
| P11 | `upsertShipment` | **Extract** inline row-building into pure `buildLunarShipmentRows`/`buildPrhShipmentRows` (tenant_id added), rewire caller | **HIGH-RISK** — structural; 3.7 unit-test target |
| P12 | `upsertShipment` PRH delete | Append `&tenant_id=eq.${TENANT_ID}` | 4.1 |
| P13 | After Step 7 | Add Step 8 `purge_old_usage_events` block | 3.5 |
| P14 | After Step 8 | Add Step 9 `auto_fulfill_past_on_sale` block | 3.6 |
| P15 | EOF | Add `require.main === module` guard + `module.exports` of the two builders | 3.7 (unit-test harness) |
| P16 | notify foc filter | `r.foc_date` → `r.foc_date && r.foc_date >= today` (+ `const today`) | **gated — see § 5** |

## 5. `foc_date` decision gate (P16)

Delta is exactly: prod considers **all** FOC dates (`r.foc_date`); staging considers **future** ones only (`r.foc_date && r.foc_date >= today`). The recommendation is **propagate** — emailing a FOC deadline that has already passed is a defect, and the change is consistent with prod's own older-month-backfill caution. **Gate:** runbook step 1 runs `git log -p import-staging.js | Select-String -Context 2 "foc_date"`. Apply P16 only if history shows the `>= today` clause was a deliberate fix; if provenance is inconclusive, skip P16 and file the divergence as a finding (next free ID **F59**) rather than guessing. P16, if applied, uses prod's 4-space indentation, not staging's.

## 6. Out of scope (anti-drift)

- **F55** (5 prod `analytics_*` views, no staging counterpart) — 4.4 carve-out; blocks the 4.6 structural-diff gate; **not** a 4.5 concern.
- **F56 / F57** (`claim_paper_account`, `generate_invite_link` prod-only) — post-cutover cleanup pass.
- **F58** (staging `user_profiles` admin-write policy) — staging audit; not script work.
- Any `import.js` behavior change beyond parity (no new flags, no refactors outside P11).
- Cosmetic normalization of prod's preserved Bucket-2 regions.
- Production database touches of any kind (deferred to 4.6).

## 7. Verification gates

- **V1** — `node --check scripts/import.js` exits 0 after all patches (syntax intact).
- **V2** — `Select-String` confirms each of P1–P16 landed (per-patch counts in the runbook).
- **V3** — `TENANT_ID` equals the `phase-4-prod-tenant-uuid.txt` value and is **not** `72e29f67-39f7-42bc-a4d5-d6f992f9d790`.
- **V4** — row-builder unit check: `require('./import.js')` exposes both builders and they stamp `tenant_id` on output rows.
- **V5** — Bucket-2 preservation: all four features still present and unmodified (grep confirms).
- **V6** — `SUPABASE_URL` still the prod project ref; service-key placeholder untouched (no credential edits).

## 8. Completion criteria

- [ ] P1–P16 applied and V1–V6 green
- [ ] Bucket-2 four features confirmed preserved (V5)
- [ ] P16 decision recorded (propagated, or skipped with F59 filed)
- [ ] Parent-plan line 152 corrected: "14 patches" → "16 patches"; stale `CLAUDE.md` line-431–449 pointer noted as a doc-accuracy fix (not a finding)
- [ ] Parent-plan Sub-Deploys table: 4.5 → **Complete** (date); 4.6 row → **Planning**, plan file `phase-4.6-edge-functions-cutover.md` written
- [ ] `CLAUDE.md` § Current Migration Phase active-sub-deploy pointer advanced to 4.6
- [ ] This plan + runbook committed to `docs/` on `staging` (doc-only)

## 9. References

- Parent plan: `docs/phase-4-production-migration.md` (§ 4.5 lines 152–154; dry-run gate § "Dry-Run Validation Gate"; line 216–217 carry-forward items 7–8)
- 4.4 handoff: function signature migration, `auto_fulfill_past_on_sale` / `purge_old_usage_events` deployed (service_role EXECUTE only)
- `docs/technical-reference.md` § 13 (highest finding F58; F59 reserved for P16 skip case)
- Prod founding tenant UUID: `scripts/phase-4-prod-tenant-uuid.txt` (gitignored)
- Runbook: `docs/phase-4.5-runbook.md`
