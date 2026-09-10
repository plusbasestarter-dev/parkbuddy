create extension if not exists postgis;

create table if not exists parking_sessions (
  id bigserial primary key,
  device_id text not null,
  label text,
  lat double precision not null,
  lon double precision not null,
  geom geometry(Point, 4326)
    generated always as (ST_SetSRID(ST_MakePoint(lon, lat), 4326)) stored,
  started_at timestamptz not null default now()
);

create index if not exists idx_parking_sessions_device_started
  on parking_sessions(device_id, started_at desc);

create index if not exists idx_parking_sessions_geom
  on parking_sessions using gist(geom);

create table if not exists parking_locations (
  id text primary key,
  city text not null default 'Warszawa',
  country_code text not null default 'PL',
  name text not null,
  parking_type text,
  currency text not null default 'PLN',
  price_per_hour numeric,
  lat double precision not null,
  lon double precision not null,
  geom geometry(Point, 4326)
    generated always as (ST_SetSRID(ST_MakePoint(lon, lat), 4326)) stored,
  source text,
  source_updated_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_parking_locations_geom
  on parking_locations using gist(geom);

create table if not exists parking_snapshots (
  id bigserial primary key,
  parking_id text references parking_locations(id) on delete cascade,
  captured_at timestamptz not null default now(),
  free_spaces integer,
  capacity integer,
  occupancy_percent numeric,
  source text
);

create index if not exists idx_snapshots_parking_time
  on parking_snapshots(parking_id, captured_at desc);

-- RC3: a single owner-protected state, including deletion tombstones.
-- This extends the existing schema; it can safely be applied again.
create table if not exists public.parking_state (
  owner_hash text primary key check (owner_hash ~ '^[0-9a-f]{64}$'),
  revision bigint not null check (revision > 0 and revision <= 9007199254740991),
  deleted boolean not null default false,
  lat double precision,
  lon double precision,
  label text,
  recorded_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint parking_state_coordinates check (
    (deleted and lat is null and lon is null and label is null and recorded_at is null)
    or (not deleted and lat is not null and lon is not null and lat between -90 and 90 and lon between -180 and 180 and recorded_at is not null)
  )
);
alter table public.parking_state enable row level security;
revoke all on public.parking_state from anon, authenticated;
grant select, insert, update, delete on public.parking_state to service_role;
alter table public.parking_sessions enable row level security;
revoke all on public.parking_sessions from anon, authenticated;

-- Preserve the latest legacy record, keyed by a hash of its existing random token.
insert into public.parking_state(owner_hash,revision,deleted,lat,lon,label,recorded_at)
select encode(sha256(convert_to(s.device_id,'UTF8')),'hex'),
       greatest(1,(extract(epoch from s.started_at)*1000)::bigint),false,
       s.lat,s.lon,s.label,s.started_at
from (select distinct on(device_id) * from public.parking_sessions order by device_id,started_at desc,id desc) s
on conflict(owner_hash) do nothing;

create or replace function public.parkbuddy_write_state(
  p_owner_hash text,p_revision bigint,p_deleted boolean,
  p_lat double precision,p_lon double precision,p_label text,p_recorded_ms bigint
) returns jsonb language plpgsql security invoker set search_path=public as $function$
declare result public.parking_state;
begin
  insert into public.parking_state(owner_hash,revision,deleted,lat,lon,label,recorded_at)
  values(p_owner_hash,p_revision,p_deleted,
    case when p_deleted then null else p_lat end,
    case when p_deleted then null else p_lon end,
    case when p_deleted then null else left(p_label,240) end,
    case when p_deleted then null else to_timestamp(p_recorded_ms/1000.0) end)
  on conflict(owner_hash) do update set
    revision=excluded.revision,deleted=excluded.deleted,lat=excluded.lat,lon=excluded.lon,
    label=excluded.label,recorded_at=excluded.recorded_at,updated_at=now()
  where excluded.revision>parking_state.revision
     or (excluded.revision=parking_state.revision and excluded.deleted and not parking_state.deleted);
  -- Remove old location history for this owner as part of the same transaction.
  delete from public.parking_sessions where encode(sha256(convert_to(device_id,'UTF8')),'hex')=p_owner_hash;
  select * into result from public.parking_state where owner_hash=p_owner_hash;
  return jsonb_build_object('revision',result.revision,'deleted',result.deleted,
    'lat',result.lat,'lon',result.lon,'name',coalesce(result.label,''),
    'time',(extract(epoch from result.recorded_at)*1000)::bigint);
end
$function$;
revoke all on function public.parkbuddy_write_state(text,bigint,boolean,double precision,double precision,text,bigint) from public,anon,authenticated;
grant execute on function public.parkbuddy_write_state(text,bigint,boolean,double precision,double precision,text,bigint) to service_role;

-- Shared throttle across Edge Function instances for public upstream services.
create table if not exists public.parkbuddy_service_limits (
  service text primary key,
  next_allowed_at timestamptz not null
);
alter table public.parkbuddy_service_limits enable row level security;
revoke all on public.parkbuddy_service_limits from anon,authenticated;
grant select,insert,update on public.parkbuddy_service_limits to service_role;
create or replace function public.parkbuddy_claim_service_slot(p_service text)
returns boolean language plpgsql security invoker set search_path=public as $function$
begin
  if p_service not in ('routing','geocoding') then return false; end if;
  insert into public.parkbuddy_service_limits(service,next_allowed_at)
  values(p_service,clock_timestamp()+interval '1.05 seconds')
  on conflict(service) do update set next_allowed_at=excluded.next_allowed_at
  where parkbuddy_service_limits.next_allowed_at<=clock_timestamp();
  return found;
end
$function$;
revoke all on function public.parkbuddy_claim_service_slot(text) from public,anon,authenticated;
grant execute on function public.parkbuddy_claim_service_slot(text) to service_role;

-- RC4: existing production application tables are accessed through the Edge API.
begin;
alter table public.cities enable row level security;
alter table public.data_sources enable row level security;
alter table public.source_registry enable row level security;
alter table public.connector_definitions enable row level security;
alter table public.connector_runs enable row level security;
alter table public.data_quality_checks enable row level security;
alter table public.parking_attributes enable row level security;
alter table public.user_parking_signals enable row level security;
revoke all on public.cities,public.data_sources,public.source_registry,public.connector_definitions,public.connector_runs,public.data_quality_checks,public.parking_attributes,public.user_parking_signals from anon,authenticated;
grant select,insert,update,delete on public.cities,public.data_sources,public.source_registry,public.connector_definitions,public.connector_runs,public.data_quality_checks,public.parking_attributes,public.user_parking_signals to service_role;
alter view public.city_coverage_summary set (security_invoker=true);
revoke all on public.city_coverage_summary from anon,authenticated;
grant select on public.city_coverage_summary to service_role;
alter function public.nearby_parking(double precision,double precision,integer,integer) security invoker;
alter function public.nearby_parking(double precision,double precision,integer,integer,text) security invoker;
revoke all on function public.nearby_parking(double precision,double precision,integer,integer), public.nearby_parking(double precision,double precision,integer,integer,text) from public,anon,authenticated;
grant execute on function public.nearby_parking(double precision,double precision,integer,integer), public.nearby_parking(double precision,double precision,integer,integer,text) to service_role;
commit;

-- Extension-owned reference data is not an application API.
revoke all on public.spatial_ref_sys from public,anon,authenticated;
revoke execute on function public.st_estimatedextent(text,text),public.st_estimatedextent(text,text,text),public.st_estimatedextent(text,text,text,boolean) from public,anon,authenticated;
