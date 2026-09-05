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


async function fetchOfficialParking(db: any) {
  const sourceUrl = 'https://zdm.waw.pl/sprawy/parkowanie/parkingi-podziemne/'
  let live: Record<string, number | null> = {
    WAW_ZDM_WARYNSKIEGO: null,
    WAW_ZDM_KRASINSKICH: null
  }
  let sourceOk = false

  try {
    const response = await fetch(sourceUrl, {
      headers: { 'User-Agent': 'ParkBuddy/0.1 Warsaw beta' }
    })
    sourceOk = response.ok
    const html = await response.text()
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;|&#160;/g, ' ')
      .replace(/\s+/g, ' ')

    const wary = text.match(/Parking pod ulicą Waryńskiego[\s\S]{0,2000}?Wolne miejsca[\s\S]{0,400}?Parking ikona\s*(\d{1,4})/i)
      || text.match(/Parking pod ul\. Waryńskiego[\s\S]{0,2000}?Wolne miejsca[\s\S]{0,400}?Parking ikona\s*(\d{1,4})/i)
    const kras = text.match(/Parking pod placem Krasińskich[\s\S]{0,2000}?Wolne miejsca[\s\S]{0,400}?Parking ikona\s*(\d{1,4})/i)

    if (wary) live.WAW_ZDM_WARYNSKIEGO = Number(wary[1])
    if (kras) live.WAW_ZDM_KRASINSKICH = Number(kras[1])

    if (live.WAW_ZDM_WARYNSKIEGO == null || live.WAW_ZDM_KRASINSKICH == null) {
      const nums = [...text.matchAll(/Parking ikona\s*(\d{1,4})/gi)].map((m) => Number(m[1]))
      if (live.WAW_ZDM_WARYNSKIEGO == null && nums.length > 0) live.WAW_ZDM_WARYNSKIEGO = nums[0]
      if (live.WAW_ZDM_KRASINSKICH == null && nums.length > 1) live.WAW_ZDM_KRASINSKICH = nums[1]
    }
  } catch (_) {}

  const { data, error } = await db.from('parking_locations')
    .select('id,name,parking_type,currency,price_per_hour,lat,lon,capacity,official_url,data_confidence,source')
    .order('name', { ascending: true })

  if (error) throw error

  return {
    source: 'ZDM Warszawa',
    source_url: sourceUrl,
    source_ok: sourceOk,
    fetched_at: new Date().toISOString(),
    parkings: (data || []).map((p: any) => ({
      ...p,
      free_spaces: live[p.id] ?? null,
      occupancy_percent:
        live[p.id] != null && p.capacity
          ? Math.round((1 - Number(live[p.id]) / Number(p.capacity)) * 1000) / 10
          : null,
      live: live[p.id] != null
    }))
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

  if (action === 'cities' && req.method === 'GET') {
    const { data, error } = await db.from('cities')
      .select('id,name,country_code,lat,lon,status,parking_count,live_data_status')
      .order('parking_count', { ascending: false })
      .order('name', { ascending: true })
    if (error) return json({ error: error.message }, 500)
    return json({ country: 'PL', cities: data || [] })
  }

  if (action === 'health' && req.method === 'GET') {
    return json({ ok: true, service: 'parkbuddy-poland-edge', city: 'Warszawa' })
  }

  if (action === 'rules' && req.method === 'GET') {
    return json({
      city: 'Warszawa',
      currency: 'PLN',
      paid_days: ['mon','tue','wed','thu','fri'],
      paid_hours: { from: '08:00', to: '20:00' },
      hourly: [4.50, 5.40, 6.40],
      subsequent_hour: 4.50,
      status: 'baseline_v1'
    })
  }

  if (action === 'sync-official-static' && req.method === 'POST') {
    try {
      const sources = [
        {
          prefix: 'WAW_PR_',
          type: 'park_and_ride',
          source: 'Warsaw ArcGIS parkingi_P_R',
          url: 'https://services7.arcgis.com/gpQ1tnydOYYnGpcS/ArcGIS/rest/services/parkingi_P_R/FeatureServer/0/query?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&f=json'
        },
        {
          prefix: 'WAW_ZTP_',
          type: 'municipal',
          source: 'Warsaw ArcGIS Parkingi_ZTP_punkty',
          url: 'https://services7.arcgis.com/gpQ1tnydOYYnGpcS/ArcGIS/rest/services/Parkingi_ZTP_punkty/FeatureServer/0/query?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&f=json'
        }
      ]

      let rows: any[] = []
      for (const src of sources) {
        const response = await fetch(src.url)
        if (!response.ok) throw new Error(src.source + ' HTTP ' + response.status)
        const payload = await response.json()
        for (const feature of payload.features || []) {
          const a = feature.attributes || {}
          const g = feature.geometry || {}
          const objectId = Number(a.OBJECTID)
          const name = String(a['Nazwa'] || '').trim()
          const capacity = Number(a['Liczba_miejsc'] ?? a['Liczba_mie'])
          const lon = Number(g.x)
          const lat = Number(g.y)
          if (!objectId || !name || !Number.isFinite(lon) || !Number.isFinite(lat)) continue

          rows.push({
            id: src.prefix + objectId,
            city: 'Warszawa',
            country_code: 'PL',
            name,
            parking_type: src.type,
            currency: 'PLN',
            price_per_hour: null,
            lat,
            lon,
            source: src.source,
            source_updated_at: new Date().toISOString(),
            capacity: Number.isFinite(capacity) ? capacity : null,
            official_url: src.url,
            data_confidence: 'verified'
          })
        }
      }

      const { error } = await db.from('parking_locations').upsert(rows, { onConflict: 'id' })
      if (error) return json({ error: error.message }, 500)
      return json({ ok: true, synced: rows.length })
    } catch (error) {
      return json({ error: String(error) }, 500)
    }
  }

  if (action === 'official-parking' && req.method === 'GET') {
    try {
      const cityId = url.searchParams.get('city_id')
      if (!cityId || cityId === 'warszawa') return json(await fetchOfficialParking(db))
      const { data, error } = await db.from('parking_locations')
        .select('id,name,parking_type,currency,price_per_hour,lat,lon,capacity,official_url,data_confidence,source,city_id')
        .eq('city_id', cityId)
        .order('name', { ascending: true })
      if (error) return json({ error: error.message }, 500)
      return json({ source: 'ParkBuddy city dataset', source_ok: true, fetched_at: new Date().toISOString(), parkings: data || [] })
    } catch (error) {
      return json({ error: String(error) }, 500)
    }
  }

  if (action === 'sync-osm-baseline' && req.method === 'POST') {
    const cityId = url.searchParams.get('city_id') || ''
    if (!cityId) return json({ error: 'city_id required' }, 400)

    const { data: city, error: cityError } = await db.from('cities')
      .select('id,name,lat,lon,status')
      .eq('id', cityId)
      .maybeSingle()
    if (cityError) return json({ error: cityError.message }, 500)
    if (!city) return json({ error: 'Unknown city' }, 404)

    const radius = Math.min(Math.max(Number(url.searchParams.get('radius') || 12000), 3000), 20000)
    const query = '[out:json][timeout:35];(nwr["amenity"="parking"](around:' + radius + ',' + city.lat + ',' + city.lon + '););out center tags;'

    try {
      const response = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'User-Agent': 'ParkBuddy-Poland/0.2' },
        body: 'data=' + encodeURIComponent(query)
      })
      if (!response.ok) return json({ error: 'Overpass HTTP ' + response.status }, 502)
      const payload = await response.json()
      const rows:any[] = []

      for (const e of payload.elements || []) {
        const t = e.tags || {}
        const lat = Number(e.lat ?? e.center?.lat)
        const lon = Number(e.lon ?? e.center?.lon)
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue

        let parkingType = 'surface'
        if (t.parking === 'underground') parkingType = 'underground'
        else if (t.parking === 'multi-storey') parkingType = 'multi_storey'
        else if (t.park_ride === 'yes' || t.park_and_ride === 'yes') parkingType = 'park_and_ride'

        const capacityRaw = String(t.capacity || '').replace(/[^0-9]/g, '')
        const capacity = capacityRaw ? Number(capacityRaw) : null
        const name = String(t.name || t.operator || ('Parking ' + e.type + ' ' + e.id)).slice(0, 200)

        rows.push({
          id: 'OSM_' + e.type + '_' + e.id,
          city: city.name,
          country_code: 'PL',
          city_id: city.id,
          name,
          parking_type: parkingType,
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

      if (!rows.length) return json({ ok: true, synced: 0, city_id: city.id })

      const chunks = []
      for (let i=0;i<rows.length;i+=400) chunks.push(rows.slice(i,i+400))
      for (const chunk of chunks) {
        const { error } = await db.from('parking_locations').upsert(chunk, { onConflict: 'id' })
        if (error) return json({ error: error.message }, 500)
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

      return json({ ok: true, city_id: city.id, city: city.name, synced: rows.length, total: count || rows.length, source: 'OpenStreetMap' })
    } catch (error) {
      return json({ error: String(error) }, 500)
    }
  }

  if (action === 'snapshot' && req.method === 'POST') {
    try {
      const { data: latestRows, error: latestError } = await db
        .from('parking_snapshots')
        .select('captured_at')
        .order('captured_at', { ascending: false })
        .limit(1)

      if (latestError) return json({ error: latestError.message }, 500)

      const latestAt = latestRows?.[0]?.captured_at ? new Date(latestRows[0].captured_at).getTime() : 0
      if (latestAt && Date.now() - latestAt < 4 * 60 * 1000) {
        return json({ ok: true, skipped: true, reason: 'Snapshot captured recently' })
      }

      const live = await fetchOfficialParking(db)
      const rows = (live.parkings || [])
        .filter((p: any) => p.free_spaces != null && p.capacity != null)
        .map((p: any) => ({
          parking_id: p.id,
          captured_at: new Date().toISOString(),
          free_spaces: p.free_spaces,
          capacity: p.capacity,
          occupancy_percent: p.occupancy_percent,
          source: 'ZDM Warszawa'
        }))

      if (!rows.length) {
        return json({ ok: false, inserted: 0, reason: 'No verified live values available' }, 503)
      }

      const { error: insertError } = await db.from('parking_snapshots').insert(rows)
      if (insertError) return json({ error: insertError.message }, 500)

      return json({
        ok: true,
        inserted: rows.length,
        captured_at: rows[0].captured_at,
        parking_ids: rows.map((r: any) => r.parking_id)
      })
    } catch (error) {
      return json({ error: String(error) }, 500)
    }
  }

  if (action === 'history' && req.method === 'GET') {
    const parkingId = url.searchParams.get('parking_id') || ''
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 48), 1), 288)
    if (!parkingId) return json({ error: 'parking_id required' }, 400)

    const { data, error } = await db
      .from('parking_snapshots')
      .select('parking_id,captured_at,free_spaces,capacity,occupancy_percent,source')
      .eq('parking_id', parkingId)
      .order('captured_at', { ascending: false })
      .limit(limit)

    if (error) return json({ error: error.message }, 500)
    return json({ parking_id: parkingId, count: data?.length || 0, snapshots: data || [] })
  }

  if (action === 'nearby' && req.method === 'GET') {
    const lat = Number(url.searchParams.get('lat'))
    const lon = Number(url.searchParams.get('lon'))
    const radius = Math.min(Math.max(Number(url.searchParams.get('radius') || 5000), 250), 15000)
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 8), 1), 20)

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return json({ error: 'lat and lon are required' }, 400)
    }

    const cityId = url.searchParams.get('city_id') || null
    const { data, error } = await db.rpc('nearby_parking', {
      p_lat: lat,
      p_lon: lon,
      p_radius_m: radius,
      p_limit: limit,
      p_city_id: cityId
    })

    if (error) return json({ error: error.message }, 500)

    const rows = (data || []).map((p: any) => {
      const distance_m = Math.round(Number(p.distance_m || 0))
      const walk_minutes = Math.max(1, Math.round(distance_m / 80))
      const capacity = Math.max(0, Number(p.capacity || 0))

      const proximityPoints = Math.max(0, 1 - distance_m / radius) * 65
      const capacityPoints = Math.min(capacity / 500, 1) * 30
      const confidencePoints = p.data_confidence === 'verified' ? 5 : 0
      const decision_score = Math.round(proximityPoints + capacityPoints + confidencePoints)

      let recommendation = 'nearby'
      if (decision_score >= 80) recommendation = 'best_candidate'
      else if (decision_score >= 65) recommendation = 'strong_candidate'
      else if (p.parking_type === 'park_and_ride') recommendation = 'park_and_ride'

      return {
        ...p,
        distance_m,
        walk_minutes,
        decision_score,
        score_basis: {
          proximity_points: Math.round(proximityPoints),
          capacity_points: Math.round(capacityPoints),
          confidence_points: Math.round(confidencePoints)
        },
        recommendation,
        availability_probability: null
      }
    }).sort((a: any, b: any) =>
      b.decision_score - a.decision_score || a.distance_m - b.distance_m
    )

    return json({
      destination: { lat, lon },
      radius_m: radius,
      count: rows.length,
      parkings: rows,
      score_version: 'decision-v1',
      score_weights: { proximity: 65, capacity: 30, verified_data: 5 },
      note: 'ParkBuddy Score is a transparent decision score, not an availability prediction. Live occupancy is not included yet.'
    })
  }

  if (action === 'plan' && req.method === 'GET') {
    const lat = Number(url.searchParams.get('lat'))
    const lon = Number(url.searchParams.get('lon'))
    const radius = Math.min(Math.max(Number(url.searchParams.get('radius') || 5000), 500), 15000)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return json({ error: 'lat and lon are required' }, 400)

    const cityId = url.searchParams.get('city_id') || null
    const { data, error } = await db.rpc('nearby_parking', {
      p_lat: lat, p_lon: lon, p_radius_m: radius, p_limit: 12, p_city_id: cityId
    })
    if (error) return json({ error: error.message }, 500)

    const scored = (data || []).map((p:any) => {
      const distance_m = Math.round(Number(p.distance_m || 0))
      const walk_minutes = Math.max(1, Math.round(distance_m / 80))
      const capacity = Math.max(0, Number(p.capacity || 0))
      const proximity = Math.max(0, 1 - distance_m / radius)
      const capacityNorm = Math.min(capacity / 500, 1)
      const verified = p.data_confidence === 'verified' ? 1 : 0
      const priceKnown = p.price_per_hour != null ? 1 : 0
      const door_to_door_score = Math.round(proximity*55 + capacityNorm*25 + verified*10 + priceKnown*10)
      return {...p,distance_m,walk_minutes,door_to_door_score,
        score_basis:{proximity:Math.round(proximity*55),capacity:Math.round(capacityNorm*25),verified:verified*10,price_known:priceKnown*10}}
    }).sort((a:any,b:any)=>b.door_to_door_score-a.door_to_door_score || a.distance_m-b.distance_m)

    return json({
      destination:{lat,lon},
      primary:scored[0] || null,
      plan_b:scored[1] || null,
      alternatives:scored.slice(2,6),
      score_version:'door-to-door-v1',
      disclaimer:'Score uses verified distance, capacity, data confidence and price availability. It does not claim live occupancy.'
    })
  }

  if (action === 'prediction' && req.method === 'GET') {
    return json({
      available: false,
      reason: 'Insufficient verified Warsaw parking occupancy data',
      model: null
    })
  }

  if (action === 'park' && req.method === 'POST') {
    const body = await req.json().catch(() => null)
    if (!body || typeof body.device_id !== 'string' || body.device_id.length < 8) {
      return json({ error: 'Invalid device_id' }, 400)
    }
    const lat = Number(body.lat)
    const lon = Number(body.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return json({ error: 'Invalid coordinates' }, 400)
    }
    const { data, error } = await db.from('parking_sessions').insert({
      device_id: body.device_id.slice(0, 128),
      label: typeof body.label === 'string' ? body.label.slice(0, 240) : null,
      lat, lon
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