# Phase 4.7 — Post-Cutover Soak Observation

**Status:** Planning — plan/runbook written 2026-06-02. Flip parent-plan row 4.7 → **Complete** at closeout (§ 6).
**Parent plan:** `docs/phase-4-production-migration.md` (sub-deploy row 4.7; In-Scope lines 161–162)
**Predecessor:** `docs/phase-4.6-edge-functions-cutover.md` — closed 2026-05-31 (maintenance off, first prod import, tags pushed). Appendix A defines the **4.8** housekeeping pass that follows this soak.
**Branches:** Doc-only edits this sub-deploy (soak ledger, finding files, pointer advances) → committed directly to `staging`. **No app-code, schema, or `main`-bound changes in 4.7.**
**Execution model:** **CLI-orchestrated, Rick-in-the-loop.** A Claude Code CLI session runs this top to bottom. It executes every repo / doc / local-script / Playwright step itself, and **pauses at every database step** — production **and** staging (both go through the Supabase SQL Editor / GoTrue admin API, which the CLI cannot reach) and the production import write — handing the exact SQL / command to Rick and **waiting for pasted output before continuing**. **Self-contained — no chat context required.**

> **Steps Claude never runs itself.** (1) Any Supabase **SQL Editor** statement — prod *or* staging. (2) The production import write (`node scripts/import.js …`). (3) GoTrue admin-API / service-role `curl` calls (they require the service-role key, which Claude never reads or echoes). (4) Supabase **dashboard** log/error checks. Each appears below as a **`PAUSE → Rick runs → paste result → match expected → continue / STOP`** block. Claude prepares the exact SQL/command text, the expected result, and the stop condition around every pause.

> **Soak runs across a calendar week — not one sitting.** Unlike the 4.6 window, 4.7 spans **multiple CLI sessions over ≥ 7 calendar days**. The durable record is the **Soak Ledger (§ 10)**: every session appends its monitoring results there. A session resumes by reading the ledger, doing the day's checks (§ 4), appending a row, and stopping. Setup (§§ 2–3) runs once; closeout (§ 6) runs once, only after the close gate.

---

## 0. Pre-flight (Claude executes; halt on any mismatch)

### 0.1 Read before doing anything
- `docs/phase-4-production-migration.md` — §§ *Sub-Deploys* (row 4.7), *In Scope 4.6/4.7* (lines 161–162), *Phase Completion Criteria*, *Discovered During Soak*, *Rollback Decision Tree* (Tier-3 = post-maintenance-off, forward-fix only).
- `docs/phase-4.6-edge-functions-cutover.md` — § 14 deploy log (cutover snapshot counts to diff against); **Appendix A** (the 4.8 housekeeping pass — *catalogued, NOT executed in 4.7*).
- `docs/phase-4.1-canary-procedure.md` — the spin-up + teardown template reused verbatim in § 2 / § 6.1.
- `docs/technical-reference.md` § 13 — findings index. **Highest filed = F62** (closed 2026-06-10, send-my-list admin 403). **Next free ID = F63.** Do not assign new IDs unless a genuine new soak defect surfaces.
- `CLAUDE.md` — § *Current Migration Phase* (active sub-deploy = 4.7), § *Definition of Done — Merge Gate*, § *Smoke Test Suite*, deployment workflow (F59 post-merge diff assertion + write-smoke).

### 0.2 Files Claude must NOT touch
- `scripts/import.js`, `scripts/import-staging.js`, `scripts/config.js`, `scripts/.env`, `scripts/phase-4-prod-tenant-uuid.txt`, `scripts/phase-4.1-canary-uuids.txt` — never edit, never echo contents. The prod import in § 3 runs **unflagged** (the `--no-write` flag from 4.6 § 3.1 is not passed; whether it still sits in the local file is immaterial — it is never committed).
- Any `supabase/functions/**`, `app.js`, `*.html`, schema — **no source or schema changes in 4.7.** A soak observes; it does not modify. Defects are *filed* (§ 5), not fixed inline, unless Rick explicitly authorizes a Tier-3 forward-fix.
- Production database — only via the Rick-in-the-loop SQL blocks below.

