# Phase 4.1 — Canary Tenant Procedure (Spin-Up + Teardown Template)

**Purpose:** Template for spinning up and tearing down a synthetic canary tenant on staging.
First used in Phase 4.1 soak (2026-05-27 to 2026-05-29). Reused in Phase 4.7.

The instantiated UUIDs for each run are stored in a **gitignored scratch file** at:
`C:\Users\richa\OneDrive\Documents\(Work)\BookStop\catalogs\scripts\phase-4.1-canary-uuids.txt`

Regenerate this file from scratch for each new canary run (new UUIDs every time).

---

## Spin-Up

### Step 1 — Generate UUIDs (PowerShell)

```powershell
$canaryTenantId = [guid]::NewGuid().ToString()
$canaryAdminId  = [guid]::NewGuid().ToString()

$uuidFile = "C:\Users\richa\OneDrive\Documents\(Work)\BookStop\catalogs\scripts\phase-4.1-canary-uuids.txt"
@"
# Canary tenant UUIDs — local only, never commit
# Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm')
CANARY_TENANT_ID=$canaryTenantId
CANARY_ADMIN_ID=$canaryAdminId
"@ | Out-File -FilePath $uuidFile -Encoding ASCII
```

### Step 2 — Insert canary tenant (SQL Editor, staging)

```sql
INSERT INTO tenants (id, slug, display_name, plan, branding)
VALUES ('<CANARY_TENANT_ID>'::uuid, 'canary', 'Canary Bookshop', 'free', '{}'::jsonb);
SELECT id, slug FROM tenants WHERE slug = 'canary';
```

### Step 3 — Create canary admin via GoTrue admin API

**Important:** Do NOT use direct SQL INSERT into auth.users — modern GoTrue requires
columns that a manual INSERT omits, causing "Database error loading user" on sign-in.
Use the admin API instead (requires service role key from `.env`):

```powershell
$svcKey = '<from .env>'
$canaryAdminId = '<CANARY_ADMIN_ID>'
$tmpBody = "$env:TEMP\canary-create.json"
[System.IO.File]::WriteAllText($tmpBody,
  "{`"id`":`"$canaryAdminId`",`"email`":`"canary-admin@example.invalid`",`"password`":`"TempCanaryPass123!`",`"email_confirm`":true}")
curl.exe -s -X POST "https://puoaiyezsreowpwxzxhj.supabase.co/auth/v1/admin/users" `
  -H "Content-Type: application/json" `
  -H "apikey: $svcKey" -H "Authorization: Bearer $svcKey" `
  --data-binary "@$tmpBody"
```

Then insert the user_profiles row (SQL Editor):

```sql
INSERT INTO user_profiles (id, full_name, is_admin, tenant_id)
VALUES ('<CANARY_ADMIN_ID>'::uuid, 'Canary Admin', true, '<CANARY_TENANT_ID>'::uuid);
SELECT id, full_name, is_admin, tenant_id FROM user_profiles WHERE id = '<CANARY_ADMIN_ID>'::uuid;
```

### Step 4 — Sign in as canary admin (PowerShell)

```powershell
$anonKey = '<from config.js>'
$tmpBody = "$env:TEMP\canary-signin.json"
[System.IO.File]::WriteAllText($tmpBody, '{"email":"canary-admin@example.invalid","password":"TempCanaryPass123!"}')
$resp = curl.exe -s -X POST "https://puoaiyezsreowpwxzxhj.supabase.co/auth/v1/token?grant_type=password" `
  -H "Content-Type: application/json" -H "apikey: $anonKey" --data-binary "@$tmpBody"
$token = ($resp | ConvertFrom-Json).access_token
Add-Content -Path $uuidFile -Value "CANARY_ADMIN_SESSION_TOKEN=$token"
```

### Step 5 — Create canary customers via Edge Function

```powershell
# Read token from scratch file for each run (session variables don't persist)
$token = (Get-Content $uuidFile | Where-Object { $_ -match '^CANARY_ADMIN_SESSION_TOKEN=' }) `
  -replace '^CANARY_ADMIN_SESSION_TOKEN=',''
$anonKey = '<from config.js>'

foreach ($n in 1,2) {
  $tmpBody = "$env:TEMP\canary-cust$n.json"
  [System.IO.File]::WriteAllText($tmpBody,
    "{`"name`":`"Canary Customer $n`",`"email`":`"canary-cust-$n@paper.pulllist.local`"}")
  $resp = curl.exe -s -X POST "https://puoaiyezsreowpwxzxhj.supabase.co/functions/v1/create-paper-customer" `
    -H "Content-Type: application/json" `
    -H "Authorization: Bearer $token" -H "apikey: $anonKey" `
    --data-binary "@$tmpBody"
  Write-Host "Customer $n`: $resp"
}
```

Save the returned `user_id` values to the scratch file.

### Step 6 — Verify tenant tagging (SQL Editor)

```sql
SELECT id, full_name, tenant_id, is_admin, is_paper
FROM user_profiles WHERE tenant_id = '<CANARY_TENANT_ID>'::uuid ORDER BY is_admin DESC;
-- Expected: 3 rows (1 admin, 2 paper customers), all tenant_id = canary
```

---

## Teardown

Run in this order in the SQL Editor. Verify each count before proceeding.

```sql
-- 1. Canary-tagged table data (no preorders/subscriptions/etc. unless catalog was imported)
DELETE FROM usage_events       WHERE tenant_id = '<CANARY_TENANT_ID>'::uuid;
DELETE FROM reservation_history WHERE tenant_id = '<CANARY_TENANT_ID>'::uuid;
DELETE FROM preorders           WHERE tenant_id = '<CANARY_TENANT_ID>'::uuid;
DELETE FROM subscriptions       WHERE tenant_id = '<CANARY_TENANT_ID>'::uuid;
DELETE FROM weekly_shipment     WHERE tenant_id = '<CANARY_TENANT_ID>'::uuid;
DELETE FROM catalog             WHERE tenant_id = '<CANARY_TENANT_ID>'::uuid;
DELETE FROM app_settings        WHERE tenant_id = '<CANARY_TENANT_ID>'::uuid;

-- 2. Auth users (also deletes user_profiles via cascade if FK is set; otherwise delete profiles first)
DELETE FROM user_profiles WHERE tenant_id = '<CANARY_TENANT_ID>'::uuid;
DELETE FROM auth.users WHERE id IN (
  '<CANARY_ADMIN_ID>'::uuid,
  '<CANARY_CUST_1_ACTUAL_ID>'::uuid,
  '<CANARY_CUST_2_ACTUAL_ID>'::uuid
);

-- 3. Tenant row
DELETE FROM tenants WHERE id = '<CANARY_TENANT_ID>'::uuid;

-- 4. Verify
SELECT tenant_id, COUNT(*) FROM user_profiles GROUP BY tenant_id ORDER BY count DESC;
SELECT COUNT(*) AS canary_tenant_rows FROM tenants WHERE id = '<CANARY_TENANT_ID>'::uuid;
-- Expected: founding tenant only; canary_tenant_rows = 0
```

---

## Notes

- Session token expires after 1 hour. Re-sign-in if needed for multi-day operations.
- Scratch file path is outside the repo and gitignored by location — never commit it.
- `example.invalid` is an RFC 2606 reserved TLD; the admin email address is unreachable by design.
- Paper customer emails use `@paper.pulllist.local` so they are excluded from `notify-customers` recipient lists (the paper-filter check strips them).
- If GoTrue `POST /auth/v1/admin/users` returns an error with the same UUID on re-spin, the UUID may still exist from a previous teardown. Check `auth.users` and delete the stale row first.
