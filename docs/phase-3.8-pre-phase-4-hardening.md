# Phase 3.8 — Pre-Phase-4 Hardening: "This Week" Rule Alignment

**Status:** Complete 2026-05-15 (one-day soak clean)
**Branch base:** `staging`
**Parent plan:** `phase-3-tenant-resolution.md` (Phase 3 marked Complete 2026-05-13 — see § Procedural Note)
**Customer impact:** Staging only. User-visible string changes on `arrivals.html` and `admin.html` This Week tab. No schema changes.
**Estimated duration:** One session.

---

## Goal

Align all customer- and admin-facing "this week" surfaces to a single,
canonical rule: **the Mon-Sun calendar week containing today's local
date**. Today the rule is implemented inconsistently across three files
(NavBubble queries a 7-day rolling window, arrivals.html queries a single
Wednesday, admin bagging queries Mon-Sat anchored on the upcoming
Wednesday), producing a customer-visible inconsistency where the nav
badge can show "1" while arrivals.html shows "Nothing reserved this
week." The fix introduces a shared `DateUtils` helper in `app.js`,
rewrites the three callsites, and pins the behavior with a new Playwright
spec.

Also closes the F28 latent `toISOString()` calls flagged in
`technical-reference.md` § 13 by removing all uses of `toISOString()`
for date math in the three callsites.

This is the **pre-Phase-4 hardening pass** flagged in `CLAUDE.md` line 23,
narrowed to the rule-alignment work only. F16 and F34 deep audit remains
queued separately.

---

## Approach Summary

| Decision | Choice | Rationale |
|---|---|---|
| Rule | Mon-Sun calendar week containing today's local date | User decision 2026-05-13. "Standard calendar week." |
| Anchor | Today-anchored (not upcoming-Wednesday-anchored) | User decision 2026-05-13. "Kills Wednesday entirely." |
| Helper location | `DateUtils` namespace in `app.js`, top-level `const` like `Preorders`/`Auth` | Visible to every page script that loads `app.js`. Same pattern as existing modules. |
| Helper API | `DateUtils.todayLocal()` and `DateUtils.weekRange(refDate?)` | Two distinct date questions in scope. mylist.html line 696 asks "what's today?"; the other three callsites ask "what's this week?" |
| Admin anchor state | Rename `weekAnchorWednesday` → `weekAnchorMonday` | Wednesday is no longer a meaningful anchor. Monday is the new start-of-week marker. |
| `usage_events` payload on `arrivals` event | Change key `on_sale_date` → `week_start` + `week_end` | The old single-date key is wrong under the new rule. See Carry-forward. |
| F28 documentation | Keep F28 narrow (the `toISOString()` anti-pattern); add new finding F35 for the semantic mismatch | Cleaner attribution: F28 was always about the timezone footgun; F35 is the rule-divergence bug. |
| Smoke spec | Replace existing `04-arrivals-this-week.spec.ts` with a range-aware version that covers boundary days + badge consistency | The existing spec was Wed-only; the new rule needs boundary coverage. Keeps orphan-reserved coverage intact. |
| Sub-deploy label | **3.8** (continuing Phase-3 numbering even though Phase 3 was certified complete 2026-05-13) | User decision 2026-05-13. Reopens the Phase 3 status header briefly. See Procedural Note. |

---

## Procedural Note: Re-opening Phase 3

`phase-3-tenant-resolution.md` was marked **Complete 2026-05-13** earlier
today. Adding a 3.8 row to its Sub-Deploys table requires:

1. Flipping the parent plan's status header from "Complete 2026-05-13"
   back to "In progress (sub-deploy 3.8)"
2. Adding row 3.8 to the Sub-Deploys table with status **Planning** and
   plan file pointer
3. Updating `CLAUDE.md` § Current Migration Phase to name 3.8 as the
   active sub-deploy
4. On 3.8 completion, re-marking Phase 3 **Complete 2026-05-13 (3.1–3.7)
   + 2026-05-NN (3.8 hardening)** with a brief note

