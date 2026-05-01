# Phase 2 — Completion Notes

**Status:** Substantially complete on staging. Production untouched.
**Date completed:** [fill in date of last working session]

Phase 2 made the import script and Edge Functions tenant-aware.
App code (app.js, HTML) was deliberately not modified — it continues
to work via the Phase 1 column defaults and `current_tenant_id()`
RLS resolution.

---

## What Was Done

### Import Script (`import-staging.js`)
- Added `TENANT_ID` constant
- Added `tenant_id` to all catalog records in normalize functions
- Added `tenant_id` to auto-reserve insert payload
- Updated catalog upsert `on_conflict` to lead with `tenant_id`
- Passes `p_tenant_id` as first arg to all 3 RPC calls:
  `purge_stale_catalog`, `delete_dropped_catalog_items`,
  `archive_stale_reservations`
- Verified working end-to-end against staging Supabase

### Edge Functions Updated (5 of 8)

| Function | Change |
|---|---|
| `notify-customers` | Tenant-scoped profiles query + paper email filter |
| `create-paper-customer` | Explicit `tenant_id` in profile INSERT |
| `invite-customer` | Explicit `tenant_id` in INSERT + staging URL fix + dropped shared MailerSend template (was hardcoding prod URL) |
| `register-customer` | Explicit `tenant_id` in profile INSERT |
| `send-my-list` | Tenant-scoped catalog month query |

### Edge Functions Not Updated (3 of 8)

| Function | Why |
|---|---|
| `approve-customer` | PATCH on existing rows only, tenant_id already set |
| `claim-paper-customer` | PATCH/DELETE on existing rows only |
| `reset-password` | No tenant-scoped writes — but **was** updated for staging URL fix (see below) |

### URL Fixes (in-scope side work)
- `reset-password` — redirect_to and action_url corrected to staging domain
- `invite-customer` — same fix + replaced shared MailerSend template `vywj2lpyd5pl7oqz` with inline HTML (the template hardcoded the prod forgot-password URL)

### Database Changes Added During Phase 2
SQL run on staging Supabase, not in any migration file:

- New RLS policy `admins write tenant preorders` (FOR ALL with tenant + admin check) — fixes admin impersonation reserve and batch fulfill 403s
- `app_settings` policies expanded with INSERT and DELETE
- Column defaults set on `app_settings`, `settings`, `user_profiles`,
  `weekly_shipment`, `reservation_history`

### Supabase Secrets Added
- `FOUNDING_TENANT_ID = 72e29f67-39f7-42bc-a4d5-d6f992f9d790` (staging only)

---

## Smoke Testing Confirmed
- Import script full run ✅
- Customer flows (catalog, my list, subscriptions, this week) ✅
- Admin flows (dashboard, fulfillment toggle, impersonation reserve) ✅
- Email flows: invite, reset password, paper customer creation ✅

---

## Carried Forward to Phase 3

These are intentionally NOT done in Phase 2:

1. **Analytics views (`analytics_*`)** — still un-scoped. Will need
   rebuilding to filter by `current_tenant_id()` once a second tenant
   exists. Currently safe because all data is in one tenant.

2. **App code explicit `tenant_id`** — `app.js` and the HTML pages still
   write without passing `tenant_id`. Column defaults handle this. Once
   tenant resolution from URL is in place (Phase 3), the writes need to
   pass tenant_id explicitly so the defaults can be removed.

3. **Admin preorders DB-side month filter** — `admin.html` fetches all
   preorders and filters by month client-side. Working as-is. Push the
   filter to the query when convenient.

4. **Import script production version** — `import.js` (production) is
   unchanged. Do NOT run a production catalog import until production
   gets the Phase 1 schema migration. Staging script is on a different
   tenant UUID and different Supabase project — safe.

---

## Known Risks Until Phase 3

- A second tenant added to staging would see Ray & Judy's data in
  analytics views (no tenant filter)
- Anyone removing column defaults before app code is updated would
  break new user signups, preorders, and subscriptions
- These are Phase 3 problems, not Phase 2 problems