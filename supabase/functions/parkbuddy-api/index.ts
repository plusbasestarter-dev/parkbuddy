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
    .select('id,name,parking_type,currency,price_per_hour,lat,lon,capacity,official_url,data_confidence')
    .in('id', ['WAW_ZDM_WARYNSKIEGO','WAW_ZDM_KRASINSKICH'])

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

  if (action === 'official-parking' && req.method === 'GET') {
    try {
      return json(await fetchOfficialParking(db))
    } catch (error) {
      return json({ error: String(error) }, 500)
    }
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