This is one of the framings the user accepted on 2026-05-13. The
alternative ("Phase 4.0 pre-migration hardening") is cleaner narratively
but was not chosen.

---

## In Scope

### Code
1. `app.js` — new `DateUtils` namespace with two helpers
2. `app.js` — `NavBubble.load` switched from 7-day rolling window to `DateUtils.weekRange()`
3. `arrivals.html` — `getThisWednesday()` deleted; queries, filters, display strings, print-button label, and usage event payload all switched to the range
4. `mylist.html` line 696 — `toISOString()` replaced with `DateUtils.todayLocal()`
5. `admin.html` — local `getThisWednesday()` deleted; state renamed `weekAnchorWednesday` → `weekAnchorMonday`; range widened from Mon-Sat to Mon-Sun; "Today" button + Prev/Next shifters updated; display strings updated

### Tests
6. `playwright/tests/04-arrivals-this-week.spec.ts` — rewritten with
   boundary-day seeds (Mon-of-week, Wed-of-week, Sat-of-week in-range;
   prior Sunday and next Monday out-of-range), plus an explicit
   badge↔arrivals-count consistency assertion. Existing orphan-reserved
   subtest preserved.

### Docs
7. `docs/technical-reference.md` § 13 — F28 entry edited to reflect call
   sites now fixed; new F35 entry added for the semantic-mismatch finding
   discovered during 3.8 planning
8. `CLAUDE.md` — "This Week" rule entry rewritten; § Current Migration
   Phase updated to 3.8 in progress
9. `docs/phase-3-tenant-resolution.md` — 3.8 row added; status header
   flipped per Procedural Note above
10. `docs/phase-3.6-admin-wednesday-tooling.md` — one-line carry-forward
    note acknowledging the Wed-anchored bagging logic introduced in 3.6
    was corrected in 3.8

---

## Out of Scope

- **F16 / F34 deep audit** — Still queued as separate pre-Phase-4 work
  per CLAUDE.md line 23. Not bundled.
- **`import-staging.js` / `import.js`** — Neither references "this week"
  semantics.
- **Edge Function source edits** — No Edge Function touches the rule.
- **Schema / RLS / SQL functions** — No DB-side changes. The
  `weekly_shipment.on_sale_date` index supports `gte/lte` range queries
  with the same performance as the prior `eq` queries.
- **Analytics views** — None currently read the renamed payload keys
  (`week_start`/`week_end`). See Carry-forward.
- **catalog.html "Available This Week" filter** — Does not exist today.
- **Backfilling old `usage_events.payload`** — Rows logged before this
  change keep the old key.
- **`mylist.html` Upcoming Arrivals section** — Uses `>= today`, not
  "this week"; not affected.
- **Production deploy** — Staging only. Production gets this as part of
  Phase 4.

---

## Pre-flight Checks (planning verification, before execution)

### P1 — Clean tree, on staging
```bash
git status
git fetch origin
git log staging..HEAD --oneline   # expect empty
```

### P2 — Confirm callsite inventory matches planning
```bash
grep -n "NavBubble\|getThisWednesday\|weekAnchorWednesday\|toISOString" \
  app.js arrivals.html mylist.html admin.html
```
Expected hits:
- `app.js`: 255 `NavBubble = {`, 262–263 `toISOString` (date math, in
  scope), 490 / 719 / 732 `toISOString` (timestamp uses, out of scope —
  values assigned to `*_at` columns)
- `arrivals.html`: 288 `function getThisWednesday()`, 299–300, 327, 332,
  349, 370, 389 (comment), 416, 502, 576
- `mylist.html`: 696 `toISOString().split('T')[0]`
- `admin.html`: `getThisWednesday`, `weekAnchorWednesday`, `shiftWeek`

If counts differ, **stop and reconcile** before proceeding.

