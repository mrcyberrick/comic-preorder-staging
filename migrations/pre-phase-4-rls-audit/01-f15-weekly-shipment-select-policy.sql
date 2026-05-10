-- F15: weekly_shipment SELECT policy — replace qual = true with tenant-scoped qual
-- Finding: the only SELECT policy on weekly_shipment uses qual = true, so any
-- authenticated user reads every row regardless of tenant_id.
-- Fix: replace the policy with one that filters by current_tenant_id().

DROP POLICY IF EXISTS "authenticated users read weekly_shipment" ON weekly_shipment;

CREATE POLICY "authenticated users read weekly_shipment"
  ON weekly_shipment
  FOR SELECT
  TO authenticated
  USING (tenant_id = current_tenant_id());
