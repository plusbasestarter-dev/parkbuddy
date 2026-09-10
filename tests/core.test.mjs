import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizePoint,validRows,validRoute,CAR_KEY,normalizeCar,readCar,writeCar,reconcileCar,nextRevision,ownerToken,rankParkings,walkingMinutes,knownPrice,isGeneratedName,navigationURL} from '../assets/core.mjs';
import {credentialHash,validateState,numberParam} from '../supabase/functions/parkbuddy-api/http.mjs';
import {dictionaries} from '../assets/i18n.mjs';
const store=()=>{const data=new Map();return{getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,String(v)),removeItem:k=>data.delete(k)};};
const car=(revision,extra={})=>({revision,deleted:false,lat:52.2297,lon:21.0122,time:revision,name:'Test spot',...extra});
test('new offline parking survives an older cloud response',()=>{const local=car(200,{pending:true,lon:21.02});assert.deepEqual(reconcileCar(local,car(100)),local);});
test('delete tombstone survives reload and late cloud save',()=>{const disk=store();disk.setItem('parkbuddy_car',JSON.stringify({lat:52.2,lon:21.1,time:100}));writeCar(disk,{revision:201,deleted:true,pending:true});assert.equal(disk.getItem('parkbuddy_car'),null);assert.deepEqual(reconcileCar(readCar(disk),car(200)),{revision:201,deleted:true,pending:true});});
test('deletion wins a simultaneous revision tie',()=>{assert.equal(reconcileCar({revision:100,deleted:true,pending:true},car(100)).deleted,true);assert.equal(reconcileCar(car(100),{revision:100,deleted:true}).deleted,true);});
test('only matching server acknowledgement clears pending',()=>{assert.equal(reconcileCar(car(100,{pending:true}),car(100)).pending,false);assert.equal(reconcileCar(car(100,{pending:true}),car(100,{lon:99})).pending,true);});
test('legacy local parking migrates without losing its position',()=>{const disk=store();disk.setItem('parkbuddy_car',JSON.stringify({lat:52.1,lon:21.2,time:100,name:'Legacy'}));const restored=readCar(disk);assert.equal(restored.lon,21.2);assert.equal(restored.pending,true);writeCar(disk,restored);assert.equal(JSON.parse(disk.getItem(CAR_KEY)).name,'Legacy');});
test('invalid local coordinates and malformed storage are rejected',()=>{assert.equal(normalizeCar(car(20,{lat:null})),null);assert.equal(normalizeCar(car(20,{lon:200})),null);const disk=store();disk.setItem(CAR_KEY,'{bad');assert.equal(readCar(disk),null);});
test('revision remains monotonic if clock moves backwards',()=>{assert.equal(nextRevision(car(100),50),101);});
test('budget applies to every priority, preserving labelled unknown prices',()=>{const rows=[{id:'expensive',lat:52,lon:21,price_per_hour:20},{id:'cheap',lat:52,lon:21,price_per_hour:5},{id:'unknown',lat:52,lon:21,price_per_hour:null}];for(const pref of ['balanced','near','capacity','cheap'])assert.deepEqual(new Set(rankParkings(rows,{budget:5,pref}).map(p=>p.id)),new Set(['cheap','unknown']));});
test('free parking is distinct from unknown pricing',()=>{assert.equal(knownPrice({price_per_hour:0}),0);assert.equal(knownPrice({price_per_hour:null}),null);});
test('walking time requires real routing evidence',()=>{assert.equal(walkingMinutes({walk_minutes:7,distance_m:530}),null);assert.equal(walkingMinutes({walk_source:'route',walk_seconds:627.2}),11);assert.equal(walkingMinutes({walk_source:'route',walk_seconds:null}),null);});
test('technical names are recognised without changing real names',()=>{assert.equal(isGeneratedName('Parking way 29390492'),true);assert.equal(isGeneratedName('Parking Wielopoziomowy P1'),false);});
test('car navigation explicitly uses walking mode',()=>{const url=new URL(navigationURL({lat:52.1,lon:21.2}));assert.equal(url.searchParams.get('travelmode'),'walking');assert.equal(url.searchParams.get('destination'),'52.1,21.2');});
test('new credentials are random, stable per device and stored as hashes by API',async()=>{const a=store(),b=store(),token=ownerToken(a,crypto);assert.equal(ownerToken(a,crypto),token);assert.notEqual(ownerToken(b,crypto),token);const hash=await credentialHash(token);assert.equal(hash.length,64);assert.notEqual(hash,token);assert.equal(await credentialHash(hash),null);assert.equal(await credentialHash('pb_known_device_id'),null);});
test('legacy UUID credential keeps access through header-only migration',async()=>{const disk=store();disk.setItem('parkbuddy_device_id','pb_5bfd56b4-7f13-4f81-928d-9cb0ad3b6289');assert.equal(ownerToken(disk,crypto),'pb_5bfd56b4-7f13-4f81-928d-9cb0ad3b6289');assert.equal((await credentialHash(ownerToken(disk,crypto))).length,64);});
test('API rejects missing coordinates, bad revisions and false deletion flags',()=>{const now=Date.now();assert.equal(validateState(car(now),now),true);assert.equal(validateState(car(now,{lat:null}),now),false);assert.equal(validateState(car(now,{deleted:'true'}),now),false);assert.equal(validateState(car(now+90000000),now),false);assert.equal(numberParam(new URLSearchParams(),'lat').toString(),'NaN');});
test('all languages contain the same complete message keys',()=>{for(const lang of ['tr','en'])assert.deepEqual(Object.keys(dictionaries[lang]),Object.keys(dictionaries.pl));for(const dict of Object.values(dictionaries))assert.ok(Object.values(dict).every(v=>typeof v==='string'&&v.length>0));});

test('malformed parking caches and empty coordinates never become a map point',()=>{
  for(const data of [null,{},'bad',42])assert.deepEqual(validRows(data),[]);
  assert.deepEqual(validRows([{lat:null,lon:21},{lat:'',lon:21},{lat:true,lon:21},{lat:'52.2',lon:'21.1'}]),[{lat:'52.2',lon:'21.1'}]);
  assert.deepEqual(normalizePoint({lat:'52.2',lon:'21.1'}),{lat:52.2,lon:21.1});
});
test('invalid route metrics and coordinates cannot be displayed as successful navigation',()=>{
  const good={duration:120,distance:200,geometry:{type:'LineString',coordinates:[[21,52],[21.01,52.01]]}};
  assert.equal(validRoute(good),true);
  for(const bad of [{...good,duration:null},{...good,distance:-1},{...good,geometry:{type:'LineString',coordinates:[[null,52],[21,52]]}},{...good,geometry:{type:'Polygon',coordinates:[]}}])assert.equal(validRoute(bad),false);
});
