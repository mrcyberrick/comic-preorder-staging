# Phase 5.0 — Pre-Phase-5 Housekeeping

**Status:** Planning — runbook written 2026-06-10 (Phase 5 planning session); not yet executed.
**Parent plan:** `docs/phase-5-second-tenant-onboarding.md` (sub-deploy row 5.0)
**Predecessor:** Phase 4 completion audit — closed 2026-06-10. Scope source: § 13 dispositions (F63/F64 from the completion audit, F66 from the F64 item-4 assessment, F58/F65 carried) + Rick's scope sign-off at the 2026-06-10 planning session: **all seven candidate items; F58 is audit → decide → fix; F64 item 5 is decide-now / defer-DDL.**
**Branches:** S1–S5 are database + doc changes (doc commits → `staging` directly). S6 (F65) is an app-code change: `feature/f65-confirm-modal` off `staging` → `--ff-only` merge → staging smoke → prod promotion PR per `CLAUDE.md` § Standard Deployment Workflow (F59 diff assertion + post-deploy write-smoke).
**Execution model:** **CLI-orchestrated, Rick-in-the-loop.** A Claude Code CLI session runs this file top to bottom. It executes every repo / doc / local-script / Playwright step itself, and **pauses at every database step — staging *and* prod** — handing Rick the exact SQL to run in the Supabase SQL Editor and **waiting for pasted results before continuing**. **Self-contained — no chat context required.**
**Rollback complexity:** Easy — every step is independently reversible from a pre-captured definition or a constraint drop; no customer-write dependency. S6 follows normal staging-first deployment.

> **Steps Claude never runs itself.** (1) Any Supabase **SQL Editor** statement — staging *or* prod. (2) Supabase **dashboard** checks. (3) The prod promotion merge/PR approval in S6 — Claude prepares it; Rick reviews and merges. Each appears below as a **`PAUSE → Rick runs → paste result → match expected → continue / STOP`** block. Claude prepares the exact SQL, the expected result, and the stop condition around every pause.

> **5.0 may span multiple sittings.** S1–S2 (staging SQL) fit one sitting; S3 needs a decision gate; S4–S5 need a prod SQL Editor sitting; S6's prod promotion may wait for Rick's chosen window. The durable state is the **Deploy Log (§ 8)**: every session appends one row per completed step. A resuming session reads the log, re-verifies the last recorded step against live state (a recorded DDL change is re-verified with its verification query before trusting it), and continues from the next unexecuted step. Every doc edit is committed before the session ends.

> **Environment discipline.** S1, S2, and S3's fix are **staging-only**. S4 touches **both** environments (staging first). S5 is **prod-only**. Every SQL block below is headed with its target environment; Rick confirms the SQL Editor's project ref before running (staging `puoaiyezsreowpwxzxhj`, prod `plgegklqtdjxeglvyjte`). Running a staging-only block on prod is a STOP-and-report event even if it appears to succeed.

---

## 0. Pre-flight (run at the top of every 5.0 session; halt on any mismatch)

### 0.1 Read before doing anything
- `CLAUDE.md` in full; confirm § Current Migration Phase active sub-deploy = **5.0**.
- `docs/phase-5-second-tenant-onboarding.md` — Sub-Deploys row 5.0, § Deferred-DDL Register (F64 item 5 lands there at S3), § Out of Scope.
- This file in full — including the Deploy Log (§ 8): if any rows exist, this is a resume session.
- `docs/technical-reference.md` § 13 — F58, F63, F64, F65, F66 entries.