### 0.3 Environment facts confirmed during planning
- Prod Supabase project ref: `plgegklqtdjxeglvyjte`. Staging project ref: `puoaiyezsreowpwxzxhj`.
- Prod founding tenant UUID: in `scripts/phase-4-prod-tenant-uuid.txt` (gitignored). Ties to admin `734bfd7e-23a6-4c23-ba35-1f64843603c0` ("Book Stop"). **Never** the staging literal `72e29f67-39f7-42bc-a4d5-d6f992f9d790`. In SQL below, `:TID` = the prod founding UUID (Rick substitutes from the scratch file).
- Maintenance mode on prod is **OFF** since 2026-05-31 (4.6 § 7.3). Production is live on the tenant-aware schema + app code. **Soak window start = 2026-05-31.**
- F59 recovered 2026-06-01: 330 reservations restored. Source dump `backups/pulllist/dump-postgres-202605302059.backup` (local, never committed) is **retained until 4.7 closeout** (§ 6.4).
- 4.6 cutover snapshot counts (deploy log § 14), the baseline this soak audits against: catalog `2306/2306` with_tid; preorders with_tid `325/325`; shipment with_tid `486/486`. (Preorders total has since grown by the 330 F59-recovered rows + organic writes.)

### 0.4 Idempotent doc-state reconciliation (verify-or-fix; doc-only → `staging`)
Prior-session commits may or may not have landed. Verify each; if already in target state, skip; if not, apply as one doc-only commit to `staging`.

| Check | Target state | Fix if absent |
|---|---|---|
| `phase-4-production-migration.md` Sub-Deploys table, row 4.6 | `Complete` / `2026-05-31` | edit row |
| same table, row 4.7 | `Planning` / plan = `phase-4.7-post-cutover-soak.md` | edit row |
| `CLAUDE.md` § Current Migration Phase | active sub-deploy = **4.7**; predecessor = 4.6 | edit pointer |
| `phase-4-production-migration.md` § Discovered During Soak | rows 1 (April/March fulfilled=false) and 2 (F59) present | already committed `47d7e9d`; verify only |
| `docs/phase-4.7-post-cutover-soak.md` (this file) | committed to `staging` (not untracked) | `git add` + commit |

Commit message if any fix applied:
```
docs: reconcile 4.6→4.7 sub-deploy pointers; land 4.7 soak plan
```

### 0.5 Pre-flight gates (halt if any fail)
- `git rev-parse --abbrev-ref HEAD` → on `staging`.
- `git status` → clean (no stray app/schema edits in the tree).
- `test -f scripts/phase-4-prod-tenant-uuid.txt` → exists, non-empty (do not print contents).
- `test -f docs/phase-4.1-canary-procedure.md` → exists (the § 2 / § 6.1 template).
- Confirm today's date and compute the **close gate**: soak start `2026-05-31` + 7 calendar days fully elapsed ⇒ earliest close **2026-06-08**. Record both in the ledger header.

---

## 1. Soak ledger — the spine of 4.7

The soak is a **week-long observation**, so its state lives in the **Soak Ledger (§ 10)**, not in a single run. Rules:

- Every CLI session that touches 4.7 appends **one ledger row** for the calendar day it runs, with the § 4 monitoring results and a `green / watch / red` verdict.
- **Backfill the already-elapsed days** (2026-05-31, 06-01, 06-02) from existing records on first run: 05-31 = maintenance-off + first import clean (4.6 § 14); 06-01 = F59 discovered **and recovered** (technical-reference.md § 13 F59); 06-02 = this plan written + § 2/§ 3 setup. Mark 06-01 verdict `watch→resolved` (F59 closed same window).
- A `red` verdict (active unresolved defect) **pauses the close gate** — the soak does not close on a red day. File per § 5.
- The ledger is committed to `staging` after each update (doc-only). Stale-but-uncommitted ledger rows are a drift source — commit them.

---

## 2. Setup task A — Re-spin canary tenant on **staging** (one-time)

Parent line 161: re-spin a canary tenant on **staging** (never production) for the soak week to keep two-tenant isolation signal live while prod soaks single-tenant. Procedure is the 4.1 template verbatim (`docs/phase-4.1-canary-procedure.md`). Run **once**, near soak start.

> **Idempotency check first (Claude):** if a prior session already spun the canary, `scripts/phase-4.1-canary-uuids.txt` exists with a fresh `Generated:` date and a `CANARY_TENANT_ID`. If so, skip spin-up; go to § 2.6 verification. Otherwise proceed.

