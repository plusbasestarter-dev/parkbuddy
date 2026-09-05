# ParkBuddy Poland

Poland-first parking assistant MVP.

## Stack
- MapLibre + OpenStreetMap
- Nominatim search (prototype)
- OSRM routing (prototype)
- FastAPI
- PostgreSQL + PostGIS
- Render-ready backend
- GitHub Pages-ready frontend

## Data policy
ParkBuddy does not invent parking-availability percentages. Prediction stays disabled until verified Warsaw occupancy/history data is connected.

## Next deployment steps
1. Create PostgreSQL/PostGIS database.
2. Run database/schema.sql.
3. Deploy backend with render.yaml.
4. Set DATABASE_URL and FRONTEND_ORIGIN.
5. Publish frontend through GitHub Pages.
