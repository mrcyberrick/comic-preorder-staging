# Phase 3.6 — Admin Operational Tooling — Wednesday Workflow

**Status:** Complete — 2026-05-11
**Parent phase:** `docs/phase-3-tenant-resolution.md`
**Branch base:** `staging`
**Branch name:** `feature/3.6-admin-wednesday-tooling`
**Estimated duration:** one extended session (largest sub-deploy in Phase 3; consider splitting into 3.6a/3.6b if execution session runs long — see § Execution Sequence)
**Customer impact:** none (staging only); customer-side surfaces (`mylist.html`, `arrivals.html`) inherit auto-fulfilled state through the existing catalog upsert join — no behavioral change beyond items showing as fulfilled after their on-sale date

---

## Goal

Replace the current multi-printout Wednesday bagging workflow with a single
**This Week bagging list** rendered from the admin "This Week" tab. The tab
becomes the canonical bag-and-call surface for the store: one print covers
every customer's arrivals for the week, week navigation lets the admin
preview next Wednesday or audit last Wednesday, and a per-customer email
button sends a "your books are in" reminder.

Introduce **automatic fulfillment** based on `on_sale_date` having passed.
The existing manual bulk-fulfill-by-title flow stays as the exception path
for pre-FOC rush orders. The automatic path handles the common case —
everything that arrives in the regular weekly shipment is treated as
in-hand once its on-sale date is reached, with no admin click required.

Bundle two deferred bugs that CLAUDE.md ties to this sub-deploy:

1. `Preorders.cancel` has no fulfilled-guard — a customer can DELETE a
   fulfilled preorder from `mylist.html` and destroy the audit trail.
2. `admin.html`'s `deadline-input` and several sibling inputs lack
   `<label for="...">` associations (DevTools a11y warning).

Both are small, both are admin-adjacent, both belong in the session where
the admin UI is being touched anyway.

---

## Approach Summary

Decisions confirmed during planning, recorded here so the CLI execution
session does not re-litigate them. Three rows marked **PENDING** require
user confirmation before the runbook is generated.

| Decision | Choice | Rationale |
|---|---|---|
| Auto-fulfill mechanism | New SECURITY DEFINER SQL function `auto_fulfill_past_on_sale(p_tenant_id uuid) → integer`, called by `import-staging.js` at end of weekly run | Matches the 3.5 `purge_old_usage_events` pattern exactly: per-tenant RPC, called from the existing weekly job, no new scheduled-job infrastructure. Wednesday is the day the function runs, which is exactly when the data needs to change. |
| Auto-fulfill scope | Only rows where `fulfilled = false` AND `catalog.on_sale_date < CURRENT_DATE` | Idempotent. Manually-fulfilled rows (pre-FOC rush orders) are left alone. Items still in the future are untouched. |
| `fulfilled_at` value on auto-fulfill | `now()` at function execution time | Honest record of when the system marked the row, not a backdated value. Distinct from a future "actual pickup time" field if/when that's modeled. |
| `usage_events` log entry for auto-fulfill | None | Telemetry is for customer-facing actions in `UsageEvents` per current convention. Server-side housekeeping operations (purge, archive, auto-fulfill) are tracked via SQL function return values printed by the import script — same pattern as 3.5. |
| Week navigation in This Week tab | Prev / Today / Next week buttons; computes window from a base date held in tab-local JS state, not URL | Simple, no routing changes, no shareable-link semantics needed for an admin-only view. |
| Print mechanism | Browser `window.print()` against a print-only stylesheet that hides nav/chrome and styles the bagging list for letter paper | Matches the existing `btn-print-top-series` and `btn-print-lunar-order` mechanism — no new infrastructure. |
| Cancel guard placement | Two layers: (1) client-side refusal in `Preorders.cancel` when the row is already fulfilled, (2) `.eq('fulfilled', false)` filter on the DELETE for race safety | Belt-and-suspenders. RLS is the wrong layer for this rule — it's a business rule, not a tenant or role rule. |
| Cancel guard error UX | Toast: "Can't cancel — this item is already in hand. Ask the store to revert fulfillment first." | Direct, names the recovery path, doesn't pretend the action succeeded. |
| a11y label scope | `admin.html` only — every `<input>` that's currently labeled by an adjacent `<span>` gets a real `<label for="...">` association (or wraps the input in the label) | Stays in the file the session is already touching. `catalog.html` / `mylist.html` / `subscriptions.html` get their own a11y pass later if needed. |
| Per-customer "books are in" email mechanism | **Option A — reuse `MyList.sendConfirmation` / `send-my-list`** | Option A is zero new infrastructure. Email subject/body still says "your pull list"; bespoke "books are in" template is a possible future enhancement. |
| mylist.html cancel UI | **Mirror the existing FOC-lock pattern — replace Remove with an "✓ In hand" chip; disable qty-buttons.** | Confirmed after reading `mylist.html`; the FOC-lock pattern was the right analogue. |
| Parent plan Completion Criteria edit | **Done in this sub-deploy** — replaced stale "All four sub-deploys (3.1–3.4)" bullet with "All sub-deploys in the Sub-Deploys table above marked Complete." | Doc cleanup complete. |

