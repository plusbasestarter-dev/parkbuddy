# ParkBuddy Release Candidate Checklist

Status: v1.0.0-rc1
Market: Poland
Scope: bug fixes and release hardening only

## Release rule
No new major features before first release. Only stability, UX clarity, mobile compatibility, and critical bug fixes.

## Core flow QA
- [x] 18 Polish cities are open in the database.
- [x] No planned city remains in the initial Poland rollout.
- [x] City parking counts match actual database rows.
- [x] Nearby parking RPC returns results for Warszawa, Krakow, Poznan, Wroclaw, and Gdansk.
- [x] User-facing technical data terms were removed from the public UI.
- [ ] Manual mobile test: city selector.
- [ ] Manual mobile test: destination search.
- [ ] Manual mobile test: Plan A / Plan B.
- [ ] Manual mobile test: map markers.
- [ ] Manual mobile test: route to parking.
- [ ] Manual mobile test: parked car save and return.
- [ ] Manual mobile test: profile settings persistence.

## Must not show to regular users
- baseline
- official
- community
- dataset
- source
- sync
- coverage
- connector

## User-facing vocabulary
- City
- Destination
- Recommended parking options
- Plan A
- Plan B
- Match score
- Walk time
- Capacity
- Go to parking
- My car
- Settings

## Deferred to v1.1+
- Live occupancy claims
- AI prediction
- Event Mode
- Parking Passport
- Admin dashboard
- B2B API
- Premium payment flow