### P3 — Confirm no analytics dependency on the old payload key
```bash
grep -rn "payload->>'on_sale_date'\|payload->'on_sale_date'\|payload\.on_sale_date" \
  docs/ supabase/
```
Expect: zero hits. Any hit must be addressed in the same PR.

### P4 — Confirm spec 04 exists and uses fixture conventions
```bash
ls playwright/tests/04-arrivals-this-week.spec.ts
head -40 playwright/tests/04-arrivals-this-week.spec.ts
```
Confirm TypeScript, `beforeAll`/`afterAll`, fixture imports from
`playwright/fixtures/`. Runbook replaces this file wholesale.

### P5 — Surface exact F28 text in technical-reference.md
```bash
grep -n -B1 -A12 "^### F28\|F28 —" docs/technical-reference.md
```
Capture the exact wording so the runbook str_replace targets match.

### P6 — Surface exact "This Week" rule in CLAUDE.md
```bash
grep -n -B1 -A4 "This Week" CLAUDE.md | head -40
```
Capture exact wording for str_replace.

### P7 — Confirm `app.js` does not already export a `DateUtils`
```bash
grep -n "^const DateUtils\|window\.DateUtils" app.js
```
Expect: zero hits.

---

## Changes (file-by-file summary)

The runbook spells out each step with exact diffs, verification, and
commit messages. This is the planning-level summary only.

### C1 — `app.js`: `DateUtils` namespace (NEW)
Top-level `const DateUtils = { todayLocal, fmtLocal, weekRange }`, placed
immediately above the `NavBubble` declaration.

### C2 — `app.js`: `NavBubble.load` rewrite
Replace the 7-day rolling window with `DateUtils.weekRange()` and
`gte/lte` query against `start`/`end`. Removes both `toISOString()` calls
from the function.

### C3 — `arrivals.html`: range adoption
- Delete local `getThisWednesday()`
- Introduce `weekStart`, `weekEnd`, `weekDisplay` from
  `DateUtils.weekRange()`
- Query: `.eq('on_sale_date', thisWednesday)` →
  `.gte('on_sale_date', weekStart).lte('on_sale_date', weekEnd)`
- Preorder filter: `=== thisWednesday` → `>= weekStart && <= weekEnd`
- All `wedDisplay` → `weekDisplay`
- Usage event payload: `{ on_sale_date: thisWednesday }` →
  `{ week_start: weekStart, week_end: weekEnd }`
- Comment on line 389 updated to reflect range semantics

### C4 — `mylist.html` line 696: `todayLocal()` swap
One-line change. `new Date().toISOString().split('T')[0]` →
`DateUtils.todayLocal()`.

### C5 — `admin.html` bagging tab: anchor + range update
- Delete local `getThisWednesday()`
- Rename `weekAnchorWednesday` → `weekAnchorMonday`
- Initialize from `DateUtils.weekRange().start`
- `weekStart = anchor`, `weekEnd = anchor + 6 days` (was Wed-2 to Wed+3)
- Display strings: `monDisplay`/`satDisplay` → `monDisplay`/`sunDisplay`
- `isCurrentWeek` comparison uses the new Monday anchor
- `shiftWeek(days)` and `btn-week-today` handler updated

### C6 — `playwright/tests/04-arrivals-this-week.spec.ts`: rewrite
Three subtests in a single `describe` block:
- **Range boundary**: seeds 5 catalog rows + preorders dated prior-Sun,
  Mon-of-week, Wed-of-week, Sat-of-week, next-Mon; asserts arrivals.html
  shows exactly the 3 in-range
- **Orphan-reserved**: preserves the 2026-05-06 regression coverage
- **Badge consistency**: asserts NavBubble badge count equals in-range
  count

### C7 — `docs/technical-reference.md` § 13: F28 edit + F35 add
F28 entry narrative trimmed (both call sites now fixed). New F35 entry
added for the semantic mismatch.

