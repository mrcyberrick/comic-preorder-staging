-- Phase 3.5 — per-tenant retention purge for usage_events.
-- Hard-deletes rows older than p_retention_days for the given tenant.
-- Returns the count of deleted rows.
-- Called by import-staging.js at the end of each weekly run.
--
-- SECURITY DEFINER is required: usage_events has no DELETE RLS policy
-- (the table is append-only by design). A named DEFINER function is
-- the controlled, auditable DELETE path, matching the pattern used by
-- purge_stale_catalog and archive_stale_reservations.

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
-- Supabase auto-grants EXECUTE to anon and authenticated on function creation;
-- revoke them explicitly so only the service-role import path can call this.
REVOKE EXECUTE ON FUNCTION public.purge_old_usage_events(uuid, integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.purge_old_usage_events(uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.purge_old_usage_events(uuid, integer) TO service_role;
