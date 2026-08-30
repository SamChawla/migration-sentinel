-- Add an index on users(full_name) to support name search.
--
-- Correct and reversible — but written WITHOUT `CONCURRENTLY`, so it takes a
-- ShareLock that blocks writes to `users` for the whole build. On a 50k-row
-- table that's a noticeable write stall in prod.
--
-- Sentinel classifies this AMBER: reversible, rollback proven, but locking.
-- The gate opens as `approval` — a human signs off, no typed confirmation.
--
-- Down migration (for reference):
--   DROP INDEX IF EXISTS idx_users_full_name;

CREATE INDEX idx_users_full_name ON public.users (full_name);
