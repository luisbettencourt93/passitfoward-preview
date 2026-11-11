-- Redeploy the previous nexar-confirm-action BEFORE running this: the new
-- function version calls nexar_confirm_pending_action().
begin;
drop function if exists public.nexar_confirm_pending_action(uuid, uuid, boolean);
drop function if exists public.nexar_settle_pending_action(uuid);
drop trigger if exists nexar_pending_action_prepare_trg on public.nexar_pending_actions;
drop function if exists public.nexar_pending_action_prepare();
drop function if exists public.nexar_pipeline_snapshot(public.nexar_pipeline);
drop index if exists public.nexar_pending_one_open_per_target;
alter table public.nexar_pending_actions drop constraint if exists nexar_pending_actions_outcome_check;
alter table public.nexar_pending_actions drop column if exists outcome, drop column if exists target_snapshot, drop column if exists target_updated_at;
commit;