---

## In Scope

1. **New SECURITY DEFINER SQL function**
   `auto_fulfill_past_on_sale(p_tenant_id uuid) → integer` that updates
   `preorders` rows where `tenant_id = p_tenant_id`, `fulfilled = false`,
   and the joined `catalog.on_sale_date < CURRENT_DATE`. Sets
   `fulfilled = true`, `fulfilled_at = now()`. Returns the row count.

2. **New call site in `import-staging.js`**, at the end of `main()`,
   placed after the existing `purge_old_usage_events` call and before
   `"✅ Import complete!"`. Same shape as 3.5's purge call. Failure
   logs but does not block.

3. **`admin.html` This Week tab rewrite** — replace the existing
   collapsible per-customer renderer with a print-optimized bagging-list
   layout (per-customer card, fixed-width title column, qty × price line
   totals, customer subtotal, page-break-after on each customer card so
   one customer per page when printed). Add week navigation (Prev / Today
   / Next). Add a "Print Bagging List" button using the existing
   `window.print()` pattern. Add a per-customer "Email customer" button
   wired to whichever email mechanism the PENDING decision lands on.

4. **`Preorders.cancel` fulfilled-guard** in `app.js`:
   - Client-side: look up the row before delete; if `fulfilled`, return
     `{ error: { message: '...' } }` without firing the DELETE
   - Server-side defensive: add `.eq('fulfilled', false)` to the DELETE
     filter

5. **`mylist.html` cancel UI update** (pending file review) — disable
   the per-row cancel button when the row's `fulfilled = true`, with a
   tooltip explaining why.

6. **`admin.html` a11y label fixes** — convert visible-text `<span>`
   labels adjacent to inputs into `<label for="...">` associations, or
   wrap the inputs. Touch points (line numbers approximate, CLI session
   re-reads file): `deadline-input` (~104), `admin-search` (~204),
   `paper-new-name` (~287), `paper-catalog-search` (~302), `invite-name`
   (~376), `invite-email` (~386), `maint-toggle` (~115). The `nav-
   hamburger` already has `aria-label` and does not need a change.

7. **Documentation updates:**
   - `CLAUDE.md` § Current Migration Phase — mark 3.6 active during work,
     Complete on close; note 3.7 is the remaining sub-deploy
   - `docs/phase-3-tenant-resolution.md` Sub-Deploys table — mark 3.6
     Complete and write the 3.7 plan reference
   - `docs/technical-reference.md` —
     - append row for `auto_fulfill_past_on_sale` in § 6 (Functions)
     - § 4.4 (`preorders`) notes: add line about the auto-fulfill path
       and the cancel guard
     - F (admin label/input warning, currently noted only in CLAUDE.md)
       gets a new finding ID and **fixed YYYY-MM-DD** status
     - Customer-can-cancel-fulfilled bug (currently in CLAUDE.md §
       Deferred): same — promote to a finding, mark fixed
   - `docs/sql/auto_fulfill_past_on_sale.sql` — committed SQL source

## Out of Scope

These are real work items but not part of 3.6. Per anti-drift rules:
discover → describe → ask → wait.

- **Per-customer manual mark-fulfilled** — explicit user defer in Q1
  ("not a high priority"). The bulk-fulfill-by-title button stays for
  pre-FOC rush orders.
- **Partial fulfillment** — product decision, deferred until product
  scoping happens. Same status as before.
