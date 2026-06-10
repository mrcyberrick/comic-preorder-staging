# Phase 4.8 — Post-Cutover Housekeeping

**Status:** Planning — plan written 2026-06-10 (same session as 4.7 closeout). **Not executed.**
**Parent plan:** `docs/phase-4-production-migration.md` (sub-deploy row 4.8)
**Predecessor:** `docs/phase-4.7-post-cutover-soak.md` — closed 2026-06-10 (soak clean; canary torn down). Scope source: `docs/phase-4.6-edge-functions-cutover.md` **Appendix A** (H1–H4) + **F61** deferral from the 4.7 soak (H5).
**Branches:** H1–H4 are prod-database + doc changes (doc commits → `staging` directly). H5 is an app-code change: feature branch off `staging` → `--ff-only` merge → staging smoke → prod promotion PR per `CLAUDE.md` § Standard Deployment Workflow (F59 diff assertion + post-deploy write-smoke).
**Execution model:** **CLI-orchestrated, Rick-in-the-loop.** A Claude Code CLI session runs this file top to bottom. It executes every repo / doc / local-script / Playwright step itself, and **pauses at every production-database step**, handing Rick the exact SQL to run in the Supabase SQL Editor and **waiting for pasted results before continuing**. **Self-contained — no chat context required.**
**Rollback complexity:** Easy — each item is an independent drop / code change with no customer-write dependency (Appendix A assessment). H5 follows normal staging-first deployment, revertible by re-deploying the prior commit.

> **Steps Claude never runs itself.** (1) Any Supabase **SQL Editor** statement — prod *or* staging. (2) The `pg_dump` structural-diff captures (connection strings hold credentials Claude never reads or echoes). (3) Supabase **dashboard** checks. (4) The prod promotion merge/PR approval in H5 — Claude prepares it; Rick reviews and merges. Each appears below as a **`PAUSE → Rick runs → paste result → match expected → continue / STOP`** block. Claude prepares the exact SQL/command text, the expected result, and the stop condition around every pause.

> **4.8 may span multiple sittings.** H1–H4 fit one session; H5's prod promotion may wait for Rick's chosen window. The durable state is the **Deploy Log (§ 8)**: every session appends one row per completed step. A resuming session reads the log, re-verifies the last recorded step against live state (a recorded drop is re-verified with its zero-row SELECT before trusting it), and continues from the next unexecuted step. Every doc edit is committed before the session ends — uncommitted runbook state is a drift source.

> **Why this sub-deploy exists.** 4.4 carved out the analytics-view retrofit (F55) because the retrofit target was undefined; F56/F57 are prod-only dead functions surfaced in the 4.4 audit; F61 is a Brave/iOS UX defect deferred from the 4.7 soak with this pass as its named owner. Clearing H1–H4 lets the Phase-4 structural-diff completion criterion (parent line 189) pass without standing annotations; H5 clears the last open soak finding.

---

## 0. Pre-flight (run at the top of every 4.8 session; halt on any mismatch)

### 0.1 Read before doing anything
- `CLAUDE.md` in full; confirm § Current Migration Phase active sub-deploy = **4.8**.
- `docs/phase-4-production-migration.md` §§ Sub-Deploys (row 4.8), Phase Completion Criteria (the structural-diff criterion this sub-deploy clears), Out of Scope (line 174 dead-code catalog stays out), Rollback Decision Tree.
- This file in full — including the Deploy Log (§ 8): if any rows exist, this is a resume session; re-verify the last recorded step against live state before continuing.
- `docs/technical-reference.md` § 13 — F55 / F56 / F57 / F58 / F61 entries (the findings this sub-deploy resolves or works around).

