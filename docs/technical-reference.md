# Technical Reference — PULLLIST

**Environment:** staging Supabase project `puoaiyezsreowpwxzxhj.supabase.co`
**Founding tenant UUID:** `72e29f67-39f7-42bc-a4d5-d6f992f9d790` (slug `raysandjudys`)
**Last verified:** post Phase 3.8 soak, May 2026.

This document is the canonical schema and architecture reference for the
PULLLIST staging environment. Production diverges from staging until Phase 4
(production multi-tenancy migration); production-side state is out of scope
for this document.

> **Findings.** A discovery pass while writing this document surfaced 27
> findings — schema-level inconsistencies, dormant multi-tenancy bugs that
> activate when a second tenant onboards, and one active production-staging
> URL bug. They are listed in [Section 13](#13-findings--known-issues). Four
> are HIGH severity and one additional is dormant-HIGH; the HIGH set should
> be addressed before Phase 4.

---

## 1. Overview

PULLLIST is a comic pre-order system for independent bookstores. The staging
deployment serves a single founding tenant, Ray & Judy's Book Stop, with the
schema fully shaped for multi-tenancy after Phases 1, 2, and 3 (sub-deploys
3.1–3.8) of the migration program. No second tenant exists yet; the multi-tenancy
plumbing is exercised only by the founding tenant in production traffic.

The application is a static GitHub Pages site (vanilla HTML/CSS/JS, no build
step) that talks directly to a Supabase project. Eight Deno-based Supabase
Edge Functions handle email-sending and privileged operations that need the
service-role key. A local Node.js script imports monthly distributor catalogs
and weekly shipment invoices.

```
Browser (GitHub Pages, staging-only branch)
  ├── index.html         ← login + invite/recovery landing
  ├── catalog.html       ← browse and reserve monthly catalog
  ├── mylist.html        ← view and manage pull list
  ├── arrivals.html      ← this week's shipment + reserved arrivals
  ├── subscriptions.html ← series auto-reserve management
  ├── admin.html         ← admin dashboard (admins only)
  ├── analytics.html     ← admin analytics (admins only)
  ├── forgot-password.html ← password reset landing
  ├── app.js             ← shared logic; all Supabase API calls
  ├── style.css
  └── config.js          ← credentials (gitignored)
        │
        ▼
  Supabase staging (puoaiyezsreowpwxzxhj.supabase.co)
  ├── PostgreSQL (10 tables, 1 view, 9 functions)
  ├── Auth (email/password + invite + magic-link flows)
  ├── RLS (enabled on every public table)
  └── Edge Functions
        ├── notify-customers      ← monthly catalog notification
        ├── send-my-list          ← per-customer pull-list confirmation
        ├── invite-customer       ← admin-invited new account + email
        ├── register-customer     ← MailerLite webhook → pending account
        ├── approve-customer      ← admin approves pending → active
        ├── create-paper-customer ← admin creates walk-in placeholder
        ├── claim-paper-customer  ← merge paper account into real account
        └── reset-password        ← MailerSend-branded password reset

Local (runs each catalog cycle, never deployed)
  └── import-staging.js  ← Node — normalizes CSVs, upserts to Supabase
```

Tenant scoping flows through three independent mechanisms in lockstep:

1. **Database**: every tenant-scoped table has `tenant_id uuid NOT NULL` with
   `ON DELETE CASCADE` to `tenants.id`, and RLS policies that filter on
   `current_tenant_id()`.
2. **Web app** (`app.js`): the `TenantContext` module resolves the active
   tenant before any other API call. `app.js` writes pass `tenant_id`
   explicitly (Phase 3.2).
3. **Server-side helpers**: the import script hard-codes `TENANT_ID` to the
   founding tenant; tenant-aware Edge Functions read `FOUNDING_TENANT_ID`
   from a Supabase secret.

The mechanisms agree only by convention. The findings in
[Section 13](#13-findings--known-issues) include several places where one
mechanism diverges from the others.

---

## 2. Tech stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML/CSS/JS, no build step, served from GitHub Pages |
| Database | Supabase Postgres (15.x, with `pgcrypto`, `uuid-ossp`, `pg_stat_statements`, `supabase_vault`) |
| Auth | Supabase Auth (email/password, invite tokens, magic links, recovery tokens) |
| Edge Functions | Deno runtime on Supabase, hand-written TypeScript |
| Email | MailerSend (transactional) and MailerLite (subscriber webhooks) |
| Import | Node.js, run from local scripts folder, never committed |
| Hosting | GitHub Pages (`mrcyberrick.github.io/comic-preorder-staging/`) |

`pgcrypto` provides `gen_random_uuid()` (used by newer tables); `uuid-ossp`
provides `uuid_generate_v4()` (used by `catalog` and `preorders`, predating
the move to `pgcrypto`). Both produce v4 UUIDs and are interchangeable for
this project's purposes; see finding F27.

`supabase_vault` is installed but no application code references it. The
`pg_stat_statements` extension is the standard Supabase performance-tracking
extension and is not used directly.

---

## 3. Multi-tenancy model

The schema treats every customer-facing table as tenant-scoped via a
`tenant_id uuid NOT NULL` column. There is one founding tenant
(`72e29f67-39f7-42bc-a4d5-d6f992f9d790`); no second tenant has been
onboarded.

### 3.1 Tenant resolution

**In the database**, two SECURITY DEFINER functions resolve the active
tenant and admin status from `auth.uid()`:

```sql
current_tenant_id()      → uuid     -- reads user_profiles.tenant_id
current_user_is_admin()  → boolean  -- reads user_profiles.is_admin
```

Both are `STABLE`, both `SET search_path = public`, both read the calling
user's profile row directly. RLS policies on tenant-scoped tables call
`current_tenant_id()` in their qual or with_check expressions to enforce
isolation.

**In the web app** (`app.js`), the `TenantContext` module resolves the
active tenant before any call that needs it. Resolution order:

1. Authenticated user's `user_profiles.tenant_id` (looked up on page load).
2. `?t=<slug>` query parameter (persisted to `sessionStorage` for the tab).
3. Founding tenant fallback.

The slug-to-id mapping for unauthenticated lookups is hard-coded in
`TENANT_SLUG_MAP` because the `tenants` table is not readable by anon. This
is acknowledged scaffolding; the comment in `app.js` notes it will be
replaced with an RPC once a second tenant exists.

**In the import script** (`import-staging.js`), tenant_id is a top-level
constant `TENANT_ID = '72e29f67-...'`. Catalog upserts, shipment upserts,
and auto-reserve inserts all carry this value explicitly. The three
tenant-aware SQL RPCs (`purge_stale_catalog`, `delete_dropped_catalog_items`,
`archive_stale_reservations`) all take `p_tenant_id uuid` as their first
argument.

**In the Edge Functions**, five of eight read `FOUNDING_TENANT_ID` from
Supabase secrets and use it for tenant filtering or for stamping new rows.
Three (`approve-customer`, `claim-paper-customer`, `reset-password`) do not
read tenant context at all; the first two perform admin-gated operations
without checking that the target user belongs to the admin's tenant
(see findings F33 and the cross-tenant aspect of F34's per-function notes).

### 3.2 Tenant-scoped vs global tables

Every public-schema table carries `tenant_id NOT NULL`:

```
tenants                ← root; id is the tenant_id everywhere else
user_profiles          ← tenant_id NOT NULL, CASCADE from tenants
catalog                ← tenant_id NOT NULL, CASCADE from tenants
preorders              ← tenant_id NOT NULL, CASCADE from tenants
subscriptions          ← tenant_id NOT NULL, CASCADE from tenants
reservation_history    ← tenant_id NOT NULL, CASCADE from tenants
usage_events           ← tenant_id NOT NULL, CASCADE from tenants
weekly_shipment        ← tenant_id NOT NULL, CASCADE from tenants
app_settings           ← tenant_id NOT NULL, CASCADE from tenants
settings               ← tenant_id NOT NULL, CASCADE from tenants (legacy)
```

Deleting a tenant cascades to every dependent row. There is no per-row
"global" or shared-across-tenants data in the public schema.

### 3.3 The `auth.users` ↔ `user_profiles` relationship

`user_profiles.id` is the same UUID as `auth.users.id` by convention but
**there is no foreign key between them**. This is intentional — the paper
customer flow (`is_paper = true`) creates `user_profiles` rows for walk-in
customers who never log in, and the placeholder auth user is sometimes
deleted before the corresponding profile, or vice versa. A FK with CASCADE
in either direction would break the paper-customer flow.

Two implications:

- `auth.users` deletion does not automatically remove `user_profiles`. The
  `claim-paper-customer` Edge Function explicitly deletes both rows when
  merging a paper account into a real account.
- The `Preorders.getAll` admin query in `app.js` joins
  `auth_users:user_id ( email )` via PostgREST — this works because
  PostgREST infers the relationship from the by-convention UUID matching,
  but it is fragile (see F30).

### 3.4 RLS mental model & gotchas

Multi-tenancy correctness depends on every read-and-write path passing
through code that respects `current_tenant_id()`. Several patterns make
this easier to get wrong than expected. The list below is the mental model
to apply when reading or writing any new policy, function, or view:

**Pattern A — `qual = true` SELECT policy.** A SELECT policy with
`qual = true` and no other policies on the table returns every row to any
caller in the policy's `roles` set. Section 7's `weekly_shipment` policy is
exactly this shape (F15). Check: every SELECT policy on a tenant-scoped
table should have `qual` of the form `tenant_id = current_tenant_id()` or a
join that achieves the same.

**Pattern B — multiple PERMISSIVE policies OR together.** PostgreSQL
combines multiple PERMISSIVE policies on the same `cmd` with OR. If one
policy is properly tenant-scoped and another is not, the looser one wins.
The `preorders` admin policies (F16) demonstrate this: three admin-related
policies coexist; only one explicitly checks `tenant_id`. Check: if a table
has more than one ALL-or-write policy for the same role, every one must
either include the tenant check or be paired with a RESTRICTIVE policy that
does.

**Pattern C — SECURITY DEFINER functions bypass RLS entirely.** A function
declared `SECURITY DEFINER` runs with the function owner's privileges, so
RLS on referenced tables does not apply. If the function body does not
itself filter by `tenant_id` (or call `current_tenant_id()`), it reads
across all tenants. `get_popular_series()` is exactly this shape (F20):
DEFINER, queries `preorders JOIN catalog`, no tenant filter. Check: every
DEFINER function that reads tenant-scoped data must filter explicitly,
either via a `p_tenant_id` parameter or via `current_tenant_id()` in the
WHERE clause.

**Pattern D — views default to `security_invoker = false`.** A view created
without explicit `WITH (security_invoker = true)` runs with the view
owner's privileges (typically `postgres`), bypassing RLS on the underlying
tables. The view body then needs its own tenant filter, otherwise it leaks
across tenants. The `admin_preorders` view is shaped this way (F26),
though no application code currently queries it. Check: every public view
that joins tenant-scoped tables either needs `WITH (security_invoker =
true)` or its body needs an explicit `WHERE tenant_id = current_tenant_id()`.

**Pattern E — SECURITY DEFINER without `SET search_path` is a footgun.**
If a SECURITY DEFINER function does not pin its `search_path`, a malicious
caller can prepend a malicious schema and shadow the functions or tables
referenced in the body. Anthropic's hardening recommendation is
`SET search_path = public, pg_temp` for every DEFINER function. Several
functions in this project lack this pin (F23). Check: every new SECURITY
DEFINER function should include `SET search_path = public` in its
declaration.

These five patterns recur through this document's findings. They are not
exhaustive but cover what the discovery pass surfaced.

---

## 4. Tables

Ten base tables in the `public` schema. Listed with `tenants` first as the
root of the cascade chain, then alphabetical. For each: purpose, columns
with types and nullability, constraints, foreign keys, indexes, and any
notable behavior.

### 4.1 `tenants`

Root of the multi-tenancy hierarchy. One row per tenant. Currently one row
exists (the founding tenant).

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `slug` | text | NO | — |
| `display_name` | text | NO | — |
| `contact_email` | text | YES | — |
| `contact_phone` | text | YES | — |
| `location` | text | YES | — |
| `plan` | text | NO | `'free'` |
| `branding` | jsonb | YES | `'{}'::jsonb` |
| `settings` | jsonb | YES | `'{}'::jsonb` |
| `created_at` | timestamptz | YES | `now()` |
| `updated_at` | timestamptz | YES | `now()` |

**Constraints:**
- PK: `id`
- UNIQUE: `slug`
- CHECK `tenants_slug_format_check`: `slug ~ '^[a-z0-9][a-z0-9-]*[a-z0-9]$'` OR `slug ~ '^[a-z0-9]$'` (DNS-safe)

**Indexes:**
- `tenants_pkey` on `id`
- `tenants_slug_key` (unique) on `slug`
- `idx_tenants_slug` on `slug` — redundant with `tenants_slug_key` (F14)

**Notes:**
- Per-tenant `branding` and `settings` jsonb columns are reserved for
  future use; no application code currently reads them.
- No INSERT or DELETE RLS policy: tenant creation is service-role-only.
  Authenticated users can SELECT only their own tenant; admins can UPDATE
  their own tenant.

### 4.2 `app_settings`

Canonical app-wide settings. Key/value with audit fields.

| Column | Type | Nullable | Default |
|---|---|---|---|
| `key` | text | NO | — |
| `value` | text | NO | — |
| `updated_at` | timestamptz | YES | `now()` |
| `updated_by` | uuid | YES | — |
| `tenant_id` | uuid | NO | — |

**Constraints:**
- PK: `key` — see F6 (no `tenant_id` in the PK; multi-tenant collision risk)

**FKs:**
- `tenant_id` → `tenants.id` ON DELETE CASCADE

**Indexes:**
- `app_settings_pkey` on `key`
- `idx_app_settings_tenant` on `tenant_id`

**Current keys in staging:**
- `maintenance_mode` — `'true'` / `'false'`; checked by `app.js`
  `Settings.isMaintenanceMode()`, redirects non-admin traffic to a holding
  page when on
- `order_deadline` — `'YYYY-MM-DD'` or empty; read by the catalog banner and
  by the `notify-customers` Edge Function for the email body

This is the table read and written by `app.js`'s `Settings` API. It is
**not** the same as the legacy `settings` table (4.8). See F4 for the
ongoing split.

### 4.3 `catalog`

Monthly distributor catalog items. The largest table by row count
(~7,200 rows in current staging).

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `uuid_generate_v4()` |
| `distributor` | text | NO | — |
| `item_code` | text | NO | — |
| `alternate_code` | text | YES | — |
| `upc` | text | YES | — |
| `isbn` | text | YES | — |
| `title` | text | NO | — |
| `series_name` | text | YES | — |
| `series_number` | text | YES | — |
| `publisher` | text | YES | — |
| `imprint` | text | YES | — |
| `format` | text | YES | — |
| `comic_type` | text | YES | — |
| `variant_type` | text | YES | — |
| `variant_desc` | text | YES | — |
| `issue_number` | text | YES | — |
| `price_usd` | numeric | YES | — |
| `foc_date` | date | YES | — |
| `on_sale_date` | date | YES | — |
| `writer` | text | YES | — |
| `artist` | text | YES | — |
| `cover_artist` | text | YES | — |
| `description` | text | YES | — |
| `cover_url` | text | YES | — |
| `rating` | text | YES | — |
| `is_mature` | boolean | YES | `false` |
| `catalog_month` | text | NO | — |
| `created_at` | timestamptz | YES | `now()` |
| `tenant_id` | uuid | NO | — |

**Constraints:**
- PK: `id`
- UNIQUE `catalog_tenant_item_distributor_month_unique`: `(tenant_id, item_code, distributor, catalog_month)` — the upsert key for the import script

**FKs:**
- `tenant_id` → `tenants.id` ON DELETE CASCADE

**Indexes:**
- `catalog_pkey` on `id`
- `catalog_tenant_item_distributor_month_unique` (unique) on the four-column upsert key
- `idx_catalog_tenant` on `tenant_id`
- `idx_catalog_distributor` on `distributor`
- `idx_catalog_month` on `catalog_month`
- `idx_catalog_on_sale` on `on_sale_date`
- `idx_catalog_publisher` on `publisher`
- `idx_catalog_series` on `series_name`

**Notes:**
- `variant_type` distinguishes standard covers from variant covers. The
  app and import script treat NULL, `'Standard'` (Lunar), and
  `'Primary Title'` (PRH) as standard covers; everything else is a variant.
- `is_mature` is set by the import script's parsing of the Lunar `Mature`
  and `Adult` flags; PRH catalog rows always have `is_mature = false`.
- No INSERT/UPDATE/DELETE RLS policy: catalog mutations are
  service-role-only via the import script.

### 4.4 `preorders`

Customer reservations. Join row between a `user_profiles.id` and a
`catalog.id`.

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `uuid_generate_v4()` |
| `user_id` | uuid | NO | — |
| `catalog_id` | uuid | NO | — |
| `created_at` | timestamptz | YES | `now()` |
| `notes` | text | YES | — |
| `quantity` | integer | NO | `1` |
| `fulfilled` | boolean | NO | `false` |
| `fulfilled_at` | timestamptz | YES | — |
| `tenant_id` | uuid | NO | — |

**Constraints:**
- PK: `id`
- UNIQUE: `(user_id, catalog_id)` — one reservation row per user per item

**FKs:**
- `user_id` → `user_profiles.id` ON DELETE NO ACTION (F10)
- `catalog_id` → `catalog.id` ON DELETE NO ACTION (F10)
- `tenant_id` → `tenants.id` ON DELETE CASCADE

**Indexes:**
- `preorders_pkey` on `id`
- `preorders_user_id_catalog_id_key` (unique) on `(user_id, catalog_id)`
- `idx_preorders_tenant` on `tenant_id`
- `idx_preorders_user` on `user_id`
- `idx_preorders_catalog` on `catalog_id`
- `preorders_fulfilled_idx` partial on `fulfilled` WHERE `fulfilled = false`

**Notes:**
- The `NO ACTION` delete behavior on `user_id` and `catalog_id` is what
  blocks naïve catalog row deletion: removing a `catalog` row referenced by
  any preorder fails, which is why `purge_stale_catalog()` filters
  `id NOT IN (SELECT catalog_id FROM preorders WHERE tenant_id = ...)`
  before deleting.
- `fulfilled` and `fulfilled_at` are set by admins via
  `Preorders.setFulfilled` and `Preorders.setFulfilledByCatalogId` (the
  latter marks every preorder for a catalog item at once, used when an
  entire title arrives). The partial index on `fulfilled = false` supports
  the admin's active-orders query.
- Phase 3.6 introduced automatic fulfillment: rows are marked
  `fulfilled = true` when `catalog.on_sale_date < CURRENT_DATE` via the
  `auto_fulfill_past_on_sale` function called from the weekly import.
  Manual fulfillment (pre-FOC rush orders) remains the exception path
  via `Preorders.setFulfilledByCatalogId()`.
- `Preorders.cancel` (app.js) refuses to delete fulfilled rows. The
  guard is a pre-DELETE row check plus a defensive
  `.eq('fulfilled', false)` filter on the DELETE itself. `mylist.html`
  hides the per-row Remove button for fulfilled rows, replacing it with
  an "✓ In hand" chip.

### 4.5 `reservation_history`

Append-only archive of past-month reservations. Populated by the
`archive_stale_reservations` SQL function during the import script's
new-month sequence.

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `user_id` | uuid | YES | — |
| `series_name` | text | YES | — |
| `publisher` | text | YES | — |
| `distributor` | text | YES | — |
| `title` | text | YES | — |
| `catalog_month` | text | YES | — |
| `on_sale_date` | date | YES | — |
| `created_at` | timestamptz | YES | `now()` |
| `tenant_id` | uuid | NO | — |

**Constraints:**
- PK: `id`
- UNIQUE `reservation_history_user_series_month_unique`: `(user_id, series_name, distributor, catalog_month)` — see F7 (no `tenant_id` in the unique key; safe in practice but inconsistent)

**FKs:**
- `tenant_id` → `tenants.id` ON DELETE CASCADE
- `user_id` → `auth.users.id` ON DELETE CASCADE — see F13 (intent unclear; cascade defeats "preserve history past user deletion" if that was the goal)

**Indexes:**
- `reservation_history_pkey` on `id`
- `reservation_history_user_series_month_unique` (unique) on the four-column key
- `idx_reservation_history_tenant` on `tenant_id`

**Notes:**
- Read by `Recommendations._getUserSignal` in `app.js` to compute the
  user's series-affinity signal (along with current preorders) for the
  Tier 1 personalized recommendations on the catalog page.
- Has only SELECT policies (user-self and admin); inserts come exclusively
  through `archive_stale_reservations` called via service-role from the
  import script. See F24.

### 4.6 `settings` (legacy)

Older settings table that pre-dates `app_settings`. **Both tables are still
read by application code** — see F4. Treat `app_settings` as canonical
unless you specifically know you need `settings`.

| Column | Type | Nullable | Default |
|---|---|---|---|
| `key` | text | NO | — |
| `value` | text | YES | — |
| `tenant_id` | uuid | NO | — |

**Constraints:**
- PK: `key` — same multi-tenant collision risk as `app_settings` (F6)

**FKs:**
- `tenant_id` → `tenants.id` ON DELETE CASCADE

**Indexes:**
- `settings_pkey` on `key`
- `idx_settings_tenant` on `tenant_id`

**Current keys in staging:**
- `popular_series` — JSON array of admin-curated popular series, **read by
  `subscriptions.html`** to show the "Popular at Book Stop" panel to users
  with no subscriptions yet
- `maintenance_mode` — duplicated from `app_settings`, **not read by any
  code path**; orphan

**Notes:**
- RLS has only SELECT (authenticated, tenant-scoped) and UPDATE (admin) —
  no INSERT or DELETE policy. The `popular_series` row was inserted by a
  migration or by hand; there is no UI to edit it.
- The dynamic `get_popular_series()` SQL function (Section 6.4) computes
  popularity from preorder data; the static `popular_series` JSON is a
  separate admin-curated list. They serve different purposes despite the
  similar name.

### 4.7 `subscriptions`

Series-level auto-reserve subscriptions. The import script's auto-reserve
step inserts a `preorders` row for every active subscription whose series
appears in the new catalog month.

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `user_id` | uuid | YES | — |
| `series_name` | text | NO | — |
| `distributor` | text | NO | — |
| `created_at` | timestamptz | YES | `now()` |
| `format` | text | YES | — |
| `tenant_id` | uuid | NO | — |

**Constraints:**
- PK: `id`
- UNIQUE `subscriptions_tenant_user_series_unique`: `(tenant_id, user_id, series_name, distributor)`

**FKs:**
- `user_id` → `user_profiles.id` ON DELETE CASCADE
- `tenant_id` → `tenants.id` ON DELETE CASCADE

**Indexes:**
- `subscriptions_pkey` on `id`
- `subscriptions_tenant_user_series_unique` (unique)
- `idx_subscriptions_tenant` on `tenant_id`

**Notes:**
- `user_id` is technically nullable but in practice never NULL because the
  FK is `ON DELETE CASCADE` (the row is deleted before user_id could
  become NULL).
- `format` is a recent addition. The import script's auto-reserve does an
  exact format match when `subscriptions.format` is set; for legacy or
  popular-series subscriptions where format is NULL, it falls back to
  `isComicFormat()` matching, which excludes Trade Paperbacks, Hardcovers,
  Omnibuses, Graphic Novels, Digests, Box Sets, and Albums.

### 4.8 `usage_events`

Fire-and-forget analytics event log. Events from `app.js`'s `UsageEvents`
helper, populated whenever a customer (not an admin, not an impersonated
session) takes a meaningful action.

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `event_type` | text | NO | — |
| `user_id` | uuid | YES | — |
| `catalog_id` | uuid | YES | — |
| `metadata` | jsonb | YES | — |
| `created_at` | timestamptz | YES | `now()` |
| `tenant_id` | uuid | NO | — |

**Constraints:**
- PK: `id`

**FKs:**
- `user_id` → `auth.users.id` ON DELETE SET NULL
- `catalog_id` → `catalog.id` ON DELETE SET NULL
- `tenant_id` → `tenants.id` ON DELETE CASCADE

**Indexes:**
- `usage_events_pkey` on `id`
- `idx_usage_events_tenant` on `tenant_id`
- `usage_events_user_id_idx` on `user_id`
- `usage_events_catalog_id_idx` on `catalog_id`
- `usage_events_event_type_idx` on `event_type`
- `usage_events_created_at_idx` on `created_at DESC`

**Notes:**
- Event types currently emitted by `UsageEvents`: `reserve`, `cancel`,
  `subscribe`, `unsubscribe`, `catalog_view`, `page_view`, `login`,
  `logout`.
- RLS allows authenticated users to INSERT their own (with
  `tenant_id = current_tenant_id()`) and admins to SELECT their tenant's;
  no UPDATE or DELETE policy exists — events are append-only from the
  RLS perspective. The retention purge (see §6.6 — `purge_old_usage_events`)
  is the one sanctioned DELETE path and runs as `SECURITY DEFINER` via
  service-role from the import script.
- Admin-impersonated sessions skip event logging entirely
  (`AdminContext.isActive()` short-circuits `_log()`).

### 4.9 `user_profiles`

Per-user profile row. `id` matches `auth.users.id` by convention but is
not enforced by FK (Section 3.3).

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | — |
| `full_name` | text | NO | — |
| `is_admin` | boolean | YES | `false` |
| `created_by_admin` | boolean | YES | `true` |
| `notes` | text | YES | — |
| `created_at` | timestamptz | YES | `now()` |
| `status` | text | NO | `'active'` |
| `email` | text | YES | — |
| `has_seen_welcome` | boolean | YES | `false` |
| `is_paper` | boolean | YES | `false` |
| `tenant_id` | uuid | NO | — |

**Constraints:**
- PK: `id`
- CHECK `user_profiles_status_check`: `status IN ('active', 'pending', 'suspended')`

**FKs:**
- `tenant_id` → `tenants.id` ON DELETE CASCADE
- (No FK to `auth.users` — see Section 3.3)

**Indexes:**
- `user_profiles_pkey` on `id`
- `idx_user_profiles_tenant` on `tenant_id`

**Notes:**
- `status` drives the invite/approval state machine. `register-customer`
  (called by MailerLite webhook) creates rows with `status = 'pending'`;
  `approve-customer` flips them to `'active'`; admin Suspend flips to
  `'suspended'`.
- `is_paper = true` marks placeholder profiles for walk-in customers who
  never log in. Used by `claim-paper-customer` to validate the merge
  source.
- `is_admin` is read directly by `current_user_is_admin()`, by
  `Auth.requireAdmin`, and by every Edge Function that needs an admin
  check.
- `email` is denormalized from `auth.users.email` (F25). No trigger keeps
  it in sync; population happens at registration time only.
- `has_seen_welcome` gates the first-login welcome modal in `app.js`
  (`WelcomeModal`). Dual-guarded with localStorage so the modal can't
  reappear before the DB write commits.

### 4.10 `weekly_shipment`

Per-shipment row representing one title arriving at the store on a given
on-sale date. Populated by the import script's optional shipment import
step (Format A delivery invoice or Format B code invoice).

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `distributor` | text | NO | — |
| `item_code` | text | YES | — |
| `upc` | text | YES | — |
| `catalog_id` | uuid | YES | — |
| `title` | text | NO | — |
| `price_usd` | numeric | YES | — |
| `quantity` | integer | NO | `1` |
| `on_sale_date` | date | NO | — |
| `created_at` | timestamptz | NO | `now()` |
| `cover_url` | text | YES | — |
| `tenant_id` | uuid | NO | — |

**Constraints:**
- PK: `id`
- UNIQUE `weekly_shipment_unique`: `(distributor, upc, on_sale_date)` — see F9 (no `tenant_id` prefix; cross-tenant collision risk)

**FKs:**
- `tenant_id` → `tenants.id` ON DELETE CASCADE
- `catalog_id` → `catalog.id` ON DELETE SET NULL

**Indexes:**
- `weekly_shipment_pkey` on `id`
- `weekly_shipment_unique` (unique) on `(distributor, upc, on_sale_date)`
- `idx_weekly_shipment_tenant` on `tenant_id`
- `weekly_shipment_on_sale_date_idx` on `on_sale_date`

**Notes:**
- Either `item_code` or `upc` carries the catalog join key, not both.
  Format A (PRH delivery invoice) populates `upc` from the ISBN column;
  Format B (Lunar/PRH code invoice) populates `item_code` from the Code
  column. Format A maps to `distributor = 'Lunar'`, Format B to
  `distributor = 'PRH'`. (Confusingly, this is opposite to which
  distributor *issued* the invoice — see Section 12.)
- `catalog_id` is nullable because the import script upserts shipment rows
  even when no catalog match is found. Unmatched rows still display on
  arrivals.html using the invoice's title and cover-URL fallbacks.
- The import script's PRH path uses **delete-then-insert** (not upsert)
  for items keyed by `item_code` because PostgREST's `on_conflict` doesn't
  support partial indexes. The Lunar path uses standard upsert on the
  full unique index.
- **F15: the SELECT RLS policy is `qual = true`.** Any authenticated user
  can read every row regardless of `tenant_id`. Currently dormant under
  one tenant.

---

## 5. Views

### 5.1 `admin_preorders`

Three-way join over `preorders`, `user_profiles`, and `catalog`,
denormalized for an admin dashboard layout. **No application code
currently queries this view.**

```sql
CREATE VIEW admin_preorders AS
  SELECT
    p.id AS preorder_id,
    p.tenant_id,
    p.created_at AS reserved_at,
    p.quantity,
    p.notes AS customer_notes,
    up.full_name AS customer_name,
    c.distributor, c.item_code, c.title, c.series_name, c.publisher,
    c.format, c.issue_number, c.price_usd,
    c.price_usd * p.quantity AS line_total,
    c.foc_date, c.on_sale_date, c.catalog_month, c.cover_url
  FROM preorders p
    JOIN user_profiles up ON up.id = p.user_id
    JOIN catalog c ON c.id = p.catalog_id
  ORDER BY up.full_name, c.on_sale_date;
```

`admin.html`'s loadData function builds the equivalent join client-side
using direct `preorders` and `user_profiles` queries; the view is
dead code at the application layer.

The view's `reloptions` is `null`, meaning it runs with the view owner's
privileges (`security_invoker = false` default). Combined with no
WHERE clause filtering by tenant, the view bypasses RLS on the three
underlying tables and would return rows from every tenant if queried.
Currently dormant on two axes: no caller, and only one tenant exists. See
F26.

---

## 6. Database functions

Eight functions in the `public` schema. Listed by category with signature,
security mode, and purpose.

### 6.1 Auth helpers

#### `current_tenant_id() → uuid`

```
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
```

Returns the calling user's tenant_id by reading
`user_profiles.tenant_id WHERE id = auth.uid()`. Called from RLS policies
across every tenant-scoped table.

#### `current_user_is_admin() → boolean`

```
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
```

Returns the calling user's is_admin flag (defaulting to false) by reading
`user_profiles WHERE id = auth.uid()`. Called from RLS policies on
`preorders`, `subscriptions`, `app_settings`, `usage_events`, and others.

#### `is_admin() → boolean`

```
LANGUAGE sql SECURITY DEFINER  -- no STABLE, no SET search_path
```

Functionally equivalent to `current_user_is_admin()` but worse: not
declared `STABLE` (can't be cached within a statement) and lacks
`SET search_path` hardening. **Not referenced by any RLS policy.** Dead
duplicate; see F19.

### 6.2 Catalog management (called by import script)

#### `purge_stale_catalog(p_tenant_id uuid, cutoff_date date, current_month text) → integer`

```
LANGUAGE plpgsql SECURITY DEFINER
```

Deletes catalog rows from previous months whose `on_sale_date < cutoff_date`
and which are not referenced by any preorder in the same tenant. Returns
the row count deleted. Called by the import script when a new catalog
month is detected.

The `id NOT IN (SELECT catalog_id FROM preorders WHERE tenant_id = p_tenant_id)`
subquery is the careful piece: without the tenant filter on the subquery,
a preorder in tenant B referencing the same catalog row would block
deletion in tenant A. Currently moot, but the function is correctly shaped
for multi-tenancy.

#### `delete_dropped_catalog_items(p_tenant_id uuid, p_catalog_month text, p_item_codes text[]) → integer`

```
LANGUAGE plpgsql SECURITY DEFINER
```

Removes items from `catalog` for the given tenant and month that are not
in the provided item_codes array. Used by the import script to drop
titles that have disappeared from this month's distributor catalog
between imports.

### 6.3 History archival

#### `archive_stale_reservations(p_tenant_id uuid, cutoff_date date, current_month text) → integer`

```
LANGUAGE plpgsql SECURITY INVOKER
```

Inserts deduplicated rows into `reservation_history` from the join of
`preorders` and `catalog` for the given tenant, where the catalog month is
not the current month and on_sale_date is before the cutoff. Called by
the import script before `purge_stale_catalog` so historical signal
survives the catalog purge.

INVOKER security model means it runs with the caller's privileges.
`reservation_history` has only SELECT policies (not INSERT), so this
function only succeeds when called by service-role (which bypasses RLS).
See F24.

### 6.4 Analytics

#### `get_popular_series(p_catalog_month text) → TABLE(series_name text, distributor text, reservation_count bigint)`

```
LANGUAGE sql STABLE SECURITY DEFINER  -- no SET search_path
```

Returns series ordered by reservation count for the given catalog month,
computed dynamically from `preorders JOIN catalog`. Two callers:
`admin.html`'s Top Series tab, and `app.js`'s
`Recommendations._getPopularSeries` (used to populate the Tier 2 popular
section of every customer's catalog page).

**No tenant filter in the body.** SECURITY DEFINER bypasses RLS, and the
WHERE clause filters only on `c.catalog_month = p_catalog_month`. Returns
counts unioned across every tenant. See F20 — dormant under one tenant,
becomes a customer-facing cross-tenant analytics leak when tenant 2
onboards.

### 6.5 Retention

#### `purge_old_usage_events(p_tenant_id uuid, p_retention_days integer) → integer`

```
LANGUAGE sql SECURITY DEFINER  SET search_path = public
```

Hard-deletes rows from `usage_events` where `tenant_id = p_tenant_id`
and `created_at < now() - make_interval(days => p_retention_days)`.
Returns the count of deleted rows.

**Caller:** `import-staging.js` Step 8, invoked at the end of every
import run with `TENANT_ID` and `90`. Failure is logged but non-fatal —
the import completes regardless.

**Grants:** EXECUTE granted only to `service_role`; REVOKE ALL FROM
PUBLIC plus explicit REVOKE from `anon` and `authenticated` (Supabase
auto-grants those on function creation). No customer code path can invoke
this function.

**Source:** `docs/sql/purge_old_usage_events.sql`.

### 6.6 Operational

#### `auto_fulfill_past_on_sale(p_tenant_id uuid) → integer`

Per-tenant operational function. Sets `fulfilled = true, fulfilled_at = now()`
on every `preorders` row that belongs to the given tenant, has
`fulfilled = false`, and whose joined `catalog.on_sale_date < CURRENT_DATE`.
Returns the count of rows updated.

- Mode: `SECURITY DEFINER`, `SET search_path = public`
- Grants: `EXECUTE` to `service_role` only
- Called by: `import-staging.js` end-of-run (one call per weekly invocation)
- Idempotent: a subsequent invocation with no new past-on-sale rows returns 0.
- The manual fulfill path via `Preorders.setFulfilledByCatalogId()` is
  unaffected — rows already marked fulfilled are left alone by the
  `fulfilled = false` filter in the WHERE clause.

**Source:** `docs/sql/auto_fulfill_past_on_sale.sql`.

### 6.7 Account merge (unused)

#### `claim_paper_account(paper_user_id uuid, real_user_id uuid) → void`

```
LANGUAGE plpgsql SECURITY INVOKER
```

Re-points all `preorders` and `subscriptions` from a paper account to a
real account, then deletes the paper user_profiles and auth.users rows.

**Not called by any application code.** The `claim-paper-customer` Edge
Function reimplements this logic in TypeScript via REST. See F33.

The function lacks defensive checks (no verification that
`paper_user_id` is actually `is_paper = true`, no tenant scoping, etc.)
and depends on the caller having `auth.users` DELETE rights, which means
it only succeeds when called via service-role. See F21.

---

## 7. Row-level security

Every public-schema table has `rls_enabled = true` and
`rls_forced = false`. Service-role bypasses RLS (Supabase's default
behavior), which is how the import script and Edge Functions perform
privileged operations. The web app uses the anon key with the
authenticated session, which goes through RLS.

**Read [Section 3.4](#34-rls-mental-model--gotchas) before touching any
policy.** The patterns there explain why several tables in this section
have findings.

### 7.1 Per-table policy summary

#### `tenants`
- `users read own tenant` — SELECT, authenticated, where `id = current_tenant_id()`
- `admins update own tenant` — UPDATE, where `id = current_tenant_id() AND current_user_is_admin()`
- No INSERT or DELETE policy. Tenant creation is service-role-only.

#### `user_profiles`
- `users view own profile` — SELECT where `auth.uid() = id`
- `users update own profile` — UPDATE where `auth.uid() = id`
- `admins view tenant profiles` — SELECT where `tenant_id = current_tenant_id() AND current_user_is_admin()`
- No INSERT or DELETE policy. Profile creation/deletion goes through
  service-role (Edge Functions).

#### `catalog`
- `users read tenant catalog` — SELECT, authenticated, where `tenant_id = current_tenant_id()`
- No INSERT/UPDATE/DELETE policies. Catalog mutations are service-role-only.

#### `preorders` (4 policies; see F16)
- `users manage own preorders` — ALL where `auth.uid() = user_id AND tenant_id = current_tenant_id()`
- `admins manage tenant preorders` — ALL where `tenant_id = current_tenant_id() AND <user_profiles is_admin check>`
- `admins write tenant preorders` — ALL where `<user_profiles is_admin AND tenant_id = current_tenant_id()>` (note: tenant check is on the admin's profile, not the row being written)
- `admins view tenant preorders` — SELECT, redundant with the two ALL policies above

The "admins write" policy lacks a row-level tenant check. Because
PERMISSIVE policies OR together, the looser policy effectively allows
cross-tenant writes — see F16.

#### `subscriptions`
- `users manage own subscriptions` — ALL where `auth.uid() = user_id AND tenant_id = current_tenant_id()`
- `admins view tenant subscriptions` — SELECT where `tenant_id = current_tenant_id() AND current_user_is_admin()`
- No admin write policy. Subscriptions are user-managed only; admins use
  impersonation (`AdminContext`) to manage on behalf of users.

#### `reservation_history` (see F17)
- `users view own history` — SELECT where `auth.uid() = user_id`
- `admins view all history` — SELECT where `current_user_is_admin()`
- No INSERT/UPDATE/DELETE policies. Inserts come exclusively through
  `archive_stale_reservations` called via service-role.

Neither policy includes a tenant filter. The user policy is safe in
practice (a user's own history can only be from the user's tenant); the
admin policy allows cross-tenant SELECT. See F17.

#### `usage_events`
- `users insert own usage events` — INSERT with check `tenant_id = current_tenant_id()`
- `admins read tenant usage events` — SELECT where `tenant_id = current_tenant_id() AND current_user_is_admin()`
- No UPDATE/DELETE policies. Events are append-only.

#### `app_settings`
- `users read tenant app_settings` — SELECT, authenticated, where `tenant_id = current_tenant_id()`
- `admins insert tenant app_settings` — INSERT with check
- `admins update tenant app_settings` — UPDATE
- `admins delete tenant app_settings` — DELETE
  — All three admin policies properly check `tenant_id = current_tenant_id() AND current_user_is_admin()`.

#### `settings` (legacy)
- `users read tenant settings` — SELECT, authenticated, where `tenant_id = current_tenant_id()`
- `admins update tenant settings` — UPDATE where `tenant_id = current_tenant_id() AND current_user_is_admin()`
- No INSERT or DELETE policy. The fewer-policy footprint compared to
  `app_settings` is consistent with `settings` being the legacy
  half-migrated table (F4).

#### `weekly_shipment` (see F15)
- `authenticated users read weekly_shipment` — SELECT, authenticated, **`qual = true`**

The only policy. `qual = true` means every authenticated user reads every
row, regardless of tenant. **F15 — confirmed cross-tenant SELECT leak**,
dormant only because there is one tenant. The arrivals.html caller relies
on RLS to scope, and RLS doesn't scope here.

### 7.2 What the policies don't cover

INSERT/UPDATE/DELETE on tables with no write policy is locked entirely to
service-role. This is the intended behavior for `catalog`,
`weekly_shipment`, and most state-changing operations on `user_profiles`.
The pattern keeps customer-driven mutations narrow (preorders,
subscriptions, own profile updates, own usage_events inserts) and forces
everything else through audited Edge Functions.

---

## 8. Indexes

Every tenant-scoped table has a non-unique `idx_<table>_tenant` index on
`tenant_id`. Other indexes are listed inline in [Section 4](#4-tables);
this section only collects cross-cutting observations.

**Performance-shaped indexes worth knowing about:**
- `catalog`: separate indexes on `distributor`, `catalog_month`,
  `on_sale_date`, `publisher`, `series_name` — supports the catalog browse
  filters without compound index management
- `preorders`: partial index on `fulfilled` WHERE `fulfilled = false` —
  supports the admin's active-reservations queries
- `usage_events`: indexes on `user_id`, `catalog_id`, `event_type`, and
  `created_at DESC` — supports the analytics-shaped queries the analytics
  page presumably runs
- `weekly_shipment`: `on_sale_date` index supports the This Week page

**Convention:** every table that has a tenant-scoped unique constraint
puts `tenant_id` as the leading column. The exceptions are
`reservation_history` (F7) and `weekly_shipment` (F9), where the unique
key omits `tenant_id`.

**Redundant index:** `idx_tenants_slug` and `tenants_slug_key` (unique)
both index `tenants.slug`. The non-unique one is dead — it cannot serve a
query better than the unique constraint's backing index. See F14.

---

## 9. Cascade chains and deletion behavior

Two roots: `tenants` and `auth.users`.

### 9.1 Tenant deletion

```
tenants (delete)
  └─ CASCADE → user_profiles
  └─ CASCADE → catalog
       ├─ NO ACTION → preorders.catalog_id   (would block, but…)
       └─ SET NULL → usage_events.catalog_id
       └─ SET NULL → weekly_shipment.catalog_id
  └─ CASCADE → preorders     (direct, before catalog cascade hits NO ACTION)
  └─ CASCADE → subscriptions
       └─ CASCADE → (already gone with user_profiles; no extra action)
  └─ CASCADE → reservation_history
  └─ CASCADE → usage_events
  └─ CASCADE → weekly_shipment
  └─ CASCADE → app_settings
  └─ CASCADE → settings
```

Deleting a tenant cleans up everything for that tenant. The order matters:
the direct `preorders.tenant_id` CASCADE removes preorders before the
catalog CASCADE runs into the `NO ACTION` blocker on `catalog_id`, so the
delete completes successfully.

### 9.2 Auth user deletion

```
auth.users (delete)
  ├─ SET NULL → usage_events.user_id
  └─ CASCADE  → reservation_history.user_id  (F13 — intent unclear)
  (no link to user_profiles.id — see Section 3.3)
```

Deleting an `auth.users` row does **not** cascade to `user_profiles`
because there is no FK between them. The expected cleanup path for a
customer who should be removed is to delete the `user_profiles` row (which
cascades through `subscriptions` but is blocked by `preorders` if any
exist) and separately delete the `auth.users` row. The
`claim-paper-customer` Edge Function does both deletes explicitly.

### 9.3 User profile deletion

```
user_profiles (delete)
  └─ CASCADE → subscriptions
  └─ NO ACTION → preorders.user_id  (blocks delete if any preorders exist)
```

Deleting a `user_profiles` row removes that user's subscriptions but is
blocked by any preorder. Either remove the user's preorders first or use
`claim-paper-customer` (for paper accounts) which moves preorders before
deleting the profile.

### 9.4 Catalog row deletion

```
catalog (delete)
  ├─ NO ACTION → preorders.catalog_id  (blocks delete if any preorders exist)
  ├─ SET NULL → usage_events.catalog_id
  └─ SET NULL → weekly_shipment.catalog_id
```

Direct catalog deletion is blocked if any preorder references the row.
This is why `purge_stale_catalog()` filters to
`id NOT IN (SELECT catalog_id FROM preorders WHERE tenant_id = ...)`
before issuing its DELETE. Without the filter the import script's
new-month sequence would fail when any past-month preorders exist.

---

## 10. Application API surface (`app.js`)

`app.js` is the single shared module loaded by every page. It exports
several namespaced API objects on `window` (or via direct const reference
within the page's inline script). Every method below is async unless
noted.

### 10.1 `TenantContext`

Resolves the active tenant for the current page load. Must be awaited
before any API call that needs `tenant_id`.

```javascript
TenantContext.resolve()       // → { id, slug, display_name }
TenantContext.current()       // → cached resolved tenant; throws if not resolved
TenantContext.source()        // → 'profile' | 'query' | 'session' | 'default'
```

Resolution order: authenticated profile → `?t=<slug>` query param →
sessionStorage → founding tenant fallback.

### 10.2 `Auth`

```javascript
Auth.getSession()             // → session
Auth.getUser()                // → user
Auth.getProfile(userId)       // → profile (full row from user_profiles)
Auth.requireAuth(redirectTo?) // → user; redirects to login if unauthenticated
Auth.requireAdmin(redirectTo?) // → { user, profile }; redirects if non-admin
Auth.signIn(email, password)  // → { data, error }; logs login event on success
Auth.signOut()                // → void; logs logout event, clears AdminContext
```

### 10.3 `Catalog`

```javascript
Catalog.getLatestMonth()      // → 'YYYY-MM'
Catalog.fetch({ month, distributor, publisher, search, hideVariants, page, pageSize })
                              // → { items, error, total }
Catalog.getPublishers(month)  // → string[] (deduplicated, sorted)
```

`Catalog.fetch` adds a `hideVariants` option (omitted from the prior
documentation) that filters to standard covers only. The `search` field
matches `title`, `series_name`, `writer`, `publisher`, `upc`, `isbn`, and
`item_code`. `getPublishers` reads in two batches (rows 0–999 and
1000–1999) to work around Supabase's 1000-row default limit.

### 10.4 `Preorders`

```javascript
Preorders.getMyIds(userId)            // → Map<catalogId, quantity>
Preorders.getMy(userId)               // → { items, error } with embedded catalog
Preorders.reserve(userId, catalogId, quantity?)
                                       // → { data, error }; passes tenant_id explicitly
Preorders.updateQuantity(userId, catalogId, quantity)
                                       // → { error }
Preorders.cancel(userId, catalogId)   // → { error }
Preorders.setFulfilled(preorderId, fulfilled)
                                       // → { error } (admin)
Preorders.setFulfilledByCatalogId(catalogId, fulfilled)
                                       // → { error } (admin batch)
Preorders.getAll()                    // → { items, error } (admin; embeds catalog + email)
```

`getAll` uses a PostgREST embedded join `auth_users:user_id ( email )`
that relies on the by-convention UUID match between `preorders.user_id`
and `auth.users.id`. The match has no FK enforcement; if PostgREST ever
fails to infer the relationship the email column silently becomes null.
See F30.

### 10.5 `Subscriptions`

```javascript
Subscriptions.getAll(userId)                        // → { items, error }
Subscriptions.isSubscribed(userId, series, distributor)
                                                    // → boolean
Subscriptions.subscribe(userId, series, distributor, format?)
                                                    // → { data, error }; logs event
Subscriptions.unsubscribe(userId, series, distributor)
                                                    // → { error }; logs event
Subscriptions.getAllAdmin()                         // → { items, error } (admin)
```

The optional `format` arg supports format-aware auto-reserve in the
import script. Subscriptions inserted from the catalog page pass the
selected item's `format`; subscriptions inserted from the popular-series
panel (subscriptions.html) pass null (legacy behavior — the import script
falls back to `isComicFormat()` matching).

### 10.6 `Settings`

Reads/writes **`app_settings`** only. The legacy `settings` table is
**not** accessed through this API — see Section 4.6 and F4.

```javascript
Settings.get(key)             // → string | null
Settings.set(key, value)      // → { error }; passes tenant_id explicitly
Settings.isMaintenanceMode()  // → boolean
Settings.setMaintenanceMode(on)
                              // → { error }
Settings.getOrderDeadline()   // → 'YYYY-MM-DD' | null
Settings.setOrderDeadline(dateStr)
                              // → { error }
```

### 10.7 `UsageEvents`

Fire-and-forget event logging. Methods do not return promises (caller
never awaits). Skipped entirely when `AdminContext.isActive()` is true,
so admin actions and impersonated sessions don't pollute analytics data.

```javascript
UsageEvents.reserve(userId, catalogItem)
UsageEvents.cancel(userId, catalogItem)
UsageEvents.subscribe(userId, seriesName, distributor)
UsageEvents.unsubscribe(userId, seriesName, distributor)
UsageEvents.catalogView(userId, { catalogMonth, page, search, publisher, distributor })
UsageEvents.pageView(userId, page, metadata?)
UsageEvents.login(userId)
UsageEvents.logout(userId)
```

Tenant_id is resolved defensively from `TenantContext.current()` with a
fallback to `FOUNDING_TENANT.id` in case `TenantContext.resolve()`
hasn't completed (this can happen because UsageEvents fires from arbitrary
page lifecycle points). Phase 3.3 removed the `tenant_id` column default;
`FOUNDING_TENANT.id` is now the only safety net (F31 — fixed 2026-05-10).

### 10.8 `MyList`

```javascript
MyList.sendConfirmation(userId, sessionToken)
                              // → { data, error }; calls send-my-list Edge Function
```

### 10.9 `Users` (admin)

```javascript
Users.getPending()            // → { items, error }; status = 'pending'
Users.approve(userId, sessionToken)
                              // → { data, error }; calls approve-customer Edge Function
Users.suspend(userId)         // → { error }; status = 'suspended'
Users.deleteProfile(userId)   // → { error }; deletes user_profiles row only
```

### 10.10 `PaperCustomers` (admin)

```javascript
PaperCustomers.generateEmail(fullName)
                              // → 'name.timestamp@paper.pulllist.local'
PaperCustomers.create(name, sessionToken)
                              // → { data: { user_id, email }, error }; calls create-paper-customer
PaperCustomers.list()         // → { items, error }; is_paper = true
PaperCustomers.claim(paperUserId, realUserId, sessionToken)
                              // → { data, error }; calls claim-paper-customer
```

### 10.11 `Recommendations`

```javascript
Recommendations.getCatalogIds(userId, month)
                              // → { items: [{id, variant_type}], hasPersonal }
```

Returns catalog item IDs ordered for the personalized catalog view. Tier 1
is items from series the user has reserved before (union of
`reservation_history` and current preorders). Tier 2 is items from the
most-popular series via `get_popular_series()` RPC.

The `get_popular_series()` call surfaces F20 directly into the customer's
catalog page recommendations.

### 10.12 `AdminContext`

Admin impersonation state. Persisted in sessionStorage; cleared on tab
close.

```javascript
AdminContext.isActive()                 // → boolean
AdminContext.activeUserId               // → uuid | null
AdminContext.activeUserName             // → string | null
AdminContext.set(userId, userName)      // sets impersonation; renders banner
AdminContext.clear()                    // clears impersonation; removes banner
AdminContext.resolveUserId(ownUserId)   // → activeUserId || ownUserId
AdminContext.restore()                  // re-renders banner on page load
```

Impersonation is purely client-side — the admin's session token is still
used for every Supabase call. Authorization to read the impersonated
user's data depends on the admin's RLS policies (admin-view policies on
`preorders` etc.). Cross-tenant impersonation is theoretically blocked by
the tenant scoping on `user_profiles` SELECT, which constrains which
users an admin can even discover to impersonate.

### 10.13 `WelcomeModal`

```javascript
WelcomeModal.show(userId, profile)
                              // → void; shown once per user, dual-guarded by localStorage and has_seen_welcome
```

### 10.14 Helpers (top-level functions)

```javascript
toast(message, type?)         // 'success' | 'error' | 'info'
formatDate(dateStr)           // → 'Mon DD, YYYY' or '—'
isFocPast(dateStr)            // boolean — uses local date parts (correct)
isFocLocked(dateStr)          // alias of isFocPast
isFocThisMonth(dateStr)       // boolean — local date parts
formatPrice(price)
escapeHtml(str)
debounce(fn, delay)
renderSkeletons(count, container)
buildComicCard(comic, reservedQty, focLocked?)
exportToCsv(rows, filename)
checkMaintenanceMode(isAdmin)  // redirects non-admins to holding page if maintenance_mode = true
initNav()                      // nav setup; called from every page's inline script
```

### 10.15 Recurring patterns

**Supabase 416 workaround.** When `.range(from, to)` is used with a filter
that may return zero rows, Supabase returns HTTP 416. The fix is to fetch
the count first with `{ head: true }` and only fetch rows if count > 0.
Used in `Recommendations.getCatalogIds`, in `catalog.html`'s catalog
fetch, and in `Catalog.getPublishers`'s two-batch fetch.

**Local date parts for date math.** `formatDate`, `isFocPast`, and
`isFocThisMonth` all use `new Date().getFullYear()`/`getMonth()`/`getDate()`
to avoid the UTC-shift bug that occurs when `toISOString().split('T')[0]`
is used in negative-UTC-offset timezones (e.g., New Jersey).
**Counter-examples** in `app.js` `NavBubble.load` and in `mylist.html`'s
past-item filter use `toISOString()` directly — see F28.

**Tenant_id on writes.** `Preorders.reserve`, `Subscriptions.subscribe`,
`Settings.set`, and `UsageEvents._log` all pass `tenant_id` explicitly via
`TenantContext.current().id`. Phase 3.2 wired this. Page-level direct
inserts (e.g., `subscriptions.html` writing `popular_series` reads only,
`mylist.html` updating preorder quantity inline) inherit tenant from the
existing row's tenant_id.

---

## 11. Edge Functions

Eight Deno-based Edge Functions are deployed to staging. All are written
in TypeScript, all use Supabase service-role for privileged operations,
and all that send email use MailerSend with the `noreply@mrcyberrick.us`
sender.

### 11.1 Function inventory

| Function | Caller | Auth check | Tenant-aware |
|---|---|---|---|
| `notify-customers` | import script (post-import prompt) | none (admin context implied by service-role caller) | yes (filters by `FOUNDING_TENANT_ID`) |
| `send-my-list` | mylist.html | session token required (but does not match user_id — F36) | yes (catalog month filter) |
| `invite-customer` | admin.html | admin check | partial (writes new profile with FOUNDING_TENANT_ID) |
| `register-customer` | MailerLite webhook | webhook secret in URL | partial (writes new profile with FOUNDING_TENANT_ID) |
| `approve-customer` | admin.html | admin check (no tenant component) | no |
| `create-paper-customer` | admin.html | admin check | partial (writes new profile with FOUNDING_TENANT_ID) |
| `claim-paper-customer` | admin.html | admin check, plus `is_paper` source check | no |
| `reset-password` | forgot-password.html | none (anti-enumeration: always returns success) | no |

The "partial" tenant-awareness in the user-creation functions is what F34
documents: every new user is created in the founding tenant regardless of
the inviting admin's tenant. Currently moot.

### 11.2 Required secrets

Set in Supabase → Edge Functions → Secrets:

| Secret | Used by |
|---|---|
| `SUPABASE_URL` | all |
| `SUPABASE_ANON_KEY` | all |
| `SUPABASE_SERVICE_ROLE_KEY` | all |
| `MAILERSEND_API_KEY` | every function that sends email (all except claim-paper-customer) |
| `MAILERLITE_WEBHOOK_SECRET` | register-customer (URL secret check) |
| `FOUNDING_TENANT_ID` | notify-customers, send-my-list, create-paper-customer, invite-customer, register-customer |

`FOUNDING_TENANT_ID` was added during Phase 2 to enable tenant-aware
filtering and writes from the Edge Functions. The web app reads tenant
through the database; the import script hard-codes it; Edge Functions
read it from this secret.

### 11.3 Per-function notes

**`notify-customers`**: monthly catalog notification email. Reads the
deadline from `app_settings.order_deadline` (filtered by tenant) and
the recipient list from `user_profiles WHERE is_admin = false` (filtered
by tenant), excluding `@paper.pulllist.local` placeholder addresses. The
catalog link in the email body is hardcoded to **production**
(`https://mrcyberrick.us/comic-preorder/catalog.html`), not staging — this
is intentional for staging since the function is invoked by the import
script's post-import prompt and links should send recipients to the live
site.

**`send-my-list`**: per-customer pull-list confirmation email. The
session-token check at the top of the function verifies that *some*
authenticated session exists, but does not verify that the session's
user_id matches the request body's user_id. Any authenticated user can
trigger an email to any other user. F36.

**`invite-customer`**: admin-only new-account creation. Generates an
invite link via the Supabase Admin API, sends a branded email via
MailerSend, and inserts a `user_profiles` row with
`status = 'active'`, `created_by_admin = true`,
`tenant_id = FOUNDING_TENANT_ID`.

**`register-customer`**: called by MailerLite webhook when a subscriber is
added to the "Monthly Comics" group. URL parameter `secret` must match
`MAILERLITE_WEBHOOK_SECRET`. Creates an auth user (no password), inserts
a `user_profiles` row with `status = 'pending'` and
`tenant_id = FOUNDING_TENANT_ID`, and sends a "browse while we review"
email containing a magic link.

**`approve-customer`**: admin-only state change from pending to active.
Verifies the caller is admin via service-role profile lookup, updates
the target's `user_profiles.status` to `'active'`, generates a fresh
magic link, and emails it. **No tenant check** — an admin in tenant A
could approve a pending user in tenant B if they had the user_id.
Currently moot.

**`create-paper-customer`**: admin-only walk-in placeholder creation.
Creates an auth user with a random password and the placeholder email
provided by the caller (`name.timestamp@paper.pulllist.local`), inserts
a `user_profiles` row with `is_paper = true, status = 'active', tenant_id = FOUNDING_TENANT_ID`.

**`claim-paper-customer`**: merges a paper account into a real account.
Verifies the source is `is_paper = true` for safety. Re-points
`preorders.user_id` and `subscriptions.user_id` from paper to real
(409 conflicts on duplicate preorders are tolerated and the duplicates
fall away with the paper profile delete). Deletes the paper
`user_profiles` row, then deletes the paper `auth.users` row via the
Admin API. Reimplements the same logic as the unused
`claim_paper_account` SQL function (F33).

**`reset-password`**: generates a Supabase recovery token and emails a
branded reset link. Always returns success regardless of whether the
email address exists, to prevent account-existence enumeration.

The `STAGING_BASE` constant in `reset-password` is set to
`'https://mrcyberrick.us/comic-preorder-staging'` — **this is wrong**.
Staging is hosted at `mrcyberrick.github.io/comic-preorder-staging`. The
reset link sent to customers in staging would 404. F35.

---

## 12. Import script

`import-staging.js` is run from a local scripts folder
(`C:\Users\richa\OneDrive\Documents\(Work)\BookStop\catalogs\scripts\`)
and is never committed to the repo. It uses the Supabase service-role
key to bypass RLS for catalog and shipment writes.

### 12.1 Invocation

```powershell
node .\import-staging.js <lunar_catalog> <prh_catalog> [<lunar_shipment>] [<prh_shipment>]
```

Example with catalog only:
```powershell
node .\import-staging.js "..\Lunar_Product_Data_0426.csv" "..\2026_04_PRH_metadata_full_active.csv"
```

Example with catalog plus shipment:
```powershell
node .\import-staging.js "..\Lunar_Product_Data_0426.csv" "..\2026_04_PRH_metadata_full_active.csv" "..\delivery-detail-LUNAR.csv" "..\Shipment_PRH.csv"
```

If shipment paths aren't passed, the script prompts interactively. Answer
"n" at the prompt to skip shipment import (e.g. at the start of a month
before invoices arrive).

### 12.2 Tenant configuration

Top of file:

```javascript
const TENANT_ID = '72e29f67-39f7-42bc-a4d5-d6f992f9d790';
```

Hard-coded. Every catalog upsert, shipment row, and auto-reserve carries
this tenant_id explicitly. Every RPC call passes `p_tenant_id: TENANT_ID`
as the first argument.

### 12.3 New-month detection

The script reads the latest `catalog_month` from the database. If the
about-to-import month is greater than the latest, it triggers the full
new-month sequence:

1. `archive_stale_reservations(p_tenant_id, today, current_month)` — copies
   distinct (user, series, distributor, month) tuples from preorders +
   catalog into reservation_history before the catalog purge wipes them.
2. `purge_stale_catalog(p_tenant_id, today, current_month)` — removes
   past-month catalog rows whose on_sale_date < today and which are not
   referenced by any preorder in this tenant.
3. Catalog upsert (described below).
4. `delete_dropped_catalog_items(p_tenant_id, current_month, item_codes)` —
   removes items from this month that disappeared from the new
   distributor catalog.

If the import month equals the latest, only step 3 runs ("mid-month
refresh"). This makes the script safe to re-run during the same month.

### 12.4 Catalog upsert

```
on_conflict=tenant_id,item_code,distributor,catalog_month
Prefer: resolution=merge-duplicates,return=minimal
Batch size: 100
```

Conflict key matches the table's unique constraint exactly. `tenant_id` is
the leading column. UUIDs are preserved across re-runs — critical because
preorders reference catalog rows by UUID.

### 12.5 Auto-reserve subscriptions

After catalog upsert, the script:

1. Fetches every subscription (across the whole tenant) with `user_id`,
   `series_name`, `distributor`, `format`.
2. Fetches the catalog month's standard-cover items (NULL or 'Standard'
   or 'Primary Title' variant_type), in two batches to clear the
   1000-row limit.
3. Fetches existing preorders for those catalog IDs, in 100-id chunks,
   to skip duplicates.
4. Format-aware match: if `subscriptions.format` is set, requires exact
   format match against `catalog.format`; otherwise falls back to
   `isComicFormat()` (true unless format contains "trade paperback",
   "hardcover", "omnibus", "graphic novel", "digest", "box set", or
   "album").
5. Batch-inserts the matched, not-yet-reserved preorder rows (each
   carrying `tenant_id: TENANT_ID`).

### 12.6 Optional shipment import

If shipment paths are provided (or accepted at the prompt), the script
auto-detects each file's format from the first line:

- **Format A** — first line starts with "Delivery Number". 9-line
  metadata header, column header on line 10, data from line 11. Key
  columns: ISBN (used as UPC), Title, On Sale, Quantity. Cover URL built
  from `https://images.penguinrandomhouse.com/cover/d/{ISBN}`. Tagged
  `distributor = 'Lunar'`.

- **Format B** — first line is a numeric shipment number. 4-line
  metadata header, column header on line 5, data from line 6. Key
  columns: Code, Title, Qty, Retail, UPC, In-Store Date. Cover URL built
  from `https://media.lunardistribution.com/images/covers/large/{Code}.jpg`.
  Rows with Retail = 0.00 are filtered as promos. Tagged
  `distributor = 'PRH'`.

The two distributor labels are flipped from the *invoice source*: PRH
delivery invoices arrive as Format A and get tagged `'Lunar'` because
they ship via Lunar; Lunar's code-formatted shipment of PRH titles
arrives as Format B and is tagged `'PRH'` because the items are PRH's.
This is confusing but matches how the catalog rows are tagged.

### 12.7 Shipment upsert

Two paths because the conflict keys differ:

- **Lunar rows** (`upc` populated): upsert via
  `on_conflict=distributor,upc,on_sale_date`, batched. Rows with the same
  (upc, on_sale_date) within a batch are pre-summed in the script
  (Format A delivery invoices sometimes split a single ISBN across
  multiple lines).
- **PRH rows** (`item_code` populated, `upc` may be NULL): delete-then-
  insert per on_sale_date. PostgREST's `on_conflict` doesn't support
  partial indexes, and a full unique constraint on `item_code` would
  conflict with Lunar rows that have `item_code = NULL`. Delete-then-
  insert is safe here because PRH Format B shipments are small and
  always fresh.

The script emits warnings for shipment rows that don't match a catalog
row — matching is performed via `weekly_shipment.upc → catalog.upc/isbn`
for Lunar rows, and `weekly_shipment.item_code → catalog.item_code`
(WHERE distributor='PRH') for PRH rows.

### 12.8 Notification prompt

After all imports complete the script prompts to send the catalog
notification email via the `notify-customers` Edge Function. Answer "y"
to send to every active customer in the founding tenant; "n" to skip.

### 12.9 Re-run safety

- Catalog upsert: in-place via merge-duplicates.
- Shipment upsert: in-place via merge-duplicates (Lunar) or
  delete-then-insert (PRH). Both safe to re-run for the same week.
- Auto-reserve: fetches existing preorders and skips duplicates.
- New-month sequence: only fires when the import month is greater than
  the latest in the database. Mid-month re-runs skip the
  archive/purge/delete-dropped steps.

The one caveat is the maintenance-mode flag. `app.js`'s
`Settings.isMaintenanceMode()` reads from `app_settings`; the script
does not flip the flag automatically. The convention is to flip
maintenance ON manually before a new-month import (admin → Settings),
and flip it OFF after the import completes successfully. The script's
final log line reminds the operator to do this when a new-month sequence
ran.

---

## 13. Findings & known issues

The discovery pass that produced this document surfaced 27 findings; 8 additional findings (F45–F52) were surfaced during the Phase 4.1 pre-cutover audit pass.
They are listed below in priority order: HIGH first, then medium, then
low/trivial/info. Each entry: severity, status, description, where it
manifests, recommended fix one-liner.

**Pre-Phase-4 audit pass indicated.** Five findings (F4, F15, F16, F20,
F34) are HIGH or dormant-HIGH. Four of the five are dormant only because
staging has a single tenant; they activate when a second tenant onboards.
The fifth (F4) is an active correctness issue today. **These five should
be addressed before Phase 4** (production multi-tenancy migration), as
Phase 4 will replicate the same dormant bugs into production.

The remaining findings are real but lower-priority. A handful are
dead-code observations (F19, F26, F33) that describe schema objects with
no caller — candidates for cleanup in a future pass. One is an active
production-staging URL bug unrelated to multi-tenancy (F35).

### HIGH

#### F4 — both `settings` and `app_settings` are actively used
- **Status:** fixed 2026-05-10 — (a) `popular_series` migrated to
  `app_settings` (same key, same JSON, founding-tenant scoped);
  (b) `subscriptions.html` updated to read via `Settings.get()`
  instead of direct `db.from('settings')` query; (c) orphan
  `settings.maintenance_mode` row deleted; (d) `settings.popular_series`
  deleted after staging smoke test confirmed the panel still renders.
  `settings` table is now empty. Table itself not yet dropped —
  separate dead-code cleanup pass.
  **Prod resolution 2026-05-31 (Phase 4.6):** app-code merge (§ 4) routes reads to `app_settings`; `settings` rows `popular_series` and `maintenance_mode` deleted (§ 8 data drop); `settings` table on production is now empty. F4 fully resolved on both environments.
- The legacy `settings` table holds `popular_series` (read by
  subscriptions.html) and `maintenance_mode` (orphan duplicate of the
  `app_settings.maintenance_mode` row). The modern `app_settings` table
  holds `maintenance_mode` (canonical, written by `Settings` API) and
  `order_deadline`.
- **Where:** subscriptions.html line ~297; `app.js` `Settings` API.
- **Fix:** migrate `popular_series` from `settings` to `app_settings`
  (with a column or key change to disambiguate from
  `get_popular_series()` if desired); update subscriptions.html to read
  through the `Settings` API; drop the orphan `settings.maintenance_mode`
  row; eventually drop the `settings` table after confirming no other
  callers exist.

#### F15 — `weekly_shipment` SELECT policy has no tenant scoping
- **Status:** fixed 2026-05-10 — `qual = true` replaced with
  `tenant_id = current_tenant_id()`; verified via probe row in
  synthetic tenant returning 0 rows to founding-tenant session.
- The only SELECT policy is `qual = true` for the `authenticated` role.
  Verified by direct policy inspection.
- **Where:** RLS policy `authenticated users read weekly_shipment`;
  surfaced in production code via arrivals.html's
  `db.from('weekly_shipment').select(...)` query.
- **Fix:** replace `qual = true` with
  `qual = (tenant_id = current_tenant_id())`.

#### F16 — `preorders` admin write policies OR-permit cross-tenant writes
- **Status:** fixed 2026-05-10 — dropped `admins write tenant preorders`
  and `admins view tenant preorders`; `admins manage tenant preorders`
  (ALL, checks row's tenant_id on both qual and with_check) is the sole
  surviving admin policy. Verified: admin INSERT into synthetic-tenant
  preorders fails with RLS violation.
- Three admin policies on `preorders` exist; PostgreSQL ORs PERMISSIVE
  policies together. The `admins write tenant preorders` policy only
  checks the admin's own tenant via the `user_profiles` join; it does
  not require the row's `tenant_id` to match.
- **Where:** RLS policies on `preorders`.
- **Fix:** consolidate the three admin policies into one that checks
  both `tenant_id = current_tenant_id()` on the row and
  `current_user_is_admin()`; drop the redundant `admins view tenant
  preorders` (covered by the consolidated ALL policy).

#### F20 — `get_popular_series()` returns counts across all tenants
- **Status:** fixed 2026-05-10 — added `AND c.tenant_id =
  current_tenant_id()` to the WHERE clause; SECURITY DEFINER kept.
  Verified: probe series inserted under synthetic tenant absent from
  results when queried as founding-tenant user.
- SECURITY DEFINER function with no `tenant_id` filter in the body.
  Bypasses RLS.
- **Where:** function body queries `preorders JOIN catalog`. Two
  callers: `admin.html`'s Top Series tab and `app.js`'s
  `Recommendations._getPopularSeries` (used in every customer's catalog
  recommendations).
- **Fix:** add `WHERE c.tenant_id = current_tenant_id()` to the WHERE
  clause; alternatively switch to `SECURITY INVOKER` and rely on RLS.

#### F34 — user-creation Edge Functions hard-pin to founding tenant
- **Status:** fixed 2026-05-10 — `invite-customer` and
  `create-paper-customer` now fetch `tenant_id` alongside `is_admin`
  from the caller's profile and use `callerTenantId` (falling back to
  `FOUNDING_TENANT_ID` if lookup fails) for new profile inserts.
  `register-customer` intentionally keeps `FOUNDING_TENANT_ID` (webhook,
  no admin context); header comment documents this as a known limitation
  to revisit before tenant 2 onboards.
- `create-paper-customer`, `invite-customer`, and `register-customer` all
  insert new `user_profiles` rows with
  `tenant_id = FOUNDING_TENANT_ID` from env. New customers in any future
  tenant would be assigned to the founding tenant.
- **Where:** all three Edge Functions read `FOUNDING_TENANT_ID` from
  Deno.env and use it directly in the profile insert body.
- **Fix:** resolve the inviting admin's tenant_id from their own profile
  (look up `user_profiles.tenant_id WHERE id = caller's auth.uid()`)
  and use that value instead of FOUNDING_TENANT_ID.
- **Prod resolution 2026-05-31 (Phase 4.6):** `FOUNDING_TENANT_ID` secret set on prod project (§ 1); all 8 EFs redeployed from staging SHA `cab5dca` (§ 2). F34 fully resolved on production.

### Medium

#### F6 — `app_settings` and `settings` PK on `key` alone
- **Status:** open
- Both tables use `key` as the primary key, not `(tenant_id, key)`. Means
  one tenant can hold the value `'maintenance_mode'` and a second tenant
  cannot independently hold a different value for the same key.
- **Where:** primary key constraints on both settings tables.
- **Fix:** drop and re-add the PK as `(tenant_id, key)` on both tables.
  Coordinated with the F4 cleanup.

#### F10 — `preorders` FKs to `user_profiles` and `catalog` are NO ACTION
- **Status:** open
- Differs from the prior documentation, which described both as CASCADE.
  Means deleting a `user_profiles` row fails if any preorder references
  it, and deleting a `catalog` row fails if any preorder references it.
- **Where:** FK definitions; documented as the reason
  `purge_stale_catalog()` filters `id NOT IN (SELECT catalog_id FROM
  preorders WHERE tenant_id = ...)`.
- **Fix:** intent unclear — confirm whether NO ACTION is the desired
  behavior (preserve preorders as audit trail) or whether CASCADE was
  intended; align the FKs and the prior documentation.

#### F17 — `reservation_history` admin SELECT policy is unscoped
- **Status:** fixed 2026-05-26 (Phase 4.1 C2) — both policies dropped and recreated:
  admin now uses `current_user_is_admin() AND tenant_id = current_tenant_id()`;
  user now uses `auth.uid() = user_id AND tenant_id = current_tenant_id()`.
  Also fixed the recursive EXISTS admin pattern (F46 bundled with C2).
- Both `users view own history` (safe) and `admins view all history`
  (unsafe) lack `tenant_id` filters. Admins in tenant A could SELECT
  reservation_history from tenant B.
- **Where:** RLS policies on `reservation_history`.
- **Fix:** add `AND tenant_id = current_tenant_id()` to the admin
  policy.

#### F21 — `claim_paper_account()` SQL function lacks defensive checks
- **Status:** fixed 2026-05-26 (Phase 4.1 C3) — function dropped (see F33). Dead code removal resolves both F21 and F33.
- The function does not verify `is_paper = true` before re-pointing
  rows, and would happily merge any two accounts. SECURITY INVOKER label
  is misleading because the function requires `auth.users` DELETE
  rights, restricting effective callers to service-role.
- **Where:** function body.
- **Fix:** if keeping the function, add
  `IF NOT (SELECT is_paper FROM user_profiles WHERE id = paper_user_id)
  THEN RAISE EXCEPTION 'Source is not a paper account'; END IF;` and
  switch to SECURITY DEFINER with `SET search_path = public`.
  Alternatively drop the function since `claim-paper-customer` Edge
  Function does the work.

#### F35 — `reset-password` uses wrong staging URL
- **Status:** confirmed, **active in staging right now**
- Line 1 of `reset-password/index.ts`:
  `STAGING_BASE = 'https://mrcyberrick.us/comic-preorder-staging'`. The
  actual staging URL is `mrcyberrick.github.io/comic-preorder-staging`.
  Customers who request a password reset via staging receive a 404 link.
- **Where:** `reset-password` Edge Function source.
- **Fix:** change `STAGING_BASE` to
  `'https://mrcyberrick.github.io/comic-preorder-staging'` and redeploy.

### Low

#### F7 — `reservation_history` unique key omits `tenant_id`
- **Status:** open
- `(user_id, series_name, distributor, catalog_month)` is the unique
  key. Tenant-scoping is implicit via `user_profiles.tenant_id` (one
  user belongs to one tenant), so cross-tenant collisions cannot
  actually happen — but the key is shaped inconsistently with `catalog`
  and `subscriptions`.
- **Fix:** rebuild the unique index as
  `(tenant_id, user_id, series_name, distributor, catalog_month)` for
  consistency.

#### F9 — `weekly_shipment` unique key omits `tenant_id`
- **Status:** open, dormant under one tenant
- `(distributor, upc, on_sale_date)` is the unique key. Tenant 2's
  shipment row with the same UPC and on_sale_date as tenant 1's would
  silently overwrite via the import script's upsert.
- **Fix:** rebuild as
  `(tenant_id, distributor, upc, on_sale_date)`; update the import
  script's `on_conflict` clause accordingly.

#### F13 — `reservation_history.user_id` cascades on auth user delete
- **Status:** open, intent unclear
- FK is `ON DELETE CASCADE`. If the table's purpose is to preserve
  history past user deletion, this defeats it. Could also be a mistake
  — SET NULL would preserve history while detaching from the deleted
  user.
- **Fix:** confirm intent. If preservation is desired, change to SET
  NULL.

#### F19 — `is_admin()` is a dead duplicate of `current_user_is_admin()`
- **Status:** fixed 2026-05-26 (Phase 4.1 C4) — function dropped; confirmed absent from pg_proc and confirmed no RLS policy referenced it.
- Same logical result as `current_user_is_admin()`, but lacks `STABLE`
  and lacks `SET search_path`. No RLS policy references it.
- **Fix:** drop the function.

#### F23 — several DEFINER functions lack `SET search_path` hardening
- **Status:** fixed 2026-05-26 (Phase 4.1 C5) — `purge_stale_catalog`, `delete_dropped_catalog_items`, and `get_popular_series(text)` all given `SET search_path = public` via ALTER FUNCTION. `is_admin` dropped (F19/C4). All 8 DEFINER functions now have `search_path=public` confirmed via pg_proc.
- `purge_stale_catalog`, `delete_dropped_catalog_items`,
  `get_popular_series`, and `is_admin` are all SECURITY DEFINER but lack
  `SET search_path = public`. Standard PostgreSQL DEFINER hardening
  recommendation.
- **Fix:** add `SET search_path = public` to each function definition.

#### F24 — `archive_stale_reservations` INVOKER but no INSERT policy on `reservation_history`
- **Status:** fixed 2026-05-26 (Phase 4.1 C12) — promoted to SECURITY DEFINER with `SET search_path = public` via two-step ALTER. Verified: prosecdef=true, proconfig=["search_path=public"]. See also F45.
- INVOKER security model means the function only succeeds when called
  by a role that has INSERT privilege on `reservation_history`. RLS
  policies on the table only grant SELECT; only service-role bypasses
  RLS. Effectively service-role-only by accident.
- **Fix:** if keeping INVOKER, document as service-role-only. If
  preferred, switch to SECURITY DEFINER with `SET search_path = public`.

#### F25 — `user_profiles.email` is denormalized from `auth.users.email`
- **Status:** open
- No trigger keeps it in sync. If a user changes their auth email, the
  profile email drifts. Population happens at registration time only.
- **Fix:** add a trigger on `auth.users` UPDATE that syncs to
  `user_profiles.email`, or remove the column and join to `auth.users`
  every read.

#### F28 — `toISOString()` used for date math in two places
- **Status:** All callsites closed in phase 3.8 (2026-05-14). The two
  date-math callsites (`NavBubble.load`, `mylist.html` past-item filter)
  now use `DateUtils.todayLocal()` and `DateUtils.weekRange()`. The four
  filename-label callsites (`mylist.html` export, three `admin.html`
  export handlers) also migrated to `DateUtils.todayLocal()` while in the
  area — same anti-pattern, milder symptom (UTC-labeled download
  filenames). F28 stays in the findings index as documentation of the
  anti-pattern; reviewers should flag any new `toISOString()` use in
  date-string contexts.
- `app.js` `NavBubble.load` (lines 262-263) and `mylist.html` past-item
  filter (line 696) both used `new Date().toISOString().split('T')[0]`
  for "today". Per the documented anti-pattern: in negative-UTC-offset
  timezones (New Jersey is UTC-4/-5), `toISOString()` after 8 PM local
  returns tomorrow's date. Off-by-one for late-evening users.
- **Fix:** replaced with `DateUtils.todayLocal()` and
  `DateUtils.weekRange()` (new helpers in `app.js`, phase 3.8).

#### F30 — `Preorders.getAll` join `auth_users:user_id ( email )` is fragile
- **Status:** open
- PostgREST embedded join relies on the by-convention UUID match
  between `preorders.user_id` and `auth.users.id`. There is no FK to
  enforce the relationship. Silent failure mode: email column becomes
  null without erroring.
- **Fix:** read `user_profiles.email` (which is denormalized from
  auth.users) instead, or query auth.users separately and join
  client-side as `admin.html` already does for the per-customer view.

#### F31 — stale comment in `UsageEvents._log`
- **Status:** fixed 2026-05-10 — comment rewritten to name
  `FOUNDING_TENANT.id` as the safety net and to note that Phase 3.3
  removed the column default. No behavior change.
- Lines 531-532 said "The DB column default is the final safety net" but
  Phase 3.3 removed all `tenant_id` column defaults including
  `usage_events.tenant_id`. The fallback to `FOUNDING_TENANT.id`
  (line 536) is now the actual safety net.
- **Fix:** update the comment.

#### F36 — `send-my-list` does not verify request user matches session user
- **Status:** confirmed
- The function checks that *some* session token is present, then trusts
  the `user_id` from the request body. An authenticated user can call
  this with any other user's user_id; the email goes to that other user
  (not the caller), so it's an annoyance/spam attack rather than data
  exfiltration, but it's still wrong.
- **Fix:** verify that the JWT's `sub` claim matches `user_id` in the
  body before sending.

### Trivial / info

#### F14 — redundant `idx_tenants_slug` index
- **Status:** open
- Both `tenants_slug_key` (unique) and `idx_tenants_slug` (non-unique)
  index `tenants.slug`. The non-unique one cannot serve a query better
  than the unique constraint's backing index.
- **Fix:** `DROP INDEX idx_tenants_slug;`

#### F26 — `admin_preorders` view bypasses RLS but has no caller
- **Status:** fixed 2026-05-26 (Phase 4.1 C11) — view dropped and recreated with `security_invoker = true`; same column list, JOINs, and ORDER BY preserved. Grants tightened: `authenticated` SELECT only, `service_role` SELECT only, `anon` no grants. See also F49.
- `reloptions = null` means `security_invoker = false` default; view
  runs as owner and bypasses RLS on the underlying tables. View body
  has no tenant filter. **No application code currently queries the
  view** (admin.html uses direct `preorders` queries with an embedded
  catalog join).
- **Fix:** drop the view. If reinstated later,
  `CREATE VIEW admin_preorders WITH (security_invoker = true) AS ...` is
  the safe form.

#### F27 — both `pgcrypto` and `uuid-ossp` installed
- **Status:** open
- `catalog.id` and `preorders.id` use `uuid_generate_v4()` (uuid-ossp);
  every newer table uses `gen_random_uuid()` (pgcrypto). Both produce v4
  UUIDs. uuid-ossp is essentially legacy at this point.
- **Fix:** as part of any future schema migration touching `catalog` or
  `preorders`, change the column default to `gen_random_uuid()` and
  drop `uuid-ossp` once unused.

#### F29 — Supabase 416 workaround pattern recurs
- **Status:** doc-only
- The count-first-then-fetch pattern is repeated in
  `Recommendations.getCatalogIds`, `Catalog.getPublishers`, and
  `catalog.html`'s catalog fetch. Not a bug; just noteworthy that the
  pattern recurs without being encapsulated in a helper.
- **Fix:** if a fourth instance appears, factor into a
  `fetchWithRangeFallback` helper.

#### F32 — CLAUDE.md page inventory missing two pages
- **Status:** confirmed
- CLAUDE.md lists 6 HTML pages; the deployed staging actually has at
  least 8: also `forgot-password.html` and `analytics.html`. Both are
  referenced from production code (sign-in form footer link;
  admin-gated nav link).
- **Fix:** out of scope for this document. Update CLAUDE.md's page
  inventory in a future session.

#### F33 — `claim_paper_account()` SQL function is unused
- **Status:** fixed 2026-05-26 (Phase 4.1 C3) — function dropped; confirmed absent from pg_proc. See also F21.
- The `claim-paper-customer` Edge Function reimplements the merge logic
  in TypeScript via REST. The SQL function has no caller in any code
  path read during this discovery pass.
- **Fix:** drop the function, or wire `claim-paper-customer` to call it
  via RPC for consistency.

#### F37 — Customer could DELETE fulfilled preorders via `Preorders.cancel`
- **Status:** fixed 2026-05-11 — added pre-DELETE fulfilled-check in
  `Preorders.cancel` (app.js) plus a defensive `.eq('fulfilled', false)`
  filter on the DELETE statement; `mylist.html` cancel button replaced
  with an "✓ In hand" chip on fulfilled rows.
- The original `Preorders.cancel` was an unconditional DELETE on the
  composite `(user_id, catalog_id)` key with no fulfilled-state check. A
  customer pressing Remove on a fulfilled row would destroy the audit
  trail (`fulfilled_at` timestamp). Surfaced during Phase 3.2 smoke
  testing; deferred to Phase 3.6 because the auto-fulfill rollout meant
  many more rows would carry `fulfilled = true` than before.
- **Where:** `Preorders.cancel` in `app.js`; cancel button render in
  `mylist.html`.
- **Fix:** as described in Status.

#### F38 — admin.html had labelless form inputs (DevTools a11y warning)
- **Status:** fixed 2026-05-11 — six inputs received `<label for="...">`
  associations (`deadline-input`, `admin-search`, `paper-new-name`,
  `paper-catalog-search`, `invite-name`, `invite-email`); a
  `.visually-hidden` utility class added to `style.css` for inputs whose
  visible cue was only a placeholder.
- Pre-existing accessibility gap. Cumulative DevTools warning of "No
  label associated with a form field" across the admin dashboard.
- **Where:** `admin.html`.
- **Fix:** as described in Status.

#### F39 — `arrivals` "this week" semantic mismatch (resolved in 3.8)

- **Severity:** HIGH (customer-visible)
- **Surface:** `app.js` `NavBubble.load`, `arrivals.html`, `admin.html` This Week tab
- **Discovered:** 2026-05-14 (post-3.7 soak)
- **Resolved:** Phase 3.8 — `docs/phase-3.8-pre-phase-4-hardening.md`

The three "this week" surfaces implemented three different rules:

| Surface | Pre-3.8 rule |
|---|---|
| `NavBubble.load` | 7-day rolling window (today → today + 7) |
| `arrivals.html` | Single Wednesday (`.eq` on `getThisWednesday()`) |
| `admin.html` This Week tab | Mon-Sat anchored on next Wednesday |

Customer-visible symptom: a reservation dated for next Wednesday caused the
nav badge to show "1" while `arrivals.html` showed "Nothing reserved this
week" — the badge counted next Wednesday's item as in-window; arrivals did
not. The same reservation was also out-of-window for the admin bagging tab.

Fix (phase 3.8): canonical rule is the Mon-Sun calendar week containing
today's local date. Shared `DateUtils.weekRange()` helper in `app.js`. All
three surfaces query the same `(start, end)` range. F28's callsites closed
as a side effect (no more `toISOString()` in date-math contexts).

Smoke pinned in `playwright/tests/04-arrivals-this-week.spec.ts` with
boundary-day seeds and a badge↔arrivals consistency assertion.

### Phase 4.1 findings (F45–F52)

Surfaced during the pre-cutover audit pass (2026-05-26). See `docs/phase-4.1-audit-findings.md` for full triage notes and raw SQL output.

#### F45 — `archive_stale_reservations` deployed as SECURITY INVOKER
- **Status:** fixed 2026-05-26 (Phase 4.1 C12) — promoted to SECURITY DEFINER + `SET search_path = public`. See F24.
- Inconsistent with sibling tenant-aware DEFINER functions. Likely Phase 1.3 / Phase 3.3 inline-patch oversight.
- **Where:** `archive_stale_reservations(uuid, date, text)` in pg_proc.
- **Fix:** two-step `ALTER FUNCTION ... SECURITY DEFINER; ALTER FUNCTION ... SET search_path = public`.

#### F46 — `preorders` admin policy uses recursive EXISTS subquery
- **Status:** fixed 2026-05-26 (Phase 4.1 C9) — EXISTS replaced with `current_user_is_admin()`.
- `admins manage tenant preorders` used `EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND is_admin = true)` — the documented anti-pattern from CLAUDE.md known issues (RLS recursion risk). The 2026-05-10 F16 hot-fix added `tenant_id` scoping but did not convert the EXISTS pattern.
- **Where:** RLS policy `admins manage tenant preorders` on `preorders`.
- **Fix:** replace EXISTS clause with `current_user_is_admin()`.

#### F47 — `notify-customers` Edge Function has no caller authentication check
- **Status:** fixed 2026-05-27 (Phase 4.1 C10a) — in-body auth added; platform JWT flipped OFF; callerTenantId scopes both tenant filters.
- Any HTTP request could trigger a bulk email blast to all founding-tenant customers. Severity HIGH (platform JWT was ON but in-body auth was absent; blast scoped to founding tenant regardless of caller).
- **Where:** `notify-customers/index.ts`.
- **Fix:** hoisted env vars to function scope; added `/auth/v1/user` JWT verify + admin profile check + callerTenantId resolution before any data operation. Both tenantFilter constructions now use callerTenantId.

#### F48 — `reservation_history` and `user_profiles` user SELECT policies lack tenant scope
- **Status:** fixed 2026-05-26 — `reservation_history` fixed in C2 (both policies); `user_profiles` fixed in C9 (user SELECT policy).
- `users view own history` and `users view own profile` filtered by `auth.uid()` only. Defense-in-depth gap: low practical risk under single-tenant (auth UUIDs globally unique), but inconsistent with multi-tenant hygiene.
- **Where:** RLS policies on `reservation_history` and `user_profiles`.
- **Fix:** add `AND tenant_id = current_tenant_id()` to both user-facing SELECT policies.

#### F49 — `admin_preorders` VIEW present on staging contrary to pre-multitenancy-state.md § 4
- **Status:** fixed 2026-05-26 (Phase 4.1 C11) — view rebuilt with `security_invoker = true`; grants tightened. See F26.
- Pre-multitenancy-state.md § 4 claimed staging lacked this view. View existed with default `security_invoker = false` and full grants to `anon` / `authenticated`. No tenant WHERE clause in view body.
- **Where:** `admin_preorders` VIEW; `pre-multitenancy-state.md` § 4 doc discrepancy.
- **Fix:** recreate with `security_invoker = true`; grant SELECT to `authenticated` and `service_role` only. Doc discrepancy flagged for review during 4.2 pre-flight.

#### F50 — `claim-paper-customer` PATCH operations not scoped by tenant
- **Status:** fixed 2026-05-27 (Phase 4.1 C10b) — both PATCH URLs now include `&tenant_id=eq.${callerTenantId}`.
- PATCH to `preorders` and `subscriptions` filtered by `user_id` only. Service-role key bypasses RLS. A canary-tenant admin could merge a founding-tenant paper account cross-tenant.
- **Where:** `claim-paper-customer/index.ts`.
- **Fix:** added `tenant_id` to admin profile select; extracted callerTenantId; appended `&tenant_id=eq.${callerTenantId}` to both PATCH URLs.

#### F51 — `send-my-list` catalog month query uses hardcoded `FOUNDING_TENANT_ID`
- **Status:** fixed 2026-05-27 (Phase 4.1 C10c) — catalog and preorders queries now use callerTenantId resolved from user profile.
- Catalog month and preorders queries both hard-pinned to founding tenant. Canary-tenant user would receive founding-tenant content.
- **Where:** `send-my-list/index.ts`.
- **Fix:** added `tenant_id` to profile select; callerTenantId extracted with FOUNDING_TENANT_ID fallback; both queries scoped by callerTenantId.

#### F52 — 5 of 8 Edge Functions not committed to the repo
- **Status:** resolved 2026-05-27 (Phase 4.1 Session 2) — all 5 EF sources committed to repo. All 8 EFs now tracked.
- `approve-customer`, `claim-paper-customer`, `notify-customers`, `reset-password`, and `send-my-list` existed only in Supabase staging deployment. 4.6 tagged-commit redeploy prerequisite now met.
- **Where:** repo `supabase/functions/`.
- **Fix:** committed all 5 missing EF sources in Session 2 opening commit. Deploy workflow documented: patch in repo → copy to `C:\Users\richa\supabase\functions\` → deploy from CLI project root.

#### F53 — `create-paper-customer` JWT verification ON despite having in-body auth
- **Status:** fixed 2026-05-27 (Phase 4.1 C13) — JWT verification flipped OFF via Supabase dashboard. In-body auth (lines 42–68) is the sole gate.
- Redundant platform JWT + in-body auth; JWT ON means the platform intercepts before in-body check runs, making the check unreachable for unauthenticated requests.
- **Where:** Supabase dashboard → Edge Functions → `create-paper-customer` → JWT verification toggle.
- **Fix:** dashboard toggle only; no source changes.

#### F54 — `send-my-list` authorization gap: any authenticated user can request any user's list
- **Status:** fixed 2026-05-27 (Phase 4.1, separate commit before C10c) — `/auth/v1/user` call added with caller's JWT; `callerUser.id !== user_id` returns 403.
- Auth check verified session token present but used service key to look up user_id — did not verify the caller IS that user. Any logged-in user could trigger a pull-list email to any other user's address.
- **Where:** `send-my-list/index.ts`.
- **Fix:** added `SUPABASE_ANON_KEY` env var; call `/auth/v1/user` with caller's JWT; assert `callerUser.id === user_id` before proceeding.

### Phase 4.4 findings (F55–F58)

Surfaced during the 4.4 cutover sub-deploy (2026-05-31).

#### F55 — production has 5 `analytics_*` views with no staging counterpart
- **Status:** open — blocks analytics view tenant-retrofit (parent plan line 148); carved out of 4.4. Disposition 2026-05-31: deferred to post-cutover housekeeping pass with F56/F57; not in 4.6 scope. Requires analytics.html/app.js audit to choose drop-vs-retrofit.
- Prod has `analytics_daily_events`, `analytics_top_cancelled`, `analytics_top_reserved`, `analytics_top_subscribed`, `analytics_user_activity` as plain untenanted views. Staging has none of them — only `admin_preorders`. The parent plan's "retrofit to match staging" target is undefined.
- **Where:** production database `public` schema; parent plan line 148.
- **Fix:** audit `analytics.html` / `app.js` to understand how staging serves analytics data; decide drop-vs-retrofit; add staging counterparts if warranted; then apply tenant filter to prod views. Resolution required before the Phase-level structural-diff completion criterion (parent plan line 190) can pass.

#### F56 — `claim_paper_account(uuid, uuid)` still present on production
- **Status:** open — dead code; dropped on staging 2026-05-26 (Phase 4.1 C3, F33). Post-cutover cleanup pass.
- The `claim-paper-customer` Edge Function reimplements the merge logic in TypeScript. SQL function has no caller.
- **Where:** production `public.claim_paper_account(uuid, uuid)` in pg_proc.
- **Fix:** `DROP FUNCTION public.claim_paper_account(uuid, uuid);` in a post-cutover cleanup sub-deploy (will be caught by Phase-level structural-diff completion criterion).

#### F57 — `generate_invite_link(text, text)` present on production, absent on staging
- **Status:** open — provenance unknown; no staging counterpart. Post-cutover cleanup pass.
- `SECURITY DEFINER` function; no caller found in any current code path. May predate staging multi-tenancy work.
- **Where:** production `public.generate_invite_link(text, text)` in pg_proc.
- **Fix:** audit callers; if none, `DROP FUNCTION public.generate_invite_link(text, text);` in the same post-cutover cleanup pass as F56.

#### F58 — staging RLS lacks an authenticated-key admin-write policy on `user_profiles`
- **Status:** open — intentional prod divergence retained; staging needs audit.
- `Users.suspend` (`app.js` UPDATE status) and `Users.deleteProfile` (`admin.html:1608` DELETE) are admin mutations via the **authenticated** client, not service-role. The staging `user_profiles` policy capture (2026-05-31) has only SELECT policies for admins — no admin ALL/UPDATE/DELETE. Either staging routes these through an unseen service-role Edge Function, or staging's admin suspend/delete is latently broken. Production intentionally keeps `admins manage tenant profiles` (ALL, authenticated). The Phase-level `pg_policies` parity check will flag this as a known intentional difference until staging is fixed.
- **Where:** staging RLS on `user_profiles`; `app.js` `Users.suspend` and `Users.deleteProfile`; `admin.html` line 1608.
- **Fix:** audit staging admin Users tab (suspend + delete flows) to determine actual code path; if authenticated-key, add the missing admin-write policy to staging; if service-role EF, document as the architectural intent and remove `admins manage tenant profiles` from prod to match.

### Phase 4.7 findings (F59–F62)

Surfaced during the 4.7 soak (2026-06-01 / 2026-06-02).

#### F59 — Customer reservation cohort lost during Phase-4 cutover window (recovered)
- **Status:** closed — data recovered 2026-06-01; prevention added to deployment workflow.
- **Severity:** high — store-wide data loss (330 reservations across 9 customers).
- Customer reservations created ~2026-04-29 → 2026-05-28 failed to persist to production `preorders`. Root cause: PR #49 (`staging → main` three-way merge) kept `main:app.js` at the pre-Phase-3 regressed version (43 KB) instead of the staging version (49 KB with `TenantContext`). Merge base `cab5dca` already contained staging's `app.js`; the three-way merge saw no delta on that side and silently kept the regressed copy. The deployed app did not write tenant-aware reservations (no `tenant_id`), so all INSERTs failed silently at the NOT-NULL constraint without a visible error to customers. Hotfix `554aec1` corrected `app.js` 2026-05-30; gap-period data was not carried forward.
- **Recovery (2026-06-01):** source = 2026-05-30 DBeaver per-table export (`backups/pulllist/dump-postgres-202605302059.backup`). Parsed `preorders` COPY data; filtered 330 in-window rows (2026-04-29 → 2026-05-28); re-resolved each stale `catalog_id` to current prod catalog via ItemCode (all 330 RESOLVED, 0 unresolved); re-stamped `tenant_id` to founding UUID; preserved original `created_at`. Brian Moss spot-check oracle (23 Jul/Aug rows) confirmed. App-side: Brian's My List shows 23 items; 44 upcoming arrivals correct.
- **Prevention:** post-merge app-file diff assertion + post-deploy write-smoke added to `CLAUDE.md` § Standard Deployment Workflow and `docs/phase-4.6-edge-functions-cutover.md` §4.
- **Where:** production `preorders` table; PR #49 merge; `app.js` TenantContext regression.

#### F60 — `notify-customers` rejects service-role callers from import script (resolved)
- **Status:** closed — fixed and redeployed 2026-06-02.
- **Severity:** medium — June catalog notification not sent on first post-recovery Tuesday import; admin workaround available (send from admin UI).
- **Root cause:** `notify-customers` authenticates callers by calling `/auth/v1/user` with the provided Bearer token. `import.js` uses `Authorization: Bearer <service_role_key>` for all Supabase calls (required for RLS bypass on catalog/shipment writes). A service-role JWT is not a user session token, so `/auth/v1/user` returns 401 and the function returned `{"error":"Invalid auth"}`. This was always broken for the import→EF notification path but was never exercised (4.6 first import answered `n` to notifications).
- **Fix:** Added a JWT role-claim bypass in `notify-customers/index.ts`: decode the Bearer token's payload and check `payload.role === 'service_role'`. If true, skip the user auth check and resolve `callerTenantId = FOUNDING_TENANT_ID`. The user-JWT path (admin UI calls) is unchanged. Safe because platform JWT verification is ON for this function — only Supabase-signed tokens reach the body.
- **Also fixed:** platform JWT verification for `notify-customers` was ON (inconsistent with project pattern); left ON because it makes the role-claim check safe.
- **Where:** `supabase/functions/notify-customers/index.ts` lines 26–44; `C:\Users\richa\supabase\functions\notify-customers\index.ts` (CLI deploy source).
- **Commits:** `2488c8c` (key-comparison attempt), `2e924d8` (JWT role-claim approach, the effective fix).

#### F62 — `send-my-list` F54 identity check blocks admin "books are in" email (resolved)
- **Status:** fixed 2026-06-10 (Phase 4.7 soak, separate commit).
- **Severity:** medium — admin "This Week" bagging tab send-email button returned 403 for all customers; admin workaround was none.
- **Root cause:** F54 fix added `callerUser.id !== user_id → 403`. When an admin sends the email from `admin.html`, the bearer token is the admin's session but `user_id` is the target customer's id — the check always trips.
- **Fix:** `send-my-list/index.ts` — on identity mismatch, fetch caller's `user_profiles.is_admin`; allow if `true`, otherwise retain 403. Own-list path (mylist.html) is unchanged.
- **Where:** `supabase/functions/send-my-list/index.ts` lines 48–68.

#### F61 — Brave/iOS suppresses `window.confirm()` on mylist.html Remove button (deferred → 4.8)
- **Status:** open — deferred to 4.8 post-cutover housekeeping.
- **Severity:** low — Brave/iOS users cannot cancel reservations via My List; other browsers unaffected; no data integrity impact.
- **Root cause:** Brave on iOS suppresses native `window.confirm()` dialogs in some contexts (treated as unwanted popups). The cancel-guard in `mylist.html` uses `if (!confirm("Remove this reservation?")) return;` — this silently returns `false` on Brave/iOS, blocking all removals.
- **Fix:** Replace `window.confirm()` with a custom in-page modal (matches the existing cancel-guard pattern used in the admin bagging tab). Scope: `mylist.html` only.
- **Where:** `mylist.html` — the Remove button click handler.

---

*End of document.*