- **Shipment-vs-expected reconciliation view** ("what didn't arrive") —
  not raised in Q1 scope; queued for a future sub-deploy if the bagging
  workflow surfaces a need.
- **POS integration improvements** — explicitly future, per Q1.
- **`reservation_history` interaction** — auto-fulfilled rows are still
  current-month preorders; they get archived next month-rollover via the
  existing `archive_stale_reservations` path. No new archival behavior
  needed. **Do not** modify `archive_stale_reservations`.
- **Customer-side `arrivals.html` or `mylist.html` changes beyond the
  cancel-guard UI** — they pick up auto-fulfilled state automatically
  through the existing JOIN on `catalog`. If the auto-fulfill rollout
  surfaces a UI display issue (e.g., fulfilled badges rendering wrong on
  customer pages), **stop and ask**.
- **Finding E** (broad table-level grants) — queued for the dedicated
  grant-audit hardening pass. Do not narrow grants on `preorders` here.
- **F23** (`SET search_path` on existing DEFINER functions) — the new
  3.6 function is born compliant; existing functions are not retrofitted
  here.
- **Production `import.js`** — standing rule: do not modify until
  production gets Phase 1. The new auto-fulfill call gets queued for
  the Phase 4 cutover patch list (CLAUDE.md § Known Out-of-Scope Items
  already maintains that list; add the new function call to it during
  doc updates).
- **a11y pass on other HTML files** — `admin.html` only.
- **Top Series tab redesign**, **By Customer redesign**, or any other
  admin tab not touched by the Wednesday-workflow story — out of scope.
- **Generalizing auto-fulfill to other date columns** (e.g.,
  `foc_date`-based auto-anything) — speculative; not asked for.

---

## Pre-flight (planning verification, before execution)

Read-only checks. If any fails, the CLI session stops and asks before
proceeding.

### P1 — Confirm `admin.html` This Week tab structure matches what the plan assumes

```bash
grep -n "renderThisWeek\|tab-this-week\|this-week-groups\|getThisWednesday" admin.html
```

Expected: the four matches found during planning — tab markup near line
210, `renderThisWeek()` function near line 1073, and tab click handler
near line 1200. If the structure differs significantly (e.g., a previous
session already rewrote the tab), **stop and re-read** the current state
before editing.

### P2 — Confirm `Preorders.cancel` is still the unguarded DELETE

```bash
grep -n "async cancel" app.js
```

Inspect: the function body must still be an unconditional `db.from('
preorders').delete().eq('user_id', ...).eq('catalog_id', ...)` with **no
`.eq('fulfilled', false)`** filter. If a guard already exists, the bug
was fixed in another session — **stop and confirm** the cancel-guard
work is still needed before proceeding.

### P3 — Confirm `MyList.sendConfirmation` API and `send-my-list` Edge Function intact

```bash
grep -n "sendConfirmation\|send-my-list" app.js
```

Expected: `MyList.sendConfirmation(userId, sessionToken)` defined near
line 813 calling `${SUPABASE_URL}/functions/v1/send-my-list`. If the API
shape has drifted, **stop and re-plan** the per-customer email path.

### P4 — Confirm no existing function named `auto_fulfill_past_on_sale`

```sql
SELECT proname FROM pg_proc WHERE proname = 'auto_fulfill_past_on_sale';
```

Expected: zero rows. If present, **stop** — plan assumed greenfield and
needs to be re-examined.

### P5 — Confirm `import-staging.js` `TENANT_ID` constant intact

The import script lives outside the repo
(`C:\Users\richa\OneDrive\Documents\(Work)\BookStop\catalogs\scripts\import-staging.js`).
The CLI session does not edit it directly — output produced for the user
to paste in is the workflow. Confirm with the user that `TENANT_ID`
near the top of the file still reads
`'72e29f67-39f7-42bc-a4d5-d6f992f9d790'`, and that the existing
`purge_old_usage_events` call from 3.5 is intact (the new call sits
immediately after it).

### P6 — Confirm a11y label gaps as described

```bash
grep -nB1 -A1 "id=\"deadline-input\"\|id=\"admin-search\"\|id=\"paper-new-name\"\|id=\"paper-catalog-search\"\|id=\"invite-name\"\|id=\"invite-email\"\|id=\"maint-toggle\"" admin.html
```

