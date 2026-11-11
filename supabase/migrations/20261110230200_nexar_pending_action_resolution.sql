-- NEXAR delete requests: one answer wins, a changed job is refused, a newer
-- request replaces older ones, and every request records how it ended.
--   preview           : now written by the database from the job row it reads.
--   target_updated_at : that same row's updated_at.
--   target_snapshot   : that same row's title, company, status and notes digest.
--   outcome           : how the request ended (null while open).
-- The text shown to the member and the version checked at confirmation
-- therefore always describe one and the same reading of the job.
-- The owner can already read their own requests (pending_select_own), so the
-- app can show the recorded outcome instead of guessing after a timeout.
-- Scope: staging. Rollback: supabase/rollback/20261110230200_...down.sql
begin;

alter table public.nexar_pending_actions
  add column if not exists target_updated_at timestamptz,
  add column if not exists target_snapshot jsonb,
  add column if not exists outcome text;

alter table public.nexar_pending_actions
  drop constraint if exists nexar_pending_actions_outcome_check;
alter table public.nexar_pending_actions
  add constraint nexar_pending_actions_outcome_check check (
    outcome is null
    or (consumed_at is not null and outcome in
        ('cancelled', 'deleted', 'already_gone', 'target_changed', 'superseded', 'expired'))
  );

-- What a delete request is bound to. Used when it is made and when it is answered.
create or replace function public.nexar_pipeline_snapshot(j public.nexar_pipeline)
returns jsonb
language sql
immutable
set search_path to 'public', 'pg_temp'
as $function$
  select jsonb_build_object('title', j.title, 'company', j.company, 'status', j.status,
                            'notes_md5', md5(coalesce(j.notes, '')));
$function$;

-- On insert: read the job ONCE, write the confirmation text and the expected
-- version from that one reading, and close older open requests for the job.
-- The caller's own preview text is replaced, so it can never be older than the
-- version the request is bound to.
create or replace function public.nexar_pending_action_prepare()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  j public.nexar_pipeline%rowtype;
begin
  if new.action_type = 'delete_pipeline' then
    select * into j from public.nexar_pipeline p
     where p.id = new.target_id and p.user_id = new.user_id;
    if not found then
      raise exception 'nexar_pending_actions: job not found for this member'
        using errcode = 'P0002';
    end if;
    new.preview := format('Delete "%s" @ %s (%s)?', j.title, j.company, j.status);
    new.target_updated_at := j.updated_at;
    new.target_snapshot := public.nexar_pipeline_snapshot(j);

    update public.nexar_pending_actions a
       set consumed_at = now(), outcome = 'superseded'
     where a.target_id = new.target_id
       and a.user_id = new.user_id
       and a.action_type = new.action_type
       and a.consumed_at is null;
  end if;
  return new;
end;
$function$;

drop trigger if exists nexar_pending_action_prepare_trg on public.nexar_pending_actions;
create trigger nexar_pending_action_prepare_trg
  before insert on public.nexar_pending_actions
  for each row execute function public.nexar_pending_action_prepare();

-- Close any older open duplicates that exist before the rule below is added.
update public.nexar_pending_actions a
   set consumed_at = now(), outcome = 'superseded'
 where a.consumed_at is null
   and exists (select 1 from public.nexar_pending_actions b
                where b.target_id = a.target_id and b.action_type = a.action_type
                  and b.consumed_at is null
                  and (b.created_at, b.id) > (a.created_at, a.id));

-- At most one open request per job, including under simultaneous inserts.
create unique index if not exists nexar_pending_one_open_per_target
  on public.nexar_pending_actions (target_id, action_type)
  where consumed_at is null;

