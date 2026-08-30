-- Drop the retired `legacy_notes` column from users.
--
-- The SCHEMA is restorable (you can re-add the column), but the DATA is not —
-- re-adding an empty column cannot bring back what was dropped. So the rollback
-- proof fails honestly and Sentinel marks this irreversible.
--
-- Because the loss is SCOPED to one named column (not a whole-dataset wipe), the
-- gate opens as `typed_confirm`: a human must type the exact table name to
-- assume responsibility before it applies. It is NOT blocked — a knowing human
-- can proceed.

ALTER TABLE public.users DROP COLUMN legacy_notes;
