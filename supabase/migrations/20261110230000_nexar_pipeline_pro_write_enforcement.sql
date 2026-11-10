-- NEXAR Pipeline: enforce the agreed permissions in the database.
--   Add / edit (including status): the owner, while NEXAR Pro is in effect.
--   Read / delete: the owner, on any plan (kept after Pro expires).
-- "Pro in effect" is the existing definition: public.nexar_effective_status(uid)
-- returns 'active' or 'trialing'. No new entitlement rule is introduced.
-- Scope: staging. Production needs separate approval.
-- Rollback: supabase/rollback/20261110230000_nexar_pipeline_pro_write_enforcement.down.sql
begin;

drop policy if exists pipeline_insert_own on public.nexar_pipeline;
create policy pipeline_insert_own on public.nexar_pipeline
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and (select public.nexar_effective_status((select auth.uid()))) in ('active', 'trialing')
  );

drop policy if exists pipeline_update_own on public.nexar_pipeline;
create policy pipeline_update_own on public.nexar_pipeline
  for update to authenticated
  using (
    (select auth.uid()) = user_id
    and (select public.nexar_effective_status((select auth.uid()))) in ('active', 'trialing')
  )
  with check (
    (select auth.uid()) = user_id
    and (select public.nexar_effective_status((select auth.uid()))) in ('active', 'trialing')
  );

-- pipeline_select_own and pipeline_delete_own are intentionally unchanged.
commit;
