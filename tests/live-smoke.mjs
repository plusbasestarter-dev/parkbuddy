import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
const API='https://oespoljjeslpsnhjwsra.supabase.co/functions/v1/parkbuddy-api';
const token='pb2_'+randomBytes(32).toString('hex');
const tokenB='pb2_'+randomBytes(32).toString('hex');
async function request(action,params={},body,credential){
  const r=await fetch(API+'?'+new URLSearchParams({action,...params}),{method:body?'POST':'GET',headers:{...(credential?{'x-parkbuddy-token':credential}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(18000)});
  return {status:r.status,data:await r.json()};
}
const health=await request('health');assert.equal(health.data.version,'1.0.0-rc4');console.log('PASS health rc4');
assert.equal((await request('latest',{device_id:'pb_untrusted_body_identifier'})).status,401);
assert.equal((await request('park',{}, {device_id:'pb_untrusted_body_identifier',lat:52,lon:21})).status,401);console.log('PASS legacy URL/body credentials rejected');
let revision=Date.now();const original={revision,deleted:false,lat:52.2297,lon:21.0122,time:revision,name:'ParkBuddy automated test (synthetic)'};
try{
  assert.equal((await request('park',{}, {...original,lat:null},token)).status,400);
  const saved=await request('park',{},original,token);assert.equal(saved.status,200,JSON.stringify(saved.data));assert.equal(saved.data.state.revision,revision);
  const outsider=await request('latest',{},undefined,tokenB);assert.equal(outsider.data.state,null);console.log('PASS valid save and owner isolation');
  const newer={...original,revision:++revision,lon:21.013};await request('park',{},newer,token);
  const stale=await request('park',{},original,token);assert.equal(stale.data.state.lon,21.013);console.log('PASS late save cannot overwrite newer parking');
  const deleted=await request('park',{}, {revision:++revision,deleted:true},token);assert.equal(deleted.data.state.deleted,true);
  await request('park',{},newer,token);const latest=await request('latest',{},undefined,token);assert.equal(latest.data.state.deleted,true);assert.equal(latest.data.state.lat,null);assert.equal(latest.data.state.lon,null);console.log('PASS deletion survives late save and removes coordinates');
}finally{await request('park',{}, {revision:Math.max(Date.now(),revision+1),deleted:true},token);}
const cities=await request('cities');assert.equal(cities.data.cities.length,18);console.log('PASS 18 cities');
const search=await request('search',{q:'Rynek Główny',city_id:'krakow',lang:'pl'});assert.equal(search.status,200,JSON.stringify(search.data));assert.ok(search.data.places.length);console.log('PASS place search');
const nearby=await request('nearby',{lat:'50.0614',lon:'19.9366',city_id:'krakow',limit:'3'});assert.equal(nearby.status,200);assert.ok(nearby.data.parkings.length);console.log('Walking matrix:',nearby.data.parkings.map(p=>({source:p.walk_source,seconds:p.walk_seconds,distance:p.walk_distance_m})));
assert.equal((await request('nearby')).status,400);console.log('PASS missing coordinates rejected');