-- The whole answer in one transaction. The request row is locked first, so two
-- answers cannot both act; the job row is locked before it is compared.
create or replace function public.nexar_confirm_pending_action(
  p_action_id uuid, p_user_id uuid, p_accept boolean
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  r public.nexar_pending_actions%rowtype;
  j public.nexar_pipeline%rowtype;
begin
  if p_action_id is null or p_user_id is null or p_accept is null then
    return jsonb_build_object('ok', false, 'error', 'not_actionable');
  end if;

  select * into r from public.nexar_pending_actions
   where id = p_action_id and user_id = p_user_id and action_type = 'delete_pipeline'
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_actionable');
  end if;

  if r.consumed_at is not null then
    return jsonb_build_object('ok', false, 'error', 'already_resolved', 'outcome', r.outcome);
  end if;

  if r.expires_at <= now() then
    update public.nexar_pending_actions set consumed_at = now(), outcome = 'expired' where id = r.id;
    return jsonb_build_object('ok', false, 'error', 'expired', 'outcome', 'expired');
  end if;

  if not p_accept then
    update public.nexar_pending_actions set consumed_at = now(), outcome = 'cancelled' where id = r.id;
    return jsonb_build_object('ok', true, 'action', 'cancelled', 'preview', r.preview);
  end if;

  select * into j from public.nexar_pipeline
   where id = r.target_id and user_id = p_user_id
   for update;
  if not found then
    update public.nexar_pending_actions set consumed_at = now(), outcome = 'already_gone' where id = r.id;
    return jsonb_build_object('ok', true, 'action', 'already_gone', 'preview', r.preview);
  end if;

  -- Both must match: the timestamp, and the content the member was shown.
  if r.target_updated_at is null or r.target_snapshot is null
     or j.updated_at is distinct from r.target_updated_at
     or public.nexar_pipeline_snapshot(j) is distinct from r.target_snapshot then
    update public.nexar_pending_actions set consumed_at = now(), outcome = 'target_changed' where id = r.id;
    return jsonb_build_object('ok', false, 'error', 'target_changed', 'outcome', 'target_changed',
      'current', jsonb_build_object('id', j.id, 'title', j.title, 'company', j.company, 'status', j.status));
  end if;

  delete from public.nexar_pipeline where id = j.id and user_id = p_user_id;
  update public.nexar_pending_actions set consumed_at = now(), outcome = 'deleted' where id = r.id;
  return jsonb_build_object('ok', true, 'action', 'deleted', 'preview', r.preview,
    'target', jsonb_build_object('id', j.id, 'title', j.title, 'company', j.company));
end;
$function$;

revoke all on function public.nexar_confirm_pending_action(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.nexar_confirm_pending_action(uuid, uuid, boolean) to service_role;
revoke all on function public.nexar_pending_action_prepare() from public, anon, authenticated;
revoke all on function public.nexar_pipeline_snapshot(public.nexar_pipeline) from public, anon, authenticated;
grant execute on function public.nexar_pipeline_snapshot(public.nexar_pipeline) to service_role;

-- The owner asks what was recorded for one of their own requests.
-- It takes the same row lock as the answer does, so it WAITS for an answer that
-- is being processed and then reports that answer's outcome. Only here, on the
-- server clock and under that lock, is an unanswered request marked expired.
-- It can never delete a job and never changes a request that has an outcome.
create or replace function public.nexar_settle_pending_action(p_action_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  r public.nexar_pending_actions%rowtype;
begin
  if p_action_id is null or auth.uid() is null then
    return jsonb_build_object('found', false);
  end if;
  select * into r from public.nexar_pending_actions
   where id = p_action_id and user_id = auth.uid()
   for update;
  if not found then
    return jsonb_build_object('found', false);
  end if;
  if r.consumed_at is null and r.expires_at <= clock_timestamp() then
    update public.nexar_pending_actions set consumed_at = now(), outcome = 'expired'
     where id = r.id returning * into r;
  end if;
  return jsonb_build_object('found', true, 'id', r.id, 'consumed_at', r.consumed_at,
                            'expires_at', r.expires_at, 'outcome', r.outcome);
end;
$function$;

revoke all on function public.nexar_settle_pending_action(uuid) from public, anon;
grant execute on function public.nexar_settle_pending_action(uuid) to authenticated, service_role;

commit;
