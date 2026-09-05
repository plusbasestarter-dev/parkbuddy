import { createClient } from 'npm:@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-parkbuddy-admin-key',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json'
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: cors })
}

function isAdminRequest(req: Request) {
  const adminKey = Deno.env.get('PARKBUDDY_ADMIN_KEY') || ''
  const provided = req.headers.get('x-parkbuddy-admin-key') || ''
  return adminKey.length >= 16 && provided === adminKey
}

function scoreParking(p: any, radius: number) {
  const distance_m = Math.round(Number(p.distance_m || 0))
  const walk_minutes = Math.max(1, Math.round(distance_m / 80))
  const capacity = Math.max(0, Number(p.capacity || 0))
  const proximity = Math.max(0, 1 - distance_m / radius)
  const capacityNorm = Math.min(capacity / 500, 1)
  const verified = p.data_confidence === 'verified' ? 1 : 0
  const priceKnown = p.price_per_hour != null ? 1 : 0
  const decision_score = Math.round(proximity * 55 + capacityNorm * 25 + verified * 10 + priceKnown * 10)
  return {
    ...p,
    distance_m,
    walk_minutes,
    decision_score,
    door_to_door_score: decision_score,
    score_basis: {
      proximity: Math.round(proximity * 55),
      capacity: Math.round(capacityNorm * 25),
      verified: verified * 10,
      price_known: priceKnown * 10,
      proximity_points: Math.round(proximity * 55),
      capacity_points: Math.round(capacityNorm * 25),
      confidence_points: verified * 10 + priceKnown * 10
    },
    availability_probability: null
  }
}

function parkingTypeFromTags(t: Record<string, any>) {
  const parking = String(t.parking || '').toLowerCase()
  if (parking === 'underground') return 'underground'
  if (parking === 'multi-storey' || parking === 'multistorey') return 'multi_storey'
  if (t.park_ride === 'yes' || t.park_and_ride === 'yes') return 'park_and_ride'
  return 'surface'
}

