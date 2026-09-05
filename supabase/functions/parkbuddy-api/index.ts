import { createClient } from 'npm:@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json'
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: cors })
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
    return json({ source: 'ParkBuddy city dataset', city_id: cityId, source_ok: true, fetched_at: new Date().toISOString(), parkings: data || [] })
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
      note: 'Score uses verified/community distance, capacity, data confidence and price availability. It does not claim live occupancy.'
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
