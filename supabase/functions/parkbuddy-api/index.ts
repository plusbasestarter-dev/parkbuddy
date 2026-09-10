import { createClient } from 'npm:@supabase/supabase-js@2.116.0'
import {validPoint,numberParam,credentialHash,validateState} from './http.mjs'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-parkbuddy-admin-key, x-parkbuddy-token',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store'
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
  const walk_minutes = null // Never present straight-line distance as walking time.
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

  if(!rows.length)throw new Error('No usable parking records; existing locations preserved')
  // Upsert before pruning: a failed upstream or batch can never empty the city.

  for (let i = 0; i < rows.length; i += 400) {
    const chunk = rows.slice(i, i + 400)
    const { error } = await db.from('parking_locations').upsert(chunk, { onConflict: 'id' })
    if (error) throw new Error(error.message)
  }

  // Stale-row removal is deliberately deferred until an atomic refresh is available.
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

const upstreamCache = new Map<string,{expires:number,data:any}>()
const userAgent = 'ParkBuddy/1.0 (https://github.com/plusbasestarter-dev/parkbuddy)'
const walkRouter = (Deno.env.get('PARKBUDDY_WALK_ROUTER_URL') || 'https://routing.openstreetmap.de/routed-foot').replace(/\/$/,'')
const driveRouter = (Deno.env.get('PARKBUDDY_DRIVE_ROUTER_URL') || 'https://routing.openstreetmap.de/routed-car').replace(/\/$/,'')
const geocoder = (Deno.env.get('PARKBUDDY_GEOCODER_URL') || 'https://nominatim.openstreetmap.org/search').replace(/\/$/,'')

async function upstream(db:any,url:string,service:string,ttl=60000) {
  const cached=upstreamCache.get(url)
  if(cached && cached.expires>Date.now())return cached.data
  let allowed=false
  for(let attempt=0;attempt<3;attempt++){
    const slot=await db.rpc('parkbuddy_claim_service_slot',{p_service:service})
    if(slot.error)throw new Error('Upstream unavailable')
    if(slot.data){allowed=true;break}
    if(attempt<2)await new Promise(resolve=>setTimeout(resolve,1100))
  }
  if(!allowed)throw new Error('Upstream temporarily busy')
  const r=await fetch(url,{headers:{'User-Agent':userAgent,'Accept':'application/json'},signal:AbortSignal.timeout(7500)})
  if(!r.ok)throw new Error('Upstream unavailable')
  const data=await r.json()
  if(upstreamCache.size>=150)upstreamCache.delete(upstreamCache.keys().next().value!)
  upstreamCache.set(url,{expires:Date.now()+ttl,data})
  return data
}
function bounded(value:number,min:number,max:number,fallback:number){return Number.isFinite(value)?Math.min(max,Math.max(min,Math.floor(value))):fallback}
function coord(lat:number,lon:number){return lon.toFixed(6)+','+lat.toFixed(6)}
function publicState(s:any){return s?{revision:Number(s.revision),deleted:s.deleted,lat:s.lat,lon:s.lon,name:s.label||'',time:s.recorded_at?new Date(s.recorded_at).getTime():null}:null}
async function addWalking(db:any,rows:any[],lat:number,lon:number){
  if(!rows.length)return rows
  const points=[coord(lat,lon),...rows.map(p=>coord(Number(p.lat),Number(p.lon)))].join(';')
  const sources=rows.map((_,i)=>i+1).join(';')
  try{
    const data=await upstream(db,walkRouter+'/table/v1/foot/'+points+'?sources='+sources+'&destinations=0&annotations=duration,distance','routing',300000)
    if(data.code!=='Ok')throw Error('No walking matrix')
    return rows.map((p,i)=>{
      const seconds=data.durations?.[i]?.[0],distance=data.distances?.[i]?.[0]
      // Reject points snapped too far from their true location.
      const snapped=(data.sources?.[i]?.distance??Infinity)<=100 && (data.destinations?.[0]?.distance??Infinity)<=100
      if(!snapped||typeof seconds!=='number'||!Number.isFinite(seconds)||seconds<0||typeof distance!=='number')return {...p,walk_minutes:null,walk_seconds:null,walk_distance_m:null,walk_source:null}
      return {...p,walk_minutes:Math.max(1,Math.ceil(seconds/60)),walk_seconds:seconds,walk_distance_m:distance,walk_source:'route'}
    })
  }catch{return rows.map(p=>({...p,walk_minutes:null,walk_seconds:null,walk_distance_m:null,walk_source:null}))}
}

