-- The passphrase sync (sync_get / sync_put) predates account sync and nothing
-- calls it any more. Both functions were SECURITY DEFINER and executable
-- without signing in, and sync_put had no size or count limit: anyone could
-- write unlimited blobs into this database. Dropping them closes that.
--
-- The `sync` table itself is left in place. It has RLS on and no policies, so
-- once these functions are gone only the service role can reach it; deleting
-- the old backups it holds is a separate, deliberate decision.
drop function if exists public.sync_put(text, text);
drop function if exists public.sync_get(text);
revoke all on table public.sync from anon, authenticated;
