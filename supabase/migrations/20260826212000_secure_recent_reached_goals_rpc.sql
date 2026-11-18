-- Source-control the goals feed RPC already present in staging and make its
-- privilege/search-path posture explicit. Replay-safe via CREATE OR REPLACE.

begin;

create or replace function
  public.get_recent_reached_goals(
    p_limit integer default 10
  )
returns table (
  handle text,
  goal text,
  reached_at timestamptz
)
language sql
stable
security definer
set search_path to 'pg_catalog', 'pg_temp'
as $function$
  select
    g.handle,
    g.goal,
    g.reached_at
  from public.member_goals as g
  where g.reached is true
    and g.deleted_at is null
    and g.lifecycle_trusted_at is not null
  order by g.reached_at desc nulls last
  limit least(greatest(coalesce(p_limit, 10), 1), 50);
$function$;

revoke all on function
  public.get_recent_reached_goals(integer)
from public;

revoke all on function
  public.get_recent_reached_goals(integer)
from anon, authenticated;

grant execute on function
  public.get_recent_reached_goals(integer)
to anon, authenticated;

commit;
