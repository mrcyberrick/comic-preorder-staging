# Phase 3.5 — Usage Events Purge Job (90-day retention)

**Status:** Complete — 2026-05-10
**Parent phase:** `docs/phase-3-tenant-resolution.md`
**Branch base:** `staging`
**Branch name:** `feature/3.5-usage-events-purge`
**Estimated duration:** one session
**Customer impact:** none (staging only, internal cleanup)

---

## Goal

Introduce a 90-day retention purge for `usage_events`. After 3.5, rows
older than 90 days in `usage_events` are removed automatically as part
of the weekly import run. Retention is per-tenant (matches established
pattern), hard delete (no archive), threshold fixed at 90 days in the
function body for now.

Also fixes F31 inline — a one-line stale comment in
`app.js` `UsageEvents._log()` left over from Phase 3.3's column-default
removal. Bundling is a deliberate scope decision (see below).

---

## Approach Summary

Decisions confirmed during planning, recorded here so the CLI session
does not re-litigate them:

| Decision | Choice | Rationale |
|---|---|---|
| Delivery mechanism | Import script calls the RPC at end of run | No new scheduled-job infrastructure; minimum surface area; cadence is weekly, well under the 90-day window so retention drift is negligible |
| Per-tenant or cross-tenant function | Per-tenant (`p_tenant_id`) | Matches `purge_stale_catalog`, `archive_stale_reservations`, `delete_dropped_catalog_items` pattern; "no operation runs without explicit tenant context" is the Phase 3 ethos |
| Caller iteration today | Single call with `TENANT_ID` constant | The script is single-tenant everywhere else; adding a tenants-table fetch + loop for a list of length 1 is premature. When tenant 2 onboards, this is one of many script changes that happen together |
| Retention value | Fixed at 90 days, passed as `p_retention_days` parameter from caller | Function is reusable; caller controls cadence/value; per-tenant configurability deferred until needed |
| Delete vs archive | Hard DELETE | `usage_events` is fire-and-forget telemetry; no archive precedent for it; archive table would carry its own cost |
| Position in import flow | End of `main()`, every invocation | Retention is time-based, not month-boundary-based; running on every import keeps the window tight; cost is one DELETE per run |
| F31 (stale comment) | Bundled into this sub-deploy | One-line trivial fix in a file (`app.js`) already adjacent to the work; isolating it would just churn the change log |

---

## In Scope

1. New SECURITY DEFINER SQL function
   `purge_old_usage_events(p_tenant_id uuid, p_retention_days integer)`
   that hard-deletes `usage_events` rows older than the threshold for
   the given tenant and returns the deletion count.

2. New call site in `import-staging.js`, at the end of `main()`, that
   invokes the RPC with `TENANT_ID` and `90`. Runs on every import
   invocation, after the notification step and before
   `"✅ Import complete!"`. Failure is logged but non-fatal —
   retention is best-effort, not blocking.

3. F31 fix in `app.js` `UsageEvents._log()`: update the stale comment
   that references the now-removed Phase 3.3 column default.

4. Documentation updates:
   - `CLAUDE.md` § Current Migration Phase — mark 3.5 active during work,
     Complete on close.
   - `docs/phase-3-tenant-resolution.md` § Sub-Deploys table —
     mark 3.5 Complete and write the 3.6 plan reference.
   - `docs/technical-reference.md` — append a row for
     `purge_old_usage_events` in Section 6 (Functions); update F31's
     **Status** line to `fixed YYYY-MM-DD`; update the §4.8
     `usage_events` notes line that currently says "no UPDATE or DELETE
     policy exists" to mention the service-role purge function path.

## Out of Scope

These belong to other sub-deploys or hardening passes. Do not touch
inline. Per anti-drift rules: discover → describe → ask → wait.

- **Finding E** (broad table-level grants on `usage_events` for `anon`,
  `authenticated`, `service_role`). RLS already prevents data exposure;
  Finding E is defense-in-depth and queued for a dedicated grant-audit
  sub-deploy spanning all tenant-scoped tables. **Do not narrow grants
  on `usage_events` in this session.**
