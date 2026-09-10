export const validPoint = (lat,lon) => typeof lat==='number' && typeof lon==='number' && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat)<=90 && Math.abs(lon)<=180;
export function numberParam(params,key) { const value=params.get(key);return value===null||value.trim()===''?NaN:Number(value); }
export async function credentialHash(token) {
  if(!/^pb2_[0-9a-f]{64}$/.test(token||'')&&!/^pb_[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(token||''))return null;
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));
  return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
}
export function validateState(body,now=Date.now()) {
  if(!body||!Number.isSafeInteger(body.revision)||body.revision<=0||body.revision>now+86400000||typeof body.deleted!=='boolean')return false;
  if(body.deleted)return true;
  return validPoint(body.lat,body.lon)&&Number.isSafeInteger(body.time)&&body.time>0&&body.time<=now+86400000&&typeof body.name==='string'&&body.name.length<=240;
}
