# Phase 3 — Tenant Resolution from URL/Subdomain

**Status:** Planning
**Branch:** `feature/phase-3-tenant-resolution`
**Out of scope:** Phase 4 (self-service tenant signup), billing,
per-tenant branding rendering

---

## Goal

Make the app know which tenant it's serving without relying on the
authenticated user's profile to figure it out. Today, every read works
because RLS calls `current_tenant_id()` which reads `user_profiles`.
That's fine for one tenant. With two tenants:

- An unauthenticated visitor on the catalog page has no tenant context
- Branded subdomain routing (`raysandjudys.pulllist.app`) needs to
  resolve to a tenant before login
- Edge Functions called from the app need to know which tenant to scope to

---

## What This Phase Does

1. Resolves a tenant from the request URL (subdomain or path)
2. Updates `app.js` to fetch and cache the resolved tenant on page load
3. Updates Edge Function callers in `app.js` to pass `tenant_id` in request bodies
4. Updates `app.js` writes to pass `tenant_id` explicitly (no longer relying on column defaults)
5. Removes column defaults once explicit writes are confirmed working

## What This Phase Does NOT Do

- Self-service tenant signup (Phase 4)
- Per-tenant branding (logo, color, store name) rendering — column exists, not yet read
- Analytics view rebuild — separate small phase
- Production migration — Phase 5

---

## Sub-Deploys (Planned)