-- Phase 3.6 — automatic fulfillment for items whose on-sale date has passed.
-- Idempotent: only touches rows that are still unfulfilled.
-- Called by import-staging.js at the end of each weekly run.
--
-- The manual fulfill path via Preorders.setFulfilledByCatalogId() remains
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
