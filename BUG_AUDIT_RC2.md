# ParkBuddy RC2 Bug Audit

Date: 2026-09-05
Status: Release-candidate hardening

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

## Remaining frontend stability risks

These are not data blockers, but they should be patched before App Store / Play Store submission.

### 1. Corrupted localStorage can break My Car

Current risk:

- `JSON.parse(localStorage.getItem('parkbuddy_car') || 'null')` can throw if the stored value is malformed.

Fix:

- Add a `safeParse()` helper.
- Remove corrupted `parkbuddy_car` values automatically.

Severity: Medium
Priority: High before mobile release

### 2. Repeated locate() calls can stack user markers

Current risk:

- Every location request creates a new marker.
- Repeated use may leave multiple blue dots on the map.

Fix:

- Track `userMarker` globally.
- Remove the old marker before adding a new one.

Severity: Low/Medium
Priority: High before mobile release

### 3. City change should clear stale destination context

Current risk:

- Changing city updates parkings and map center, but previously searched `dest` and `window.__nearby` can remain in memory.
- If the user returns to choices/detail after changing city, stale recommendation context may be confusing.

Fix:

- Clear `dest`, `selectedParking`, `window.__nearby`, `decisionPlan`, and `nearbyList` on city change.

Severity: Medium
Priority: High before mobile release

### 4. MapLibre unavailable should fail gracefully

Current risk:

- If the CDN fails, map initialization can break the flow.

Fix:

- Check `window.maplibregl` before creating maps.
- Show a user-friendly toast instead of failing silently.

Severity: Medium
Priority: Medium

### 5. Route geometry needs a stronger guard

Current risk:

- If OSRM returns a response without usable geometry, drawing the route can fail after navigating to the route screen.

Fix:

- Validate `routes[0].geometry` before opening the route screen.
- Show `Rota bulunamadı` if missing.

Severity: Medium
Priority: Medium

## Release recommendation

ParkBuddy is close to publishable as an MVP, but before store submission the next patch should be:

`rc2-stability-patch`

Patch contents:

- safe localStorage parsing
- user marker cleanup
- stale city context cleanup
- MapLibre availability guard
- route geometry guard

After that, proceed to device testing on:

- iPhone Safari
- Android Chrome
- Android WebView / PWA wrapper
