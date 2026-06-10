# Phase 4.6 — Edge Functions redeploy + first prod import + maintenance off

**Status:** Planning — plan/runbook drafted 2026-05-31. Flip parent-plan row 4.6 → **Complete** on execution.
**Sign-offs (Rick, 2026-05-31):** (1) `--no-write` flag added to local `import.js` at 4.6 execution start — **approved**. (2) F55 analytics views deferred to post-cutover housekeeping + parent structural-diff criterion annotated — **approved**. Pre-session doc commits **not assumed** — § 0.4 verifies-or-fixes regardless of state.
**Parent plan:** `docs/phase-4-production-migration.md` (sub-deploy row 4.6)
**Branches:**
- Migration-artifact PR: `feat/phase-4-prod-cutover` (production repo; holds the 4.2–4.4 SQL artifacts, committed and held — its PR to `main` is opened by Rick at end of window).
- App-code promotion: standard `staging → main` merge producing `feat/<desc>-prod`, PR opened by Rick per `CLAUDE.md` deployment workflow.
- Doc-only edits this sub-deploy: committed directly to `staging`.
**Cutover-window slot:** Sat evening (4.6 part 1) → Sun morning/afternoon (4.6 part 2). Final active sub-deploy in the window; 4.7 is soak only.
**Execution model:** **CLI-orchestrated, Rick-in-the-loop.** A Claude Code CLI session runs this top to bottom. It executes every repo / doc / source-prep / Edge-Function-deploy-prep step itself, and **pauses at every production-affecting step** — production SQL, `supabase` CLI deploys against the prod project, secret writes, and any push toward `main` — handing the exact command to Rick and waiting for pasted output before continuing. **Self-contained — no chat context required.**

> **Production-affecting steps Claude never runs itself.** Production SQL (handed to the Supabase **prod** SQL Editor), `supabase functions deploy … --project-ref plgegklqtdjxeglvyjte`, `supabase secrets set … --project-ref plgegklqtdjxeglvyjte`, and any push to a `main`-bound branch / PR. Each appears below as a **`PAUSE → Rick runs → paste result → match expected → continue/STOP`** block. Claude prepares everything around them (checkouts, source copies, local merge prep, the exact command text) but does not execute them.

---

## 0. Pre-flight (Claude executes; halt on any mismatch)

### 0.1 Read before doing anything
- `docs/phase-4-production-migration.md` — §§ *Sub-Deploys*, *Cutover window sequencing*, *Dry-Run Validation Gate*, *In Scope 4.6*, *Rollback Decision Tree*.
- `docs/phase-4.4-prod-schema-rls.md` — F55 carve-out; F34/F4 routed-to-4.6 notes; Decision B (`user_profiles` admin-write retained on prod).
- `docs/phase-4.5-prod-import-merge.md` — patch inventory P1–P16; the post-P11 builder extraction; V1–V6 results.
- `docs/technical-reference.md` § 13 — findings index. **Highest filed = F59** (filed + closed 2026-06-01; F59 = cutover-window reservation data loss, recovered). Do not assign new IDs in 4.6 unless a genuine new defect surfaces.
- `CLAUDE.md` — § *Current Migration Phase*, § *Edge Functions* (8 names + `FOUNDING_TENANT_ID` secret), deployment workflow.

### 0.2 Files Claude must NOT touch
- `scripts/import.js` — **one exception**: the `--no-write` flag in § 3.1 below (local, gitignored, no commit). Nothing else.
- `scripts/import-staging.js`, `scripts/config.js`, `scripts/phase-4-prod-tenant-uuid.txt` — never edit, never echo contents.
- Any `supabase/functions/**` source — redeploy only; **no source edits** in 4.6.
- Production database — only via the Rick-in-the-loop SQL blocks below.

### 0.3 Environment facts confirmed during planning
- Prod Supabase project ref: `plgegklqtdjxeglvyjte`.
- Prod founding tenant UUID: lives in `scripts/phase-4-prod-tenant-uuid.txt` (gitignored). Ties to admin user `734bfd7e-23a6-4c23-ba35-1f64843603c0` ("Book Stop"). **Never** the staging literal `72e29f67-39f7-42bc-a4d5-d6f992f9d790`.
- 8 Edge Functions: `notify-customers`, `create-paper-customer`, `invite-customer`, `register-customer`, `send-my-list`, `claim-paper-customer`, `approve-customer`, `reset-password`. All committed to repo `supabase/functions/` (F52 resolved 2026-05-27).
- EF deploy workflow (F52): copy repo source → `C:\Users\richa\supabase\functions\<name>` → deploy from CLI project root.
- Maintenance mode is **ON** (since 4.2 pre-flight) and **stays ON** until § 7.

### 0.4 Idempotent doc-state reconciliation (verify-or-fix; doc-only → `staging`)
The pre-session commits may or may not have landed. Verify each; if already in the target state, skip; if not, apply as a single doc-only commit to `staging`.