**2.1–2.5 — Spin-up.** Follow `docs/phase-4.1-canary-procedure.md` Steps 1–6 exactly (new UUIDs each run). The DB inserts (tenant row, `user_profiles` row) and the GoTrue admin-API / sign-in / `create-paper-customer` `curl` calls are **Rick-in-the-loop** (SQL Editor + service-role key). Claude restates each command from the procedure doc with the placeholders, but does not run them.

> **PAUSE → Rick runs the canary spin-up (staging)** per `phase-4.1-canary-procedure.md` Steps 1–6.
> **Paste:** the Step 6 verification SELECT.
> **Expected:** 3 rows for `CANARY_TENANT_ID` — 1 admin + 2 paper customers, all `tenant_id = canary`.
> **STOP if:** fewer than 3 rows, or any row carries the founding tenant_id. Do not proceed to leak testing on a broken fixture.

**2.6 — Isolation verification (Claude runs Playwright locally; staging only).** The local smoke suite covers tenant isolation (F15, F20). The CLI runs it directly — it is non-destructive and staging-targeted.
```
cd C:\Users\richa\OneDrive\Documents\(Work)\BookStop\catalogs\scripts\playwright
.\run-smoke.ps1
```
- **Expected:** full green, including the tenant-isolation specs. (Runner aborts if `SUPABASE_URL` is prod — that abort is a correct safety stop, not a soak failure.)
- **STOP if:** any isolation spec fails → that is a live cross-tenant leak; file as **F60** (§ 5) and stop — do not tear the canary down (preserve evidence), surface to Rick.

**2.7 — Canary-vs-founding leak spot-check (Rick-in-the-loop, staging SQL).** A real-tenant cross-check the binary Playwright fixture cannot give:
> **PAUSE → Rick runs (staging SQL Editor):**
> ```sql
> -- No founding-tenant row is visible under the canary tenant_id and vice-versa.
> SELECT tenant_id, count(*) FROM user_profiles GROUP BY tenant_id ORDER BY count DESC;
> SELECT tenant_id, count(*) FROM preorders     GROUP BY tenant_id ORDER BY count DESC;
> ```
> **Paste:** both groupings.
> **Expected:** exactly two `tenant_id` values present (founding + canary); founding counts unchanged from before spin-up; no row mis-tagged.
> **STOP if:** any third/unexpected tenant_id, or founding counts shifted → file F60, stop.

Record canary spin-up + isolation result in the ledger (§ 10) on the day it runs.

---

## 3. Setup task B — First post-recovery production import (Tuesday cadence)

Parent line 162: Tuesday-cadence imports run normally during the soak. This is the **first production import since the F59 recovery** — highest-attention import of the soak. It runs on its normal Tuesday slot (2026-06-02 is a Tuesday). The script auto-detects new-vs-same catalog month; if it rolls a new month it will additionally archive history, purge stale rows, and auto-reserve — verify all paths.

> **One-way reminder.** Maintenance is OFF; this is a real customer-visible write. Per parent § Rollback **Tier-3**, anything discovered after the write lands is **forward-fix only**. There is no rollback to a pre-import state without losing customer writes since cutover.

**3.1 — Recommended pre-import snapshot (Rick).** Cheap insurance before the first new-schema Tuesday import (especially if it rolls a new month). Same mechanism as the 5/30 export.
> **PAUSE → Rick (optional but recommended):** take a fresh prod `pg_dump`/DBeaver export and store it in `backups/pulllist/` alongside `dump-postgres-202605302059.backup`.
> **Paste:** the saved filename (or "skipped — accepted risk").

**3.2 — Run the import (Rick-in-the-loop, prod write).**
> **PAUSE → Rick runs the real import** (maintenance OFF, normal cadence), current-week catalog + shipment CSVs, **no `--no-write`**:
> ```
> node scripts/import.js "<lunar_catalog.csv>" "<prh_catalog.csv>" "<lunar_shipment.csv>" "<prh_shipment.csv>"
> ```
> Answer the prompts: catalog-month confirm as the script reports it; shipment **y**; notify — **Rick's call** (notify **y** is allowed now that maintenance is off and this is normal cadence; notify **n** if it is a mid-cycle shipment-only run with nothing new to announce).
> **Paste:** full stdout/stderr, the exit code, and the printed counts (auto-fulfill; usage_events purged; if new month: archived / purged-stale / dropped-catalog / auto-reserve counts).

