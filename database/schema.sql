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
