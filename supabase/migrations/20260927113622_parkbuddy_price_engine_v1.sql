-- Applied to production as Supabase migration 20260927113622_parkbuddy_price_engine_v1.
-- Source-of-truth copy for ParkBuddy RC5 price freshness.

create table if not exists public.price_source_monitors (
  source_url text primary key,
  authority_level text not null check (authority_level in ('official','operator','community')),
  check_interval_minutes integer not null check (check_interval_minutes between 5 and 43200),
  status text not null default 'active' check (status in ('active','paused','error','review')),
  content_hash text,
  etag text,
  last_modified text,
  last_http_status integer,
  last_checked_at timestamptz,
  next_check_at timestamptz not null default now(),
  last_changed_at timestamptz,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint price_source_monitors_https check (source_url ~ '^https://')
);
create index if not exists idx_price_source_monitors_due on public.price_source_monitors(status,next_check_at);

create table if not exists public.price_refresh_runs (
  id uuid primary key default gen_random_uuid(),
  requested_by text not null default 'cron' check (requested_by in ('cron','manual','bootstrap')),
  status text not null default 'queued' check (status in ('queued','running','succeeded','partial','failed')),
  source_limit integer not null default 12 check (source_limit between 1 and 50),
  sources_seen integer not null default 0,
  sources_ok integer not null default 0,
  sources_changed integer not null default 0,
  sources_failed integer not null default 0,
  tariffs_reverified integer not null default 0,
  tariffs_flagged integer not null default 0,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  error_message text
);
create index if not exists idx_price_refresh_runs_status_created on public.price_refresh_runs(status,created_at desc);

create table if not exists public.price_source_changes (
  id bigserial primary key,
  source_url text not null references public.price_source_monitors(source_url) on delete cascade,
  old_hash text,
  new_hash text,
  http_status integer,
  affected_tariffs integer not null default 0,
  flagged_tariffs integer not null default 0,
  resolution text not null default 'observed' check (resolution in ('observed','price_unchanged','needs_review','resolved')),
  detected_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);
create index if not exists idx_price_source_changes_source_time on public.price_source_changes(source_url,detected_at desc);

alter table public.parking_tariffs
  add column if not exists last_checked_at timestamptz,
  add column if not exists next_check_at timestamptz,
  add column if not exists freshness_status text not null default 'current',
  add column if not exists confidence_score integer,
  add column if not exists source_hash text,
  add column if not exists source_etag text,
  add column if not exists source_last_modified text,
  add column if not exists last_http_status integer,
  add column if not exists consecutive_failures integer not null default 0,
  add column if not exists superseded_by bigint;

do $$ begin
  if not exists (select 1 from pg_constraint where conname='parking_tariffs_freshness_status_check') then
    alter table public.parking_tariffs add constraint parking_tariffs_freshness_status_check
      check (freshness_status in ('current','due','stale','review','error'));
  end if;
  if not exists (select 1 from pg_constraint where conname='parking_tariffs_confidence_score_check') then
    alter table public.parking_tariffs add constraint parking_tariffs_confidence_score_check
      check (confidence_score is null or confidence_score between 0 and 100);
  end if;
  if not exists (select 1 from pg_constraint where conname='parking_tariffs_superseded_by_fkey') then
    alter table public.parking_tariffs add constraint parking_tariffs_superseded_by_fkey
      foreign key (superseded_by) references public.parking_tariffs(id);
  end if;
end $$;
create index if not exists idx_parking_tariffs_source_current on public.parking_tariffs(source_url,valid_to,freshness_status);
create index if not exists idx_parking_tariffs_parking_current on public.parking_tariffs(parking_id,valid_to,verification_level);

alter table public.parking_locations
  add column if not exists price_freshness_status text not null default 'unknown',
  add column if not exists price_confidence_score integer,
  add column if not exists price_last_checked_at timestamptz,
  add column if not exists price_next_check_at timestamptz;