**3.3 — Post-import verification (Rick-in-the-loop, prod SQL Editor).** `:TID` = prod founding UUID; `:MONTH` = imported `YYYY-MM`.
> **PAUSE → Rick runs:**
> ```sql
> -- catalog upserted, all founding tenant_id
> SELECT count(*) AS catalog_rows, count(*) FILTER (WHERE tenant_id = ':TID') AS with_tid
> FROM catalog WHERE catalog_month = ':MONTH';
> -- shipment rows all founding tenant_id
> SELECT count(*) AS shipment_rows, count(*) FILTER (WHERE tenant_id = ':TID') AS with_tid
> FROM weekly_shipment;
> -- any foreign / null tenant_id introduced by the import? (must be zero everywhere)
> SELECT 'preorders' AS tbl, count(*) AS bad FROM preorders WHERE tenant_id IS NULL OR tenant_id <> ':TID'
> UNION ALL SELECT 'catalog',         count(*) FROM catalog         WHERE tenant_id IS NULL OR tenant_id <> ':TID'
> UNION ALL SELECT 'weekly_shipment', count(*) FROM weekly_shipment WHERE tenant_id IS NULL OR tenant_id <> ':TID'
> UNION ALL SELECT 'subscriptions',   count(*) FROM subscriptions   WHERE tenant_id IS NULL OR tenant_id <> ':TID';
> ```
> **Paste:** the two count pairs + the `bad` table.
> **Expected:** `with_tid == total` in each pair; every `bad` = 0; § 3.2 exit code 0; no "function does not exist" / RLS / NOT-NULL errors in stdout; only the known unmatched-shipment-row warnings on stderr.
> **STOP if:** any `bad > 0`, any `with_tid < total`, any schema error, or non-zero exit → file F60 (§ 5); forward-fix per Tier-3; ledger verdict `red`.

Record the import outcome (exit code, counts, month, new-month-or-not) in the ledger.

---

## 4. Daily soak monitoring (repeat each calendar day until the close gate)

Run this block **once per calendar day** the soak is open. It is the F59-class early-warning system: the failure 4.7 most needs to catch is **silent write failure** (app deployed but writes not persisting / mis-tagged), exactly the F59 pattern. The centerpiece is "are new customer writes landing, and are they all founding-tenant-tagged."

**4.0 — Day-1 column confirmation (run once, first monitoring day; do not infer schema).**
> **PAUSE → Rick (prod SQL Editor):**
> ```sql
> SELECT column_name FROM information_schema.columns
> WHERE table_schema='public' AND table_name IN ('preorders','usage_events')
>   AND column_name IN ('created_at','reserved_at','inserted_at','tenant_id')
> ORDER BY table_name, column_name;
> ```
> **Paste:** the column list.
> **Use:** the actual timestamp column name in the `INTERVAL '24 hours'` filters below (the queries assume `created_at`; if the live column differs, substitute it). If neither table has a usable insert-timestamp, fall back to running-total deltas (query 4 below) day-over-day instead of a 24h window.

