create index if not exists idx_parking_tariffs_superseded_by
  on public.parking_tariffs(superseded_by)
  where superseded_by is not null;

revoke execute on function public.st_estimatedextent(text,text) from public,anon,authenticated;
revoke execute on function public.st_estimatedextent(text,text,text) from public,anon,authenticated;
revoke execute on function public.st_estimatedextent(text,text,text,boolean) from public,anon,authenticated;