For each match, verify there is no preceding `<label for="...">`. If
some inputs already have proper labels (e.g., a previous session
partial-fixed), narrow the scope of Change 6 to only the inputs that
still lack labels.

### P7 — Confirm `mylist.html` cancel UI shape

CLI session reads `mylist.html` and locates the per-row cancel button.
If the file uses a different cancel pattern than expected (e.g., quantity
spinner with implicit-zero-cancel rather than an explicit button),
**stop and ask** before editing. This is the file most likely to surprise
the session and the one not yet read during planning.

---

## Changes

### Change 1 — Create `auto_fulfill_past_on_sale(uuid) → integer`

**Where:** Supabase staging SQL editor. The CLI session generates the SQL
and saves it to `docs/sql/auto_fulfill_past_on_sale.sql` for the user to
paste in.

**SQL:**

```sql
-- Phase 3.6 — automatic fulfillment for items whose on-sale date has passed.
-- Idempotent: only touches rows that are still unfulfilled.
-- Called by import-staging.js at the end of each weekly run.
--
-- The "manual fulfill" path via Preorders.setFulfilledByCatalogId() remains
-- the exception path for pre-FOC rush orders. This function handles the
-- common case where the regular weekly shipment delivers the title and the
-- on-sale date arrives.

CREATE OR REPLACE FUNCTION public.auto_fulfill_past_on_sale(
  p_tenant_id uuid
)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH updated AS (
    UPDATE preorders p
       SET fulfilled    = true,
           fulfilled_at = now()
      FROM catalog c
     WHERE p.catalog_id = c.id
       AND p.tenant_id  = p_tenant_id
       AND p.fulfilled  = false
       AND c.on_sale_date < CURRENT_DATE
     RETURNING p.id
  )
  SELECT COUNT(*)::integer FROM updated;
$$;

REVOKE ALL ON FUNCTION public.auto_fulfill_past_on_sale(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auto_fulfill_past_on_sale(uuid) TO service_role;
```

**Verification (after applying):**

1. Function exists with correct signature:
   ```sql
   SELECT proname, prosecdef, proconfig
   FROM pg_proc
   WHERE proname = 'auto_fulfill_past_on_sale';
   -- Expected: 1 row, prosecdef = true, proconfig contains 'search_path=public'
   ```

2. Execute privilege scoped correctly:
   ```sql
   SELECT grantee, privilege_type
   FROM information_schema.routine_privileges
   WHERE routine_name = 'auto_fulfill_past_on_sale';
   -- Expected: service_role / EXECUTE only
   ```

3. Dry-run count before any real invocation:
   ```sql
   SELECT COUNT(*) FROM preorders p
     JOIN catalog c ON c.id = p.catalog_id
    WHERE p.tenant_id  = '72e29f67-39f7-42bc-a4d5-d6f992f9d790'
      AND p.fulfilled  = false
      AND c.on_sale_date < CURRENT_DATE;
   -- Records the number of rows the next invocation will fulfill.
   ```

4. Invoke once and confirm count matches:
   ```sql
   SELECT auto_fulfill_past_on_sale('72e29f67-39f7-42bc-a4d5-d6f992f9d790'::uuid);
   ```
   Output should equal the count from step 3.

5. Idempotency check — second invocation returns 0:
   ```sql
   SELECT auto_fulfill_past_on_sale('72e29f67-39f7-42bc-a4d5-d6f992f9d790'::uuid);
   -- Expected: 0
   ```

### Change 2 — Add `auto_fulfill_past_on_sale` call to `import-staging.js`

**Where:** local script outside repo. CLI session emits the diff for the
user to apply manually.

**Position:** end of `main()`, after the existing `purge_old_usage_events`
block (Phase 3.5) and before the `"✅ Import complete!"` line.

**Diff (illustrative — CLI session re-reads file to pin line numbers):**

