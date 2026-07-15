-- XP1 community category compatibility
-- Aligns the community_posts category whitelist and the trusted RPC
-- validation with the real frontend values:
-- General, Questions, Wins, Resources, Intros.
-- Compatibility correction only: no reward, cap, activation or grant changes.
-- Replay-safe: constraint is dropped and re-added; function is replaced.

begin;

do $migration_preflight$
begin
  if exists (
    select 1
    from public.community_posts
    where category not in
      ('General', 'Questions', 'Wins', 'Resources', 'Intros')
  ) then
    raise exception
      'Community posts contain categories outside the expanded whitelist';
  end if;
end
$migration_preflight$;

alter table public.community_posts
  drop constraint if exists community_posts_category_whitelist;

alter table public.community_posts
  add constraint community_posts_category_whitelist
    check (
      category in
        ('General', 'Questions', 'Wins', 'Resources', 'Intros')
    );


create or replace function
  public.submit_community_post_with_xp(
    p_body text,
    p_category text
  )
returns table (
  community_post_id bigint,
  author_handle text,
  author_user_id uuid,
  post_body text,
  post_category text,
  post_created_at timestamptz,
  likes integer,
  stars integer,
  upvotes integer,
  downvotes integer,
  comments jsonb,
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
  v_category text;
  v_banned boolean;

  v_post_id bigint;
  v_post_likes integer;
  v_post_stars integer;
  v_post_upvotes integer;
  v_post_downvotes integer;
  v_post_comments jsonb;
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
      'Community post body is required';
  end if;

  if char_length(v_body) > 2000 then
    raise exception
      'Community post body must be 2000 characters or fewer';
  end if;

  v_category := btrim(coalesce(p_category, ''));

  if v_category = '' then
    v_category := 'General';
  end if;

  if v_category not in ('General', 'Questions', 'Wins', 'Resources', 'Intros') then
    raise exception
      'Community post category is invalid';
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

  insert into public.community_posts as c (
    handle,
    user_id,
    body,
    category
  )
  values (
    v_handle,
    v_user_id,
    v_body,
    v_category
  )
  returning
    c.id,
    c.created_at,
    coalesce(c.likes, 0),
    coalesce(c.stars, 0),
    coalesce(c.upvotes, 0),
    coalesce(c.downvotes, 0),
    coalesce(c.comments, '[]'::jsonb)
  into
    v_post_id,
    v_created_at,
    v_post_likes,
    v_post_stars,
    v_post_upvotes,
    v_post_downvotes,
    v_post_comments;

  select e.occurred_at
  into v_activation_at
  from public.xp_events e
  where e.event_key =
    'xp1:community-post:activation:v1';

  if not found then
    return query
    select
      v_post_id,
      v_handle,
      v_user_id,
      v_body,
      v_category,
      v_created_at,
      v_post_likes,
      v_post_stars,
      v_post_upvotes,
      v_post_downvotes,
      v_post_comments,
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
      v_post_id,
      v_handle,
      v_user_id,
      v_body,
      v_category,
      v_created_at,
      v_post_likes,
      v_post_stars,
      v_post_upvotes,
      v_post_downvotes,
      v_post_comments,
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
    'community_post_reward'
    and e.actor_user_id = v_user_id
    and (
      e.occurred_at at time zone 'UTC'
    )::date = (
      v_created_at at time zone 'UTC'
    )::date;

  if v_rewarded_today >= 3 then
    return query
    select
      v_post_id,
      v_handle,
      v_user_id,
      v_body,
      v_category,
      v_created_at,
      v_post_likes,
      v_post_stars,
      v_post_upvotes,
      v_post_downvotes,
      v_post_comments,
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
    'xp1:community-post:' ||
      v_post_id::text,
    'community_post_reward',
    'community_post',
    v_post_id::text,
    v_user_id,
    v_created_at,
    jsonb_build_object(
      'community_post_id', v_post_id,
      'reward_xp', 3,
      'daily_cap', 3,
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
  set xp = coalesce(p.xp, 0) + 3
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
    'community_post_reward',
    3,
    0,
    v_before_xp,
    v_after_xp,
    v_before_locked_xp,
    v_after_locked_xp,
    jsonb_build_object(
      'community_post_id',
      v_post_id,
      'daily_position',
      v_rewarded_today + 1
    )
  );

  return query
  select
    v_post_id,
    v_handle,
    v_user_id,
    v_body,
    v_category,
    v_created_at,
    v_post_likes,
    v_post_stars,
    v_post_upvotes,
    v_post_downvotes,
    v_post_comments,
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
  public.submit_community_post_with_xp(text, text)
from public, anon;

grant execute
on function
  public.submit_community_post_with_xp(text, text)
to authenticated;

commit;
