-- Two SECURITY DEFINER functions act across all members and were executable by
-- any signed-in member through the API. Limit them to server callers.
-- The opportunity trigger keeps working: trigger functions are not subject to
-- an EXECUTE check when they fire, and trg_match_new_opportunity() runs as its
-- owner, which keeps EXECUTE on match_opportunity_to_users().
-- Scope: staging. Rollback: supabase/rollback/20261110230100_...down.sql
begin;
revoke all on function public.generate_pipeline_reminders()        from public, anon, authenticated;
revoke all on function public.match_opportunity_to_users(bigint)   from public, anon, authenticated;
revoke all on function public.trg_match_new_opportunity()          from public, anon, authenticated;
grant execute on function public.generate_pipeline_reminders()      to service_role;
grant execute on function public.match_opportunity_to_users(bigint) to service_role;
commit;