```javascript
  // ── Step 9: Auto-fulfill past-on-sale preorders ──────────
  // Items whose on_sale_date has passed are considered in-hand at the
  // store. This sweeps any unfulfilled rows and marks them fulfilled so
  // exports and the bagging list treat them correctly. Manual fulfillment
  // (pre-FOC rush orders) is unaffected — those rows are already
  // fulfilled=true and the SQL function leaves them alone.
  console.log('\n📦 Auto-fulfilling past-on-sale preorders...');
  try {
    const autoRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/auto_fulfill_past_on_sale`, {
      method:  'POST',
      headers: HEADERS,
      body:    JSON.stringify({ p_tenant_id: TENANT_ID }),
    });
    if (autoRes.ok) {
      const count = await autoRes.json();
      console.log(`   ✅ Auto-fulfilled ${count ?? 0} preorder(s) past on-sale date`);
    } else {
      console.warn(`   ⚠️  Auto-fulfill failed: ${await autoRes.text()}`);
    }
  } catch (err) {
    console.warn(`   ⚠️  Auto-fulfill errored: ${err.message}`);
  }
```

Rationale notes (same shape as 3.5):

- **Position at end of run, after purge:** the purge step is housekeeping
  on telemetry; auto-fulfill is housekeeping on operational state.
  Grouping them together keeps the "import is done; now clean up" phase
  cohesive.
- **Non-fatal failure handling:** matches 3.5's pattern. Retention and
  auto-fulfill are best-effort sweeps, not preconditions for any later
  step.
- **No `BATCH_SIZE` involvement:** single RPC call.
- **`TENANT_ID` reused:** no new constant needed.

**Verification:** re-run the script; expect the new step to print after
the purge step. Confirm in Supabase:

```sql
SELECT COUNT(*) FROM preorders p
  JOIN catalog c ON c.id = p.catalog_id
 WHERE p.fulfilled  = false
   AND c.on_sale_date < CURRENT_DATE;
-- Expected: 0
```

### Change 3 — Rewrite `admin.html` This Week tab

This is the largest visual change in the sub-deploy. Three sub-pieces.

#### 3a. Week navigation + state

Add a small toolbar above `#this-week-groups`:

```
[← Prev week]   Week of <Monday display> – <Saturday display>   [Today]   [Next week →]
                                                                       [🖨 Print Bagging List]
```

Tab-local JS state: `let weekAnchorDate = getThisWednesday();` plus
handlers that re-compute the window from `weekAnchorDate ± 7` and
re-invoke `renderThisWeek()`.

`renderThisWeek()` is generalized: instead of always computing the window
from `getThisWednesday()`, it computes from `weekAnchorDate`. Default
remains today's week.

#### 3b. Bagging list layout

Per-customer card, styled for print:

```
─────────────────────────
JOE MOE — 6 items, $47.94
─────────────────────────
☐ Absolute Batman #21              $4.99
☐ Uncanny X-Men #27                $4.99
☐ Olympus Saga: Megalith #1        $5.99
...
                          TOTAL:   $47.94
```

- Each item line: `<label><input type="checkbox"> Title (qty if >1) — line total</label>`
- Customers sorted alphabetically (existing behavior — retain)
- Within each customer: items sorted by title for consistent print order
- `page-break-after: always` on each customer card in print stylesheet
  so each customer prints on its own page
- Fulfilled items (post-auto-fulfill) still appear but render with a
  filled checkbox `☑` and a subtle "fulfilled <date>" caption — the
  bagging list is a snapshot of what's expected, including what's
  already accounted for

#### 3c. Per-customer email button

Inside each customer card header, a small button:

```
[ 📧 Email "Your books are in" ]
```

Click handler — **PENDING decision** (Approach Summary row):

- **Option A (reuse send-my-list):** call
  `MyList.sendConfirmation(userId, sessionToken)`. Email body says
  "your pull list."
- **Option B (new Edge Function):** call a new
  `notify-arrival` Edge Function with a bespoke template focused on
  this week's arrivals only.

In either case: toast on success, toast on error. No new database write.

