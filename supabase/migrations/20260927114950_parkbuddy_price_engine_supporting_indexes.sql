create index if not exists idx_connector_definitions_city_id
  on public.connector_definitions(city_id);
create index if not exists idx_data_sources_city_id
  on public.data_sources(city_id);
