-- Intended: purge only refunded orders.
--   DELETE FROM public.orders WHERE status = 'refunded';
--
-- Actual: the WHERE clause was lost in a rebase. As written this deletes EVERY
-- row in `orders` — a whole-dataset destruction with no recovery path. A normal
-- migration tool would run it without blinking; a human reviewer skimming the
-- diff might miss the missing predicate.
--
-- Sentinel refuses. This is `blocked`: even human approval cannot push it
-- through. The remedy is a bounded, reversible replacement (add the WHERE, or
-- soft-delete). This is the whole point of the gate.

DELETE FROM public.orders;