**Print stylesheet sketch (added to `style.css` or inline in
admin.html's existing print block):**

```css
@media print {
  /* hide chrome */
  .nav-bar, .admin-tabs, .admin-section:not(.active),
  .stat-grid, .deadline-group, .maint-group,
  #btn-print-this-week, .week-nav-toolbar { display: none !important; }

  /* page breaks per customer */
  .customer-group { page-break-after: always; }
  .customer-group:last-child { page-break-after: auto; }

  /* tighten for paper */
  body { background: white; color: black; }
  .customer-group-header { border-bottom: 1px solid #000; }
  .bagging-row { font-size: 11pt; }
}
```

CLI session re-reads `style.css` (not uploaded this session) to confirm
the existing print block's structure before adding new rules.

**Verification:**

1. Browser smoke — open admin → This Week, confirm rendering matches the
   ascii sketch above.
2. Print preview — `Ctrl+P` shows one customer per page, no nav/chrome,
   checkboxes visible.
3. Prev/Next nav — clicking Next shifts the window forward 7 days,
   header updates, data re-fetches.
4. Email button — click sends, toast confirms; check the customer's
   inbox (staging MailerSend) for receipt.

### Change 4 — `Preorders.cancel` fulfilled-guard

**Where:** `app.js`, the `Preorders.cancel` method (near line 686
per current upload; CLI session re-reads to confirm).

**Diff:**

```javascript
  async cancel(userId, catalogId) {
    // Guard: refuse to cancel a fulfilled row. This protects the audit
    // trail (fulfilled_at timestamp) and prevents customers from wiping
    // out a row the store has already counted as in-hand.
    const { data: existing, error: lookupErr } = await db
      .from('preorders')
      .select('id, fulfilled')
      .eq('user_id', userId)
      .eq('catalog_id', catalogId)
      .maybeSingle();
    if (lookupErr)   return { error: lookupErr };
    if (!existing)   return { error: { message: 'Reservation not found' } };
    if (existing.fulfilled) {
      return { error: { message: 'Can\'t cancel — this item is already in hand. Ask the store to revert fulfillment first.' } };
    }

    const { error } = await db
      .from('preorders')
      .delete()
      .eq('user_id', userId)
      .eq('catalog_id', catalogId)
      .eq('fulfilled', false);   // defensive race guard
    return { error };
  },
```

**Verification:**

1. From a customer session on staging: reserve item A, admin marks A
   fulfilled (or wait for its on-sale-date), customer tries to cancel
   A from `mylist.html`. Expected: toast with the guard message; row
   remains in DB with `fulfilled = true`.
2. Customer reserves item B (unfulfilled), cancels B. Expected: row
   gone, normal toast.
3. `usage_events`: a `UsageEvents.cancel` event should NOT fire on the
   blocked cancel. Check the API surface — `mylist.html` likely fires
   the event only on successful cancel; confirm during execution that
   the guard returns before `UsageEvents.cancel` is called.

### Change 5 — `mylist.html` cancel UI guard

**Where:** `mylist.html` — not uploaded this session. CLI session reads
the file as the first step of Change 5 and identifies the per-row cancel
control. **If the cancel pattern differs from a clear per-row button,
stop and ask.**

**Goal:** the cancel button is `disabled` (with a tooltip explaining why)
when the row's `fulfilled = true`. Falls back gracefully if the API
guard fires.

**Verification:** browser smoke — fulfilled rows show a disabled cancel
button with hover tooltip; unfulfilled rows are unchanged.

### Change 6 — `admin.html` a11y label fixes

**Where:** `admin.html`, multiple inputs.

**Pattern A** — input has an adjacent `<span>` with visible label text:
convert the span into a `<label for="<input-id>">`.

**Pattern B** — input is a checkbox inside a `<label>` (e.g., the
existing `maint-toggle` pattern, which wraps the input in a label
already): leave as-is. Verify with grep — no change if the wrapper
exists.

**Touchpoints:**

| Input id | Current pattern | Fix |
|---|---|---|
| `deadline-input` | adjacent `<span>Order Deadline</span>` | `<label for="deadline-input">Order Deadline</label>` |
| `admin-search` | placeholder only, no visible text | add visually-hidden `<label for="admin-search" class="visually-hidden">Search reservations</label>` |
| `paper-new-name` | placeholder only | hidden label |
| `paper-catalog-search` | placeholder only | hidden label |
| `invite-name` | preceding `<label>` without `for=` | add `for="invite-name"` |
| `invite-email` | preceding `<label>` without `for=` | add `for="invite-email"` |
| `maint-toggle` | already inside `<label class="toggle-switch">` | no change |

A `.visually-hidden` utility class may not yet exist in `style.css`. CLI
session checks; if absent, adds the standard 1px-clip pattern in a
single small CSS block.

**Verification:** open admin.html in DevTools, check the Issues panel
for the "No label associated with a form field" warning — should be
gone.

### Change 7 — Documentation updates

Specified in § In Scope item 7. CLI session generates the file edits
during the final commit pass.

---

## Execution Sequence

Strict order. The CLI session does not skip ahead. **If the session is
running long after Change 3 (the largest visual change), it is safe to
stop, commit what's done as 3.6a, and continue Changes 4–6 as 3.6b in a
follow-up session.** The auto-fulfill path (Changes 1–2) is
self-contained and can ship without the UI rewrite if needed.

1. **Pre-flight P1–P7.** Stop if any fails.
2. Create the SQL file at `docs/sql/auto_fulfill_past_on_sale.sql` with
   Change 1's exact body.
3. Hand SQL to user. Wait for confirmation. Run verification queries
   1–5 from Change 1.
4. Generate the diff for Change 2 (import script). User applies it to
   the local script. User re-runs `import-staging.js` against the most
   recent catalog files (catalog-only is fine; shipment optional). Run
   the post-Change-2 verification query.
5. Apply Change 4 (`Preorders.cancel` guard) in `app.js`. Run its
   verification.
6. Read `mylist.html`. Apply Change 5. Run its verification.
   **If the cancel pattern differs from expectation, stop here and ask
   the user.** Do not improvise.
7. Apply Change 3 in `admin.html` (the large rewrite). Verify in browser
   on staging.
8. Apply Change 6 (a11y labels) in `admin.html`. Verify in DevTools.
9. Apply Change 7 (docs). Run a final `grep` pass on `CLAUDE.md`,
   `phase-3-tenant-resolution.md`, and `technical-reference.md` to
   confirm all targeted edits landed.
10. Commit on `feature/3.6-admin-wednesday-tooling`. Suggested commit
    message:
    ```
    feat(3.6): admin Wednesday workflow — bagging list, auto-fulfill,
    cancel guard, a11y labels
    ```
    (One commit if the session ran in one shot; two if 3.6a/3.6b split.)
11. Merge to `staging`, push to GitHub Pages staging, smoke-test (login
    as admin → This Week tab → print preview → Prev/Next nav → click an
    email button → cancel-guard from a customer session).
12. Status update per anti-drift rules; update CLAUDE.md and parent
    phase doc per § In Scope item 7.

---

## Post-execution verification

After the session closes, on staging:

```sql
-- A. Auto-fulfill completed: no past-on-sale unfulfilled rows
SELECT COUNT(*) FROM preorders p
  JOIN catalog c ON c.id = p.catalog_id
 WHERE p.fulfilled  = false
   AND c.on_sale_date < CURRENT_DATE;
-- Expected: 0

-- B. Auto-fulfilled rows have fulfilled_at near now()
SELECT p.id, p.fulfilled_at, c.on_sale_date
FROM preorders p
JOIN catalog c ON c.id = p.catalog_id
WHERE p.fulfilled = true
  AND c.on_sale_date < CURRENT_DATE
ORDER BY p.fulfilled_at DESC
LIMIT 10;
-- Expected: fulfilled_at timestamps from the import run; on_sale_date < today

-- C. No cross-tenant rows touched (single-tenant today; meaningful at tenant 2)
SELECT tenant_id, COUNT(*) FROM preorders
WHERE fulfilled = true
GROUP BY tenant_id;
-- Expected: one row, founding tenant UUID

-- D. Cancel guard active: a fulfilled row cannot be deleted via the API path
-- (Manual SQL DELETE still works via service role — RLS is not the guard layer.
--  The guard is in Preorders.cancel and the .eq('fulfilled', false) filter.)
```

Browser smoke (manual, on staging):

1. Log in as admin. Open `admin.html` → This Week tab.
   - Bagging list renders grouped by customer with checkboxes
   - Header shows week-of label and totals
   - Prev / Today / Next buttons shift the window correctly
2. `Ctrl+P` → print preview shows one customer per page, no chrome.
3. Click "Email customer" on one row — toast confirms send; check staging
   MailerSend logs for delivery.
4. Open a non-fulfilled item and a fulfilled item in DevTools — confirm
   admin.html's existing per-title bulk-fulfill button (`By Distributor`
   tab) still works for the pre-FOC exception path.