| Check | Target state | Fix if absent |
|---|---|---|
| `phase-4-production-migration.md` line ~152 | "16 … patches"; one-line note that the `CLAUDE.md` line-431–449 carry-forward list was stale and the 4.5 runbook's file diff is authoritative | edit text |
| `phase-4-production-migration.md` Sub-Deploys table, row 4.5 | `Complete` / `2026-05-31` | edit row |
| same table, row 4.6 | `Planning` / plan = `phase-4.6-edge-functions-cutover.md` | edit row |
| same table, row 4.4 **title** | drop "analytics views" from the title (carved out per F55) **or** leave title and rely on the § 6 structural-diff annotation | see § 6 — annotate, do not silently claim done |
| `CLAUDE.md` § Current Migration Phase line 13 | active sub-deploy = **4.6**; remove "plan not yet written" | edit pointer |
| `docs/phase-4.5-prod-import-merge.md` (runbook + plan) | committed to `staging` (not untracked) | `git add` + commit if untracked |

Commit message if any fix applied:
```
docs: reconcile 4.5→4.6 sub-deploy pointers and 16-patch count pre-4.6
```

### 0.5 Pre-flight gates (halt if any fail)
- `git rev-parse --abbrev-ref HEAD` → on `staging`.
- `test -f scripts/phase-4-prod-tenant-uuid.txt` → exists and non-empty (do not print contents).
- `ls supabase/functions/` → all 8 function directories present.
- Capture the staging HEAD SHA to deploy EF sources from a pinned point (satisfies parent line 155 "staging tagged commit"):
  ```
  git rev-parse HEAD > /tmp/phase-4.6-staging-sha.txt
  ```
  Record this SHA in § 8 deploy log. All 8 EF deploys and the app-code merge derive from this exact commit.

---

## PART 1 — Edge Functions, secret, dry-run gate, app-code merge (no real write yet)

## 1. Set `FOUNDING_TENANT_ID` secret on prod  *(Rick-in-the-loop — secret write)*

Claude prepares the command using the UUID **path**, never the value:

> **PAUSE → Rick runs in his authenticated terminal:**
> ```
> supabase secrets set FOUNDING_TENANT_ID="$(cat scripts/phase-4-prod-tenant-uuid.txt)" --project-ref plgegklqtdjxeglvyjte
> ```
> **Then verify (does not reveal the value):**
> ```
> supabase secrets list --project-ref plgegklqtdjxeglvyjte
> ```
> **Paste:** the `secrets list` output.
> **Expected:** a row named `FOUNDING_TENANT_ID` present (digest only).
> **STOP if:** the name is absent. The tenant-aware EFs (F34, F51) cannot resolve without it.

This is the prerequisite for item-1 resolution of **F34** (EF tenant resolution).

---

## 2. Redeploy all 8 Edge Functions to prod from the pinned staging SHA  *(Rick-in-the-loop — prod deploy)*

Claude executes the source prep, then hands deploys to Rick.

**Claude (repo prep):**
```
git checkout $(cat /tmp/phase-4.6-staging-sha.txt) -- supabase/functions
# copy each function source into the supabase CLI project tree
for fn in notify-customers create-paper-customer invite-customer register-customer \
          send-my-list claim-paper-customer approve-customer reset-password; do
  cp -R "supabase/functions/$fn" "C:/Users/richa/supabase/functions/$fn"
done
git checkout staging -- supabase/functions   # restore working tree
```

> **PAUSE → Rick runs (from the supabase CLI project root), one per function:**
> ```
> supabase functions deploy notify-customers     --project-ref plgegklqtdjxeglvyjte
> supabase functions deploy create-paper-customer --project-ref plgegklqtdjxeglvyjte
> supabase functions deploy invite-customer       --project-ref plgegklqtdjxeglvyjte
> supabase functions deploy register-customer     --project-ref plgegklqtdjxeglvyjte
> supabase functions deploy send-my-list          --project-ref plgegklqtdjxeglvyjte
> supabase functions deploy claim-paper-customer  --project-ref plgegklqtdjxeglvyjte
> supabase functions deploy approve-customer       --project-ref plgegklqtdjxeglvyjte
> supabase functions deploy reset-password         --project-ref plgegklqtdjxeglvyjte
> ```
> **Paste:** the 8 deploy confirmations (each prints a deployed-version line).
> **Expected:** 8 successful deploys, no error.
> **STOP if:** any deploy errors. Per § Rollback, 4.6-part-1 rollback = redeploy the prior tagged version; window pauses for post-mortem.

**Post-deploy platform settings to confirm (Rick, Supabase dashboard → Edge Functions):**
- `create-paper-customer`: JWT verification **OFF** (F53) — in-body auth is the gate.
- `notify-customers`: JWT verification **ON** is acceptable (F47 added in-body auth as defense-in-depth); confirm in-body admin auth path is the deployed one from the pinned SHA.

> **PAUSE → Rick confirms** the two toggles match the above and pastes a one-line "confirmed."

Records resolution of **F34** (with § 1 secret) and preserves the F47/F50/F51/F53/F54 hardening shipped in 4.1.

---

## 3. Dry-run validation gate  *(two-track; Track 1 Claude-local, Track 2 Rick-in-the-loop)*