Deno.serve(async (req:Request)=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:cors})
  const url=new URL(req.url),action=url.searchParams.get('action')||'health'
  try{
    const secretKeys=JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')||'{}')
    const secret=secretKeys.default||Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const supabaseUrl=Deno.env.get('SUPABASE_URL')
    if(!secret||!supabaseUrl)return json({error:'Server unavailable'},503)
    const db=createClient(supabaseUrl,secret,{auth:{persistSession:false,autoRefreshToken:false}})
    if(action==='health'&&req.method==='GET')return json({ok:true,service:'parkbuddy-poland-edge',version:'1.0.0-rc4'})

    // Location ownership is proven with an unguessable bearer credential in a header.
    // URL/body device IDs are never an authority and are no longer accepted.
    if(action==='park'||action==='latest'){
      const owner=await credentialHash(req.headers.get('x-parkbuddy-token'))
      if(!owner)return json({error:'Private parking credential required'},401)
      if(action==='latest'&&req.method==='GET'){
        const {data,error}=await db.from('parking_state').select('revision,deleted,lat,lon,label,recorded_at').eq('owner_hash',owner).maybeSingle()
        if(error)return json({error:'Parking state unavailable'},503)
        return json({state:publicState(data)})
      }
      if(action==='park'&&req.method==='POST'){
        if(Number(req.headers.get('content-length')||0)>4096)return json({error:'Request too large'},413)
        const raw=await req.text();if(raw.length>4096)return json({error:'Request too large'},413)
        let body:any;try{body=JSON.parse(raw)}catch{return json({error:'Invalid JSON'},400)}
        if(!validateState(body))return json({error:'Invalid parking state'},400)
        const {data,error}=await db.rpc('parkbuddy_write_state',{
          p_owner_hash:owner,p_revision:body.revision,p_deleted:body.deleted,
          p_lat:body.deleted?null:body.lat,p_lon:body.deleted?null:body.lon,
          p_label:body.deleted?null:body.name,p_recorded_ms:body.deleted?null:body.time
        })
        if(error)return json({error:'Parking state could not be saved'},503)
        return json({state:data})
      }
      return json({error:'Method not allowed'},405)
    }
    if(action==='cities'&&req.method==='GET'){
      const {data,error}=await db.from('cities').select('id,name,country_code,lat,lon,status,parking_count').order('name')
      if(error)return json({error:'Cities unavailable'},503)
      return json({cities:data||[]})
    }
    if(action==='official-parking'&&req.method==='GET'){
      const cityId=url.searchParams.get('city_id')||'warszawa'
      const {data,error}=await db.from('parking_locations').select('id,name,city,city_id,parking_type,currency,price_per_hour,lat,lon,capacity,source_updated_at').eq('city_id',cityId).order('name')
      if(error)return json({error:'Parking locations unavailable'},503)
      return json({city_id:cityId,parkings:data||[]})
    }
    if(action==='search'&&req.method==='GET'){
      const q=(url.searchParams.get('q')||'').trim(),cityId=url.searchParams.get('city_id')||'warszawa'
      if(!q||q.length>200)return json({error:'Invalid search'},400)
      const {data:city}=await db.from('cities').select('name,lat,lon').eq('id',cityId).maybeSingle()
      if(!city)return json({error:'Unknown city'},400)
      const lang=['pl','en','tr'].includes(url.searchParams.get('lang')||'')?url.searchParams.get('lang')!:'pl'
      const searchUrl=new URL(geocoder)
      searchUrl.search=new URLSearchParams({format:'jsonv2',limit:'3',countrycodes:'pl','accept-language':lang,q:q+', '+city.name,viewbox:`${city.lon-0.4},${city.lat+0.3},${city.lon+0.4},${city.lat-0.3}`}).toString()
      const places=await upstream(db,searchUrl.toString(),'geocoding',3600000)
      return json({places:Array.isArray(places)?places.map(p=>({lat:Number(p.lat),lon:Number(p.lon),display_name:p.display_name})):[]})
    }
    if((action==='nearby'||action==='plan')&&req.method==='GET'){
      const lat=numberParam(url.searchParams,'lat'),lon=numberParam(url.searchParams,'lon')
      if(!validPoint(lat,lon))return json({error:'Valid coordinates required'},400)
      const radius=bounded(numberParam(url.searchParams,'radius'),250,15000,5000)
      const limit=bounded(numberParam(url.searchParams,'limit'),1,20,12)
      const cityId=url.searchParams.get('city_id')||null
      const {data,error}=await db.rpc('nearby_parking',{p_lat:lat,p_lon:lon,p_radius_m:radius,p_limit:limit,p_city_id:cityId})
      if(error)return json({error:'Nearby parking unavailable'},503)
      const rows=(await addWalking(db,(data||[]).map((p:any)=>scoreParking(p,radius)),lat,lon)).sort((a:any,b:any)=>b.decision_score-a.decision_score||a.distance_m-b.distance_m)
      if(action==='plan')return json({primary:rows[0]||null,plan_b:rows[1]||null,alternatives:rows.slice(2),destination:{lat,lon}})
      return json({parkings:rows,city_id:cityId,destination:{lat,lon},count:rows.length})
    }
    if(action==='route'&&req.method==='GET'){
      const a=numberParam(url.searchParams,'from_lat'),b=numberParam(url.searchParams,'from_lon'),c=numberParam(url.searchParams,'to_lat'),d=numberParam(url.searchParams,'to_lon')
      if(!validPoint(a,b)||!validPoint(c,d))return json({error:'Valid coordinates required'},400)
      const mode=url.searchParams.get('mode');if(mode!=='walking'&&mode!=='driving')return json({error:'Invalid travel mode'},400)
      const router=mode==='walking'?walkRouter:driveRouter,profile=mode==='walking'?'foot':'driving'
      const routeUrl=router+'/route/v1/'+profile+'/'+coord(a,b)+';'+coord(c,d)+'?overview=full&geometries=geojson&steps=false'
      const data=await upstream(db,routeUrl,'routing',60000)
      const route=data.routes?.[0]
      if(data.code!=='Ok'||route?.geometry?.type!=='LineString'||!Array.isArray(route.geometry.coordinates)||route.geometry.coordinates.length<2||!route.geometry.coordinates.every((p:any)=>Array.isArray(p)&&validPoint(p[1],p[0]))||!Number.isFinite(route.duration)||route.duration<0||!Number.isFinite(route.distance)||route.distance<0||!Array.isArray(data.waypoints)||data.waypoints.length!==2||data.waypoints.some((p:any)=>!Number.isFinite(p.distance)||p.distance>100))return json({error:'Route unavailable'},404)
      return json({route:{geometry:route.geometry,duration:route.duration,distance:route.distance},mode})
    }
    if((action==='sync-osm-baseline'||action==='sync-next-baseline')&&req.method==='POST'){
      if(!isAdminRequest(req))return json({error:'Admin only'},403)
      let cityId=url.searchParams.get('city_id')||''
      if(action==='sync-next-baseline'){
        const {data:next}=await db.from('cities').select('id').eq('status','planned').order('name').limit(1).maybeSingle()
        if(!next)return json({ok:true,done:true});cityId=next.id
      }
      if(!cityId)return json({error:'city_id required'},400)
      const result=await syncOsmBaseline(db,cityId,Number(url.searchParams.get('radius')||12000))
      return json(result,(result as any).status||200)
    }
    return json({error:'Not found'},404)
  }catch{return json({error:'Service temporarily unavailable. Please retry.'},503)}
})