### C8 — `CLAUDE.md`: rule + active phase
- "This Week" rule entry rewritten to describe Mon-Sun calendar week
  anchored on today's local date
- § Current Migration Phase: Phase 3 status → "In progress (3.8
  hardening)"; active sub-deploy → 3.8

### C9 — `docs/phase-3-tenant-resolution.md`: parent plan update
- Status header: "Complete 2026-05-13" → "In progress — 3.8 hardening
  (base 3.1–3.7 complete 2026-05-13)"
- Sub-Deploys table: append row 3.8 with status **Planning** / plan file
  pointer
- Completion Criteria: unchanged; re-certified on 3.8 completion

### C10 — `docs/phase-3.6-admin-wednesday-tooling.md`: carry-forward note
Append a one-line carry-forward acknowledging the Wed-anchored bagging
logic delivered in 3.6 was superseded by the Mon-Sun rule in 3.8. The
bagging tab UI/workflow is unchanged; only the date range and anchor
variable changed.

---

## Execution Sequence

1. `git checkout -b phase-3.8-this-week-rule-alignment`
2. C1 (DateUtils) — first; C2/C3/C4/C5 depend on it
3. C2 (NavBubble) — smallest callsite, sanity-checks the helper
4. C4 (mylist.html one-liner)
5. C3 (arrivals.html) — biggest single-file rewrite
6. C5 (admin.html) — second biggest
7. C6 (Playwright spec rewrite)
8. C7–C10 (docs) — last, so they reflect the committed code state
9. `npx playwright test` locally; suite green
10. Push branch, deploy to staging GH Pages
11. Manual smoke per § Post-execution Verification
12. PR; user merges to `staging`

---

## Post-execution Verification

### V1 — Static greps return zero
```bash
grep -n "thisWednesday\|getThisWednesday\|weekAnchorWednesday\|wedDisplay" \
  app.js mylist.html arrivals.html admin.html
# expect: zero hits

grep -n "toISOString().split" app.js mylist.html arrivals.html admin.html
# expect: zero hits in the date-math callsites (app.js 490/719/732 are
# timestamp uses — confirm those still exist as *_at column writes)
```

### V2 — Spec 04 passes
```bash
npx playwright test playwright/tests/04-arrivals-this-week.spec.ts
# expect: 3/3 subtests pass; teardown clean
```

### V3 — Full Playwright suite passes
```bash
npx playwright test
# expect: 7/7 green
```

### V4 — Manual smoke (staging GH Pages)
- Reserve a title on-sale today → badge shows 1, arrivals shows it
- Reserve a title on-sale next Monday → badge does NOT count it,
  arrivals does NOT show it
- Admin → This Week tab: header reads "Mon DD – Sun DD, YYYY"; the
  current week shows correct customers; Prev/Today/Next shifts by 7 days
- Print Bagging List opens print view with correct Mon-Sun header

### V5 — Usage event payload sanity
After loading arrivals.html once on staging:
```sql
SELECT payload FROM usage_events
WHERE event_name = 'arrivals'
ORDER BY created_at DESC
LIMIT 1;
```
Expect `{ "week_start": "YYYY-MM-DD", "week_end": "YYYY-MM-DD" }`.

### V6 — Late-night edge case
Open arrivals.html at exactly 11:59 PM ET on a Sunday: displayed week
should still be the Mon-Sun ending that Sunday. At 12:01 AM Monday,
refresh shows the new week. This is the F28 regression the helper
prevents.

---

## Completion Criteria

3.8 is complete when **all** of the following are true on staging:

- [x] V1 returns zero hits for legacy patterns
- [x] `DateUtils` defined in `app.js` and called by NavBubble,
      arrivals.html, mylist.html, admin.html
- [x] Playwright spec 04 (rewritten) passes; full suite green
- [x] arrivals.html displays a Mon-Sun range in its header, subtitle,
      and print button label
