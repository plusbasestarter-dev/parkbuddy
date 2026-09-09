# ParkBuddy RC2 Bug Audit

Date: 2026-09-05
Status: RC2 stability patch applied

## Scope

This audit focused on release-blocking stability and safety issues after the first security pass.

Checked areas:

- Frontend rendering safety
- City switching lifecycle
- Map marker lifecycle
- Route flow
- My Car localStorage flow
- Backend city coverage
- Nearby recommendation RPC
- Public/admin API boundary

## Already fixed in previous pass

- User-facing dynamic values are escaped before being inserted into HTML strings.
- City selector options are created through DOM APIs rather than interpolated HTML.
- MapLibre popup rendering no longer uses `setHTML`; it uses DOM nodes.
- `sync-osm-baseline` and `sync-next-baseline` are admin-only.
- Invalid selected parking no longer silently opens an empty detail screen.
- API public health and cities endpoints still return 200.
- Public sync call without admin key returns 403.

## Backend/RPC test result

All 18 active Poland cities returned nearby recommendations from their city-center coordinates.

Expected output target: 12 nearby rows per city.
Actual result: 12 nearby rows for every city below:

- Białystok
- Bydgoszcz
- Gdańsk
- Gorzów Wielkopolski
- Katowice
- Kielce
- Kraków
- Łódź
- Lublin
- Olsztyn
- Opole
- Poznań
- Rzeszów
- Szczecin
- Toruń
- Warszawa
- Wrocław
- Zielona Góra

Conclusion: backend recommendation coverage is acceptable for RC.

## RC2 frontend stability patch

The RC2 stability patch is now applied on `main`:

- [x] Corrupted `parkbuddy_car` localStorage is handled safely and invalid values are removed.
- [x] Repeated locate calls replace the previous user marker instead of stacking markers.
- [x] City changes clear stale destination, selected parking, nearby recommendations, and plan UI.
- [x] MapLibre availability is guarded with a user-facing error.
- [x] OSRM route geometry is validated before opening/drawing the route.

## Release recommendation

The RC2 web stability patch is complete. No new major feature should be added before the first release.

Proceed to device testing on:

- iPhone Safari
- Android Chrome
- Android WebView / PWA wrapper
