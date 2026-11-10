begin;

create table public.competition_settings (
  id integer primary key default 1 check (id = 1),
  title text not null default 'Game Jam Theme Vote',
  description text not null default 'Which theme would make a better game?',
  voting_enabled boolean not null default true,
  leaderboard_visible boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
insert into public.competition_settings (id) values (1);

create table public.items (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) > 0 and name = btrim(name)),
  description text,
  rating numeric not null default 1500,
  wins integer not null default 0 check (wins >= 0),
  losses integer not null default 0 check (losses >= 0),
  comparisons integer not null default 0 check (comparisons = wins + losses),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index items_name_ci on public.items (lower(name));
create index items_active on public.items (id) where active;

create table public.votes (
  id uuid primary key default gen_random_uuid(),
  item_a_id uuid not null references public.items(id),
  item_b_id uuid not null references public.items(id),
  winner_id uuid not null references public.items(id),
  session_id uuid not null,
  request_id uuid not null unique default gen_random_uuid(),
  created_at timestamptz not null default clock_timestamp(),
  check (item_a_id <> item_b_id),
  check (winner_id in (item_a_id, item_b_id))
);
create index votes_item_a on public.votes (item_a_id);
create index votes_item_b on public.votes (item_b_id);
create index votes_winner on public.votes (winner_id);
create index votes_session_time on public.votes (session_id, created_at desc);
create index votes_replay on public.votes (created_at, id);

alter table public.items enable row level security;
alter table public.votes enable row level security;
alter table public.competition_settings enable row level security;
-- No public table policies: every read/write goes through the deliberately narrow RPCs.
revoke all on public.items, public.votes, public.competition_settings from public, anon, authenticated;

create function public.touch_settings() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := clock_timestamp(); return new; end;
$$;
create trigger settings_updated before update on public.competition_settings
for each row execute function public.touch_settings();
revoke all on function public.touch_settings() from public, anon, authenticated;

create function public.get_settings() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('title', title, 'description', description,
    'voting_enabled', voting_enabled, 'leaderboard_visible', leaderboard_visible)
  from public.competition_settings where id = 1;
$$;

create function public.get_themes()
returns table(id uuid, name text, description text)
language sql stable security definer set search_path = '' as $$
  select id, name, description from public.items where active order by name;
$$;

