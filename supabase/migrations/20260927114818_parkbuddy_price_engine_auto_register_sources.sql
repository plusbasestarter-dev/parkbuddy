create or replace function public.parkbuddy_record_tariff(
  p_parking_id text,
  p_tariff_kind text,
  p_amount numeric,
  p_currency text,
  p_duration_minutes integer,
  p_condition_text text,
  p_source_url text,
  p_verification_level text,
  p_verified_at timestamptz default now()
)
returns bigint
language plpgsql
security invoker
set search_path=public
as $$
declare
  v_existing bigint;
  v_new bigint;
  v_conf integer;
  v_interval integer;
begin
  if p_tariff_kind not in ('free','hourly','flat','duration','conditional') then
    raise exception 'invalid tariff kind';
  end if;
  if p_verification_level not in ('official','operator','community') then
    raise exception 'invalid verification level';
  end if;
  if p_source_url is null or p_source_url !~ '^https://' then
    raise exception 'https source required';
  end if;

  v_conf := case p_verification_level when 'official' then 95 when 'operator' then 90 else 65 end;
  v_interval := case p_verification_level when 'official' then 1440 when 'operator' then 360 else 10080 end;

  insert into public.price_source_monitors(
    source_url,authority_level,check_interval_minutes,status,next_check_at,updated_at
  ) values (
    p_source_url,p_verification_level,v_interval,'active',now(),now()
  )
  on conflict(source_url) do update set
    authority_level = case
      when excluded.authority_level='official' then 'official'
      when price_source_monitors.authority_level='official' then 'official'
      when excluded.authority_level='operator' then 'operator'
      else price_source_monitors.authority_level
    end,
    check_interval_minutes = least(price_source_monitors.check_interval_minutes,excluded.check_interval_minutes),
    status = case when price_source_monitors.status='paused' then 'paused' else 'active' end,
    next_check_at = least(price_source_monitors.next_check_at,now()),
    updated_at = now();

  select id into v_existing
  from public.parking_tariffs
  where parking_id=p_parking_id
    and valid_to is null
    and tariff_kind=p_tariff_kind
    and amount is not distinct from p_amount
    and currency=coalesce(p_currency,'PLN')
    and duration_minutes is not distinct from p_duration_minutes
    and condition_text is not distinct from p_condition_text
    and source_url=p_source_url
    and verification_level=p_verification_level
  order by id desc
  limit 1;

  if v_existing is not null then
    update public.parking_tariffs
    set verified_at=p_verified_at,
        last_checked_at=p_verified_at,
        next_check_at=now(),
        freshness_status='current',
        confidence_score=v_conf,
        consecutive_failures=0
    where id=v_existing;
    perform public.parkbuddy_sync_location_prices(p_source_url);
    return v_existing;
  end if;

  insert into public.parking_tariffs(
    parking_id,tariff_kind,amount,currency,duration_minutes,condition_text,
    source_url,verification_level,verified_at,valid_from,last_checked_at,next_check_at,
    freshness_status,confidence_score,consecutive_failures
  ) values (
    p_parking_id,p_tariff_kind,p_amount,coalesce(p_currency,'PLN'),p_duration_minutes,p_condition_text,
    p_source_url,p_verification_level,p_verified_at,p_verified_at,p_verified_at,now(),
    'current',v_conf,0
  ) returning id into v_new;

  update public.parking_tariffs
  set valid_to=p_verified_at, superseded_by=v_new
  where parking_id=p_parking_id
    and id<>v_new
    and valid_to is null
    and (
      (p_tariff_kind in ('free','hourly') and tariff_kind in ('free','hourly'))
      or (p_tariff_kind='duration' and tariff_kind='duration' and duration_minutes is not distinct from p_duration_minutes)
      or (p_tariff_kind='flat' and tariff_kind='flat')
      or (p_tariff_kind='conditional' and tariff_kind='conditional' and condition_text is not distinct from p_condition_text)
    );

  perform public.parkbuddy_sync_location_prices(p_source_url);
  return v_new;
end
$$;

revoke all on function public.parkbuddy_record_tariff(text,text,numeric,text,integer,text,text,text,timestamptz)
  from public,anon,authenticated;
grant execute on function public.parkbuddy_record_tariff(text,text,numeric,text,integer,text,text,text,timestamptz)
  to service_role;
