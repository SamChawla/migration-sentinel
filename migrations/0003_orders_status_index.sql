-- Speed up the "orders by status" dashboard query and start recording when an
-- order was fulfilled.
--
-- Both statements are online / metadata-only:
--   * CREATE INDEX CONCURRENTLY builds without taking a write-blocking lock.
--   * ADD COLUMN of a nullable column is metadata-only in Postgres 11+ (no table
--     rewrite).
--
-- Down migration (for reference; Sentinel generates/verifies its own):
--   ALTER TABLE public.orders DROP COLUMN fulfilled_at;
--   DROP INDEX CONCURRENTLY IF EXISTS idx_orders_status;

CREATE INDEX CONCURRENTLY idx_orders_status ON public.orders (status);
ALTER TABLE public.orders ADD COLUMN fulfilled_at timestamptz;
