-- Phase 3 (live turn progress): a per-shop status string the server updates as
-- it works through a chat turn ("Thinking…", "Searching products…", …) and the
-- chat UI polls to show step-by-step progress. Null when no turn is running.
--
-- The cofounder snake_case UUID tables are managed directly in Supabase (RLS +
-- not part of Prisma Migrate). Apply this in the Supabase SQL editor once;
-- `prisma generate` alone does not add the column. The app degrades gracefully
-- until then: the status writes are best-effort and the poll route returns null
-- on error, so chat keeps working — it just won't show the live step yet.

alter table public.shops
  add column if not exists current_step text;