The parent-plan gate (§ *Dry-Run Validation Gate*, lines 110–116) is **locked**. It cannot be weakened. Neither a write-skipping script run nor a SQL transaction alone covers all of it, so this gate runs **two complementary tracks** and a **mapping check**. **Any failed check = Tier-1 rollback** (maintenance stays ON; window aborts; post-mortem).

### Gate-bullet → check mapping (every locked bullet covered; zero persisted prod writes)

| # | Locked gate bullet (parent 110–116) | Covered by |
|---|---|---|
| 1 | 3 catalog RPCs resolve signatures, no "function does not exist" | G1 (pg_proc) + G2 (txn calls them) |
| 2 | Catalog upsert resolves w/o auth/RLS/on_conflict errors | G3 (idempotent REST self-upsert) + G2 (txn upsert) |
| 3 | Auto-reserve fetch returns expected count vs snapshot, scaled to month | G4 (read-only count) |
| 4 | `auto_fulfill_past_on_sale` + `purge_old_usage_events` RPCs resolve | G1 (signatures) + G1b (`service_role` grant) + G5 (no-op REST `purge` call) + G2 (txn `auto_fulfill`) |
| 5 | Shipment upsert paths (Lunar upsert; PRH delete-then-insert) resolve | G2 (txn exercises both) |
| 6 | Zero unexpected stderr | Track 1 (`--no-write` run) |
| 7 | Exit code 0 | Track 1 (`--no-write` run) |

Known-expected, non-failing Track-1 stderr (document, do not treat as failure): `⚠️ Unmatched Lunar/PRH` rows for shipment lines absent from the current-month catalog.

### Track 1 — `--no-write` script run *(Claude-local; covers bullets 6, 7, read paths, row construction)*

**3.1 Add the `--no-write` flag to `scripts/import.js`** (local, gitignored, **no commit**; in scope per parent line 156; HIGH-RISK — verify with V-checks). The flag short-circuits every state-changing fetch to a log line and runs all reads normally.

Add near the top of `main()` arg parsing:
```js
const NO_WRITE = process.argv.includes('--no-write');
```
Wrap each state-changing `fetch` (every `POST`/`PATCH`/`DELETE` to `/rest/v1/...`, every `/rest/v1/rpc/...` call, and the `/functions/v1/notify-customers` call) with a guard helper. Add once, above `main()`:
```js
async function writeFetch(url, opts, label) {
  if (NO_WRITE) {
    const n = (() => { try { return JSON.parse(opts.body).length ?? 1; } catch { return 1; } })();
    console.log(`   [no-write] would ${opts.method || 'POST'} ${n} row(s) → ${label}`);
    return { ok: true, json: async () => ([]), text: async () => '' };
  }
  return fetch(url, opts);
}
```
Replace the write-side `fetch(...)` calls (catalog upsert, the 3 catalog RPCs, auto-reserve insert, both shipment upsert branches, PRH delete, `purge_old_usage_events`, `auto_fulfill_past_on_sale`, notify) with `writeFetch(..., '<label>')`. **Leave all read `fetch` calls untouched** (catalog month check, subscriptions fetch, `buildCatalogIdMap` lookups, auto-reserve count). Use prod's existing 4-space indentation; introduce no staging whitespace (Bucket-3 discipline from 4.5).

**3.2 Local verification of the flag (Claude):**
- `node --check scripts/import.js` → exit 0.
- Grep confirms `writeFetch(` wraps every write site and `--no-write` is parsed.

**3.3 Run the dry-run** against prod reads, with current-week catalog CSVs staged but writes suppressed:
```
node scripts/import.js "<lunar_catalog.csv>" "<prh_catalog.csv>" "<lunar_shipment.csv>" "<prh_shipment.csv>" --no-write
```
- **Expected:** exit code 0; every write logged as `[no-write] would …`; reads (catalog month, subscriptions count, catalog-ID match rates) print real numbers; only the known unmatched-row warnings (above) on stderr.
- **STOP if:** non-zero exit, an unexpected stderr line, or any read fetch errors (auth/RLS on a read = a real problem). Tier-1 rollback.

### Track 2 — Live-schema probes *(Rick-in-the-loop; covers bullets 1–5 against the real post-4.4 schema, zero persisted writes)*

> **PAUSE → Rick runs in the prod SQL Editor. Substitute `:TID` with the prod founding UUID from the scratch file; `:MONTH` with the current `YYYY-MM`.**

**G1 — RPC signatures exist with the post-4.4 shape:**
```sql
SELECT proname, pg_get_function_identity_arguments(oid) AS args
FROM pg_proc
WHERE proname IN (
  'archive_stale_reservations','purge_stale_catalog','delete_dropped_catalog_items',
  'auto_fulfill_past_on_sale','purge_old_usage_events','current_tenant_id','current_user_is_admin'
)
ORDER BY proname;
```
- **Expected:** the 3 catalog RPCs each show `p_tenant_id uuid` as first arg; `auto_fulfill_past_on_sale(p_tenant_id uuid)`; `purge_old_usage_events(p_tenant_id uuid, p_retention_days …)`; both helpers present. No old 2-arg catalog signatures.

