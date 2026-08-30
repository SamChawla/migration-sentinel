-- Sample migration (RED gate) — an irreversible DROP COLUMN. A normal tool would
-- just run it; Sentinel flags it RED, marks the rollback UNRECOVERABLE, and
-- physically refuses to proceed until a human types the confirmation token.
-- This is the hero beat of the demo.
--
-- There is NO clean rollback: re-adding the column cannot restore the dropped
-- data. Sentinel surfaces exactly that.
ALTER TABLE public.users DROP COLUMN legacy_notes;