**4.1 — Daily prod monitoring (Rick-in-the-loop, prod SQL Editor).**
> **PAUSE → Rick runs:**
> ```sql
> -- (1) F59 SIGNAL: new customer writes in the last 24h, all founding-tagged
> SELECT count(*) AS new_preorders_24h,
>        count(*) FILTER (WHERE tenant_id = ':TID')                       AS with_founding_tid,
>        count(*) FILTER (WHERE tenant_id IS NULL OR tenant_id <> ':TID') AS bad_tid
> FROM preorders WHERE created_at >= NOW() - INTERVAL '24 hours';
>
> -- (2) single-tenant invariant: zero foreign/null tenant_id anywhere
> SELECT 'preorders' AS tbl,   count(*) AS foreign_or_null FROM preorders     WHERE tenant_id IS NULL OR tenant_id <> ':TID'
> UNION ALL SELECT 'subscriptions',   count(*) FROM subscriptions   WHERE tenant_id IS NULL OR tenant_id <> ':TID'
> UNION ALL SELECT 'catalog',         count(*) FROM catalog         WHERE tenant_id IS NULL OR tenant_id <> ':TID'
> UNION ALL SELECT 'weekly_shipment', count(*) FROM weekly_shipment WHERE tenant_id IS NULL OR tenant_id <> ':TID'
> UNION ALL SELECT 'usage_events',    count(*) FROM usage_events    WHERE tenant_id IS NULL OR tenant_id <> ':TID'
> UNION ALL SELECT 'user_profiles',   count(*) FROM user_profiles   WHERE tenant_id IS NULL OR tenant_id <> ':TID';
>
> -- (3) telemetry alive: usage_events still flowing
> SELECT count(*) AS usage_events_24h FROM usage_events WHERE created_at >= NOW() - INTERVAL '24 hours';
>
> -- (4) running totals (delta audit vs the cutover snapshot / prior ledger day)
> SELECT (SELECT count(*) FROM preorders)     AS preorders_total,
>        (SELECT count(*) FROM subscriptions) AS subs_total,
>        (SELECT count(*) FROM user_profiles) AS profiles_total,
>        (SELECT count(*) FROM catalog)       AS catalog_total;
> ```
> **Paste:** all four result sets.
> **Expected:** `bad_tid = 0` and every query-(2) `foreign_or_null = 0`; `new_preorders_24h ≥ 0` (and **> 0 on store-active days** — a sustained zero across active days is the F59 smell, investigate); totals move only by plausible customer-driven deltas (no unexplained drops).
> **STOP / `red` if:** any `bad_tid > 0` or any query-(2) row `> 0` (tenant mis-tagging = active correctness bug), or totals **dropped** unexpectedly (data loss). File F60 (§ 5).