**G1b — `service_role` can execute the two service-role-only RPCs (the REST path uses this role):**
```sql
SELECT has_function_privilege('service_role','public.auto_fulfill_past_on_sale(uuid)','EXECUTE') AS auto_fulfill,
       has_function_privilege('service_role','public.purge_old_usage_events(uuid,integer)','EXECUTE') AS purge_usage;
```
- **Expected:** both `true`. (If `purge_old_usage_events` arg types differ, adjust the signature string to the one G1 printed.)

**G2 — body / RLS / constraint execution, rolled back (no persisted writes):**
```sql
BEGIN;
-- catalog upsert path: RLS + (tenant_id,item_code,distributor,catalog_month) conflict key
INSERT INTO catalog (tenant_id, distributor, item_code, title, catalog_month)
VALUES (':TID','PRH','PROBE-DRYRUN-0001','__dryrun probe__',':MONTH')
ON CONFLICT (tenant_id, item_code, distributor, catalog_month) DO UPDATE SET title = EXCLUDED.title;

-- the 3 catalog RPCs (bodies execute under current RLS)
SELECT public.archive_stale_reservations(':TID', CURRENT_DATE, ':MONTH');
SELECT public.purge_stale_catalog(':TID', CURRENT_DATE, ':MONTH');
SELECT public.delete_dropped_catalog_items(':TID', ':MONTH', ARRAY['PROBE-DRYRUN-0001']);

-- the two service-role RPCs
SELECT public.auto_fulfill_past_on_sale(':TID');
SELECT public.purge_old_usage_events(':TID', 99999);

-- shipment paths: Lunar upsert + PRH delete-then-insert
INSERT INTO weekly_shipment (tenant_id, distributor, upc, on_sale_date, title, quantity)
VALUES (':TID','Lunar','000000000000', CURRENT_DATE, '__dryrun lunar__', 1)
ON CONFLICT (distributor, upc, on_sale_date) DO UPDATE SET quantity = EXCLUDED.quantity;
DELETE FROM weekly_shipment WHERE tenant_id=':TID' AND distributor='PRH' AND on_sale_date=CURRENT_DATE;
INSERT INTO weekly_shipment (tenant_id, distributor, item_code, on_sale_date, title, quantity)
VALUES (':TID','PRH','PROBE-PRH-0001', CURRENT_DATE, '__dryrun prh__', 1);
ROLLBACK;
```
- **Expected:** every statement returns without error; final `ROLLBACK` confirmed. No row persists.
- **STOP if:** any statement raises (missing function, RLS denial, constraint/conflict error, NOT-NULL violation). That is the exact class of failure the gate exists to catch — Tier-1 rollback.

> **PAUSE → Rick runs via service-role REST (his terminal; reads + two no-op writes). `:KEY` = service-role key, `:UUID` = prod founding UUID.**

**G3 — REST `on_conflict` translation (idempotent self-upsert of an existing row → no net change):** first read one real current-month catalog row, then re-upsert it onto itself.
```
# read one existing row
curl -s "https://plgegklqtdjxeglvyjte.supabase.co/rest/v1/catalog?tenant_id=eq.:UUID&catalog_month=eq.:MONTH&select=tenant_id,distributor,item_code,title,catalog_month&limit=1" \
  -H "apikey: :KEY" -H "Authorization: Bearer :KEY"
# re-upsert that exact row (paste its fields into the body) — merges identical → no net change
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://plgegklqtdjxeglvyjte.supabase.co/rest/v1/catalog?on_conflict=tenant_id,item_code,distributor,catalog_month" \
  -H "apikey: :KEY" -H "Authorization: Bearer :KEY" -H "Content-Type: application/json" \
  -H "Prefer: resolution=merge-duplicates,return=minimal" \
  -d '[ <the row just read> ]'
```
- **Expected:** read returns one row; upsert returns `201`/`204`, empty body, no conflict error.

**G5 — service-role → PostgREST → RPC round-trip, guaranteed no-op (273-yr retention deletes nothing):**
```
curl -s -w "\n%{http_code}\n" \
  "https://plgegklqtdjxeglvyjte.supabase.co/rest/v1/rpc/purge_old_usage_events" \
  -H "apikey: :KEY" -H "Authorization: Bearer :KEY" -H "Content-Type: application/json" \
  -d '{"p_tenant_id":":UUID","p_retention_days":99999}'
```
- **Expected:** `200`, returns `0` (rows purged). Confirms the live REST+service_role+signature path the script uses.

**G4 — auto-reserve count sanity (read-only):**
```sql
SELECT count(*) AS sub_count FROM subscriptions WHERE tenant_id = ':TID';
```
- **Expected:** matches the pre-cutover snapshot's `subscriptions` count (scaled to current month per the gate). Compare against the snapshot figure recorded at 4.2 pre-flight.

> **Paste:** outputs of G1, G1b, G2 (incl. the `ROLLBACK`), G3, G5, G4.
> **Gate verdict:** all green → proceed. Any red → **Tier-1 rollback**, maintenance stays ON, window aborts.

---

## 4. App-code promotion: `staging → main` merge  *(Claude preps locally; Rick pushes + opens PR)*

