# ParkBuddy RC4 verification — 2026-09-10

## Completed

- Recovered the unpublished RC3 frontend and aligned it with the already deployed token-based Edge API.
- Replaced MapLibre/WebGL with locally bundled Leaflet 1.9.4; map sizing and map failure notices are handled in every tab.
- Added a useful empty My Car state, GPS or map-based saving, keyboard-accessible map-centre selection, walking return routes and external navigation fallback.
- Local state renders before networking. Revisions and deletion tombstones prevent stale cloud saves from resurrecting deleted coordinates. Pending mutations retry with backoff.
- Fixed history-based back navigation, stale city/search responses, cancelled GPS actions, map-independent route summaries and corrupt cached data handling.
- Added Polish/Turkish/English throughout, clearer parking names, larger controls and a wider desktop layout.
- Budget applies in every priority; unavailable EV/feedback promises removed; walking times require a real pedestrian routing result.
- Multiple geocoder matches are presented for selection. Search loading states and retry actions are available.
- Root and frontend entrypoints are generated together. Offline shell caches are scoped and versioned; private API responses and map tiles are never cached.
- Protected application tables and coverage view from direct client access; restricted nearby RPCs to the backend role. Existing private parking state uses hashed per-device credentials.
- Hardened server validation and upstream throttling. An empty OSM import no longer clears an existing city list; stale import-row pruning is deferred pending an atomic refresh implementation.

## Evidence

- 24 automated tests pass (18 core and 6 DOM flow tests).
- Application entrypoints, mirrored assets and JavaScript syntax pass validation.
- Live RC4 API: save, latest, owner isolation, invalid input, out-of-order saves, deletion and late-save rejection pass using synthetic test data. Coordinates removed after testing.
- Live search and pedestrian time/distance matrix return results.
- All 18 cities return 12 nearby results from city centres after database hardening.

These are unit/DOM simulation and live API checks, not physical device or visual browser certification.

## Remaining limitations

- Physical iPhone Safari and Android Chrome GPS, touch, and background/resume checks remain.
- Public Nominatim/FOSSGIS/OSM services have no application SLA. Prices and live occupancy remain incomplete/unverified and the UI says so.
- The pre-existing PostGIS public.spatial_ref_sys table is owned by supabase_admin. Its direct client grants remain despite an attempted REVOKE by the available postgres role. This does not expose private parking rows, but is a remaining database configuration issue requiring the owning administrator/Supabase support. No role escalation or extension relocation was attempted. See https://supabase.com/docs/guides/database/database-linter?lint=0013_rls_disabled_in_public .
- PostGIS/pg_net remain in the public schema; extension relocation should be handled as a separately verified infrastructure change. See https://supabase.com/docs/guides/database/database-linter?lint=0014_extension_in_public .
- Frontend publication to both main and a review branch was blocked by automatic approval review, which requires explicit authorization for uploading code to this GitHub destination. RC4 server and application security changes are deployed; frontend changes are completed locally.
