-- F4 step (c): delete orphan maintenance_mode row from the legacy settings table
--
-- settings.maintenance_mode is not read by any code path. The canonical
-- maintenance_mode lives in app_settings, written and read by the Settings API.
-- This row is a duplicate with no reader — safe to delete unconditionally.

DELETE FROM settings WHERE key = 'maintenance_mode';

-- Verify: should return 1 row (popular_series only)
SELECT key FROM settings;
