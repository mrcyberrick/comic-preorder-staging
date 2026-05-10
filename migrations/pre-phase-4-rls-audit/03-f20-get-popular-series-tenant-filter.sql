-- F20: get_popular_series() — add tenant filter to SECURITY DEFINER function body
--
-- The function is SECURITY DEFINER, so it bypasses RLS on preorders and catalog.
-- Without a tenant_id filter its WHERE clause only narrows by catalog_month,
-- returning reservation counts from all tenants combined.
--
-- Fix: add AND c.tenant_id = current_tenant_id() to the WHERE clause.
-- current_tenant_id() reads user_profiles.tenant_id for the calling auth.uid(),
-- so authenticated calls are automatically scoped to the caller's tenant.
--
-- SECURITY DEFINER is kept intentionally: anon-key web app clients call this
-- function for aggregate data in the Tier 2 recommendations panel.
--
-- Note: F23 (SET search_path hardening) is a separate finding and is not touched here.

CREATE OR REPLACE FUNCTION public.get_popular_series(p_catalog_month text)
  RETURNS TABLE(series_name text, distributor text, reservation_count bigint)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
AS $function$
  SELECT
    c.series_name,
    c.distributor,
    COUNT(*)::bigint AS reservation_count
  FROM preorders p
  JOIN catalog c ON c.id = p.catalog_id
  WHERE c.catalog_month = p_catalog_month
    AND c.series_name IS NOT NULL
    AND c.tenant_id = current_tenant_id()
  GROUP BY c.series_name, c.distributor
  ORDER BY reservation_count DESC;
$function$;
