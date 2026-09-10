# ParkBuddy Poland

Parking search, driving route previews and walking routes back to a saved car across 18 Polish cities. Languages: Polish, Turkish and English. Current release candidate: **1.0.0-rc4**.

## Application

GitHub Pages serves `index.html` and `assets/` at https://plusbasestarter-dev.github.io/parkbuddy/ . The app calls the existing `parkbuddy-api` Supabase Edge Function. Leaflet 1.9.4 is vendored with its license and needs no WebGL. No frontend build step is required.

Author the root application. `npm run sync:frontend` generates the matching `frontend/` entrypoint. Do not edit that copy separately.

## Validation

- `npm ci`
- `npm test` — core behavior and DOM flow tests; no physical browser or GPS simulation claim.
- `npm run sync:frontend && npm run validate` — mirrored files, entrypoints and syntax.
- `npm run test:live` — live API checks, including synthetic save/delete records with random credentials and coordinate cleanup.

`database/schema.sql` records the original schema plus the applied RC3/RC4 security changes. Earlier multicity schema/RPC migrations are maintained in Supabase migration history; this file alone is not a complete fresh-project bootstrap.

## Deployment

Commit and publish the root application to the existing GitHub Pages main branch. Deploy `supabase/functions/parkbuddy-api/index.ts` with `http.mjs` to the existing project, keeping custom token authentication. Verify both the public frontend assets and API health version after publication.

The Edge Function proxies Nominatim/FOSSGIS, with configurable `PARKBUDDY_GEOCODER_URL`, `PARKBUDDY_WALK_ROUTER_URL` and `PARKBUDDY_DRIVE_ROUTER_URL`. Public upstreams are throttled and have no application SLA. Routing failures retain external navigation links; unknown walking times and prices are explicitly labelled.

Private parking state uses a per-device random credential, sent in a header and hashed on the server. Offline updates carry monotonic revisions; deletion tombstones prevent stale requests from restoring coordinates. Preserve credentials when upgrading existing users. The browser's private key is device access, not an account or cross-device sign-in.