do $$ begin
  if not exists (select 1 from pg_constraint where conname='parking_locations_price_freshness_check') then
    alter table public.parking_locations add constraint parking_locations_price_freshness_check
      check (price_freshness_status in ('unknown','current','due','stale','review','error'));
  end if;
  if not exists (select 1 from pg_constraint where conname='parking_locations_price_confidence_check') then
    alter table public.parking_locations add constraint parking_locations_price_confidence_check
      check (price_confidence_score is null or price_confidence_score between 0 and 100);
  end if;
end $$;

create table if not exists public.parking_price_live (
  parking_id text primary key references public.parking_locations(id) on delete cascade,
  city_id text,
  price_per_hour numeric,
  currency text not null default 'PLN',
  freshness_status text not null default 'unknown',
  verification_level text,
  verified_at timestamptz,
  last_checked_at timestamptz,
  next_check_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.price_source_monitors enable row level security;
alter table public.price_refresh_runs enable row level security;
alter table public.price_source_changes enable row level security;
alter table public.parking_price_live enable row level security;
alter table public.parking_tariffs enable row level security;
alter table public.parking_locations enable row level security;
alter table public.parking_reverse_geocode_cache enable row level security;
alter table public.osm_parking_tag_snapshots enable row level security;

revoke all on public.price_source_monitors,public.price_refresh_runs,public.price_source_changes,
  public.parking_tariffs,public.parking_locations,public.parking_reverse_geocode_cache,
  public.osm_parking_tag_snapshots from anon,authenticated;
grant select,insert,update,delete on public.price_source_monitors,public.price_refresh_runs,
  public.price_source_changes,public.parking_tariffs,public.parking_locations,
  public.parking_reverse_geocode_cache,public.osm_parking_tag_snapshots to service_role;
grant usage,select on sequence public.price_source_changes_id_seq to service_role;
revoke insert,update,delete on public.parking_price_live from anon,authenticated;
grant select on public.parking_price_live to anon,authenticated;
grant select,insert,update,delete on public.parking_price_live to service_role;

drop policy if exists "public read live parking prices" on public.parking_price_live;
create policy "public read live parking prices" on public.parking_price_live
for select to anon,authenticated using (true);

create or replace function public.parkbuddy_sync_location_prices(p_source_url text default null)
returns integer language plpgsql security invoker set search_path=public as $$
declare v_count integer:=0;
begin
  with affected as (
    select distinct parking_id from public.parking_tariffs
    where valid_to is null and (p_source_url is null or source_url=p_source_url)
  ), ranked as (
    select t.*,row_number() over(partition by t.parking_id order by
      case t.freshness_status when 'current' then 0 when 'due' then 1 when 'review' then 2 when 'stale' then 3 else 4 end,
      case t.verification_level when 'official' then 0 when 'operator' then 1 else 2 end,
      case when t.tariff_kind='hourly' then 0 when t.tariff_kind='free' then 1
           when t.tariff_kind='duration' and t.duration_minutes=60 then 2 when t.tariff_kind='flat' then 3 else 4 end,
      t.verified_at desc,t.id desc) rn
    from public.parking_tariffs t join affected a on a.parking_id=t.parking_id
    where t.valid_to is null
  ), best as (select * from ranked where rn=1)
  update public.parking_locations pl set
    price_per_hour=case when b.tariff_kind='free' then 0 when b.tariff_kind='hourly' then b.amount
      when b.tariff_kind='duration' and b.duration_minutes=60 then b.amount else null end,
    currency=coalesce(b.currency,pl.currency,'PLN'),
    pricing_status=case when b.tariff_kind='free' then 'free' when b.tariff_kind='hourly' then 'hourly'
      when b.tariff_kind='duration' and b.duration_minutes=60 then 'hourly' when b.tariff_kind='flat' then 'flat' else 'conditional' end,
    price_source_url=b.source_url,price_verified_at=b.verified_at,price_verification_level=b.verification_level,
    price_note=b.condition_text,price_freshness_status=b.freshness_status,price_confidence_score=b.confidence_score,
    price_last_checked_at=b.last_checked_at,price_next_check_at=b.next_check_at
  from best b where pl.id=b.parking_id;
  get diagnostics v_count=row_count;
  return v_count;
end $$;
revoke all on function public.parkbuddy_sync_location_prices(text) from public,anon,authenticated;
grant execute on function public.parkbuddy_sync_location_prices(text) to service_role;

create or replace function public.parkbuddy_record_tariff(
  p_parking_id text,p_tariff_kind text,p_amount numeric,p_currency text,p_duration_minutes integer,
  p_condition_text text,p_source_url text,p_verification_level text,p_verified_at timestamptz default now()
) returns bigint language plpgsql security invoker set search_path=public as $$
declare v_existing bigint;v_new bigint;v_conf integer;
begin
  if p_tariff_kind not in ('free','hourly','flat','duration','conditional') then raise exception 'invalid tariff kind'; end if;
  if p_verification_level not in ('official','operator','community') then raise exception 'invalid verification level'; end if;
  if p_source_url is null or p_source_url !~ '^https://' then raise exception 'https source required'; end if;
  v_conf:=case p_verification_level when 'official' then 95 when 'operator' then 90 else 65 end;
  select id into v_existing from public.parking_tariffs
    where parking_id=p_parking_id and valid_to is null and tariff_kind=p_tariff_kind
      and amount is not distinct from p_amount and currency=coalesce(p_currency,'PLN')
      and duration_minutes is not distinct from p_duration_minutes
      and condition_text is not distinct from p_condition_text
      and source_url=p_source_url and verification_level=p_verification_level
    order by id desc limit 1;
  if v_existing is not null then
    update public.parking_tariffs set verified_at=p_verified_at,last_checked_at=p_verified_at,
      freshness_status='current',confidence_score=v_conf,consecutive_failures=0 where id=v_existing;
    perform public.parkbuddy_sync_location_prices(p_source_url);
    return v_existing;
  end if;
  insert into public.parking_tariffs(parking_id,tariff_kind,amount,currency,duration_minutes,condition_text,
    source_url,verification_level,verified_at,valid_from,last_checked_at,freshness_status,confidence_score,consecutive_failures)
  values(p_parking_id,p_tariff_kind,p_amount,coalesce(p_currency,'PLN'),p_duration_minutes,p_condition_text,
    p_source_url,p_verification_level,p_verified_at,p_verified_at,p_verified_at,'current',v_conf,0)
  returning id into v_new;
  update public.parking_tariffs set valid_to=p_verified_at,superseded_by=v_new
  where parking_id=p_parking_id and id<>v_new and valid_to is null and (
    (p_tariff_kind in ('free','hourly') and tariff_kind in ('free','hourly'))
    or (p_tariff_kind='duration' and tariff_kind='duration' and duration_minutes is not distinct from p_duration_minutes)
    or (p_tariff_kind='flat' and tariff_kind='flat')
    or (p_tariff_kind='conditional' and tariff_kind='conditional' and condition_text is not distinct from p_condition_text));
  perform public.parkbuddy_sync_location_prices(p_source_url);
  return v_new;
end $$;
revoke all on function public.parkbuddy_record_tariff(text,text,numeric,text,integer,text,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.parkbuddy_record_tariff(text,text,numeric,text,integer,text,text,text,timestamptz) to service_role;

create or replace function public.parkbuddy_price_live_trigger()
returns trigger language plpgsql security invoker set search_path=public as $$
begin
  insert into public.parking_price_live(parking_id,city_id,price_per_hour,currency,freshness_status,
    verification_level,verified_at,last_checked_at,next_check_at,updated_at)
  values(new.id,new.city_id,new.price_per_hour,new.currency,new.price_freshness_status,
    new.price_verification_level,new.price_verified_at,new.price_last_checked_at,new.price_next_check_at,now())
  on conflict(parking_id) do update set city_id=excluded.city_id,price_per_hour=excluded.price_per_hour,
    currency=excluded.currency,freshness_status=excluded.freshness_status,verification_level=excluded.verification_level,
    verified_at=excluded.verified_at,last_checked_at=excluded.last_checked_at,next_check_at=excluded.next_check_at,updated_at=now();
  return new;
end $$;
drop trigger if exists trg_parkbuddy_price_live on public.parking_locations;
create trigger trg_parkbuddy_price_live after insert or update of price_per_hour,currency,price_freshness_status,
  price_verification_level,price_verified_at,price_last_checked_at,price_next_check_at,city_id
on public.parking_locations for each row execute function public.parkbuddy_price_live_trigger();

insert into public.price_source_monitors(source_url,authority_level,check_interval_minutes,status,next_check_at)
select source_url,
  case when bool_or(verification_level='official') then 'official' when bool_or(verification_level='operator') then 'operator' else 'community' end,
  case when bool_or(verification_level='official') then 1440 when bool_or(verification_level='operator') then 360 else 10080 end,
  'active',
  case when bool_or(verification_level in ('official','operator')) then now()
       else now()+((abs(hashtext(source_url))%10080)::text||' minutes')::interval end
from public.parking_tariffs
where source_url is not null and source_url~'^https://' and valid_to is null
group by source_url
on conflict(source_url) do update set authority_level=excluded.authority_level,
  check_interval_minutes=excluded.check_interval_minutes,updated_at=now();

update public.parking_tariffs t set
  confidence_score=coalesce(t.confidence_score,case t.verification_level when 'official' then 95 when 'operator' then 90 else 65 end),
  last_checked_at=coalesce(t.last_checked_at,t.verified_at),
  next_check_at=coalesce(t.next_check_at,m.next_check_at),
  freshness_status=case when t.valid_to is null then coalesce(t.freshness_status,'current') else 'stale' end
from public.price_source_monitors m where t.source_url=m.source_url;

select public.parkbuddy_sync_location_prices(null);

insert into public.parking_price_live(parking_id,city_id,price_per_hour,currency,freshness_status,
  verification_level,verified_at,last_checked_at,next_check_at,updated_at)
select id,city_id,price_per_hour,currency,price_freshness_status,price_verification_level,
  price_verified_at,price_last_checked_at,price_next_check_at,now()
from public.parking_locations
on conflict(parking_id) do update set city_id=excluded.city_id,price_per_hour=excluded.price_per_hour,
  currency=excluded.currency,freshness_status=excluded.freshness_status,verification_level=excluded.verification_level,
  verified_at=excluded.verified_at,last_checked_at=excluded.last_checked_at,next_check_at=excluded.next_check_at,updated_at=now();

alter table public.parking_price_live replica identity full;
do $$ begin
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='parking_price_live') then
    execute 'alter publication supabase_realtime add table public.parking_price_live';
  end if;
end $$;

do $$ declare j record; begin
  for j in select jobid from cron.job where jobname='parkbuddy-poland-baseline-sync' loop perform cron.unschedule(j.jobid); end loop;
  for j in select jobid from cron.job where jobname='parkbuddy-price-refresh' loop perform cron.unschedule(j.jobid); end loop;
end $$;

select cron.schedule('parkbuddy-price-refresh','*/10 * * * *',$cron$
  with queued as (
    insert into public.price_refresh_runs(requested_by,status,source_limit)
    select 'cron','queued',12
    where not exists(select 1 from public.price_refresh_runs where status in ('queued','running') and created_at>now()-interval '20 minutes')
    returning id
  )
  select net.http_post(
    url:='https://oespoljjeslpsnhjwsra.supabase.co/functions/v1/parkbuddy-price-refresh',
    headers:='{"Content-Type":"application/json"}'::jsonb,
    body:=jsonb_build_object('run_id',id),
    timeout_milliseconds:=55000
  ) from queued;
$cron$);