- **F23** (other SECURITY DEFINER functions missing
  `SET search_path = public`). Broader cleanup. The new function
  *introduced* by 3.5 must be born with `SET search_path = public` —
  that is not fixing F23, that is writing the new function correctly
  to current standard. Do not retrofit `purge_stale_catalog`,
  `delete_dropped_catalog_items`, `get_popular_series`, or `is_admin`
  here.
- **`analytics.html` query window verification**. Pre-flight step
  (below) only — confirm by `grep`/inspection that no analytics query
  reads `usage_events` older than 90 days. If verification fails,
  **stop and ask**; do not adjust analytics queries inline.
- **`UsageEvents` business logic** (event types, payload shape,
  defensive `tenant_id` fallback in `_log()`). 3.5 touches one comment
  line, nothing else in that module.
- **Production `import.js`**. Standing rule: do not modify until
  production gets Phase 1. Patches for production are queued for
  the Phase 4 cutover.
- **3.6 admin operational tooling** and **3.7 smoke test automation**.
  Separate sub-deploys.
- **Generalizing the purge to other telemetry tables**. There are no
  other telemetry tables today; speculative scope.

---

## Pre-flight (planning verification, before execution)

These are read-only checks the CLI session runs before any change. If
any fails, stop and ask before proceeding.

### P1 — Confirm `usage_events` schema matches what the plan assumes
```sql
\d usage_events
```
Expected: `tenant_id uuid NOT NULL`, `created_at timestamptz DEFAULT now()`,
`usage_events_created_at_idx` exists on `created_at DESC`,
`idx_usage_events_tenant` exists on `tenant_id`. If schema diverges,
stop — the purge function and its expected performance both assume this
shape.

### P2 — Confirm no analytics consumer reads beyond 90 days
```bash
grep -nE "usage_events|UsageEvents" analytics.html app.js
```
Inspect the matches. The user has confirmed analytics already operates
within a ≤ 90-day window. The CLI session's job is to spot-verify: any
query with `.gte('created_at', ...)` or `WHERE created_at >= ...` should
reference a date no older than `now() - interval '90 days'` (or the
JS equivalent). If a longer window appears, **stop and ask**.

### P3 — Confirm no existing function named `purge_old_usage_events`
```sql
SELECT proname FROM pg_proc WHERE proname = 'purge_old_usage_events';
```
Expected: zero rows. If it exists, stop — the plan assumed greenfield.

### P4 — Confirm F31's target lines exist in `app.js` as described
```bash
grep -n "DB column default" app.js
```
Expected: a hit inside the `UsageEvents._log()` method (technical
reference points to ~lines 531–532). If no hit, the comment may have
been touched already by another session — stop and re-read the file
before editing.

### P5 — Confirm the import script's `TENANT_ID` constant is intact
The import script lives outside the repo
(`C:\Users\richa\OneDrive\Documents\(Work)\BookStop\catalogs\scripts\import-staging.js`).
The user runs the script locally; the CLI session does not edit it
directly. Output produced for the user to paste in is the workflow.
Confirm with the user that `TENANT_ID` near the top of the file still
reads `'72e29f67-39f7-42bc-a4d5-d6f992f9d790'`.

---

## Changes

### Change 1 — Create `purge_old_usage_events(uuid, integer) → integer`

**Where:** Supabase staging SQL editor (run by user, not the CLI session).
The CLI session generates the SQL and saves it to
`docs/sql/purge_old_usage_events.sql` for the user to paste.

