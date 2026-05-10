-- F16: preorders admin policies — drop the redundant pair that OR-permits cross-tenant writes
--
-- Three admin policies coexist on preorders; PostgreSQL ORs PERMISSIVE policies.
--
-- "admins write tenant preorders" (ALL):
--   qual = EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid()
--                  AND is_admin = true AND tenant_id = current_tenant_id())
--   The tenant check is on the ADMIN's profile row, NOT on the row being written.
--   Because it is OR'd with "admins manage tenant preorders", an admin can write a
--   preorder with any tenant_id as long as their own profile is in the right tenant.
--
-- "admins view tenant preorders" (SELECT): redundant — covered by the ALL policy below.
--
-- "admins manage tenant preorders" (ALL):
--   qual     = tenant_id = current_tenant_id() AND EXISTS (...is_admin)
--   with_check = same
--   Both qual and with_check check the ROW's tenant_id. Correctly scoped. KEEP THIS.
--
-- Drop both in a single transaction so the table is never left without an admin policy.

BEGIN;

DROP POLICY "admins write tenant preorders" ON preorders;
DROP POLICY "admins view tenant preorders"  ON preorders;

COMMIT;
