-- Sample migration (GREEN gate) — a safe, reversible, non-blocking index build.
-- Sentinel dry-runs this on a shadow clone, proves the rollback, and opens the
-- gate as GREEN — the "approve & apply" beat.
--
-- Down migration (for reference; Sentinel generates/verifies its own):
--   DROP INDEX CONCURRENTLY IF EXISTS idx_orders_amount_cents;
CREATE INDEX CONCURRENTLY idx_orders_amount_cents ON public.orders (amount_cents);