async function syncOsmBaseline(db: any, cityId: string, radiusParam: number) {
  const { data: city, error: cityError } = await db.from('cities')
    .select('id,name,lat,lon,status')
    .eq('id', cityId)
    .maybeSingle()

  if (cityError) throw new Error(cityError.message)
  if (!city) return { error: 'Unknown city', status: 404 }

  const radius = Math.min(Math.max(Number(radiusParam || 12000), 3000), 22000)
  const query = '[out:json][timeout:35];(nwr["amenity"="parking"](around:' + radius + ',' + city.lat + ',' + city.lon + '););out center tags;'

  const response = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': 'ParkBuddy-Poland/0.3 contact: beta'
    },
    body: 'data=' + encodeURIComponent(query)
  })

  if (!response.ok) throw new Error('Overpass HTTP ' + response.status)
  const payload = await response.json()
  const rows: any[] = []
  const seen = new Set<string>()

  for (const e of payload.elements || []) {
    const t = e.tags || {}
    const lat = Number(e.lat ?? e.center?.lat)
    const lon = Number(e.lon ?? e.center?.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue

    const access = String(t.access || '').toLowerCase()
    const parkingTag = String(t.parking || '').toLowerCase()
    const hasName = Boolean(t.name || t.operator || t.brand)
    const capacityRaw = String(t.capacity || '').replace(/[^0-9]/g, '')
    const capacity = capacityRaw ? Number(capacityRaw) : null
    const structured = ['underground', 'multi-storey', 'multistorey'].includes(parkingTag) || t.park_ride === 'yes' || t.park_and_ride === 'yes'
    const streetLike = ['street_side', 'lane', 'on_street'].includes(parkingTag)
    const publicEnough = !['private', 'no', 'customers'].includes(access)
    const useful = hasName || structured || (capacity != null && capacity >= 10) || t.fee === 'yes'

    if (!publicEnough || streetLike || !useful) continue

    const id = 'OSM_' + e.type + '_' + e.id
    if (seen.has(id)) continue
    seen.add(id)

    rows.push({
      id,
      city: city.name,
      country_code: 'PL',
      city_id: city.id,
      name: String(t.name || t.operator || t.brand || ('Parking ' + e.type + ' ' + e.id)).slice(0, 200),
      parking_type: parkingTypeFromTags(t),
      currency: 'PLN',
      price_per_hour: null,
      lat,
      lon,
      source: 'OpenStreetMap',
      source_updated_at: new Date().toISOString(),
      capacity,
      official_url: 'https://www.openstreetmap.org/' + e.type + '/' + e.id,
      data_confidence: 'community'
    })
  }

  const { error: deleteError } = await db.from('parking_locations')
    .delete()
    .eq('city_id', city.id)
    .eq('source', 'OpenStreetMap')
  if (deleteError) throw new Error(deleteError.message)

  for (let i = 0; i < rows.length; i += 400) {
    const chunk = rows.slice(i, i + 400)
    const { error } = await db.from('parking_locations').upsert(chunk, { onConflict: 'id' })
    if (error) throw new Error(error.message)
  }

  const { count } = await db.from('parking_locations')
    .select('id', { count: 'exact', head: true })
    .eq('city_id', city.id)

  await db.from('cities').update({
    parking_count: count || rows.length,
    status: city.id === 'warszawa' ? 'active' : 'baseline',
    coverage_tier: city.id === 'warszawa' ? 'official' : 'baseline',
    updated_at: new Date().toISOString()
  }).eq('id', city.id)

  return { ok: true, city_id: city.id, city: city.name, synced: rows.length, total: count || rows.length, source: 'OpenStreetMap' }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const url = new URL(req.url)
  const action = url.searchParams.get('action') || 'health'

  const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}')
  const secret = secretKeys['default'] || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  if (!secret || !supabaseUrl) return json({ ok: false, error: 'Server credentials unavailable' }, 500)

  const db = createClient(supabaseUrl, secret)

  if (action === 'health' && req.method === 'GET') {
    return json({ ok: true, service: 'parkbuddy-poland-edge', scope: 'poland-multicity' })
  }

  if (action === 'cities' && req.method === 'GET') {
    const { data, error } = await db.from('cities')
      .select('id,name,country_code,lat,lon,status,parking_count,live_data_status,coverage_tier')
      .order('parking_count', { ascending: false })
      .order('name', { ascending: true })
    if (error) return json({ error: error.message }, 500)
    return json({ country: 'PL', cities: data || [] })
  }

  if (action === 'official-parking' && req.method === 'GET') {
    const cityId = url.searchParams.get('city_id') || 'warszawa'
    const { data, error } = await db.from('parking_locations')
      .select('id,name,city,city_id,parking_type,currency,price_per_hour,lat,lon,capacity,official_url,data_confidence,source,source_updated_at')
      .eq('city_id', cityId)
      .order('name', { ascending: true })
    if (error) return json({ error: error.message }, 500)
    return json({ city_id: cityId, fetched_at: new Date().toISOString(), parkings: data || [] })
  }

  if (action === 'sync-osm-baseline' && req.method === 'POST') {
    if (!isAdminRequest(req)) return json({ error: 'Admin only' }, 403)
    try {
      const cityId = url.searchParams.get('city_id') || ''
      if (!cityId) return json({ error: 'city_id required' }, 400)
      const radius = Number(url.searchParams.get('radius') || 12000)
      const result = await syncOsmBaseline(db, cityId, radius)
      if ((result as any).status) return json({ error: (result as any).error }, (result as any).status)
      return json(result)
    } catch (error) {
      return json({ error: String(error) }, 500)
    }
  }

  if (action === 'sync-next-baseline' && req.method === 'POST') {
    if (!isAdminRequest(req)) return json({ error: 'Admin only' }, 403)
    try {
      const { data: nextCity, error } = await db.from('cities')
        .select('id,name')
        .eq('status', 'planned')
        .order('name', { ascending: true })
        .limit(1)
        .maybeSingle()
      if (error) return json({ error: error.message }, 500)
      if (!nextCity) return json({ ok: true, done: true, message: 'No planned cities remain' })
      const result = await syncOsmBaseline(db, nextCity.id, 12000)
      return json(result)
    } catch (error) {
      return json({ error: String(error) }, 500)
    }
  }

  if (action === 'nearby' && req.method === 'GET') {
    const lat = Number(url.searchParams.get('lat'))
    const lon = Number(url.searchParams.get('lon'))
    const radius = Math.min(Math.max(Number(url.searchParams.get('radius') || 5000), 250), 15000)
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 8), 1), 20)
    const cityId = url.searchParams.get('city_id') || null
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return json({ error: 'lat and lon are required' }, 400)

    const { data, error } = await db.rpc('nearby_parking', {
      p_lat: lat,
      p_lon: lon,
      p_radius_m: radius,
      p_limit: limit,
      p_city_id: cityId
    })
    if (error) return json({ error: error.message }, 500)

    const rows = (data || []).map((p: any) => scoreParking(p, radius))
      .sort((a: any, b: any) => b.decision_score - a.decision_score || a.distance_m - b.distance_m)

    return json({
      destination: { lat, lon },
      city_id: cityId,
      radius_m: radius,
      count: rows.length,
      parkings: rows,
      score_version: 'door-to-door-v1',
      note: 'Score uses distance, capacity, data confidence and price availability. It does not claim live occupancy.'
    })
  }

  if (action === 'plan' && req.method === 'GET') {
    const lat = Number(url.searchParams.get('lat'))
    const lon = Number(url.searchParams.get('lon'))
    const radius = Math.min(Math.max(Number(url.searchParams.get('radius') || 5000), 500), 15000)
    const cityId = url.searchParams.get('city_id') || null
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return json({ error: 'lat and lon are required' }, 400)

    const { data, error } = await db.rpc('nearby_parking', {
      p_lat: lat,
      p_lon: lon,
      p_radius_m: radius,
      p_limit: 12,
      p_city_id: cityId
    })
    if (error) return json({ error: error.message }, 500)

    const scored = (data || []).map((p: any) => scoreParking(p, radius))
      .sort((a: any, b: any) => b.door_to_door_score - a.door_to_door_score || a.distance_m - b.distance_m)

    return json({
      destination: { lat, lon },
      city_id: cityId,
      primary: scored[0] || null,
      plan_b: scored[1] || null,
      alternatives: scored.slice(2, 6),
      score_version: 'door-to-door-v1',
      disclaimer: 'This is not live occupancy prediction.'
    })
  }

  if (action === 'park' && req.method === 'POST') {
    const body = await req.json().catch(() => null)
    if (!body || typeof body.device_id !== 'string' || body.device_id.length < 8) return json({ error: 'Invalid device_id' }, 400)
    const lat = Number(body.lat)
    const lon = Number(body.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return json({ error: 'Invalid coordinates' }, 400)
    const { data, error } = await db.from('parking_sessions').insert({
      device_id: body.device_id.slice(0, 128),
      label: typeof body.label === 'string' ? body.label.slice(0, 240) : null,
      lat,
      lon
    }).select('id,device_id,label,lat,lon,started_at').single()
    if (error) return json({ error: error.message }, 500)
    return json(data, 201)
  }

  if (action === 'latest' && req.method === 'GET') {
    const deviceId = url.searchParams.get('device_id') || ''
    if (deviceId.length < 8) return json({ error: 'Invalid device_id' }, 400)
    const { data, error } = await db.from('parking_sessions')
      .select('id,device_id,label,lat,lon,started_at')
      .eq('device_id', deviceId)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) return json({ error: error.message }, 500)
    if (!data) return json({ error: 'No parking session' }, 404)
    return json(data)
  }

  return json({ error: 'Not found' }, 404)
})