**4.2 — Edge Function + Auth error scan (Rick, Supabase dashboard).**
> **PAUSE → Rick (Supabase dashboard → prod project):**
> - Edge Functions → Logs (last 24h) for the 8 functions — scan for non-2xx spikes / unhandled errors.
> - Auth → Logs — scan for elevated failed sign-ins / "Database error finding users" 500s (known intermittent — `CLAUDE.md` Gotchas; note frequency, don't alarm on a single occurrence).
> **Paste:** a one-line summary per area (e.g. "EF: clean, no errors"; "Auth: 2 failed sign-ins, both bad-password, normal").
> **Expected:** no error spikes; no new error class.
> **`watch` / `red` if:** a recurring EF 5xx or a new error signature → note in ledger; escalate to F60 if it implies a customer-facing break.

**4.3 — Customer-reported issues (Rick).** Rick reports any store/customer complaints since the last check (mis-shows on My List, missing reservations, email problems). Zero is the expected steady state post-F59-recovery. Any report → ledger `watch`/`red` + F60 if confirmed.

Append the day's row to the Soak Ledger (§ 10) with the verdict, and commit (doc-only → `staging`).

---

## 5. Discovered-during-soak handling (file, don't fix inline)

A soak observes. When a defect surfaces:
1. **Stop** — do not fix inline (anti-drift; § 0.2). Maintenance is off, so this is Tier-3: forward-fix only, and only with Rick's explicit go-ahead.
2. **Describe** it in the ledger row (`red`) and add a row to `phase-4-production-migration.md` § *Discovered During Soak* (next number after 2).
3. **File** in `technical-reference.md` § 13 using the next free ID — **F60** first (verify F59 is still the highest before assigning). Severity, root cause, where, status.
4. **Ask Rick**: (a) forward-fix now as its own commit/sub-deploy, (b) file for the 4.8 housekeeping pass, or (c) accept-and-defer with a written owner. Wait for the answer.
5. A `red` finding **holds the close gate open** until resolved or explicitly deferred-with-owner.

---

## 6. Closeout — runs once, **only** when the close gate is met

**Close gate (all must hold):**
- Date ≥ **2026-06-08** (7 calendar days from maintenance-off 2026-05-31 fully elapsed — a one-week soak means seven calendar days, not "green so far at day 4"; `CLAUDE.md` Merge Gate).
- Ledger (§ 10) has a row for **every** calendar day 2026-05-31 → close, none `red`/unresolved.
- § 3 first post-recovery import recorded clean.
- No open customer-reported issue.

If any gate item is unmet, **do not close** — append today's ledger row and stop.

### 6.1 Tear down the staging canary (Rick-in-the-loop, staging SQL)
Use `docs/phase-4.1-canary-procedure.md` § *Teardown* verbatim, substituting the UUIDs from `scripts/phase-4.1-canary-uuids.txt`.
> **PAUSE → Rick runs the teardown SQL (staging SQL Editor)** in the documented FK order, then the verification block:
> ```sql
> SELECT tenant_id, COUNT(*) FROM user_profiles GROUP BY tenant_id ORDER BY count DESC;
> SELECT COUNT(*) AS canary_tenant_rows FROM tenants WHERE id = '<CANARY_TENANT_ID>'::uuid;
> ```
> **Paste:** both results.
> **Expected:** founding tenant only in the grouping; `canary_tenant_rows = 0`.
> **STOP if:** any canary row remains — the Merge Gate requires a **live SELECT returning zero rows**, not "we ran the teardown." Re-run teardown until zero.

### 6.2 Phase 4.7 completion criteria (all must be checked)
- [ ] Seven calendar days elapsed since maintenance-off (date ≥ 2026-06-08)
- [ ] Soak Ledger (§ 10) complete for every day 2026-05-31 → close; no unresolved `red`
- [ ] First post-recovery Tuesday import (§ 3) ran clean: exit 0, all `with_tid == total`, zero foreign/null tenant_id, no schema errors
- [ ] F59-class signal absent across the soak: new customer writes landed with founding tenant_id on active days; no silent write-failure pattern
- [ ] No open customer-reported issue
- [ ] Edge Function + Auth logs showed no new error class across the soak
- [ ] Staging canary torn down — live SELECT returns zero canary rows (§ 6.1)
- [ ] Any F60+ soak finding filed and either resolved or explicitly deferred with a named owner
- [ ] F59 recovery dump (`backups/pulllist/dump-postgres-202605302059.backup`) retention decided (§ 6.4)
- [ ] Parent Sub-Deploys table row 4.7 → **Complete** + close date
- [ ] `CLAUDE.md` § Current Migration Phase active sub-deploy pointer advanced to **4.8**
- [ ] Parent Sub-Deploys table gains a **4.8** row (`Planning`, plan = `phase-4.8-post-cutover-housekeeping.md`) — the 4.8 *plan file itself is written in the next session* from Appendix A, per the "plan written after previous closes" convention

> **4.7 closes the soak only.** Phase 4 overall (`phase-4-production-migration.md` § Phase Completion Criteria) stays open pending 4.8 (clears F55/F56/F57 + structural diff) and the remaining phase-level items (post-cutover dump stored, `pre-multitenancy-state.md` Phase 4 notes, Phase 5 stub). Do not tick Phase-4-level boxes here.

### 6.3 Doc updates + pointer advance (Claude; doc-only → `staging`)
- `phase-4-production-migration.md` Sub-Deploys table: row 4.7 → **Complete** + date; add row 4.8 → **Planning** / `phase-4.8-post-cutover-housekeeping.md`.
- `CLAUDE.md` § Current Migration Phase: Phase 4 status line — mark 4.7 closed + date; active sub-deploy → **4.8**.
- `technical-reference.md` § 13: append any F60+ filed during soak with final status.
- This file: fill the Soak Ledger (§ 10) final summary row and the § 6.2 checkboxes.

Commit:
```
docs: close Phase 4.7 (post-cutover soak); advance pointer to 4.8 housekeeping
```

### 6.4 F59 recovery-dump retention
The F59 source dump was retained "until soak closes." At closeout, **either** archive it permanently alongside the 2026-04-29 `pre-multitenancy-v1` snapshot and the post-cutover dump (parent completion criterion — recovery anchors), **or** confirm a post-cutover dump already supersedes it before removing. Record the decision in the ledger. Default: **keep** — disk is cheap, store-wide-loss recovery evidence is not.

---

## 7. Out of scope (anti-drift — surface as findings, do not fix inline)

- **4.8 post-cutover housekeeping** (F55 analytics views, F56 `claim_paper_account`, F57 `generate_invite_link`) — `phase-4.6…` **Appendix A**. **NOT executed in 4.7.** 4.7 closeout only *opens* the 4.8 row; the 4.8 plan + execution is a separate session.
- **Any schema / RLS / function change on prod or staging** — a soak does not migrate. Tier-3 forward-fixes only with explicit Rick sign-off, as their own commit.
- **App-code / Edge-Function source edits**, any `main`-bound push — none in 4.7.
- **F58** (staging `user_profiles` admin-write policy) — staging-reconcile item, not a soak step.
- **Phase-4-level completion items** (structural diff, post-cutover dump as a phase anchor, `pre-multitenancy-state.md` Phase 4 notes, Phase 5 stub) — closed at *Phase 4* completion after 4.8, not here.
- **Customer notification policy** beyond the normal Tuesday-cadence prompt in § 3 — no extra blasts.

If something seems related but isn't listed IN scope (§§ 2–6), **stop and ask** per `CLAUDE.md` anti-drift.

---

## 8. Rollback posture

The entire soak is **past maintenance-off** ⇒ parent § Rollback **Tier-3** governs everything here: **forward-fix only.** Customer preorders/subscriptions/`usage_events` now exist under the new RLS + NOT-NULL schema; restoring a pre-cutover backup loses every write since cutover, and reverting the app code reintroduces the F59 null-tenant_id failure. Any soak defect is hot-patched forward and promoted to a finding — never rolled back destructively. The only "rollback" in 4.7 is the **canary teardown** on staging (§ 6.1), which touches no production data.

---

## 9. References
- Parent: `docs/phase-4-production-migration.md` — In-Scope 4.7 (161–162), Completion Criteria (184–202), Discovered During Soak (224–229), Rollback Tier-3 (255–264).
- `docs/phase-4.6-edge-functions-cutover.md` — § 14 deploy log (cutover baseline counts); **Appendix A** (4.8 scope, not executed here).
- `docs/phase-4.1-canary-procedure.md` — canary spin-up (§ 2) + teardown (§ 6.1) template.
- `docs/technical-reference.md` § 13 — F59–F62 (all closed); next free **F63**.
- `CLAUDE.md` — Merge Gate (soak-day discipline, zero-row teardown verify), Smoke Test Suite, deployment workflow (F59 prevention).
- Prod project ref `plgegklqtdjxeglvyjte`; prod founding UUID in `scripts/phase-4-prod-tenant-uuid.txt` (gitignored). Staging ref `puoaiyezsreowpwxzxhj`; staging founding `72e29f67-39f7-42bc-a4d5-d6f992f9d790`.

---

## 10. Soak Ledger (append one row per calendar day; commit after each update)

**Soak window:** start `2026-05-31` (maintenance off) · earliest close `2026-06-08` (7 calendar days elapsed).
**Verdict key:** `green` = all checks pass · `watch` = minor signal, no defect confirmed · `red` = active unresolved defect (holds close gate).

| Day | new_preorders_24h (founding/bad) | foreign/null tenant_id (any table) | usage_events_24h | EF / Auth logs | Customer issues | Import (if any) | Verdict | Notes |
|---|---|---|---|---|---|---|---|---|
| 2026-05-31 | — | — | — | — | — | exit 0; 2306/2306 catalog, 325/325 preorders, 486/486 shipment (4.6 § 14) | green | Maintenance off; first prod import clean (cutover). |
| 2026-06-01 | — | — | — | — | F59 (330 lost reservations) | — | watch→resolved | F59 discovered **and recovered same window** (330 rows restored; Brian Moss ✓). Closed in § 13. |
| 2026-06-02 | 49 (49/0) | 0 all tables | 64 | EF: clean; Auth: admin login + token activity only (Brave/iOS + Chrome) | F60 (notify auth, resolved); F61 (Brave/iOS confirm, →4.8) | June 2026 new month; 2333 records (1358L+975P); notify ✓ 8/0; 2 auto-reserves; shipment 41 rows; exit 0 | watch→resolved | Canary respun ✓; PRH catalog initially missing (wrong file, fixed on re-run); notify-customers auth fixed (F60 deployed); F61 filed →4.8. |
| 2026-06-03 | | | | | | | | |
| 2026-06-04 | | | | | | | | |
| 2026-06-05 | | | | | | | | |
| 2026-06-06 | | | | | | | | |
| 2026-06-07 | | | | | | | | |
| 2026-06-08 (close eval) | | | | | | | | Closeout § 6 if gate met. |
| 2026-06-10 | | | | EF: F62 discovered (send-my-list 403 on admin email); fixed + redeployed | F62 (send-my-list admin 403, resolved) | — | watch→resolved | Admin "This Week" send-email button broken since F54 fix; admin bypass added; redeployed to prod. |

---

**Last updated:** 2026-06-10 (F62 discovered and fixed — send-my-list admin identity-check bypass; redeployment required).