**SQL:**
```sql
-- Phase 3.5 — per-tenant retention purge for usage_events.
-- Hard-deletes rows older than p_retention_days. Returns count deleted.
-- Called by import-staging.js at the end of each weekly run.

CREATE OR REPLACE FUNCTION public.purge_old_usage_events(
  p_tenant_id      uuid,
  p_retention_days integer
)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH deleted AS (
    DELETE FROM public.usage_events
    WHERE tenant_id  = p_tenant_id
      AND created_at < now() - make_interval(days => p_retention_days)
    RETURNING 1
  )
  SELECT count(*)::integer FROM deleted;
$$;

REVOKE ALL ON FUNCTION public.purge_old_usage_events(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.purge_old_usage_events(uuid, integer) TO service_role;
```

**Why these choices:**
- `SECURITY DEFINER` — `usage_events` has no DELETE policy in RLS (per
  technical reference §7.1, "append-only"); a DEFINER function is the
  controlled DELETE path. Service-role alone could do it, but a named
  function is greppable, auditable, and matches `purge_stale_catalog`.
- `SET search_path = public` — built-in to the new function, not a
  retrofit of F23. Modern Supabase requirement.
- `make_interval(days => ...)` — safe construction from an integer
  argument; avoids the `(p_retention_days || ' days')::interval`
  string-concat idiom.
- `REVOKE ... FROM PUBLIC` then `GRANT ... TO service_role` — only the
  import script (service-role-keyed) should call this. Authenticated
  users have no business invoking it directly.
- Returns `integer` — count of deleted rows, mirrors
  `purge_stale_catalog`'s return shape so the script's logging code
  can follow the same pattern.

**Verification (after running):**
```sql
-- 1. Function exists with correct signature
SELECT proname, pg_get_function_arguments(oid), pg_get_function_result(oid)
FROM pg_proc
WHERE proname = 'purge_old_usage_events';
-- Expected: arguments "p_tenant_id uuid, p_retention_days integer", result "integer"

-- 2. SECURITY DEFINER and search_path are set
SELECT proname, prosecdef, proconfig
FROM pg_proc
WHERE proname = 'purge_old_usage_events';
-- Expected: prosecdef = true, proconfig = {search_path=public}

-- 3. Only service_role has EXECUTE
SELECT grantee, privilege_type
FROM information_schema.routine_privileges
WHERE routine_name = 'purge_old_usage_events';
-- Expected: one row, grantee=service_role, privilege_type=EXECUTE

-- 4. Dry-run with the founding tenant, expect a count (likely 0 in staging)
SELECT public.purge_old_usage_events(
  '72e29f67-39f7-42bc-a4d5-d6f992f9d790'::uuid,
  90
);
-- Expected: an integer (probably 0 on first run unless staging has 90+ day old events)
```

### Change 2 — Wire the purge call into `import-staging.js`

**Where:** local scripts folder (user applies, CLI session generates the
exact diff and the user pastes). The CLI session also adds the SQL file
to the repo per Change 1.

**Insertion point:** end of `main()`, immediately before the final
`console.log('\n✅ Import complete!');`. After the notification block,
inside the same try/await flow.

**Diff (against the sample currently in `/mnt/project/sample-import-staging.js`):**
```diff
       console.error(`   ❌ Notification failed: ${err.message}`);
     }
   }

+  // ── Step 8: Purge old usage_events (90-day retention) ─────
+  // Best-effort cleanup. Failure is logged but non-fatal —
+  // retention is not a precondition for any later step.
+  console.log('\n🧹 Purging usage_events older than 90 days...');
+  try {
+    const purgeRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/purge_old_usage_events`, {
+      method:  'POST',
+      headers: HEADERS,
+      body:    JSON.stringify({ p_tenant_id: TENANT_ID, p_retention_days: 90 }),
+    });
+    if (purgeRes.ok) {
+      const deleted = await purgeRes.json();
+      console.log(`   ✅ Purged ${deleted ?? 0} usage_events row(s)`);
+    } else {
+      console.warn(`   ⚠️  Usage events purge failed: ${await purgeRes.text()}`);
+    }
+  } catch (err) {
+    console.warn(`   ⚠️  Usage events purge errored: ${err.message}`);
+  }
+
   console.log('\n✅ Import complete!');
   if (isNewMonth) {
     console.log('   Remember to turn Maintenance Mode OFF in the admin panel.');
   }
 }
