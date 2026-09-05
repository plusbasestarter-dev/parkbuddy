# ParkBuddy Poland

Poland-first parking assistant MVP focused on Warsaw.

## Live architecture
- Frontend: MapLibre + OpenStreetMap
- Search: Nominatim (beta)
- Routing: OSRM public demo service (beta)
- API: Supabase Edge Functions
- Database: Supabase PostgreSQL + PostGIS
- Source control: GitHub

## Database
The project uses:
- parking_sessions
- parking_locations
- parking_snapshots

PostGIS is enabled and ParkBuddy tables have RLS enabled. Browser clients do not access the database directly; the Edge Function performs controlled server-side operations.

## Data policy
ParkBuddy does not invent parking availability percentages. Prediction remains unavailable until verified Warsaw historical/live occupancy data is connected.

## Production gaps
Public OSM, Nominatim and OSRM endpoints are used only for beta testing. Before public launch these must be replaced with compliant/self-hosted or contracted providers, and API rate limiting/monitoring must be added.