**Sequencing (settled):** the merge lands **before** the first real import, and is **bound to before maintenance-off** — placed here so § 5 Playwright tests the deployed new code. The post-Phase-3.3 app code passes `tenant_id` explicitly on every write; running old app code against the new NOT-NULL schema once maintenance is off would fail with `null value in column "tenant_id"`.

**Claude (local merge prep, per `CLAUDE.md` workflow — never pushes to `main`):**
```
git checkout main
git pull origin main
git merge staging --no-commit --no-ff
git checkout main -- config.js          # preserve prod credentials (config.js tracked per-branch)
# Verify config.js is NOT in the staged diff:
git diff --cached --name-only | grep -x 'config.js' && echo "ABORT: config.js staged" || echo "ok: config.js preserved"
# Assert critical app files actually changed (catches merge-base regression — see F59):
for f in app.js mylist.html arrivals.html admin.html; do
  if ! git diff --quiet "main:$f" "staging:$f"; then
    echo "ok: $f differs from main (will update)"
  else
    echo "WARN: $f identical to main — verify this is expected, NOT a merge-base regression"
  fi
done
git commit -m "feat: promote Phase 2–3.8 tenant-aware app code to production (Phase 4.6)"
git checkout -b feat/phase-4.6-appcode-prod
```
- **STOP if:** `config.js` appears in the diff. Do not proceed.

> **PAUSE → Rick:** push the feat branch and open the PR to `main` (Rick owns all `main`-bound pushes/PRs):
> ```
> git push origin feat/phase-4.6-appcode-prod
> ```
> Open PR `feat/phase-4.6-appcode-prod → main`; **verify `config.js` is not in the PR diff**; merge when satisfied.
> Also open/merge the held migration-artifact PR `feat/phase-4-prod-cutover → main` (records the 4.2–4.4 SQL already applied to the prod DB).
> **Paste:** confirmation both PRs are merged to `main`.
> **Expected:** prod GitHub Pages now serves the tenant-aware app code; `config.js` unchanged (prod creds intact).

---

## PART 2 — Playwright, first real import, maintenance off, F4 drop, tags

## 5. Full Playwright suite against prod (headed)  *(Rick-in-the-loop — runs against live prod)*

Runs after EF deploy + app-code merge, **before** maintenance-off and before the first real import.

> **PAUSE → Rick runs the prod-targeted Playwright suite in headed mode** (prod base URL, founding-tenant fixtures).
> **Paste:** the run summary (pass/fail counts).
> **Expected:** full green.
> **STOP if:** any customer-facing spec fails → Tier-2 (customer-blocking = roll back offending piece, abort window). Admin/edge-case failure → assess per § Rollback Tier-2 (forward-fix in window if straightforward, else hot-patch + document).

---

## 6. F55 analytics views — explicit disposition (no third carry-forward)  *(doc-only → `staging`)*

> **RESOLVED 2026-06-10 (4.8 H1, drop branch):** All 5 `analytics_*` views dropped on production. Confirmed dead code — `analytics.html` queries `usage_events` directly; no view reads existed. `pg_views` verify returned zero rows; `analytics.html` renders post-drop. F55 → resolved in `technical-reference.md` § 13. The F55 annotation added to `phase-4-production-migration.md` completion criteria has been removed (4.8 H4 doc update).

**Decision (original, 2026-05-31):** **DEFER** the analytics-view retrofit/drop to the **post-cutover housekeeping pass specified in Appendix A** (bundled with F56 and F57), **not** 4.6. Rationale: deciding drop-vs-retrofit safely requires `analytics.html` / `app.js` (how staging serves analytics) — not available to the 4.6 authoring inputs — and 4.6 is the one-shot window where blindly dropping a customer-visible admin surface is highest-risk. This is a disposition, not a silent carry-forward: F55 stays open with a named owner (Appendix A), and the phase structural-diff criterion is annotated so it does not falsely fail.

**Claude applies (doc-only):**
- `technical-reference.md` § 13 F55 **Status** → append: `Disposition 2026-05-31: deferred to post-cutover housekeeping pass with F56/F57; not in 4.6 scope. Requires analytics.html/app.js audit to choose drop-vs-retrofit.`
- `phase-4-production-migration.md` completion criteria (line ~189/190, structural diff + `pg_policies`): append a note that **5 prod-extra `analytics_*` views are a known tracked difference pending F55**, handled exactly like the F58 `user_profiles` policy exception — the structural-diff criterion is satisfied-with-annotation, not blocked.
- `phase-4-production-migration.md` line 148: change "Re-scope in parent plan before 4.6 gate" → "Re-scoped 2026-05-31: deferred to post-cutover housekeeping (F55 disposition in 4.6 plan)."
- Row 4.4 title: leave as-is; the structural-diff annotation above is the authoritative record that analytics views were carved out, so the title is not claiming false completion.

Commit:
```
docs: disposition F55 (analytics views → post-cutover housekeeping); annotate Phase 4 structural-diff criterion
```

> No production action in this section.

---

## 7. First real production import + maintenance off  *(Rick-in-the-loop; one-way after the write)*

> **This is the one-way gate.** After a successful real import write, rollback is forward-fix only (parent § Rollback Tier-3). Maintenance mode is **still ON** during the import.

