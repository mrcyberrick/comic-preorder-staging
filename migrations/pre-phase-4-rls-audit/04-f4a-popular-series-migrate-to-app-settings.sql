-- F4 step (a): migrate popular_series from legacy settings table to app_settings
--
-- Copies the value and tenant_id from settings.popular_series into app_settings.
-- Idempotent: ON CONFLICT DO UPDATE means safe to re-run.
--
-- IMPORTANT: Do NOT run step (d) (delete from settings) until subscriptions.html
-- has been updated and deployed to staging and verified working.

INSERT INTO app_settings (key, value, tenant_id, updated_at)
SELECT
  'popular_series',
  value,
  tenant_id,
  now()
FROM settings
WHERE key = 'popular_series'
ON CONFLICT (key) DO UPDATE
  SET value      = EXCLUDED.value,
      tenant_id  = EXCLUDED.tenant_id,
      updated_at = now();

-- Verify: should return 1 row with the migrated JSON
SELECT key, tenant_id, left(value, 60) AS value_preview FROM app_settings WHERE key = 'popular_series';
