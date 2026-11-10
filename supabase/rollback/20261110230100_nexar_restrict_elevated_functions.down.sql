-- Restores the grants recorded on staging before the change (10 Nov 2026).
begin;
grant execute on function public.generate_pipeline_reminders()      to authenticated;
grant execute on function public.match_opportunity_to_users(bigint) to authenticated;
grant execute on function public.trg_match_new_opportunity()        to public, anon, authenticated;
commit;
