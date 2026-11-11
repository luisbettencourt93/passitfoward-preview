-- Restores the previous owner-only rules (no plan check).
begin;
drop policy if exists pipeline_insert_own on public.nexar_pipeline;
create policy pipeline_insert_own on public.nexar_pipeline
  for insert with check (auth.uid() = user_id);
drop policy if exists pipeline_update_own on public.nexar_pipeline;
create policy pipeline_update_own on public.nexar_pipeline
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
commit;