```

**Why these choices:**
- **Non-fatal failure path** — if the RPC is missing or the function
  signature drifts, the import still completes successfully. The user
  sees a `⚠️` line and can investigate. Retention is housekeeping;
  blocking the import on it would be the wrong tradeoff.
- **Position after notification, before "Import complete!"** — keeps
  the purge inside the script's status report but does not interpose
  it between user-visible actions (catalog, shipment, notify) that the
  user is mentally tracking.
- **Constants inline (`90`, `TENANT_ID`)** — `TENANT_ID` already exists
  at the top of the file; introducing a `RETENTION_DAYS` constant for
  a value used in one place is over-engineering. If a second caller
  needs the value, extract then.
- **No `BATCH_SIZE` involvement** — it is one RPC call, not a batched
  insert.

**Verification (after applying):**
1. Re-run the script with the same CSVs used for last import; expect
   the new step to print after notification.
2. Inspect Supabase staging: `SELECT COUNT(*) FROM usage_events WHERE created_at < now() - interval '90 days';` should be 0 after the run.
3. Sanity check no other `usage_events` rows were affected: `SELECT COUNT(*) FROM usage_events;` should be unchanged minus the count the script reported as purged.

### Change 3 — Fix F31 stale comment in `app.js`

**Where:** repo `app.js`, inside `UsageEvents._log()`. Technical
reference points to lines 531–532 but **the CLI session must re-read
the file** — line numbers drift across sessions.

**Find:** the comment line(s) referencing "DB column default" and "final
safety net" inside `UsageEvents._log()`. There should be exactly one
occurrence in the file (P4 confirms this).

**Replace with:** a comment that accurately describes the current
fallback chain — `TenantContext.current()` first, `FOUNDING_TENANT.id`
as the last-resort fallback because Phase 3.3 removed the column
default. Exact wording is the CLI session's call as long as it:
- Removes the stale "DB column default is the final safety net" claim.
- Names `FOUNDING_TENANT.id` (or the actual symbol used at that line)
  as the current safety net.
- Stays a comment — no behavioral change.

**Verification:**
```bash
grep -n "DB column default" app.js
# Expected: zero matches
grep -n "FOUNDING_TENANT" app.js | head
# Expected: the existing fallback code line(s) unchanged; updated
# comment line above/near them references FOUNDING_TENANT
```

No runtime smoke test needed — comment-only change.

---

## Execution Sequence

Strict order. The CLI session does not skip ahead.

1. Pre-flight P1–P5. Stop if any fails.
2. Create the SQL file at `docs/sql/purge_old_usage_events.sql` with
   the exact body from Change 1.
3. Hand the SQL to the user to run in Supabase staging SQL editor.
   Wait for confirmation. Run verification queries 1–4 from Change 1.
4. Apply Change 3 (F31 comment fix) in `app.js`. Run its grep
   verification.
5. Generate the diff for Change 2 (import script). The user applies it
   to the local script (it lives outside the repo).
6. The user re-runs `import-staging.js` against the most recent
   catalog/shipment files (or runs catalog-only if no fresh shipment
   is available — the purge step runs either way).
7. Run post-execution verification (next section).
8. Commit: Change 3 (app.js) and the new SQL file together on
   `feature/3.5-usage-events-purge`. Suggested commit message:
   `feat(3.5): purge_old_usage_events function + import call; fix F31 stale comment`
9. Merge to `staging`, push to GitHub Pages staging, smoke-test
   (login → catalog reserve → confirm a `usage_events` row appears
   under 90-day window; no behavioral regression).
10. Status update (per anti-drift rules), then update CLAUDE.md and
    parent phase doc per "Documentation updates" in In Scope.

---

## Post-execution verification

After the import script runs:

```sql
-- A. Any rows older than 90 days remaining? Expected: 0
SELECT COUNT(*) FROM usage_events
WHERE created_at < now() - interval '90 days';

