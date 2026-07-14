-- XP1 testimonial reward preparation
-- Preparation only: no activation event and no legacy permission revocation.

begin;

do $migration_preflight$
begin
if exists (
    select 1
    from public.testimonials
    where author_id is null
       or created_at is null
  ) then
    raise exception
      'Testimonials contain incomplete reward identity';
  end if;

  if exists (
    select 1
    from public.testimonials
    where btrim(author_handle) = ''
       or btrim(body) = ''
       or char_length(body) > 2000
  ) then
    raise exception
      'Testimonials contain invalid text values';
  end if;
end
$migration_preflight$;

alter table public.testimonials
  alter column author_id set not null,
  alter column created_at set not null;

alter table public.testimonials
  drop constraint if exists testimonials_author_handle_not_blank,
  drop constraint if exists testimonials_body_not_blank,
  drop constraint if exists testimonials_body_length_check;

alter table public.testimonials
  add constraint testimonials_author_handle_not_blank
    check (btrim(author_handle) <> ''),
  add constraint testimonials_body_not_blank
    check (btrim(body) <> ''),
  add constraint testimonials_body_length_check
    check (char_length(body) <= 2000);


create or replace function
  public.protect_testimonial_reward_identity()
returns trigger
language plpgsql
set search_path to 'pg_catalog'
as $function$
begin
  if new.id is distinct from old.id
     or new.author_handle is distinct from old.author_handle
     or new.author_id is distinct from old.author_id
     or new.created_at is distinct from old.created_at
  then
    if session_user = 'postgres'
       and coalesce(
         current_setting(
           'app.bypass_testimonial_reward_identity',
           true
         ),
         'false'
       ) = 'true'
    then
      return new;
    end if;

    raise exception
      'Testimonial reward identity fields are immutable';
  end if;

  return new;
end;
$function$;

drop trigger if exists protect_testimonial_reward_identity_trg
on public.testimonials;

create trigger
  protect_testimonial_reward_identity_trg
before update of
  id,
  author_handle,
  author_id,
  created_at
on public.testimonials
for each row
execute function
  public.protect_testimonial_reward_identity();

revoke all
on function
  public.protect_testimonial_reward_identity()
from public, anon, authenticated;


create or replace function
  public.submit_testimonial_with_xp(p_body text)
returns table (
  testimonial_id bigint,
  author_handle text,
  testimonial_created_at timestamptz,
  awarded boolean,
  reason text,
  new_xp integer,
  new_locked_xp integer,
  xp_event_id bigint,
  rewarded_on_source_day integer
)
language plpgsql
security definer
set search_path to 'pg_catalog', 'pg_temp'
as $function$
declare
  v_user_id uuid;
  v_handle text;
  v_body text;
  v_banned boolean;

  v_testimonial_id bigint;
  v_created_at timestamptz;
  v_activation_at timestamptz;

  v_before_xp integer;
  v_before_locked_xp integer;
  v_after_xp integer;
  v_after_locked_xp integer;

  v_event_id bigint;
  v_rewarded_today integer;
begin
  v_user_id := auth.uid();

  if v_user_id is null then
    raise exception
      'Authentication required';
  end if;

  v_body := btrim(coalesce(p_body, ''));

  if v_body = '' then
    raise exception
      'Testimonial body is required';
  end if;

  if char_length(v_body) > 2000 then
    raise exception
      'Testimonial body must be 2000 characters or fewer';
  end if;

  select
    p.handle,
    coalesce(p.banned, false),
    coalesce(p.xp, 0),
    coalesce(p.locked_xp, 0)
  into
    v_handle,
    v_banned,
    v_before_xp,
    v_before_locked_xp
  from public.profiles p
  where p.id = v_user_id
  for update;

  if not found then
    raise exception
      'Profile not found';
  end if;

  if v_banned then
    raise exception
      'Account is disabled';
  end if;

  if btrim(coalesce(v_handle, '')) = '' then
    raise exception
      'Profile handle is missing';
  end if;

  insert into public.testimonials as t (
    author_handle,
    author_id,
    body
  )
  values (
    v_handle,
    v_user_id,
    v_body
  )
  returning
    t.id,
    t.created_at
  into
    v_testimonial_id,
    v_created_at;

  select e.occurred_at
  into v_activation_at
  from public.xp_events e
  where e.event_key =
    'xp1:testimonial-post:activation:v1';

  if not found then
    return query
    select
      v_testimonial_id,
      v_handle,
      v_created_at,
      false,
      'not_active'::text,
      v_before_xp,
      v_before_locked_xp,
      null::bigint,
      0;
    return;
  end if;

  if v_created_at < v_activation_at then
    return query
    select
      v_testimonial_id,
      v_handle,
      v_created_at,
      false,
      'before_activation'::text,
      v_before_xp,
      v_before_locked_xp,
      null::bigint,
      0;
    return;
  end if;

  select count(*)::integer
  into v_rewarded_today
  from public.xp_events e
  where e.event_type =
    'testimonial_post_reward'
    and e.actor_user_id = v_user_id
    and (
      e.occurred_at at time zone 'UTC'
    )::date = (
      v_created_at at time zone 'UTC'
    )::date;

  if v_rewarded_today >= 1 then
    return query
    select
      v_testimonial_id,
      v_handle,
      v_created_at,
      false,
      'daily_cap_reached'::text,
      v_before_xp,
      v_before_locked_xp,
      null::bigint,
      v_rewarded_today;
    return;
  end if;

  insert into public.xp_events (
    event_key,
    event_type,
    source_type,
    source_id,
    actor_user_id,
    occurred_at,
    metadata
  )
  values (
    'xp1:testimonial-post:' ||
      v_testimonial_id::text,
    'testimonial_post_reward',
    'testimonial',
    v_testimonial_id::text,
    v_user_id,
    v_created_at,
    jsonb_build_object(
      'reward_xp', 10,
      'daily_cap', 1,
      'source_created_at', v_created_at
    )
  )
  returning id
  into v_event_id;

  perform set_config(
    'app.bypass_xp_cap',
    'true',
    true
  );

  update public.profiles as p
  set xp = coalesce(p.xp, 0) + 10
  where p.id = v_user_id
  returning
    coalesce(p.xp, 0),
    coalesce(p.locked_xp, 0)
  into
    v_after_xp,
    v_after_locked_xp;

  insert into public.xp_ledger_entries (
    event_id,
    user_id,
    movement_type,
    xp_delta,
    locked_xp_delta,
    xp_before,
    xp_after,
    locked_xp_before,
    locked_xp_after,
    metadata
  )
  values (
    v_event_id,
    v_user_id,
    'testimonial_post_reward',
    10,
    0,
    v_before_xp,
    v_after_xp,
    v_before_locked_xp,
    v_after_locked_xp,
    jsonb_build_object(
      'testimonial_id',
      v_testimonial_id,
      'daily_position',
      v_rewarded_today + 1
    )
  );

  return query
  select
    v_testimonial_id,
    v_handle,
    v_created_at,
    true,
    'awarded'::text,
    v_after_xp,
    v_after_locked_xp,
    v_event_id,
    v_rewarded_today + 1;
end;
$function$;

revoke all
on function
  public.submit_testimonial_with_xp(text)
from public, anon;

grant execute
on function
  public.submit_testimonial_with_xp(text)
to authenticated;

commit;