-- Replace this function to experiment with scheduling; no private fields leave it.
-- 25% exploration, 40% under-tested pairs, 35% close-rating pairs.
-- The bounded client history also remembers skipped pairs; stored votes work across visits.
create function public.get_pair(p_session_id uuid, p_recent_pairs jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  mode float8 := random(); chosen record; recent jsonb;
begin
  if p_session_id is null then raise exception 'A session identifier is required.'; end if;
  if jsonb_typeof(p_recent_pairs) <> 'array' or jsonb_array_length(p_recent_pairs) > 50 then
    raise exception 'Recent pairs must be an array of at most 50 keys.';
  end if;
  if not coalesce((select voting_enabled from public.competition_settings where id = 1), false) then
    return '[]'::jsonb;
  end if;
  select coalesce(jsonb_agg(pair_key), '[]'::jsonb) into recent from (
    select least(item_a_id, item_b_id)::text || ':' || greatest(item_a_id, item_b_id)::text as pair_key
    from public.votes where session_id = p_session_id order by created_at desc limit 20
  ) history;
  -- Enumerating pairs is intentional for a typical game-jam list (tens/hundreds of themes).
  -- Prefer unseen pairs, then fall back to repeats without retries or infinite loops.
  select a.id aid, a.name aname, a.description adescription,
         b.id bid, b.name bname, b.description bdescription
  into chosen from public.items a join public.items b on a.id < b.id
  where a.active and b.active
  order by ((p_recent_pairs || recent) ? (a.id::text || ':' || b.id::text)) asc,
    case when mode < 0.25 then random()
      when mode < 0.65 then random() * (a.comparisons + b.comparisons + 2)
      else abs(a.rating - b.rating)::float8 + random() * 100 end
  limit 1;
  if not found then return '[]'::jsonb; end if;
  if random() < 0.5 then
    return jsonb_build_array(
      jsonb_build_object('id', chosen.aid, 'name', chosen.aname, 'description', chosen.adescription),
      jsonb_build_object('id', chosen.bid, 'name', chosen.bname, 'description', chosen.bdescription));
  end if;
  return jsonb_build_array(
    jsonb_build_object('id', chosen.bid, 'name', chosen.bname, 'description', chosen.bdescription),
    jsonb_build_object('id', chosen.aid, 'name', chosen.aname, 'description', chosen.adescription));
end;
$$;

create function public.submit_vote(
  p_item_a_id uuid, p_item_b_id uuid, p_winner_id uuid, p_session_id uuid,
  p_request_id uuid default gen_random_uuid()
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  a public.items%rowtype; b public.items%rowtype; prior public.votes%rowtype;
  enabled boolean; expected numeric; delta numeric;
begin
  if p_session_id is null or p_request_id is null or p_item_a_id is null or p_item_b_id is null
    or p_winner_id is null or p_item_a_id = p_item_b_id or p_winner_id not in (p_item_a_id, p_item_b_id) then
    raise exception 'Invalid vote.' using errcode = '22023';
  end if;
  -- Serializes one anonymous session, including its retry and cooldown checks.
  perform pg_advisory_xact_lock(hashtextextended(p_session_id::text, 0));
  select * into prior from public.votes where request_id = p_request_id;
  if found then
    if prior.session_id = p_session_id and prior.item_a_id = p_item_a_id
      and prior.item_b_id = p_item_b_id and prior.winner_id = p_winner_id then
      return jsonb_build_object('success', true);
    end if;
    raise exception 'Request identifier already used.';
  end if;
  -- SHARE permits simultaneous voters, but a dashboard UPDATE waits for in-flight votes.
  select voting_enabled into enabled from public.competition_settings where id = 1 for share;
  if not coalesce(enabled, false) then raise exception 'Voting is closed.'; end if;
  if exists (select 1 from public.votes where session_id = p_session_id
    and created_at > clock_timestamp() - interval '750 milliseconds') then
    raise exception 'Please wait a moment before voting again.';
  end if;
  -- All votes lock item rows in UUID order, preventing crossed-pair deadlocks.
  perform id from public.items where id in (p_item_a_id, p_item_b_id) order by id for update;
  select * into a from public.items where id = p_item_a_id;
  select * into b from public.items where id = p_item_b_id;
  if a.id is null or b.id is null or not a.active or not b.active then
    raise exception 'Both themes must exist and be active.';
  end if;
  expected := 1 / (1 + power(10::numeric, (b.rating - a.rating) / 400));
  delta := 32 * ((case when p_winner_id = a.id then 1 else 0 end) - expected);
  insert into public.votes (item_a_id, item_b_id, winner_id, session_id, request_id)
    values (a.id, b.id, p_winner_id, p_session_id, p_request_id);
  update public.items set rating = rating + delta,
    wins = wins + (case when p_winner_id = a.id then 1 else 0 end),
    losses = losses + (case when p_winner_id = a.id then 0 else 1 end), comparisons = comparisons + 1 where id = a.id;
  update public.items set rating = rating - delta,
    wins = wins + (case when p_winner_id = b.id then 1 else 0 end),
    losses = losses + (case when p_winner_id = b.id then 0 else 1 end), comparisons = comparisons + 1 where id = b.id;
  return jsonb_build_object('success', true);
end;
$$;

create function public.get_leaderboard() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare visible boolean; result jsonb;
begin
  select leaderboard_visible into visible from public.competition_settings where id = 1 for share;
  if not coalesce(visible, false) then raise exception 'Results will be available when voting concludes.' using errcode = '42501'; end if;
  -- One statement supplies a consistent snapshot of counters and total votes.
  select jsonb_build_object('total_votes', (select count(*) from public.votes),
    'refreshed_at', clock_timestamp(), 'rankings', coalesce((select jsonb_agg(to_jsonb(r) order by r.rating desc, r.name, r.id) from (
      select dense_rank() over (order by rating desc) as rank, id, name, rating, wins, losses, comparisons,
        case when comparisons = 0 then 0 else 100.0 * wins / comparisons end as win_percentage,
        active
      from public.items
    ) r), '[]'::jsonb)) into result;
  return result;
end;
$$;

-- SQL Editor / postgres only. Settings lock excludes live votes while replay runs.
create function public.recompute_ratings() returns void
language plpgsql security definer set search_path = '' as $$
declare v record; ra numeric; rb numeric; delta numeric;
begin
  perform id from public.competition_settings where id = 1 for update;
  perform id from public.items order by id for update;
  update public.items set rating = 1500, wins = 0, losses = 0, comparisons = 0;
  for v in select * from public.votes order by created_at, id loop
    select rating into ra from public.items where id = v.item_a_id;
    select rating into rb from public.items where id = v.item_b_id;
    delta := 32 * ((case when v.winner_id = v.item_a_id then 1 else 0 end)
      - 1 / (1 + power(10::numeric, (rb - ra) / 400)));
    update public.items set rating = rating + delta,
      wins = wins + (case when v.winner_id = id then 1 else 0 end),
      losses = losses + (case when v.winner_id = id then 0 else 1 end), comparisons = comparisons + 1 where id = v.item_a_id;
    update public.items set rating = rating - delta,
      wins = wins + (case when v.winner_id = id then 1 else 0 end),
      losses = losses + (case when v.winner_id = id then 0 else 1 end), comparisons = comparisons + 1 where id = v.item_b_id;
  end loop;
end;
$$;

revoke all on function public.get_settings(), public.get_themes(), public.get_pair(uuid,jsonb),
  public.submit_vote(uuid,uuid,uuid,uuid,uuid), public.get_leaderboard(), public.recompute_ratings()
  from public, anon, authenticated;
grant execute on function public.get_settings(), public.get_themes(), public.get_pair(uuid,jsonb),
  public.submit_vote(uuid,uuid,uuid,uuid,uuid), public.get_leaderboard() to anon, authenticated;
commit;