**7.1 Remove the dry-run flag from the invocation** (run the real, unflagged script). The `--no-write` flag added in § 3.1 stays in the local file but is simply not passed. Optionally Claude reverts § 3.1 after the window; it is never committed either way.

> **PAUSE → Rick runs the real import** (maintenance ON), current-week catalog + shipment CSVs, **no `--no-write`**:
> ```
> node scripts/import.js "<lunar_catalog.csv>" "<prh_catalog.csv>" "<lunar_shipment.csv>" "<prh_shipment.csv>"
> ```
> Answer the script prompts (catalog month confirm; shipment y; notify **n** — do not blast customers while maintenance is on).
> **Paste:** full stdout/stderr and exit code.

**7.2 Verification queries — run immediately after, before maintenance off.** `:TID` = prod founding UUID; `:MONTH` = imported month.

> **PAUSE → Rick runs in prod SQL Editor:**
```sql
-- catalog upserted with tenant_id
SELECT count(*) AS catalog_rows, count(*) FILTER (WHERE tenant_id = ':TID') AS with_tid
FROM catalog WHERE catalog_month = ':MONTH';
-- auto-reserve inserts carry tenant_id
SELECT count(*) AS preorder_rows, count(*) FILTER (WHERE tenant_id = ':TID') AS with_tid
FROM preorders;
-- shipment rows carry tenant_id
SELECT count(*) AS shipment_rows, count(*) FILTER (WHERE tenant_id = ':TID') AS with_tid
FROM weekly_shipment;
```
> **Paste:** the three count pairs, plus from § 7.1 stdout: the printed **auto-fulfill count** and the **usage_events purged** count (prod-tenant-scoped).
> **Expected:** in each pair, `with_tid == total` (no null/foreign tenant_id); auto-fulfill count printed; usage_events purge scoped to prod tenant; § 7.1 exit code 0; zero unexpected stderr.
> **STOP if:** any `with_tid < total`, any error, non-zero exit. Forward-fix per Tier-3 (we are past the one-way point if the write landed).

**7.3 Toggle maintenance mode OFF — only after 7.2 passes.**

> **PAUSE → Rick runs in prod SQL Editor (as postgres):**
> ```sql
> UPDATE app_settings SET maintenance_mode = false WHERE key = 'maintenance_mode';
> SELECT key, maintenance_mode FROM app_settings WHERE key = 'maintenance_mode';
> ```
> **Paste:** the verifying SELECT.
> **Expected:** `maintenance_mode = false`. Production is now live on the new schema + tenant-aware app code.

---

## 8. F4 prod data drop (after maintenance off)  *(Rick-in-the-loop)*

**F4 on production** = the orphan `settings` table rows (`popular_series`, `maintenance_mode`) that the staging F4 fix already removed; once the app-code merge (§ 4) routes reads through `Settings.get()` → `app_settings`, prod's `settings` rows are vestigial (`CLAUDE.md` line 503). Drop **after** maintenance off so nothing reads them mid-window.

> **PAUSE → Rick runs in prod SQL Editor — DISCOVERY first:**
> ```sql
> SELECT key FROM settings ORDER BY key;
> ```
> **Paste:** the key list.
> **Expected:** only `popular_series` and/or `maintenance_mode`.
> **STOP and ask** if any other key appears — do not delete unknown keys (anti-drift; surface as a finding).