5. Log in as a normal customer. Open `mylist.html`.
   - Fulfilled rows show disabled cancel button with tooltip
   - Unfulfilled rows: cancel works normally
6. DevTools Issues panel on `admin.html` — the "No label associated"
   warning is gone.

---

## Completion Criteria

Phase 3.6 is complete when **all** of the following are true on staging:

- [ ] `auto_fulfill_past_on_sale(uuid) → integer` exists in staging
      Supabase, SECURITY DEFINER, `search_path = public`, EXECUTE
      granted to `service_role` only.
- [ ] `import-staging.js` calls the RPC at end of `main()`; a re-run
      shows the new step output and post-execution query A returns 0.
- [ ] `Preorders.cancel` in `app.js` refuses to delete fulfilled rows;
      verification 1 and 2 from Change 4 both pass.
- [ ] `mylist.html` cancel button is disabled on fulfilled rows; tooltip
      explains why.
- [ ] `admin.html` This Week tab renders the bagging list, supports
      prev/next week navigation, prints one customer per page, and has
      a working per-customer email button.
- [ ] `admin.html` a11y warnings ("No label associated with a form
      field") are resolved for all inputs listed in Change 6.
- [ ] `docs/sql/auto_fulfill_past_on_sale.sql` committed to staging.
- [ ] `docs/technical-reference.md` updated:
        - new function row in § 6
        - § 4.4 (`preorders`) notes mention the auto-fulfill path and
          the cancel guard
        - new finding IDs assigned (or existing rows updated) for the
          two bundled fixes, status `fixed YYYY-MM-DD`
- [ ] `docs/phase-3-tenant-resolution.md` Sub-Deploys table:
      3.6 marked Complete with date; 3.7 plan reference added.
- [ ] `CLAUDE.md` § Current Migration Phase updated: 3.6 complete,
      3.7 plan pending. Customer-can-cancel-fulfilled and admin-label-
      warning items removed from § Known Out-of-Scope (now fixed).
- [ ] Parent plan Completion Criteria bullet about "All four sub-deploys
      (3.1, 3.2, 3.3, 3.4)" reconciled with the expanded Sub-Deploys
      table (per the PENDING Approach Summary row).
- [ ] Browser smoke tests in § Post-execution verification all pass.
- [ ] Status update produced per anti-drift rules.

---

## Carry-forward / Notes

Items observed during planning that are intentionally **not** addressed
in 3.6. Recorded so they don't get lost:

- **`import.js` (production) auto-fulfill call** — needs the same Change
  2 addition before its first post-migration run. Add to the existing
  patch list in CLAUDE.md § Known Out-of-Scope Items under "`import.js`
  (production) — required patches before first prod run." Do not patch
  prod script in 3.6.
- **Per-customer manual mark-fulfilled** — user-deferred in Q1. Likely
  candidate for a future sub-deploy if POS integration timing slips or
  if the auto-fulfill window proves too coarse in practice.
- **Email template fidelity** (the PENDING Approach Summary row): if the
  session lands on Option A (reuse send-my-list), the "your books are
  in" intent is approximated. If real-world usage shows admins want a
  dedicated template, that becomes its own small Edge Function project.
- **Reconciliation view** ("what didn't arrive") — explicitly out of
  scope this session. The bagging-list checkboxes serve as the
  paper-side reconciliation tool until a digital version is needed.
- **Partial fulfillment** — still a product decision pending.
- **POS integration** — future phase.

---

## Reference

- Parent: `docs/phase-3-tenant-resolution.md`
- Schema canonical: `docs/technical-reference.md` § 4.4 (`preorders`),
  § 6 (functions), § 10.4 (`Preorders` API), § 10.8 (`MyList`).
- Sibling sub-deploy template: `docs/phase-3.5-usage-events-purge.md`
  (this plan adopts its shape exactly).
- CLAUDE.md § Anti-Drift Rules — followed throughout this plan.
- CLAUDE.md § Known Out-of-Scope Items — entries for "Customer can
  cancel a fulfilled preorder" and "Admin label/input warning"
  resolved by this sub-deploy.
- Project file reference: `/mnt/project/sample-import-staging.js` for
  Change 2's insertion-point context.

---

**Plan written:** 2026-05-11
**Plan author session:** chat (Opus)
**Execution session target:** Claude Code CLI on staging repo
**Pending decisions before runbook generation:** three rows marked
**PENDING** in § Approach Summary — Option A vs B for the email
mechanism, mylist.html cancel UI assumption, and the parent plan
Completion Criteria edit.