-- B. Founding tenant rows still present within the retention window
SELECT COUNT(*) FROM usage_events
WHERE tenant_id = '72e29f67-39f7-42bc-a4d5-d6f992f9d790'
  AND created_at >= now() - interval '90 days';
-- Expected: same as pre-run count of in-window rows (no false deletes)

-- C. No cross-tenant rows touched
-- (Currently only one tenant exists; this becomes meaningful at tenant 2.
--  For now, this confirms the WHERE tenant_id = ... filter is shaped
--  correctly in the function body.)
SELECT tenant_id, COUNT(*) FROM usage_events GROUP BY tenant_id;
-- Expected: one row only, the founding tenant UUID

-- D. Function execution trace via pg_stat_statements (optional)
SELECT query, calls, total_exec_time
FROM pg_stat_statements
WHERE query ILIKE '%purge_old_usage_events%'
ORDER BY calls DESC LIMIT 5;
```

Browser smoke test:
1. Log in as a normal customer on staging.
2. Reserve any catalog item.
3. As admin, navigate to analytics.html.
4. Confirm: the new event appears in analytics (within whatever
   recent-window the page shows); no JS errors in DevTools; no 500s in
   the network panel referencing `usage_events`.

---

## Completion Criteria

Phase 3.5 is complete when **all** of the following are true on staging:

- [ ] `purge_old_usage_events(uuid, integer)` exists in staging Supabase,
      SECURITY DEFINER, `search_path = public`, executable only by
      service_role (Change 1 verification queries pass).
- [ ] `import-staging.js` calls the RPC at end of `main()`; a re-run
      shows the new step output and post-execution query A returns 0.
- [ ] F31's "DB column default" comment is gone from `app.js`;
      `grep "DB column default" app.js` returns no hits.
- [ ] `docs/sql/purge_old_usage_events.sql` committed to staging.
- [ ] `docs/technical-reference.md` updated:
        - new function row in §6
        - §4.8 notes line updated to mention the purge path
        - F31 status updated to `fixed YYYY-MM-DD`
- [ ] `docs/phase-3-tenant-resolution.md` Sub-Deploys table:
      3.5 marked Complete with date; 3.6 plan reference added.
- [ ] `CLAUDE.md` § Current Migration Phase updated:
      3.5 complete, 3.6 plan pending, soak in progress.
- [ ] Browser smoke test passes (event appears in analytics, no errors).
- [ ] Status update produced per anti-drift rules.

---

## Carry-forward / Notes

Items observed during planning that are intentionally **not** addressed
in 3.5. Recorded so they don't get lost:

- **Finding E** (broad grants on `usage_events`) — queued for a dedicated
  grant-audit hardening sub-deploy spanning all tenant-scoped tables.
  Touching grants here would be scope creep.
- **F23** (`SET search_path` missing on several existing DEFINER
  functions) — broader cleanup, separate sub-deploy. New function in
  3.5 is born compliant; existing functions untouched.
- **`import.js` (production)** — needs the same Change 2 call before its
  first post-migration run. Logged here for the Phase 4 cutover; do
  not patch production script in 3.5.
- **Per-tenant retention overrides** — if a future tenant requires a
  different window, the path is to read the value from `app_settings`
  in the caller (script or eventual job) and pass it as
  `p_retention_days`. The function already supports it; no schema
  change needed.

---

## Reference

- Parent: `docs/phase-3-tenant-resolution.md`
- Schema canonical: `docs/technical-reference.md` §4.8 (`usage_events`),
  §6 (functions), §7.1 (RLS), F31 (stale comment), Finding E (grants),
  F23 (search_path hardening).
- CLAUDE.md § Anti-Drift Rules — followed throughout this plan.
- Sample import script reference: `/mnt/project/sample-import-staging.js`
  (used to fix insertion-point context for Change 2's diff).

---

**Plan written:** 2026-05-10
**Plan author session:** chat (Opus)
**Execution session target:** Claude Code CLI on staging repo
