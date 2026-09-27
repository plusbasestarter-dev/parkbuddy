alter table public.parking_locations
  add column if not exists price_tariff_kind text,
  add column if not exists price_primary_amount numeric,
  add column if not exists price_primary_duration_minutes integer;

do $$
begin
  if not exists (select 1 from pg_constraint where conname='parking_locations_price_tariff_kind_check') then
    alter table public.parking_locations
      add constraint parking_locations_price_tariff_kind_check
      check (price_tariff_kind is null or price_tariff_kind in ('free','hourly','flat','duration','conditional'));
  end if;
end $$;

alter table public.parking_price_live
  add column if not exists tariff_kind text,
  add column if not exists primary_amount numeric,
  add column if not exists primary_duration_minutes integer;

create or replace function public.parkbuddy_sync_location_prices(p_source_url text default null)
returns integer language plpgsql security invoker set search_path=public as $$
declare v_count integer := 0;
begin
  with affected as (
    select distinct parking_id from public.parking_tariffs
    where valid_to is null and (p_source_url is null or source_url=p_source_url)
  ), ranked as (
    select t.*,row_number() over(partition by t.parking_id order by
      case t.freshness_status when 'current' then 0 when 'due' then 1 when 'review' then 2 when 'stale' then 3 else 4 end,
      case t.verification_level when 'official' then 0 when 'operator' then 1 else 2 end,
      case when t.tariff_kind='hourly' then 0 when t.tariff_kind='free' then 1 when t.tariff_kind='duration' then 2 when t.tariff_kind='flat' then 3 else 4 end,
      t.duration_minutes asc nulls last,t.verified_at desc,t.id desc) rn
    from public.parking_tariffs t join affected a on a.parking_id=t.parking_id
    where t.valid_to is null
  ), best as (select * from ranked where rn=1)
  update public.parking_locations pl set
    price_per_hour=case when b.tariff_kind='free' then 0 when b.tariff_kind='hourly' then b.amount when b.tariff_kind='duration' and b.duration_minutes=60 then b.amount else null end,
    price_tariff_kind=b.tariff_kind,
    price_primary_amount=b.amount,
    price_primary_duration_minutes=b.duration_minutes,
    currency=coalesce(b.currency,pl.currency,'PLN'),
    pricing_status=case when b.tariff_kind='free' then 'free' when b.tariff_kind='hourly' then 'hourly'
      when b.tariff_kind='duration' and b.duration_minutes=60 then 'hourly'
      when b.tariff_kind='flat' then 'flat' else 'conditional' end,
    price_source_url=b.source_url,price_verified_at=b.verified_at,price_verification_level=b.verification_level,
    price_note=b.condition_text,price_freshness_status=b.freshness_status,price_confidence_score=b.confidence_score,
    price_last_checked_at=b.last_checked_at,price_next_check_at=b.next_check_at
  from best b where pl.id=b.parking_id;
  get diagnostics v_count=row_count;
  return v_count;
end $$;

revoke all on function public.parkbuddy_sync_location_prices(text) from public,anon,authenticated;
grant execute on function public.parkbuddy_sync_location_prices(text) to service_role;

create or replace function public.parkbuddy_price_live_trigger()
returns trigger language plpgsql security invoker set search_path=public as $$
begin
  insert into public.parking_price_live(parking_id,city_id,price_per_hour,currency,freshness_status,verification_level,
    verified_at,last_checked_at,next_check_at,tariff_kind,primary_amount,primary_duration_minutes,updated_at)
  values(new.id,new.city_id,new.price_per_hour,new.currency,new.price_freshness_status,new.price_verification_level,
    new.price_verified_at,new.price_last_checked_at,new.price_next_check_at,new.price_tariff_kind,new.price_primary_amount,
    new.price_primary_duration_minutes,now())
  on conflict(parking_id) do update set city_id=excluded.city_id,price_per_hour=excluded.price_per_hour,currency=excluded.currency,
    freshness_status=excluded.freshness_status,verification_level=excluded.verification_level,verified_at=excluded.verified_at,
    last_checked_at=excluded.last_checked_at,next_check_at=excluded.next_check_at,tariff_kind=excluded.tariff_kind,
    primary_amount=excluded.primary_amount,primary_duration_minutes=excluded.primary_duration_minutes,updated_at=now();
  return new;
end $$;

drop trigger if exists trg_parkbuddy_price_live on public.parking_locations;
create trigger trg_parkbuddy_price_live
after insert or update of price_per_hour,currency,price_freshness_status,price_verification_level,price_verified_at,
  price_last_checked_at,price_next_check_at,city_id,price_tariff_kind,price_primary_amount,price_primary_duration_minutes
on public.parking_locations for each row execute function public.parkbuddy_price_live_trigger();

select public.parkbuddy_sync_location_prices(null);
