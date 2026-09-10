export const VERSION = '1.0.0-rc4';
export const CAR_KEY = 'parkbuddy_car_v2';
export const TOKEN_KEY = 'parkbuddy_owner_token';
export const isPoint = p => p && Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;
export function normalizePoint(p) {
  const number = value => (typeof value === 'number' || typeof value === 'string' && value.trim() !== '') ? Number(value) : NaN;
  return {lat:number(p?.lat),lon:number(p?.lon)};
}
export function validRows(value) { return Array.isArray(value) ? value.filter(p => p && isPoint(normalizePoint(p))) : []; }
export function validRoute(r) { return r?.geometry?.type === 'LineString' && Array.isArray(r.geometry.coordinates) && r.geometry.coordinates.length >= 2 && r.geometry.coordinates.every(p => Array.isArray(p) && isPoint({lon:p[0],lat:p[1]})) && Number.isFinite(r.duration) && r.duration >= 0 && Number.isFinite(r.distance) && r.distance >= 0; }
export const isGeneratedName = name => /^Parking\s+(node|way|relation)\s+\d+$/i.test(String(name || ''));
export const escapeHTML = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function parseJSON(value, fallback = null) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
export function normalizeCar(value) {
  if (!value || !Number.isSafeInteger(value.revision) || value.revision <= 0) return null;
  if (value.deleted === true) return {revision:value.revision, deleted:true, pending:!!value.pending};
  const lat = value.lat, lon = value.lon;
  if (!isPoint({lat,lon})) return null;
  return {revision:value.revision, deleted:false, lat, lon, name:String(value.name || value.label || '').slice(0,240), time:Number(value.time) || value.revision, pending:!!value.pending};
}
export function readCar(storage) {
  const raw = storage.getItem(CAR_KEY);
  if (raw !== null) return normalizeCar(parseJSON(raw));
  const legacy = parseJSON(storage.getItem('parkbuddy_car'));
  if (!legacy || !isPoint(legacy)) return null;
  const time = Number(legacy.time) || Date.now();
  return normalizeCar({...legacy, revision:time, pending:true});
}
export function writeCar(storage, value) {
  const car = normalizeCar(value);
  if (!car) throw new Error('Invalid parking state');
  storage.setItem(CAR_KEY, JSON.stringify(car));
  // Once migrated, the old copy must never revive a deleted parking record.
  storage.removeItem('parkbuddy_car');
  return car;
}
export function nextRevision(car, now = Date.now()) { return Math.max(now, (car?.revision || 0) + 1); }
export function reconcileCar(local, remote) {
  local = normalizeCar(local); remote = normalizeCar(remote);
  if (!remote) return local;
  if (!local || remote.revision > local.revision) return {...remote,pending:false};
  if (remote.revision === local.revision) {
    // An acknowledgement is only valid for the same mutation; deletion wins a tie.
    if (local.deleted && !remote.deleted) return local;
    if (remote.deleted || (remote.lat === local.lat && remote.lon === local.lon && remote.name === local.name)) return {...remote,pending:false};
  }
  return local;
}
export function ownerToken(storage, cryptoAPI) {
  const valid = s => /^pb2_[0-9a-f]{64}$/.test(s || '') || /^pb_[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(s || '');
  let token = storage.getItem(TOKEN_KEY);
  if (valid(token)) return token;
  // Existing random UUID credentials keep access to the migrated parking record.
  token = storage.getItem('parkbuddy_device_id');
  if (!valid(token)) token = 'pb2_' + Array.from(cryptoAPI.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2,'0')).join('');
  storage.setItem(TOKEN_KEY,token);
  return token;
}
export function knownPrice(p) {
  if (p.price_per_hour == null || p.price_per_hour === '') return null;
  const n = Number(p.price_per_hour);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
export function walkingMinutes(p) {
  return p.walk_source === 'route' && Number.isFinite(p.walk_seconds) && p.walk_seconds >= 0 ? Math.max(1, Math.ceil(p.walk_seconds / 60)) : null;
}
export function distanceMeters(a,b) {
  if (!isPoint(a) || !isPoint(b)) return null;
  const rad = Math.PI/180, dlat=(b.lat-a.lat)*rad, dlon=(b.lon-a.lon)*rad;
  const h=Math.sin(dlat/2)**2+Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin(dlon/2)**2;
  return 6371000*2*Math.atan2(Math.sqrt(h),Math.sqrt(Math.max(0,1-h)));
}
export function rankParkings(rows, settings = {}) {
  const {budget = 0, pref = 'balanced', maxWalk = 10, vehicle = 'standard'} = settings;
  return validRows(rows).filter(p => !budget || knownPrice(p) === null || knownPrice(p) <= budget).map(p => {
    const minutes = walkingMinutes(p), price = knownPrice(p);
    const distance = Number.isFinite(p.walk_distance_m) ? p.walk_distance_m : (Number(p.distance_m) || 0);
    let score = Math.max(0,55-distance/100);
    if (pref === 'capacity') score += Math.min(Number(p.capacity)||0,1000)/40;
    if (pref === 'balanced') score += Math.min(Number(p.capacity)||0,500)/100;
    if (pref === 'cheap' && price !== null) score += Math.max(0,30-price*2);
    if (pref === 'cheap' && price === null) score -= 30;
    if (minutes !== null && minutes > maxWalk) score -= Math.min(60,(minutes-maxWalk)*5);
    if (vehicle === 'large' && ['underground','multi_storey'].includes(p.parking_type)) score -= 5;
    return {...p, rank_score:score};
  }).sort((a,b) => b.rank_score-a.rank_score || (a.distance_m||0)-(b.distance_m||0));
}
export function navigationURL(point, mode='walking') {
  if (!isPoint(point)) return '#';
  const q=new URLSearchParams({api:'1',destination:`${point.lat},${point.lon}`,travelmode:mode === 'driving' ? 'driving' : 'walking'});
  return 'https://www.google.com/maps/dir/?'+q.toString();
}