> **Then, only if discovery matches expectation, run the drop + verify:**
> ```sql
> DELETE FROM settings WHERE key IN ('popular_series','maintenance_mode');
> SELECT count(*) AS remaining FROM settings;
> ```
> **Paste:** the `remaining` count.
> **Expected:** `remaining = 0` (mirrors staging's empty `settings` post-F4). Records **F4** prod resolution.

---

## 9. Recovery-anchor tags  *(Rick-in-the-loop — end of window)*

> **PAUSE → Rick:**
> ```
> # production repo
> git tag phase-4-cutover-v1 && git push origin phase-4-cutover-v1
> # staging repo
> git tag phase-4-cutover-v1-staging && git push origin phase-4-cutover-v1-staging
> ```
> Store a post-cutover prod DB dump alongside the 2026-04-29 snapshot.
> **Paste:** confirmation both tags pushed.

---

## 10. Post-execution doc updates  *(Claude; doc-only → `staging`)*

- `phase-4-production-migration.md` Sub-Deploys table: row 4.6 → **Complete** + date; row 4.7 → **Planning** (write `phase-4.7-post-cutover-soak.md` next).
- `CLAUDE.md` § Current Migration Phase: active sub-deploy → **4.7**.
- `technical-reference.md` § 13: mark **F34** resolved (EF redeploy + secret) and **F4** resolved (prod data drop); F55/F56/F57 remain open under the post-cutover housekeeping owner.
- Record in this plan's § 8 deploy log: the pinned staging SHA, the 8 EF deploy versions, the two merged PR numbers, the import exit code, and the verification counts.

Commit:
```
docs: close Phase 4.6 (EF cutover, first prod import, maintenance off); advance pointer to 4.7
```

---

## 11. Out of scope (anti-drift — surface as findings, do not fix inline)

- **F55 retrofit/drop of analytics views** — deferred to the post-cutover housekeeping pass (**Appendix A**). Not executed in 4.6.
- **F56 / F57** (`claim_paper_account`, `generate_invite_link` prod-only) — same post-cutover housekeeping pass (**Appendix A**).
- **F58** (staging `user_profiles` admin-write policy) — staging audit; not a cutover step. Prod intentionally retains `admins manage tenant profiles` (4.4 Decision B).
- **Edge Function source edits** — redeploy only; no source changes in 4.6.
- **`register-customer` self-service tenant resolution** — intentionally pinned to `FOUNDING_TENANT_ID` (F34 documented status); Phase 5.
- **Customer notification blast** during the window — answer notify prompt **n**; the first post-cutover catalog email follows normal Tuesday cadence in 4.7, not here.
- **Hosting migration, branding, slug→id RPC, second-tenant onboarding** — Phase 5.
- **Vestigial-row cleanup beyond F4's two keys** — if § 8 discovery shows more, STOP and ask.
- Any `import.js` change beyond the § 3.1 `--no-write` flag (local, uncommitted).

---

## 12. Rollback summary (keyed to parent § Rollback Decision Tree)

| Stage | Tier | Action |
|---|---|---|
| § 1 secret / § 2 EF deploy fails | Tier-1 / 4.6-pt1 Easy | redeploy prior tagged EF version; re-set secret; maintenance stays ON; abort window |
| § 3 dry-run gate red | Tier-1 | no prod write occurred; abort window; post-mortem |
| § 4 merge issue (config.js in diff, etc.) | pre-write | do not push; fix locally; re-run merge prep |
| § 5 Playwright fail | Tier-2 | customer-blocking → roll back + abort; admin/edge → forward-fix or hot-patch |
| § 7 import fails **before** write lands | Tier-1/2 | abort or forward-fix; maintenance stays ON |
| § 7 import write **landed** then issue found | **Tier-3 one-way** | forward-fix only; rollback is destructive (customer writes under new schema; defaults removed) |

---

## 13. References

- Parent: `docs/phase-4-production-migration.md` — In-Scope 4.6 (lines 155–160), Dry-Run gate (106–118), sequencing (56–76), rollback (228–259), completion (184–202).
- `docs/phase-4.4-prod-schema-rls.md` — F55 carve-out; Decision B; F34/F4 routed-to-4.6.
- `docs/phase-4.5-prod-import-merge.md` — P1–P16; post-P11 builders; the `--no-write` design question this plan settles (§ 3).
- `docs/technical-reference.md` § 13 — F4, F34, F55–F59; highest filed F59 (closed 2026-06-01).
- `CLAUDE.md` — § Edge Functions (8 names, `FOUNDING_TENANT_ID`), deployment workflow (staging→main, `git checkout main -- config.js`), anti-drift stop-and-ask.
- Prod project ref `plgegklqtdjxeglvyjte`; prod founding UUID in `scripts/phase-4-prod-tenant-uuid.txt` (gitignored).

---

## 14. Deploy log (recorded 2026-05-31)

| Item | Value |
|---|---|
| Staging SHA (pinned) | `cab5dca53868eb90719f8576c4b40b67c0cc7c34` |
| EF deploys | All 8 deployed 2026-05-31 from staging SHA `cab5dca` |
| App-code PR | #49 `feat/phase-4.6-appcode-prod → main` |
| Migration-artifact PR | `feat/phase-4-prod-cutover → main` |
| Import exit code | 0 |
| Catalog upserted | 2306 / 2306 with_tid |
| Preorders with_tid | 325 / 325 |
| Shipment with_tid | 486 / 486 |
| Auto-reserve inserts | 2 (3 subscriptions; 1 no standard cover match in May catalog) |
| Auto-fulfill (import) | 0 (all existing preorders already in fulfilled state) |
| Usage events purged | 0 |
| Recovery tags | `phase-4-cutover-v1` (prod), `phase-4-cutover-v1-staging` |
| Discovered (not finding) | `app_settings` on prod uses `value TEXT` column, not boolean `maintenance_mode` column — 4.6 runbook SQL corrected inline; `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` env vars were set in Rick's shell from staging `.env`; cleared before real import |
| Post-cutover hotfix | `fix/appjs-tenantcontext-prod → main` (commit `554aec1`) — PR #49 merge left `main:app.js` at the pre-Phase-3 version (43 KB) instead of the staging version (49 KB with TenantContext). Root cause: merge base `cab5dca` already contained staging's `app.js`; three-way merge saw no delta and kept main's regressed copy. Hotfix: `git checkout staging -- app.js` onto a fresh branch, merged immediately. Login page confirmed working post-deploy. |
| Post-cutover discovery (soak) | 250 April preorders had `fulfilled = false` at cutover time — store had not marked April items as picked up in the app. They became invisible (My List = current month only; admin dashboard = current month only) when May import ran. Resolved 2026-05-31: bulk-UPDATE `fulfilled = true` on all April preorders via prod SQL Editor. Root cause: pre-Phase-4 workflow did not use the app's fulfill toggle consistently. **CORRECTED 2026-05-31:** Initial bulk-update (all 258 = 250 Apr + 8 Mar unfulfilled) was wrong — ALL 258 had `on_sale_date >= CURRENT_DATE` (future items not yet arrived). Rolled back immediately via `fulfilled_at >= NOW() - 2h AND on_sale_date >= CURRENT_DATE` filter. Correct final state: `fulfilled = false` for 258 future-dated items (will arrive throughout May/June); `fulfilled = true` for 65 past-on-sale items already fulfilled by store. **Lesson:** bulk-fulfill must filter by `on_sale_date < CURRENT_DATE` — only mark arrived items. |

---

## Appendix A — Post-cutover housekeeping pass (catalogued; **NOT executed in 4.6**)

> **GUARD.** This appendix is **not** part of the 4.6 cutover window and the CLI session running §§ 0–13 **must not execute it**. It is captured here so the deferred cleanup is concrete and actionable for its own follow-on session. Run it as a **separate sub-deploy after the 4.7 soak opens**, on its own plan file, under the standard one-sub-deploy-per-session and Rick-in-the-loop rules. It clears F55/F56/F57 so the Phase-4 structural-diff completion criterion (parent line 189) can pass without standing annotations.

**Suggested sub-deploy id:** `4.8 — post-cutover housekeeping` (new row in the parent Sub-Deploys table; written after 4.7 opens). Rollback complexity: Easy (each item is an independent drop/retrofit; no customer-write dependency).

**Pre-flight for that session:** read `analytics.html` and the analytics code paths in `app.js` (the inputs 4.6 lacked); confirm prod is post-cutover (maintenance off, first import landed); confirm no caller exists for the functions below before dropping.

### H1 — F55 analytics views (decide drop-vs-retrofit, then act)
Prod has 5 untenanted views — `analytics_daily_events`, `analytics_top_cancelled`, `analytics_top_reserved`, `analytics_top_subscribed`, `analytics_user_activity` — with **no staging counterpart**.

1. **Audit:** determine from `analytics.html` / `app.js` whether the admin analytics surface reads these views, and how staging serves the same surface (different query path, or not at all).
2. **Branch:**
   - **If unused by prod app code** (staging serves analytics another way) → **drop to match staging.** Prod then matches the staging object set; structural diff passes clean.
     > **PAUSE → Rick (prod SQL Editor):**
     > ```sql
     > DROP VIEW IF EXISTS public.analytics_daily_events,
     >                     public.analytics_top_cancelled,
     >                     public.analytics_top_reserved,
     >                     public.analytics_top_subscribed,
     >                     public.analytics_user_activity;
     > -- verify gone:
     > SELECT viewname FROM pg_views WHERE schemaname='public' AND viewname LIKE 'analytics\_%';
     > ```
     > **Expected:** verify query returns zero rows.
   - **If the prod admin tab depends on them** → **retrofit + build staging counterparts** so both sides match: add `WHERE tenant_id = current_tenant_id()` (or join through it) to each view on prod, then create the same 5 views on staging. This is a larger change — its own plan, not a one-liner. Do **not** drop a view the admin UI reads.
3. **Record:** flip F55 → resolved in § 13 with the chosen branch.

### H2 — F56 `claim_paper_account(uuid, uuid)` (dead code; drop)
The `claim-paper-customer` Edge Function reimplements the merge in TypeScript; the SQL function has no caller (dropped on staging 2026-05-26).
1. **Confirm no caller** (grep repo + EF sources for `claim_paper_account`).
   > **PAUSE → Rick (prod SQL Editor):**
   > ```sql
   > DROP FUNCTION IF EXISTS public.claim_paper_account(uuid, uuid);
   > SELECT proname FROM pg_proc WHERE proname = 'claim_paper_account';
   > ```
   > **Expected:** verify query returns zero rows.
2. **Record:** F56 → resolved.

### H3 — F57 `generate_invite_link(text, text)` (prod-only; audit then drop)
`SECURITY DEFINER`, no staging counterpart, provenance unknown.
1. **Audit callers** (repo + EF sources + any RPC reference). **STOP and ask** if any caller is found — do not drop a live function.
   > **PAUSE → Rick (prod SQL Editor), only if audit finds no caller:**
   > ```sql
   > DROP FUNCTION IF EXISTS public.generate_invite_link(text, text);
   > SELECT proname FROM pg_proc WHERE proname = 'generate_invite_link';
   > ```
   > **Expected:** verify query returns zero rows.
2. **Record:** F57 → resolved.

### H4 — Re-confirm structural-diff criterion
After H1–H3, re-run the Phase-4 completion structural diff (`pg_dump --schema-only` normalize/compare; `pg_policies` diff). Expected: the only remaining intentional difference is F58 (`user_profiles` admin-write) until staging is reconciled. Remove the F55 annotation added in 4.6 § 6 once H1 resolves it.

> Items already handled elsewhere and **not** in this pass: F4 vestigial `settings` rows (dropped in 4.6 § 8); the `CLAUDE.md` line-503 vestigial `settings.maintenance_mode` row (same drop). Pre-existing dead-code catalog items (F19 `is_admin`, F26 `admin_preorders` if confirmed unused, F33) remain catalogued under parent-plan line 174 — fold into this pass only with explicit sign-off, not inline.