- [x] admin This Week tab header reads Mon-Sun; Prev/Today/Next works
- [x] Manual smoke V4 succeeds
- [x] `technical-reference.md` F28 edited and F35 added
- [x] `CLAUDE.md` "This Week" rule reflects new semantics; active phase
      updated
- [x] Parent plan `phase-3-tenant-resolution.md` reflects 3.8 status
- [x] `phase-3.6-admin-wednesday-tooling.md` carry-forward note added
- [x] PR merged to `staging`
- [x] One soak day passes with no badge↔arrivals discrepancy

---
---

## Execution Notes (added post-soak 2026-05-15)

Two amendments folded into the runbook during execution, plus one
plan-vs-execution divergence on the findings index:

### A1 — C2b: mylist.html export filename
While editing line 696 per C4, the session detected a second
`toISOString().split('T')[0]` call a few lines below, used to label
the CSV download filename. Same anti-pattern, milder symptom.
Stop-and-ask: user confirmed fix-in-place under the same commit.
Swapped to `DateUtils.todayLocal()`.

### A2 — C4b: admin.html export filenames
Same pattern surfaced in three admin export handlers (preorders,
users, subscribers). Stop-and-ask returned the same decision; fix
applied to all three under the same commit.

### A3 — F35 collision avoidance
Plan item C7 named a new F35 entry for the semantic-mismatch
finding. The existing `technical-reference.md` § 13 already holds
F35 (`reset-password` staging-URL bug). The session resolved this
by expanding F28 to absorb both the date-math callsites and the
filename-label callsites (now stamped "phase 3.8 (2026-05-14)"),
treating the semantic mismatch as one symptom of the broader
`toISOString()` anti-pattern rather than a separate finding. Cleaner
outcome than renumbering and avoids the collision entirely.

### A4 — test-this-week.ps1 refactor (outside repo)
Local scripts folder helper was refactored in parallel to match the
new Mon-Sun rule. Added `-BoundaryTest` mode that manually seeds the
same boundary scenarios spec 04 asserts. Not in the repo — local
scripts only. Documented in `CLAUDE.md` § Repository Structure.

Anti-drift verdict: the stop-and-ask discipline worked exactly as
intended. The inventory-divergence check in C4 caught the filename
callsites before they were committed silently as scope creep.

## Carry-Forward

1. **`usage_events.payload` key rename** — Rows logged before 3.8 carry
   the legacy `on_sale_date` key. No backfill. Any future analytics
   query spanning the rename must `COALESCE(payload->>'week_start',
   payload->>'on_sale_date')` or filter `created_at >= '2026-05-NN'` to
   use the new key cleanly.

2. **Playwright clock pinning** — Spec 04 reads "today" at test time.
   If the suite runs in the last seconds before midnight Sunday, the
   seeded "next Monday" row could be in the new week by assertion time.
   Mitigation deferred — would require a clock-injection seam in
   `DateUtils` or a `--clock` flag. Note in spec comments; revisit only
   if it flakes.

3. **F16 / F34 deep audit** — Still queued as a separate pre-Phase-4
   sub-deploy (CLAUDE.md line 23). 3.8 does not touch.

4. **catalog.html "Available This Week"** — If product later adds it,
   uses `DateUtils.weekRange()`. No work this sub-deploy.

5. **`mylist.html` Upcoming Arrivals** — Uses `>= today`, not "this
   week". Out of scope. If product later groups Upcoming by week, the
   helper supports it.

---

## Reference

- Parent plan: `docs/phase-3-tenant-resolution.md`
- 3.6 plan (admin bagging origin): `docs/phase-3.6-admin-wednesday-tooling.md`
- 3.7 plan (Playwright fixture conventions): `docs/phase-3.7-playwright-smoke-tests.md`
- Anti-drift rules: `CLAUDE.md` § Anti-Drift Rules for Agentic Sessions
- Findings index: `docs/technical-reference.md` § 13
- Founding tenant UUID: `72e29f67-39f7-42bc-a4d5-d6f992f9d790`