### 0.2 Gates (halt if any fail)
- `git rev-parse --abbrev-ref HEAD` → `staging`; `git status` → clean (the known-stray untracked `docs/status-slide.html` is acceptable; anything else, stop and ask).
- `git pull origin staging` → up to date (or fast-forward) before any edit.
- `docs/technical-reference.md` § 13: confirm the highest filed finding ID (**F66** at planning time; **next free = F67**). New defects discovered during 5.0 are filed from the next free ID — never guessed or reused.
- **Re-verify the planning-time audits in § 1 against the current tree and live DBs** (anti-drift: never trust a prior session's grep or a 12-day-old dump). Every § 1 result is re-derived at execution before acting on it; the live capture is authoritative over both this file and the 4.8 dumps.

### 0.3 Commit discipline
- **One finding per commit.** Each S-step's doc update (finding resolution, deploy-log row) is its own doc-only commit to `staging` with the finding ID in the message — exact messages are given inline. S4 produces **two** commits (F66 and F64 item 4 are separate findings even though they execute in one sitting).
- S6 app-code changes ride `feature/f65-confirm-modal`, never `staging` directly.
- Push `origin staging` after each commit; the Deploy Log row lands in the same commit as the step it records.

### 0.4 Files touched by this sub-deploy

| File / target | Change | Branch / actor |
|---|---|---|
| Staging DB (`public` schema) | 14 × `ALTER POLICY … TO authenticated` (S1); 5 additive constraints/FKs + 1 column type (S2); 1 `CREATE POLICY` (S3 branch A); `delete_dropped_catalog_items` guard (S4) | Rick, staging SQL Editor |
| Production DB (`public` schema) | `delete_dropped_catalog_items` guard + `preorders_catalog_id_fkey` → NO ACTION (S4); `settings.maintenance_mode` row delete (S5) | Rick, prod SQL Editor |
| `subscriptions.html` | Confirm modal: CSS + overlay + helper + call-site (S6) | `feature/f65-confirm-modal` |
| `mylist.html` | Line 1081 unsubscribe guard → `confirmDialog` (S6) | `feature/f65-confirm-modal` |
| Playwright `05-subscriptions.spec.ts` | Native-dialog handler → in-page modal click (S6) | local-only, never committed |
| `docs/technical-reference.md` § 13 | F58, F63, F64 (items 1–5), F65, F66 status updates | `staging` (doc-only) |
| `docs/phase-5-second-tenant-onboarding.md` | Row 5.0 → Complete; Deferred-DDL Register F64-5 owner | `staging` (doc-only) |
| `CLAUDE.md` | § Current Migration Phase pointer advance; § Known Out-of-Scope `settings.maintenance_mode` line removal | `staging` (doc-only) |

**Not touched:** `config.js`, `app.js`, `import.js` / `import-staging.js`, any Edge Function source, `app_settings` (either env — the live maintenance flag lives there), any schema object not named above.

---

## 1. Planning-time audit results (2026-06-10) — re-verify at execution

Derived from the 2026-06-10 schema-only dumps (`catalogs\scripts\schema-staging-4.8.sql`, `schema-prod-4.8.sql`) and live-tree greps at the planning session. **The dumps are snapshots; each S-step's pre-flight re-captures from live before changing anything.**

### 1.1 F63 — the exact 14-policy set (count corrected from "13" at planning)

The staging dump enumerates **14** policies lacking `TO authenticated` (F63 as filed said 13 across 9 tables; the dump-derived truth is **14 across 8 tables** — § 13 corrected at the planning session). Prod has all 22 of its policies qualified. The 14, by table:

| Table | Policies lacking `TO authenticated` |
|---|---|
| `app_settings` | `admins delete tenant app_settings`, `admins update tenant app_settings` |
| `preorders` | `admins manage tenant preorders`, `users manage own preorders` |
| `reservation_history` | `admins view all history`, `users view own history` |
| `settings` | `admins update tenant settings` |
| `subscriptions` | `admins view tenant subscriptions`, `users manage own subscriptions` |
| `tenants` | `admins update own tenant` |
| `usage_events` | `admins read tenant usage events` |
| `user_profiles` | `admins view tenant profiles`, `users update own profile`, `users view own profile` |

Staging has 21 policies total (7 already qualified: `admins insert tenant app_settings`, `authenticated users read weekly_shipment`, `users insert own usage events`, `users read own tenant`, `users read tenant app_settings`, `users read tenant catalog`, `users read tenant settings`). Prod has those 21 **plus** `admins manage tenant profiles` (the F58 row).

### 1.2 F58 — code-path determination: **authenticated-key, no service-role EF**

- `app.js:916–922` — `Users.suspend(userId)`: `db.from('user_profiles').update({ status: 'suspended' }).eq('id', userId)` — **authenticated client UPDATE**, no Edge Function.
- `app.js:925–931` — `Users.deleteProfile(userId)`: `db.from('user_profiles').delete().eq('id', userId)` — **authenticated client DELETE**, no Edge Function.
- `admin.html:1600–1612` — Pending-tab **Decline** handler calls `Users.deleteProfile(id)` after a native `confirm()` (admin-page confirm sites stay out of scope).
- Staging `user_profiles` has **no admin UPDATE/DELETE/ALL policy** (§ 1.1: only `admins view`, `users update own`, `users view own`) → both mutations match **0 rows**. PostgREST returns success on 0-row UPDATE/DELETE, so the failure is **silent** — exactly the observed staging symptom (Decline appears to work, row remains, `auth.users` untouched).
- **Conclusion (planning-time):** staging's admin suspend/delete is **latently broken**; prod's `admins manage tenant profiles` policy is the architectural intent. Indicated direction = **Branch A: add the policy to staging.** The S3 gate re-verifies the greps and Rick makes the call.
- Note even post-fix: `deleteProfile` removes only the profile row; the `auth.users` row remains by design in both envs (no reverse FK). Whether that is the *intended* terminal state is the **F64 item 5 decision** taken at the same gate.

### 1.3 F66 — current function body (byte-identical both envs at planning time)

From the 4.8 dumps (staging lines 141–154; prod identical):

```sql
CREATE FUNCTION public.delete_dropped_catalog_items(p_tenant_id uuid, p_catalog_month text, p_item_codes text[]) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE deleted_count integer;
BEGIN
  DELETE FROM catalog
  WHERE tenant_id = p_tenant_id
    AND catalog_month = p_catalog_month
    AND item_code != ALL(p_item_codes);
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;
```

- The guard mirrors `purge_stale_catalog`'s existing pattern: `AND id NOT IN (SELECT catalog_id FROM preorders WHERE tenant_id = p_tenant_id)`.
- `preorders.catalog_id` is **NOT NULL** (staging dump line 274; prod same) — no `NOT IN`-with-NULL no-op hazard.
- `CREATE OR REPLACE` preserves existing grants; S4 verifies `proacl` unchanged anyway.

### 1.4 F64 items 1–4, 6, 7 — prod-side DDL to replicate / align (from the prod dump)

1. `catalog.price_usd` → prod `numeric(6,2)`, staging bare `numeric`.
2. `CONSTRAINT catalog_distributor_check CHECK ((distributor = ANY (ARRAY['Lunar'::text, 'PRH'::text])))` — prod-only. (`catalog.distributor` is NOT NULL both envs, so no NULL edge.)
3. `CONSTRAINT preorders_quantity_check CHECK (((quantity >= 1) AND (quantity <= 99)))` — prod-only.
4. `preorders_catalog_id_fkey`: prod `REFERENCES public.catalog(id) ON DELETE CASCADE` → align to staging's `NO ACTION` (paired with F66).
6. `app_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id)` — prod-only.
7. `user_profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE` — prod-only; design-consistent per the § 13 disposition (paper customers get `auth.users` rows too).

### 1.5 S5 — nothing reads the legacy `settings.maintenance_mode` row

- Repo-wide grep for `from('settings')` → one hit, and it is **documentation** (`technical-reference.md:1653` describing a historical pattern). The live flag is `app_settings.maintenance_mode` (`Settings.isMaintenanceMode()`); the `settings` table itself is still read for other keys via RLS policies, but no code references the `maintenance_mode` key in it.
- `settings` shape (both envs): `(key text NOT NULL, value text, tenant_id uuid NOT NULL)`.

### 1.6 F65 — sites, pattern source, and the Playwright dependency

- **Sites (scope per § 13 as corrected at planning):** `subscriptions.html:419` (F65 as filed) **and** `mylist.html:1081` (deferred from F61 4.8 H5 "tracked as F65" — now recorded in the F65 entry). Both click handlers are already `async` (subscriptions.html:418, mylist.html:1080).
- **Pattern source (F61 fix, live on both branches):** `mylist.html` — page-local CSS at lines 477–485 (`/* ── Confirm Modal ── */` block), overlay HTML at 648–656 (after `#toast-container`), promise-based `confirmDialog()` helper at 662–684 (top of the page script). `style.css` supplies the generic `.modal-overlay` / `.modal` / `.open` classes globally; **the `.confirm-modal` / `.confirm-actions` rules are page-local and must be copied into `subscriptions.html`'s `<style>` block** (ends line 183).
- **Playwright:** `05-subscriptions.spec.ts:38` uses `authenticatedPage.once('dialog', d => d.accept())` — dead once the native dialog is gone; switch to the in-page modal click exactly as `03-mylist-cancel-guards.spec.ts:54–56` already does. Local-only edit, never committed.
- Remaining native `confirm()` sites after S6: `admin.html` ×5 (1066/1235/1556/1603/1967) — admin-operated, explicitly out of scope (4.8 § 1.4 disposition stands).

---

## 2. In scope

1. **S1** — F63: `TO authenticated` on the 14 staging policies; full-suite Playwright after. Resolve **F63**.
2. **S2** — F64 items 1–3, 6, 7: staging additive constraints/FKs + `price_usd` precision, each with its named pre-flight data check. Close those items within **F64**.
3. **S3** — F58 audit → **decision gate** → fix (Branch A expected: add `admins manage tenant profiles` to staging) + functional verify. **Same gate: F64 item 5 decision** (canonical user-deletion path) — decision recorded, DDL deferred to the parent § Deferred-DDL Register. Resolve **F58**; disposition **F64 item 5**.
4. **S4** — F66 + F64 item 4: preorder guard into `delete_dropped_catalog_items` on **staging then prod**; prod `preorders_catalog_id_fkey` → NO ACTION. Resolve **F66**; close **F64 item 4**.
5. **S5** — Drop the vestigial prod `settings.maintenance_mode` row (CLAUDE.md deferred-list item; no finding ID).
6. **S6** — F65: confirm modal on `subscriptions.html` + `mylist.html:1081`; staging deploy + Rick Brave/iOS verify; prod promotion. Resolve **F65**.
7. **S7** — Closeout: § 13 final statuses, parent row 5.0 → Complete, Deferred-DDL Register owner assignment, CLAUDE.md pointer advance, end-of-session status update.

## 3. Out of scope (stop and ask before touching)

- **F64 item 8** (`idx_tenants_slug` → prod) — belongs to sub-deploy 5.2.
- **F64 item 5 DDL** — decision only in S3; executing the FK realignment here is scope growth even if the decision feels obvious.
- **`admin.html` native `confirm()` sites** — admin-operated; not customer-facing; catalog as a new finding only with explicit sign-off.
- **Dead-code catalog** (F19 `is_admin()` prod-only function, F26, F33 remnants) — unchanged.
- **`app_settings` rows (either env)** — S5 touches the legacy `settings` table only. Deleting or editing `app_settings.maintenance_mode` would take the live flag out from under the app.
- **Stale prose in `technical-reference.md` § 6.4** (F20 text predates its 2026-05-10 fix) — noted at planning; fold into a doc pass only with sign-off.
- Any Edge Function source, import-script, or `app.js` change.

---

## 4. Runbook

Execution order: **S1 → S2 (one staging SQL sitting) → S3 (audit + gate + staging fix) → S4 (staging, then prod sitting) → S5 (same prod sitting) → S6 last** (S6 is the only `main`-bound change; a failed smoke never blocks the DB housekeeping). S7 closes.

### S1 — F63: `TO authenticated` on 14 staging policies

1. **Pre-capture** —
   > **PAUSE → Rick (STAGING SQL Editor `puoaiyezsreowpwxzxhj`):**
   > ```sql
   > SELECT tablename, policyname, cmd, roles
   > FROM pg_policies
   > WHERE schemaname = 'public'
   > ORDER BY tablename, policyname;
   > ```
   > **Paste:** full result. **Expected:** 21 rows; exactly the 14 policies named in § 1.1 show `roles = {public}`; the other 7 show `{authenticated}`. **STOP if:** the set differs in any way from § 1.1 (a policy was added/renamed since planning) — re-derive the ALTER list from the live capture and update this file before proceeding.
2. > **PAUSE → Rick (STAGING SQL Editor):**
   > ```sql
   > ALTER POLICY "admins delete tenant app_settings" ON public.app_settings TO authenticated;
   > ALTER POLICY "admins update tenant app_settings" ON public.app_settings TO authenticated;
   > ALTER POLICY "admins manage tenant preorders" ON public.preorders TO authenticated;
   > ALTER POLICY "users manage own preorders" ON public.preorders TO authenticated;
   > ALTER POLICY "admins view all history" ON public.reservation_history TO authenticated;
   > ALTER POLICY "users view own history" ON public.reservation_history TO authenticated;
   > ALTER POLICY "admins update tenant settings" ON public.settings TO authenticated;
   > ALTER POLICY "admins view tenant subscriptions" ON public.subscriptions TO authenticated;
   > ALTER POLICY "users manage own subscriptions" ON public.subscriptions TO authenticated;
   > ALTER POLICY "admins update own tenant" ON public.tenants TO authenticated;
   > ALTER POLICY "admins read tenant usage events" ON public.usage_events TO authenticated;
   > ALTER POLICY "admins view tenant profiles" ON public.user_profiles TO authenticated;
   > ALTER POLICY "users update own profile" ON public.user_profiles TO authenticated;
   > ALTER POLICY "users view own profile" ON public.user_profiles TO authenticated;
   >
   > -- verify:
   > SELECT count(*) AS unqualified
   > FROM pg_policies
   > WHERE schemaname = 'public' AND roles = '{public}';
   > ```
   > **Paste:** the verify count. **Expected:** `unqualified = 0`. **STOP if:** any ALTER errors or the count is non-zero.
3. **Post-capture (Rick, same sitting):** re-run the step-1 SELECT; paste. **Expected:** 21 rows, all `{authenticated}` — byte-comparable to prod's capture minus the F58 row.
4. **Smoke (Claude):** `cd C:\Users\richa\OneDrive\Documents\(Work)\BookStop\catalogs\scripts\playwright` → `.\run-smoke.ps1` — full suite green (this is the F63 assessment's named post-condition). `anon` access stays blocked by `current_tenant_id()` returning NULL; no app behavior change expected.
5. **Record (Claude):** § 13 F63 → resolved (with the before/after capture summary); Deploy Log row. Commit:
   ```
   docs: resolve F63 — 14 staging policies aligned to TO authenticated (5.0 S1)
   ```

### S2 — F64 items 1–3, 6, 7: staging additive DDL (one sitting; each item = pre-flight → DDL → verify)

Run items strictly in order; a failed pre-flight halts **that item only** (report, file/disposition, continue with the next item — these five are independent).

> **PAUSE → Rick (STAGING SQL Editor) — item 1, `price_usd` precision:**
> ```sql
> -- pre-flight: rows that would overflow or be silently rounded by numeric(6,2)
> SELECT count(*) AS bad_rows
> FROM catalog
> WHERE price_usd IS NOT NULL
>   AND (price_usd < 0 OR price_usd >= 10000 OR price_usd <> round(price_usd, 2));
> ```
> **Expected:** `bad_rows = 0`. **STOP this item if non-zero** (paste the offending rows: re-run with `SELECT id, item_code, price_usd FROM …` and the same WHERE).
> ```sql
> ALTER TABLE public.catalog ALTER COLUMN price_usd TYPE numeric(6,2);
> -- verify:
> SELECT numeric_precision, numeric_scale FROM information_schema.columns
> WHERE table_schema = 'public' AND table_name = 'catalog' AND column_name = 'price_usd';
> ```
> **Expected:** `6, 2`.

> **PAUSE → Rick (STAGING SQL Editor) — item 2, distributor check:**
> ```sql
> SELECT DISTINCT distributor FROM catalog ORDER BY 1;
> ```
> **Expected:** exactly two rows — `Lunar`, `PRH`. **STOP this item if anything else appears.**
> ```sql
> ALTER TABLE public.catalog ADD CONSTRAINT catalog_distributor_check
>   CHECK ((distributor = ANY (ARRAY['Lunar'::text, 'PRH'::text])));
> -- verify:
> SELECT conname FROM pg_constraint
> WHERE conrelid = 'public.catalog'::regclass AND conname = 'catalog_distributor_check';
> ```
> **Expected:** 1 row.

> **PAUSE → Rick (STAGING SQL Editor) — item 3, quantity check:**
> ```sql
> SELECT count(*) AS bad_rows FROM preorders WHERE quantity < 1 OR quantity > 99;
> ```
> **Expected:** `bad_rows = 0`.
> ```sql
> ALTER TABLE public.preorders ADD CONSTRAINT preorders_quantity_check
>   CHECK (((quantity >= 1) AND (quantity <= 99)));
> -- verify:
> SELECT conname FROM pg_constraint
> WHERE conrelid = 'public.preorders'::regclass AND conname = 'preorders_quantity_check';
> ```
> **Expected:** 1 row.

> **PAUSE → Rick (STAGING SQL Editor) — item 6, `app_settings.updated_by` FK:**
> ```sql
> SELECT count(*) AS orphans
> FROM app_settings a
> WHERE a.updated_by IS NOT NULL
>   AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = a.updated_by);
> ```
> **Expected:** `orphans = 0`.
> ```sql
> ALTER TABLE public.app_settings ADD CONSTRAINT app_settings_updated_by_fkey
>   FOREIGN KEY (updated_by) REFERENCES auth.users(id);
> -- verify:
> SELECT conname FROM pg_constraint
> WHERE conrelid = 'public.app_settings'::regclass AND conname = 'app_settings_updated_by_fkey';
> ```
> **Expected:** 1 row.

> **PAUSE → Rick (STAGING SQL Editor) — item 7, `user_profiles.id` FK:**
> ```sql
> SELECT count(*) AS orphans
> FROM user_profiles p
> WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.id);
> ```
> **Expected:** `orphans = 0`. **STOP this item if non-zero** — orphaned profiles mean the § 13 item-7 disposition's premise ("every profile has an auth parent") is false on staging; report before adding a CASCADE FK that would change deletion behavior.
> ```sql
> ALTER TABLE public.user_profiles ADD CONSTRAINT user_profiles_id_fkey
>   FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
> -- verify (confdeltype 'c' = CASCADE):
> SELECT conname, confdeltype FROM pg_constraint
> WHERE conrelid = 'public.user_profiles'::regclass AND conname = 'user_profiles_id_fkey';
> ```
> **Expected:** 1 row, `confdeltype = c`.

**Post (Claude):** `.\run-smoke.ps1` full suite green. § 13 F64 items 1–3, 6, 7 → closed (item-level annotations inside the F64 entry); Deploy Log row. Commit:
```
docs: F64 items 1-3,6,7 — staging additive constraints/FKs reconciled to prod (5.0 S2)
```

### S3 — F58: audit → decision gate → fix (+ F64 item 5 decision)

1. **Re-verify the code path (Claude, current tree):**
   - `Select-String -Path app.js -Pattern "suspend|deleteProfile" -Context 0,6` → confirm `Users.suspend` is a `db.from('user_profiles').update(…)` and `Users.deleteProfile` a `db.from('user_profiles').delete(…)` (authenticated client; § 1.2 recorded lines 916/925).
   - `Select-String -Path admin.html -Pattern "Users.deleteProfile|Users.suspend"` → confirm the admin Users/Pending tabs call them directly (no Edge Function indirection).
   - `Select-String -Path supabase\functions\*\index.ts -Pattern "user_profiles"` → confirm no EF performs admin suspend/delete on behalf of the UI.
   - **HALT if any of these contradicts § 1.2** — the decision inputs below would be stale.
2. **Live policy capture** —
   > **PAUSE → Rick (STAGING SQL Editor):**
   > ```sql
   > SELECT policyname, cmd, roles, qual, with_check
   > FROM pg_policies
   > WHERE schemaname = 'public' AND tablename = 'user_profiles'
   > ORDER BY policyname;
   > ```
   > **Paste:** full result. **Expected:** 3 rows (`admins view tenant profiles` SELECT, `users update own profile` UPDATE, `users view own profile` SELECT — all `{authenticated}` after S1); **no** ALL/DELETE policy.
3. **DECISION GATE → Rick.** Inputs: § 1.2 (authenticated-key path confirmed), step-2 capture (no admin write policy), observed symptom (staging Decline silently no-ops). Choose:
   - **Branch A (recommended; planning-time evidence supports it):** staging is latently broken → add prod's policy to staging. Proceed to step 4.
   - **Branch B (only if the audit overturned § 1.2):** the architectural intent is service-role-EF mediation → **drop** `admins manage tenant profiles` on **prod** (`DROP POLICY "admins manage tenant profiles" ON public.user_profiles;`), file the missing-EF gap as a new finding (next free ID), and route admin mutations through an EF in a later sub-deploy. Do **not** improvise the EF here.
4. **Branch A apply** —
   > **PAUSE → Rick (STAGING SQL Editor):**
   > ```sql
   > CREATE POLICY "admins manage tenant profiles" ON public.user_profiles
   >   TO authenticated
   >   USING (((tenant_id = public.current_tenant_id()) AND public.current_user_is_admin()))
   >   WITH CHECK (((tenant_id = public.current_tenant_id()) AND public.current_user_is_admin()));
   > -- verify (re-run the step-2 capture):
   > SELECT policyname, cmd, roles, qual, with_check
   > FROM pg_policies
   > WHERE schemaname = 'public' AND tablename = 'user_profiles'
   > ORDER BY policyname;
   > ```
   > **Paste:** full result. **Expected:** 4 rows; the new row is `cmd = ALL`, `roles = {authenticated}`, `qual` and `with_check` both `((tenant_id = current_tenant_id()) AND current_user_is_admin())` — textually identical to prod's row (modulo `public.` prefixes pg_policies may strip). Staging `user_profiles` policy surface now equals prod's: **F58's standing "known intentional difference" annotation is cleared.**
5. **Functional verify (Rick on staging app, ~5 min; Claude scripts the steps):**
   - Create a **disposable** pending account (staging signup flow or invite) — never use a real customer.
   - Admin → Pending tab → **Decline** the disposable account → row disappears **and stays gone on reload** (pre-fix it silently reappeared).
   - Admin → Users tab → **Suspend** any test account → status flips to `suspended` on reload; un-suspend after.
   - Note: the `auth.users` row for a declined profile **remains** — expected in both envs; its fate is the F64 item 5 decision (step 6), not a defect here.
6. **F64 item 5 decision (same gate, Rick).** Question: what is the canonical user-deletion path? Inputs:
   - Staging FK (`preorders_user_id_fkey` → `user_profiles`, NO ACTION): profile delete **fails loudly** for any customer with preorders; nothing is orphaned.
   - Prod FK (→ `auth.users`, CASCADE): profile delete succeeds; preorders survive until the `auth.users` row is deleted (GoTrue admin API), which then cascades through both prod FKs.
   - Post-S2-item-7, staging also has `user_profiles_id_fkey` (auth → profile CASCADE), so an auth-level delete now cleans the profile on both envs.
   - **Record the decision + rationale in § 13 F64 item 5** (disposition: which FK shape is canonical, and what "delete a customer" should mean operationally). **Do not execute realignment DDL** — enter the decision in the parent plan § Deferred-DDL Register with its owner per the register's constraint (must land before 5.4).
7. **Smoke (Claude):** `.\run-smoke.ps1` full suite green (the suite's tenant-isolation specs cover `user_profiles` reads; the new ALL policy must not widen non-admin access — `current_user_is_admin()` gates it).
8. **Record (Claude):** § 13 F58 → resolved (branch taken, verification evidence); F64 item 5 disposition updated; parent § Deferred-DDL Register row filled; Deploy Log rows. **Two commits:**
   ```
   docs: resolve F58 — admins manage tenant profiles added to staging; Decline/suspend verified (5.0 S3)
   ```
   ```
   docs: F64 item 5 — user-deletion path decision recorded; FK realignment deferred to register (5.0 S3)
   ```

### S4 — F66 + F64 item 4: preorder guard (both envs) + prod FK → NO ACTION

Order inside this step is deliberate: **guard on staging → guard on prod → prod FK swap.** The guard makes the FK tightening safe (no import path can hit a reserved row once guarded); doing the FK first would expose imports to loud FK failures in the gap.

1. **Staging guard** —
   > **PAUSE → Rick (STAGING SQL Editor):**
   > ```sql
   > -- pre-capture (must match § 1.3 body; STOP on any difference):
   > SELECT pg_get_functiondef('public.delete_dropped_catalog_items(uuid, text, text[])'::regprocedure);
   > -- grants snapshot:
   > SELECT proacl FROM pg_proc WHERE proname = 'delete_dropped_catalog_items';
   > ```
   > **Paste:** both. **Expected:** the § 1.3 body, byte-for-byte (modulo `CREATE OR REPLACE FUNCTION` header normalization). **STOP if the body differs** — someone changed the function since planning; re-derive.
   > ```sql
   > CREATE OR REPLACE FUNCTION public.delete_dropped_catalog_items(p_tenant_id uuid, p_catalog_month text, p_item_codes text[]) RETURNS integer
   >     LANGUAGE plpgsql SECURITY DEFINER
   >     SET search_path TO 'public'
   >     AS $$
   > DECLARE deleted_count integer;
   > BEGIN
   >   DELETE FROM catalog
   >   WHERE tenant_id = p_tenant_id
   >     AND catalog_month = p_catalog_month
   >     AND item_code != ALL(p_item_codes)
   >     AND id NOT IN (SELECT catalog_id FROM preorders WHERE tenant_id = p_tenant_id);
   >   GET DIAGNOSTICS deleted_count = ROW_COUNT;
   >   RETURN deleted_count;
   > END;
   > $$;
   > -- verify: definition now contains the guard line, grants unchanged
   > SELECT pg_get_functiondef('public.delete_dropped_catalog_items(uuid, text, text[])'::regprocedure);
   > SELECT proacl FROM pg_proc WHERE proname = 'delete_dropped_catalog_items';
   > ```
   > **Paste:** both. **Expected:** body = pre-capture **plus exactly the one added line** `AND id NOT IN (SELECT catalog_id FROM preorders WHERE tenant_id = p_tenant_id)`; `proacl` identical to the snapshot.
2. **Prod guard** — same four statements verbatim on the **PROD SQL Editor (`plgegklqtdjxeglvyjte`)**, same expectations, same STOP conditions. (F66 recorded the bodies as identical across envs; the pre-capture proves it again live.)
3. **Prod FK alignment (F64 item 4)** —
   > **PAUSE → Rick (PROD SQL Editor):**
   > ```sql
   > -- pre-flight: no orphaned catalog references (ADD CONSTRAINT validates, but name the rows first)
   > SELECT count(*) AS orphans
   > FROM preorders p LEFT JOIN catalog c ON c.id = p.catalog_id
   > WHERE c.id IS NULL;
   > ```
   > **Expected:** `orphans = 0`. **STOP if non-zero.**
   > ```sql
   > ALTER TABLE public.preorders DROP CONSTRAINT preorders_catalog_id_fkey;
   > ALTER TABLE public.preorders ADD CONSTRAINT preorders_catalog_id_fkey
   >   FOREIGN KEY (catalog_id) REFERENCES public.catalog(id);
   > -- verify (confdeltype 'a' = NO ACTION):
   > SELECT conname, confdeltype FROM pg_constraint
   > WHERE conrelid = 'public.preorders'::regclass AND conname = 'preorders_catalog_id_fkey';
   > ```
   > **Paste:** result. **Expected:** 1 row, `confdeltype = a`. Run the DROP + ADD as one statement batch (single transaction in the SQL Editor) so no gap exists with the FK absent.
4. **Behavioral note for the log:** post-S4, a future same-month wiring of this function (the F66 activation risk) deletes only unreserved rows; a reserved-but-dropped title now survives the delete on both envs, and prod's FK no longer cascades catalog deletes into `preorders`.
5. **Record (Claude):** § 13 F66 → resolved; F64 item 4 → closed; Deploy Log rows. **Two commits:**
   ```
   docs: resolve F66 — preorder guard added to delete_dropped_catalog_items, both envs (5.0 S4)
   ```
   ```
   docs: F64 item 4 — prod preorders_catalog_id_fkey aligned to NO ACTION (5.0 S4)
   ```

### S5 — Drop the vestigial prod `settings.maintenance_mode` row

1. **Re-verify (Claude):** `Select-String -Path app.js,*.html -Pattern "from\('settings'\)"` and `Select-String -Path supabase\functions\*\index.ts -Pattern "settings"` → no code reads the legacy `settings` table's `maintenance_mode` key (§ 1.5; the live flag is `app_settings.maintenance_mode`). **HALT if a reader appears.**
2. > **PAUSE → Rick (PROD SQL Editor):**
   > ```sql
   > -- capture for rollback:
   > SELECT key, value, tenant_id FROM settings WHERE key = 'maintenance_mode';
   > ```
   > **Paste:** result. **Expected:** exactly **1 row**. **STOP if** 0 rows (already gone — record and skip) or >1 row (unexpected shape — investigate).
   > ```sql
   > DELETE FROM settings WHERE key = 'maintenance_mode';
   > SELECT count(*) AS remaining FROM settings WHERE key = 'maintenance_mode';
   > ```
   > **Paste:** count. **Expected:** `remaining = 0`.
3. **Post-check (Rick, ~1 min):** load the prod app as a normal user — pages load normally (the maintenance gate reads `app_settings`, untouched).
4. **Record (Claude):** Deploy Log row (captured row values in the Notes column for rollback); remove the "Vestigial `settings.maintenance_mode` row" line from `CLAUDE.md` § Known Out-of-Scope Items. Commit:
   ```
   docs: drop vestigial prod settings.maintenance_mode row (5.0 S5); CLAUDE.md deferred list updated
   ```

### S6 — F65: confirm modal on `subscriptions.html` + `mylist.html:1081`

1. **Branch:** `git checkout -b feature/f65-confirm-modal` off current `staging` (pulled).
2. **File-drift gate (Claude):** re-read both files from disk; verify each `old_str` below matches **byte-exactly** (`Select-String` the anchor lines first). **HALT on any mismatch** — re-derive from disk, do not force.
3. **Edit 1 — `subscriptions.html` CSS** (page-local `<style>` block ends at line 183; copy of `mylist.html:477–485`):
   - `old_str`:
     ```
         .popular-series-actions {
           display: flex;
           align-items: center;
           gap: 10px;
           flex-shrink: 0;
         }
       </style>
     ```
   - `new_str`:
     ```
         .popular-series-actions {
           display: flex;
           align-items: center;
           gap: 10px;
           flex-shrink: 0;
         }

         /* ── Confirm Modal ────────────────────────────────────────── */
         .confirm-modal {
           max-width: 320px;
           padding: 24px;
           text-align: center;
         }
         .confirm-modal p { margin: 0 0 20px; font-size: 0.95rem; }
         .confirm-actions { display: flex; gap: 10px; justify-content: center; }
         .confirm-actions .btn { min-width: 90px; }
       </style>
     ```
   *(Indentation note: `subscriptions.html` style rules are indented 4 spaces — shown here as in-file. The executing session verifies against disk per step 2.)*
4. **Edit 2 — `subscriptions.html` overlay HTML** (after `#toast-container`, line 259; copy of `mylist.html:648–656` with `Unsubscribe` as the OK label):
   - `old_str`:
     ```
     <div id="toast-container"></div>

     <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
     ```
   - `new_str`:
     ```
     <div id="toast-container"></div>

     <div class="modal-overlay" id="confirm-overlay">
       <div class="modal confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="confirm-msg">
         <p id="confirm-msg"></p>
         <div class="confirm-actions">
           <button class="btn btn-ghost"    id="confirm-cancel">Keep it</button>
           <button class="btn btn-primary"  id="confirm-ok">Unsubscribe</button>
         </div>
       </div>
     </div>

     <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
     ```
5. **Edit 3 — `subscriptions.html` helper** (top of the page script, line 264; copy of `mylist.html:662–684` with default label `'Unsubscribe'`):
   - `old_str`:
     ```
     <script src="app.js"></script>
     <script>
     (async () => {
     ```
   - `new_str`:
     ```
     <script src="app.js"></script>
     <script>
     function confirmDialog(message, okLabel = 'Unsubscribe') {
       return new Promise(resolve => {
         const overlay = document.getElementById('confirm-overlay');
         const msg     = document.getElementById('confirm-msg');
         const btnOk   = document.getElementById('confirm-ok');
         const btnCancel = document.getElementById('confirm-cancel');
         msg.textContent = message;
         btnOk.textContent = okLabel;
         overlay.classList.add('open');
         const close = result => {
           overlay.classList.remove('open');
           overlay.removeEventListener('click', onOverlay);
           document.removeEventListener('keydown', onKey);
           resolve(result);
         };
         const onOverlay = e => { if (e.target === overlay) close(false); };
         const onKey     = e => { if (e.key === 'Escape') close(false); };
         btnOk.onclick     = () => close(true);
         btnCancel.onclick = () => close(false);
         overlay.addEventListener('click', onOverlay);
         document.addEventListener('keydown', onKey);
       });
     }

     (async () => {
     ```
6. **Edit 4 — `subscriptions.html:419` call site** (handler at 418 is already `async`):
   - `old_str` (8-space indent):
     ```
             if (!confirm(`Unsubscribe from "${btn.dataset.series}"?`)) return;
     ```
   - `new_str`:
     ```
             if (!(await confirmDialog(`Unsubscribe from "${btn.dataset.series}"?`))) return;
     ```
7. **Edit 5 — `mylist.html:1081` call site** (handler at 1080 is already `async`; helper/overlay/CSS already on the page from F61):
   - `old_str` (10-space indent — distinguishes it from the subscriptions.html line):
     ```
               if (!confirm(`Unsubscribe from "${btn.dataset.series}"?`)) return;
     ```
   - `new_str`:
     ```
               if (!(await confirmDialog(`Unsubscribe from "${btn.dataset.series}"?`, 'Unsubscribe'))) return;
     ```
8. **Verification greps (counts derived from the edits above, not estimated):**
   - `Select-String -Path subscriptions.html -Pattern "confirm\("` → **0 lines** (`confirmDialog(` does not match — `m` is followed by `D`).
   - `Select-String -Path subscriptions.html -Pattern "confirmDialog"` → **2 lines** (helper definition + call site).
   - `Select-String -Path subscriptions.html -Pattern "confirm-overlay"` → **2 lines** (overlay `id` + `getElementById`).
   - `Select-String -Path mylist.html -Pattern "confirm\("` → **0 lines** (line 1081 was the last native site; 991 was converted by F61).
   - `Select-String -Path mylist.html -Pattern "confirmDialog"` → **3 lines** (definition 662 + calls 991, 1081).
   - `git diff` shows **no nav-block or footer-block lines changed** in either file (CLAUDE.md § Files That Must Stay in Sync).
9. **Playwright spec update (local-only, never committed):** `playwright\tests\05-subscriptions.spec.ts` lines 38–39 — replace
   ```ts
         authenticatedPage.once('dialog', d => d.accept());
         await unsubBtn.click();
   ```
   with
   ```ts
         await unsubBtn.click();
         await authenticatedPage.locator('#confirm-overlay.open #confirm-ok').click();
   ```
   (mirrors `03-mylist-cancel-guards.spec.ts:54–56`). Remember `Unblock-File` after any OneDrive sync of `.ps1` files.
10. **Smoke (Claude):** `.\run-smoke.ps1` — full suite green **before any push**.
11. **Commit + merge + deploy to staging (Claude):**
    ```
    git add subscriptions.html mylist.html
    git commit -m "fix(subscriptions,mylist): replace window.confirm with in-page modal — Brave/iOS suppression (F65)"
    git checkout staging
    git pull origin staging
    git merge --ff-only feature/f65-confirm-modal
    git push origin staging
    git push staging staging:main
    ```
12. > **PAUSE → Rick verifies on staging** (`mrcyberrick.github.io/comic-preorder-staging/`), Brave/iOS if available: Subscriptions page Unsubscribe shows the modal (confirm removes, cancel keeps); My List → My Subscriptions section Unsubscribe likewise. **Paste:** "staging verified" + browser used.
13. **Prod promotion at Rick's chosen window** (F65 is low severity — next normal promotion is fine). Claude prepares the standard workflow: `git merge staging --no-commit --no-ff` on `main`, `git checkout main -- config.js`, the F59 diff-assertion loop, branch `feat/f65-confirm-modal-prod` + PR. **Rick verifies `config.js` is NOT in the PR diff and merges.** Post-deploy write-smoke: subscribe to a test series as a test user, unsubscribe via the new modal, confirm the row is gone — then clean up.
14. **Record (Claude):** § 13 F65 → resolved (staging + prod commit hashes, browsers verified); Deploy Log row. Commit:
    ```
    docs: resolve F65 — subscriptions + mylist unsubscribe confirm-modal deployed (5.0 S6)
    ```

### S7 — Closeout (run once, when every § 5 box is ticked)

1. Tick the § 5 boxes with inline result notes (4.7/4.8 pattern).
2. This file: Status line → **Complete** + date; Last-updated line.
3. Parent (`phase-5-second-tenant-onboarding.md`): row 5.0 → **Complete** + date; § Deferred-DDL Register F64-item-5 owner confirmed; row 5.1 → **Planning** only when its plan file exists (next session writes it).
4. `CLAUDE.md` § Current Migration Phase: active sub-deploy → **5.1 (plan not yet written)**; last-completed sub-deploy → 5.0; § Known Out-of-Scope list updated (S5 line already removed; F63/F64/F66 deferral line updated to reflect residual = item 5 DDL + item 8).
5. Commit:
   ```
   docs: close Phase 5.0 (pre-Phase-5 housekeeping); advance pointer to 5.1 planning
   ```
6. End-of-session status update per `CLAUDE.md` § Anti-Drift Rules (changed / verified / left / filed / new IDs).

---

## 5. Completion criteria (all must be checked before parent row 5.0 → Complete)

- [ ] S1: 14 staging policies altered; live `pg_policies` shows zero `{public}`-role policies in `public` schema; full Playwright green after
- [ ] S2: items 1–3, 6, 7 live on staging (each verified via `information_schema` / `pg_constraint` query); every pre-flight returned 0 bad rows / expected set; full Playwright green after
- [ ] S3: code path documented in § 13 from execution-time re-verification; Rick's branch decision recorded; Branch A policy live and byte-equal to prod (or Branch B executed + new finding filed); Decline + suspend functionally verified on staging with a disposable account; full Playwright green
- [ ] S3: F64 item 5 decision + rationale recorded in § 13; parent § Deferred-DDL Register row filled with owner; **no realignment DDL executed in 5.0**
- [ ] S4: guard present in `pg_get_functiondef` output on **both** envs (exactly one added line vs pre-capture); `proacl` unchanged on both; prod `preorders_catalog_id_fkey` `confdeltype = a`
- [ ] S5: prod `settings.maintenance_mode` SELECT returns zero rows; captured row values stored in the Deploy Log; prod app loads normally post-delete; CLAUDE.md deferred-list line removed
- [ ] S6: zero native `confirm(` matches in `subscriptions.html` and `mylist.html`; derived grep counts match step-8 exactly; Playwright suite green (incl. updated 05 spec); staging verified by Rick (browser noted); prod promotion completed (or explicitly scheduled by Rick with a date) with write-smoke passed
- [ ] F58, F63, F65, F66 → resolved and F64 items 1–5 dispositioned in `technical-reference.md` § 13; any new finding filed from **F67**+ and resolved or deferred-with-owner
- [ ] Deploy Log complete (one row per executed step); all doc changes committed to `staging`; parent row 5.0 → **Complete** + date; `CLAUDE.md` pointer advanced

---

## 6. Rollback (per step; pre-captures are taken before every change)

- **S1 (F63):** `ALTER POLICY "<name>" ON public.<table> TO public;` restores any policy to its pre-change role list (the step-1 capture is the authoritative before-state). Strictly a loosening — never data-destructive.
- **S2 (F64 1–3, 6, 7):** `ALTER TABLE … DROP CONSTRAINT <name>;` for items 2/3/6/7; `ALTER TABLE public.catalog ALTER COLUMN price_usd TYPE numeric;` for item 1. All additive; no data changed.
- **S3 (F58):** Branch A: `DROP POLICY "admins manage tenant profiles" ON public.user_profiles;` (staging). Branch B: recreate the prod policy from the § 1.1/H4 capture (definition recorded in § 13 F58 and in `schema-prod-4.8.sql`).
- **S4 (F66):** `CREATE OR REPLACE` from the step-1/step-2 pre-captured `pg_get_functiondef` output (stored in the Deploy Log). **F64 item 4:** re-add with `ON DELETE CASCADE` from the captured definition — only as a true rollback; the CASCADE is the defect being removed.
- **S5:** `INSERT INTO settings (key, value, tenant_id) VALUES (<captured row>);` — values preserved in the Deploy Log Notes column.
- **S6 (F65):** standard code rollback — revert the commit on staging; prod rolls back by re-deploying the prior commit. No data dependency.
- Nothing in 5.0 touches customer data; Tier-3 forward-fix pressure does not apply.

---

## 7. References

- Scope sign-off: 2026-06-10 Phase 5 planning session (all seven candidates; F58 audit→decide→fix; F64-5 decide/defer-DDL; F64-8 excluded → 5.2).
- Findings: `docs/technical-reference.md` § 13 — F58, F63, F64 (per-item dispositions), F65, F66. **Next free ID F67.**
- Parent: `docs/phase-5-second-tenant-onboarding.md` (row 5.0; § Deferred-DDL Register).
- Shape mirror: `docs/phase-4.8-post-cutover-housekeeping.md` (execution model, pause-block format, deploy-log resume protocol).
- DDL sources of truth at planning: `catalogs\scripts\schema-staging-4.8.sql`, `schema-prod-4.8.sql` (2026-06-10 schema-only dumps; the similarly-named `schema-{prod,staging}-full.sql` are **full data dumps** despite the prefix — do not paste from those). Live DB overrides both at execution.
- Recovery anchors: `backups\2026-06-10-phase-4-close\` (full data dumps both envs + schema-only pair); tags `phase-4-cutover-v1` / `phase-4-cutover-v1-staging`.
- Projects: staging `puoaiyezsreowpwxzxhj`, prod `plgegklqtdjxeglvyjte`. Prod founding tenant UUID in `catalogs\scripts\phase-4-prod-tenant-uuid.txt` (local-only; **no 5.0 step needs it** — no tenant-scoped writes here).

---

## 8. Deploy log (filled during execution)

| Date | Step | Result | Notes |
|---|---|---|---|
| 2026-06-11 | S1 — F63 | Complete | Pre-capture: 21 rows (14 `{public}`, 7 `{authenticated}`). Post-capture: 21 rows all `{authenticated}`. Playwright 15/15 green. |
| 2026-06-11 | S2 — F64 items 1–3,6,7 | Complete | Items 1–3,6 clean. Item 1 required view drop/recreate (admin_preorders depends on price_usd) + REVOKE ALL (Supabase default-privilege escalation). Item 7 pre-flight found 44 Playwright orphan profiles (pw-*@example.test, 0 dependent rows); deleted inline before FK add. Playwright 15/15 green. |
| 2026-06-11 | S3 — F58 + F64 item 5 | Complete | Branch A: `admins manage tenant profiles` ALL policy added to staging. Functional verify: Decline removed profile and stayed gone on reload. `Users.suspend` has no admin UI entry point (no Users tab) — UPDATE path covered by ALL policy. F64 item 5: Option A decision recorded (profile-first, NO ACTION canonical); no DDL executed. Playwright 15/15 green. |

---

**Last updated:** 2026-06-10 (runbook written at the Phase 5 planning session; not yet executed)
