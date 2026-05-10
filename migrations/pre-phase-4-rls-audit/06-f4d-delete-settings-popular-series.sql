-- F4 step (d): delete popular_series from the legacy settings table
--
-- !! HOLD: DO NOT RUN until subscriptions.html has been updated to read
-- !! popular_series via Settings.get() (from app_settings) AND that change
-- !! has been deployed to staging and verified working in the browser.
--
-- Running this before the subscriptions.html update is live will break
-- the "Popular at Book Stop" panel for users with no subscriptions.

DELETE FROM settings WHERE key = 'popular_series';

-- Verify: should return 0 rows (settings table now empty or contains other keys only)
SELECT count(*) FROM settings;
