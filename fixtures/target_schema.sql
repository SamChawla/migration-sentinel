-- Migration Sentinel — demo TARGET database ("prod")
-- This is the database our agent migrates. The seed script loads this.
-- Volume is intentionally non-trivial so blast-radius (full-table rewrite,
-- rows-affected) is visibly meaningful in the demo.

DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;

-- ── users ──────────────────────────────────────────────────────────────
CREATE TABLE public.users (
  id           bigserial PRIMARY KEY,
  email        text NOT NULL UNIQUE,
  full_name    text,
  is_active    boolean NOT NULL DEFAULT true,
  legacy_notes text,                       -- the column our "drop" fixture removes
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ── orders ─────────────────────────────────────────────────────────────
CREATE TABLE public.orders (
  id           bigserial PRIMARY KEY,
  user_id      bigint NOT NULL REFERENCES public.users(id),
  amount_cents integer NOT NULL,
  status       text NOT NULL DEFAULT 'pending',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_user_id_idx ON public.orders (user_id);

-- ── seed data ──────────────────────────────────────────────────────────
-- 50k users
INSERT INTO public.users (email, full_name, is_active, legacy_notes)
SELECT
  'user' || g || '@example.com',
  'User ' || g,
  (g % 7 <> 0),                            -- ~14% inactive
  CASE WHEN g % 3 = 0 THEN 'legacy import note ' || g ELSE NULL END
FROM generate_series(1, 50000) AS g;

-- ~150k orders (0–5 per user), only for active users to keep it realistic
INSERT INTO public.orders (user_id, amount_cents, status)
SELECT
  u.id,
  (100 + (random() * 50000)::int),
  (ARRAY['pending','paid','shipped','refunded'])[1 + (random() * 3)::int]
FROM public.users u
CROSS JOIN generate_series(1, 3) AS n
WHERE u.is_active AND random() < 0.9;

ANALYZE public.users;
ANALYZE public.orders;