### 0.2 Gates (halt if any fail)
- `git rev-parse --abbrev-ref HEAD` → `staging`; `git status` → clean (a known-stray untracked `docs/status-slide.html` is acceptable; anything else, stop and ask).
- Confirm prod is post-cutover steady state: maintenance OFF, 4.7 closed (parent table row 4.7 = Complete / 2026-06-10).
- `docs/technical-reference.md` § 13: confirm the highest filed finding ID (F62 at planning time; **next free = F63**). New defects discovered during 4.8 are filed from the next free ID — never guessed or reused.
- **Re-verify the planning-time audits in § 1 against the current tree** (anti-drift: never trust a prior session's grep): the three caller greps in H1/H2/H3 are re-run at execution time even though this plan records their 2026-06-10 results.

### 0.3 Commit discipline
- Each H-step's doc update (finding resolution, annotation removal) is **its own doc-only commit to `staging`** with the finding ID in the message — exact messages are given inline at each step. Never bundle finding fixes.
- H5 app-code changes ride `feature/f61-confirm-modal`, never `staging` directly.
- Push `origin staging` after each commit; the Deploy Log row lands in the same commit as the step it records.

### Files touched by this sub-deploy

| File | Change | Branch |
|---|---|---|
| Production DB (`public` schema) | Drop 5 `analytics_*` views (H1); drop 2 dead functions (H2, H3) | n/a — Rick, prod SQL Editor |
| `mylist.html` | Replace `window.confirm()` cancel-guards with in-page modal (H5) | `feature/f61-confirm-modal` |
| `docs/technical-reference.md` § 13 | F55, F56, F57, F61 → resolved | `staging` (doc-only) |
| `docs/phase-4-production-migration.md` | Completion-criterion annotations removed (H4); row 4.8 → Complete | `staging` (doc-only) |
| `docs/phase-4.6-edge-functions-cutover.md` | Remove the F55 structural-diff annotation added in 4.6 § 6 | `staging` (doc-only) |
| `CLAUDE.md` | § Current Migration Phase pointer advance at closeout | `staging` (doc-only) |

**Not touched:** `config.js`, `scripts/import.js` / `import-staging.js`, any Edge Function source, any schema object other than the 7 drops above.

---

## 1. Planning-time audit results (2026-06-10) — the inputs 4.6 lacked

These audits were run during 4.8 planning (the 4.7-closeout session). They decide the H1 branch and pre-confirm H2/H3. **Re-run each grep at execution time before acting on it.**

### 1.1 H1 branch decision: **DROP** — the analytics views are dead code

- `analytics.html` exists in the repo (all branches) and is the admin analytics surface (nav-gated to admins on every page).
- Its entire data path queries **`usage_events` directly** via PostgREST — `db.from('usage_events')` at `analytics.html` lines 400, 447, 469, 490, 511, 552, 620, plus `user_profiles` name lookups at 558/627. RLS tenant-scopes these reads.
- **Zero references to any `analytics_*` view anywhere in the repo** (`grep -ri "analytics_" *.js *.html` → no view names; only CSS class names and element ids match `analytics`).
- Staging serves the identical page from the identical query path and has **no** `analytics_*` views — proving the views are not needed.
- Conclusion: the 5 prod views (`analytics_daily_events`, `analytics_top_cancelled`, `analytics_top_reserved`, `analytics_top_subscribed`, `analytics_user_activity`) predate the `analytics.html` client-side implementation and nothing reads them. **Drop to match staging** (Appendix A branch 1). The retrofit branch is dead — do not build staging counterparts.

### 1.2 H2 pre-confirmation: `claim_paper_account` has no caller

- Repo-wide grep (2026-06-10): the only non-doc hit is a **comment** at `app.js:945` describing a historical design option. No live call site in `app.js`, any HTML page, `supabase/functions/**`, or the CLI deploy sources at `C:\Users\richa\supabase\functions\**`.
- The `claim-paper-customer` Edge Function reimplements the merge in TypeScript (F33). Staging dropped the SQL function 2026-05-26 (4.1 C3) with no regression across the 4.1 canary soak and the 4.7 soak.

### 1.3 H3 pre-confirmation: `generate_invite_link` has no caller

- Repo-wide grep + CLI deploy sources (2026-06-10): **doc references only.** No call site in app code, Edge Functions, or local scripts paths searched.
- The live invite flow (`invite-customer` Edge Function) generates links via the GoTrue admin API, not this SQL function. Provenance remains unknown (likely pre-multitenancy experiment); it has no staging counterpart.

### 1.4 H5 inputs: `mylist.html` confirm sites + reusable modal pattern

- **F61 target:** `mylist.html:947` — `if (!confirm('Remove this reservation?')) return;` (Remove/cancel button).
- **Same-class neighbor on the same page:** `mylist.html:1037` — `if (!confirm(\`Unsubscribe from "${btn.dataset.series}"?\`)) return;`. Brave/iOS suppresses it identically. F61-as-filed names only the Remove button; H5 scope below covers **both** `mylist.html` sites (same page, same fix, same session) — confirm with Rick at execution before touching line 1037.
- **Out of this scope (same defect class, other pages):** `subscriptions.html:419`, `admin.html:1066/1235/1556/1603/1967`. Admin pages are Rick-operated (not Brave/iOS-blocked in practice); `subscriptions.html` is customer-facing and *would* benefit, but it is a separate page with its own deploy surface — catalog it as a candidate follow-up finding at execution time if Rick wants it fixed (next free ID), do not fold in silently.
- **Reusable pattern:** `style.css` already ships generic `.modal-overlay` / `.modal` classes (lines 624–654, used by the catalog detail modal) with an `.open` transition. The H5 modal reuses these; no new CSS file, minimal page-local styles.

---

## 2. In scope

1. **H1** — Drop the 5 prod-only `analytics_*` views (drop branch per § 1.1). Resolve **F55**.
2. **H2** — Drop prod `claim_paper_account(uuid, uuid)`. Resolve **F56**.
3. **H3** — Drop prod `generate_invite_link(text, text)`. Resolve **F57**.
4. **H4** — Re-run the Phase-4 structural diff (schema + `pg_policies`); confirm the only remaining intentional difference is **F58**; remove the F55 annotations from the parent completion criteria and 4.6 § 6.
5. **H5** — Replace `window.confirm()` cancel-guards on `mylist.html` with a custom in-page modal; staging smoke; prod promotion per standard workflow. Resolve **F61**.
6. Findings/doc/pointer updates + parent row 4.8 → Complete at closeout.

## 3. Out of scope (stop and ask before touching)

- **F58** (`user_profiles` admin-write policy parity) — staging-reconcile item with its own audit; remains the documented intentional diff after H4.
- **Pre-existing dead-code catalog** (F19 `is_admin`, F26 `admin_preorders` view, F33 remnants) — parent line 174–175; fold into this pass **only with explicit sign-off**, not inline.
- **`subscriptions.html` / `admin.html` `confirm()` sites** — same class as F61, different pages (§ 1.4); candidate new finding, not silent scope growth.
- **Phase-4-level completion items** — structural diff is *checked* here (H4), but the phase closeout itself (post-cutover dump as recovery anchor, `pre-multitenancy-state.md` Phase 4 notes, Phase 5 stub, ticking parent § Phase Completion Criteria) is the **next** session after 4.8 closes. Do not tick parent phase-level boxes in 4.8.
- Any Edge Function source change, `import.js` change, or schema change beyond the 7 named drops.

---

## 4. Runbook

Execution order: **H1 → H2 → H3 in one prod SQL Editor sitting → H4 diff → H5 app change last** (H5 is the only `main`-bound change; keeping it last means a failed smoke never blocks the DB housekeeping).

### H1 — Drop the 5 prod `analytics_*` views (F55)

1. **Re-verify (Claude):** `grep -rin "analytics_daily_events\|analytics_top_\|analytics_user_activity" *.js *.html supabase/functions/` → expect **zero** hits. Halt and re-plan if any appear (a caller landed since planning).
2. > **PAUSE → Rick (prod SQL Editor):**
   > ```sql
   > DROP VIEW IF EXISTS public.analytics_daily_events,
   >                     public.analytics_top_cancelled,
   >                     public.analytics_top_reserved,
   >                     public.analytics_top_subscribed,
   >                     public.analytics_user_activity;
   > -- verify gone:
   > SELECT viewname FROM pg_views WHERE schemaname='public' AND viewname LIKE 'analytics\_%';
   > ```
   > **Paste:** the verify result. **Expected:** zero rows. **STOP if:** any view remains or the DROP errors (a dependency exists that the audit missed — investigate, do not CASCADE blindly).
3. **Post-drop smoke (Rick, ~1 min):** load `analytics.html` on prod as admin; all cards render. (They read `usage_events`, so this must be unaffected — the check exists to catch a wrong-branch surprise immediately, while it is one `CREATE VIEW` away from undone.)
4. **Record (Claude):** F55 → resolved (drop branch) in `technical-reference.md` § 13; Deploy Log row. Commit:
   ```
   docs: resolve F55 — 5 prod analytics_* views dropped (4.8 H1, drop branch)
   ```

### H2 — Drop prod `claim_paper_account(uuid, uuid)` (F56)

1. **Re-verify (Claude):** `grep -rn "claim_paper_account" app.js *.html supabase/functions/` and the CLI deploy sources → comment-only at `app.js:945` is the sole acceptable hit.
2. > **PAUSE → Rick (prod SQL Editor):**
   > ```sql
   > DROP FUNCTION IF EXISTS public.claim_paper_account(uuid, uuid);
   > SELECT proname FROM pg_proc WHERE proname = 'claim_paper_account';
   > ```
   > **Paste:** the verify result. **Expected:** zero rows.
3. **Record (Claude):** F56 → resolved in § 13; Deploy Log row. Commit:
   ```
   docs: resolve F56 — prod claim_paper_account(uuid,uuid) dropped (4.8 H2)
   ```

### H3 — Drop prod `generate_invite_link(text, text)` (F57)

1. **Re-verify (Claude):** `grep -rn "generate_invite_link" app.js *.html supabase/functions/` + CLI deploy sources → **zero** non-doc hits. **STOP and ask if any caller is found — do not drop a live function.**
2. > **PAUSE → Rick (prod SQL Editor), only if step 1 is clean:**
   > ```sql
   > DROP FUNCTION IF EXISTS public.generate_invite_link(text, text);
   > SELECT proname FROM pg_proc WHERE proname = 'generate_invite_link';
   > ```
   > **Paste:** the verify result. **Expected:** zero rows.
3. **Quick invite-flow smoke (Rick):** send one test invite from the prod admin UI (or confirm the most recent real invite post-dates planning) — the live flow uses the `invite-customer` EF and must be unaffected.
4. **Record (Claude):** F57 → resolved in § 13; Deploy Log row. Commit:
   ```
   docs: resolve F57 — prod generate_invite_link(text,text) dropped (4.8 H3)
   ```

### H4 — Structural-diff re-confirm (parent completion criterion, line 189)

1. > **PAUSE → Rick (local shell; connection strings hold credentials, Claude never sees them):**
   > ```
   > pg_dump --schema-only --no-owner --no-privileges "<PROD_CONN>"    > schema-prod-4.8.sql
   > pg_dump --schema-only --no-owner --no-privileges "<STAGING_CONN>" > schema-staging-4.8.sql
   > ```
   > **Paste:** both files (or drop them in a scratch path Claude can read — they contain schema only, no data/credentials).
2. **Claude:** normalize (strip comments, SET lines, whitespace; sort objects) and diff. **Expected residual differences:** none attributable to F55/F56/F57 (cleared by H1–H3). Document anything else found; **expected known item:** F58 `user_profiles` policy difference.
3. > **PAUSE → Rick (both SQL Editors):**
   > ```sql
   > SELECT tablename, policyname, cmd, roles, qual, with_check
   > FROM pg_policies WHERE schemaname='public'
   > ORDER BY tablename, policyname;
   > ```
   > **Paste:** both result sets. **Expected:** identical except the documented F58 row (`admins manage tenant profiles` ALL-policy on prod `user_profiles`).
4. **Doc updates (Claude):** parent § Phase Completion Criteria — remove the F55 satisfied-with-annotation wording from the structural-diff criterion (leave the F58 annotation); `phase-4.6-edge-functions-cutover.md` § 6 — strike the F55 annotation; Deploy Log row with the diff result. Commit:
   ```
   docs: 4.8 H4 structural diff re-confirmed — F58 only remaining intentional difference
   ```
5. **STOP if:** any *unexpected* structural difference appears → file it as a new finding (next free ID), do not reconcile inline.

### H5 — F61: replace `window.confirm()` with an in-page modal on `mylist.html`

1. **Branch:** `git checkout -b feature/f61-confirm-modal` off current `staging`.
2. **Confirm scope with Rick before editing:** Remove button (`mylist.html:947`, F61 proper) is committed scope; the unsubscribe guard (`mylist.html:1037`) is recommended-include per § 1.4 — Rick decides include/defer at this pause.
3. **Implementation sketch** (final code reads the live file first, per file-drift rules):
   - Add one hidden overlay near the toast container, reusing existing `style.css` classes:
     ```html
     <div class="modal-overlay" id="confirm-overlay">
       <div class="modal confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="confirm-msg">
         <p id="confirm-msg"></p>
         <div class="confirm-actions">
           <button class="btn btn-ghost"   id="confirm-cancel">Keep it</button>
           <button class="btn btn-primary" id="confirm-ok">Remove</button>
         </div>
       </div>
     </div>
     ```
   - Add a promise-based helper in the page script (no `app.js` change — page-local, like the existing page scripts):
     ```js
     function confirmDialog(message, okLabel = 'Remove') { /* returns Promise<boolean>;
       shows overlay, resolves true on #confirm-ok, false on #confirm-cancel,
       overlay-background click, or Escape */ }
     ```
   - Replace `if (!confirm('Remove this reservation?')) return;` with `if (!(await confirmDialog('Remove this reservation?'))) return;` (handler at line 945 is already `async`). Same pattern at line 1037 if Rick includes it (`okLabel: 'Unsubscribe'`; its handler is also `async`).
   - **No native `confirm()` remains on the page** when done: `grep -n "confirm(" mylist.html` → only `confirmDialog` definitions/calls.
4. **Nav/footer parity check:** the edit touches neither nav nor footer blocks; verify with `git diff` that no shared block changed (CLAUDE.md § Files That Must Stay in Sync).
5. **Smoke (Claude, local Playwright):** `.\run-smoke.ps1` — full suite green, especially the mylist cancel-guard specs (update the spec's dialog handling: Playwright's `dialog` auto-accept no longer applies; the spec clicks the in-page modal buttons instead). The spec change lives in the local playwright folder (never committed).
6. **Commit + merge + deploy to staging (Claude):**
   ```
   git add mylist.html
   git commit -m "fix(mylist): replace window.confirm with in-page modal — Brave/iOS suppression (F61)"
   git checkout staging
   git pull origin staging
   git merge --ff-only feature/f61-confirm-modal
   git push origin staging
   git push staging staging:main
   ```
   (Smoke from step 5 runs **before** the pushes, per the standard workflow.)
7. > **PAUSE → Rick verifies on staging** (`mrcyberrick.github.io/comic-preorder-staging/`), on Brave/iOS if available — the defect environment: modal appears on Remove, confirm completes the removal, cancel keeps the row.
   > **Paste:** "staging verified" (+ browser used).
   > Then **Rick decides prod promotion timing** (F61 is low severity — next normal promotion window is fine). When promoting, Claude prepares the standard workflow: `git merge staging --no-commit --no-ff` on `main`, `git checkout main -- config.js`, the F59 diff-assertion loop, `feat/f61-confirm-modal-prod` branch + PR. **Rick verifies config.js is NOT in the PR diff and merges.** Post-deploy write-smoke: reserve + cancel one item as a test user — the cancel now exercises the new modal on prod.
8. **Record (Claude):** F61 → resolved in § 13 with the deployed commit hash; note whether line 1037 (unsubscribe) was included; Deploy Log row. Commit:
   ```
   docs: resolve F61 — mylist confirm-modal deployed to prod (4.8 H5)
   ```

---

## 5. Completion criteria (all must be checked before parent row 4.8 → Complete)

- [ ] H1: 5 `analytics_*` views dropped on prod; live `pg_views` SELECT returns zero rows; prod `analytics.html` renders post-drop
- [ ] H2: `claim_paper_account` dropped; live `pg_proc` SELECT returns zero rows
- [ ] H3: `generate_invite_link` dropped; live `pg_proc` SELECT returns zero rows; invite flow verified working post-drop
- [ ] H4: structural diff + `pg_policies` diff re-run; only documented residual is F58; F55 annotations removed from parent criterion and 4.6 § 6
- [ ] H5: `mylist.html` cancel-guard(s) use the in-page modal; no native `confirm(` left on the page; Playwright suite green; deployed to staging; prod promotion completed (or explicitly scheduled by Rick with a date) with write-smoke passed
- [ ] F55, F56, F57, F61 marked resolved in `technical-reference.md` § 13 (F61 only after prod deploy)
- [ ] Any new finding surfaced during 4.8 filed from the next free ID (F63+) and resolved or deferred-with-owner
- [ ] Parent Sub-Deploys table row 4.8 → **Complete** + date; this file's Status line updated
- [ ] `CLAUDE.md` § Current Migration Phase pointer advanced (next: **Phase-4-level completion audit** session — dump anchor, `pre-multitenancy-state.md` notes, Phase 5 stub, parent criteria tick)
- [ ] All doc changes committed to `staging` (doc-only commits; no stray files)

### Closeout sequence (run once, when every box above is ticked)
1. Tick the boxes above with inline result notes (mirror the 4.7 § 6.2 pattern).
2. This file: Status line → **Complete** + date; Last-updated line.
3. Parent table: row 4.8 → **Complete** + date.
4. `CLAUDE.md`: Phase 4 status line — append "4.8 closed DATE"; active sub-deploy → **Phase 4 completion audit**; last-completed sub-deploy → 4.8.
5. Commit:
   ```
   docs: close Phase 4.8 (post-cutover housekeeping); advance pointer to Phase 4 completion audit
   ```
6. End-of-session status update per `CLAUDE.md` § Anti-Drift Rules (changed / verified / left / filed / new IDs).

---

## 6. Rollback

- **H1–H3 (drops):** recreate from the captured pre-drop definitions. **Before dropping anything**, Rick saves `pg_get_viewdef()` / `pg_get_functiondef()` output for all 7 objects to a local scratch file (one extra SELECT in the same sitting):
  ```sql
  SELECT viewname, pg_get_viewdef(('public.'||viewname)::regclass, true) FROM pg_views
  WHERE schemaname='public' AND viewname LIKE 'analytics\_%';
  SELECT proname, pg_get_functiondef(oid) FROM pg_proc
  WHERE proname IN ('claim_paper_account','generate_invite_link');
  ```
  This is the H1/H2/H3 step-0 capture — run it before the first DROP.
- **H5:** standard code rollback — revert the commit on staging; prod rolls back by re-deploying the prior tagged commit. No data dependency.
- Nothing in 4.8 touches customer data; Tier-3 forward-fix pressure does not apply to the drops (they are reversible from the captured definitions).

---

## 7. References

- Scope source: `docs/phase-4.6-edge-functions-cutover.md` Appendix A (H1–H4 verbatim basis + guard).
- Findings: `docs/technical-reference.md` § 13 — F55 (2079), F56 (2085), F57 (2091), F58 (2097), F61 (2131). Next free ID **F63**.
- Parent: `docs/phase-4-production-migration.md` — completion criteria lines 188–203 (structural-diff criterion + annotations), Out of Scope line 174 (dead-code catalog stays out).
- Planning-time audit evidence: § 1 above (recorded 2026-06-10; re-verify at execution).
- Prod project ref `plgegklqtdjxeglvyjte`; staging `puoaiyezsreowpwxzxhj`. Prod founding UUID in `scripts/phase-4-prod-tenant-uuid.txt` (not needed by any 4.8 step — no tenant-scoped writes here).

---

## 8. Deploy log (filled during execution)

| Date | Step | Result | Notes |
|---|---|---|---|
| 2026-06-10 | H1 — DROP 5 analytics_* views | ✓ — zero rows on pg_views verify; analytics.html renders post-drop | Rollback defs captured step-0; 7/7 objects present |
| 2026-06-10 | H2 — DROP claim_paper_account(uuid,uuid) | ✓ — zero rows on pg_proc verify | |
| 2026-06-10 | H3 — DROP generate_invite_link(text,text) | ✓ — zero rows on pg_proc verify; invite flow verified working post-drop | |
| 2026-06-10 | H4 — Structural diff re-confirm | F55 cleared; F58 confirmed (prod has admins manage tenant profiles ALL; staging lacks it); **unexpected:** F63 (13 staging policies missing TO authenticated) + F64 (8 pre-Phase-4 DDL divergences) filed; F19 is_admin() prod-only (pre-existing). Phase-4-level structural-diff criterion not tickable until F63/F64 assessed (next session). pg_policies paste: table 1 = staging ({public} roles), table 2 = prod ({authenticated} roles). | |

---

**Last updated:** 2026-06-10 (upgraded to self-contained CLI execution runbook: execution-model guard, multi-sitting resume rules, per-step commit messages, closeout sequence; not executed).
