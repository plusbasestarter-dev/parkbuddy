import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {parseHTML} from 'linkedom';
import * as core from '../assets/core.mjs';
import {translator} from '../assets/i18n.mjs';
const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
const source=(await readFile(new URL('../assets/app.mjs',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'');
const cityData=[{id:'warszawa',name:'Warszawa',lat:52.2297,lon:21.0122},{id:'krakow',name:'Kraków',lat:50.0614,lon:19.9366}];
const parking=(city='warszawa')=>({id:city+'1',name:city==='warszawa'?'Test parking':'Parking way 123',lat:city==='warszawa'?52.23:50.06,lon:city==='warszawa'?21.01:19.93,city_id:city,city:city==='warszawa'?'Warszawa':'Kraków',parking_type:'surface',price_per_hour:5,capacity:50});
async function settle(predicate=()=>true){for(let i=0;i<100;i++){await new Promise(setImmediate);if(predicate())return;}assert.ok(predicate(),'Asynchronous UI did not settle');}
function create(t,{stored={},fetcher,geo,map=true}={}){
  const {window}=parseHTML(html),{document}=window;
  Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,get(){return this.querySelector('option[selected]')?.value||this.options[0]?.value||''},set(v){for(const o of this.options){if(o.value===v)o.setAttribute('selected','');else o.removeAttribute('selected');}}});
  const data=new Map(Object.entries(stored));let remote=null;
  const disk={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,String(v)),removeItem:k=>data.delete(k)};
  const requests=[],timers=new Set(),stack=[{screen:'home',depth:0}];let stackIndex=0;
  const L={map:(id)=>{let centre={lat:52.23,lng:21.01};const m={setView(ll){centre={lat:ll[0],lng:ll[1]};return m},invalidateSize(){return m},on(){return m},getCenter(){return centre},fitBounds(){return m}};return m},layerGroup:()=>({addTo(){return this},clearLayers(){}}),tileLayer:()=>({addTo(){return this},on(){return this}}),marker:()=>({addTo(){return this},bindPopup(){return this}}),divIcon:x=>x,circleMarker:()=>({addTo(){return this}}),geoJSON:()=>({addTo(){return this},getBounds(){return {extend(){return this}}}})};
  const browser={L:map?L:undefined,scrollTo(){},addEventListener:window.addEventListener.bind(window)};
  const history={replaceState:s=>stack[stackIndex]=s,pushState:s=>{stack.splice(++stackIndex);stack.push(s)},back:()=>{if(stackIndex){stackIndex--;const e=new window.Event('popstate');e.state=stack[stackIndex];window.dispatchEvent(e);}}};
  const context=vm.createContext({...core,esc:core.escapeHTML,translator,document,window:browser,L:map?L:undefined,history,localStorage:disk,navigator:{onLine:true,geolocation:{getCurrentPosition:(yes,no)=>geo?geo(yes,no):no({code:1})}},matchMedia:()=>({matches:false,addEventListener(){}}),requestAnimationFrame:fn=>queueMicrotask(fn),crypto:webcrypto,URL,URLSearchParams,AbortController,console,confirm:()=>true,
    setTimeout:(fn,ms)=>{const id=setTimeout(fn,ms);id.unref();timers.add(id);return id},clearTimeout,
    fetch:async(url,options)=>{const u=new URL(url),action=u.searchParams.get('action');requests.push({action,params:u.searchParams,options});let body=await fetcher?.(action,u.searchParams,options);if(body===undefined){if(action==='cities')body={cities:cityData};else if(action==='official-parking')body={parkings:[parking(u.searchParams.get('city_id'))]};else if(action==='latest')body={state:remote};else if(action==='park'){remote=JSON.parse(options.body);body={state:remote};}else if(action==='nearby')body={parkings:[{...parking(),distance_m:300,walk_seconds:240,walk_source:'route'}]};else body={};}return{ok:true,status:200,json:async()=>body};}});
  vm.runInContext(source,context);t.after(()=>{for(const id of timers)clearTimeout(id)});
  const click=selector=>{const el=document.querySelector(selector);assert.ok(el,selector);el.dispatchEvent(new window.Event('click',{bubbles:true}));};
  const change=(id,value)=>{const el=document.getElementById(id);el.value=value;el.dispatchEvent(new window.Event('change',{bubbles:true}));};
  const submit=(query)=>{document.getElementById('q').value=query;document.getElementById('homeSearch').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));};
  return{document,requests,disk,click,change,submit,screen:()=>document.querySelector('.screen.active').id};
}
test('home detail returns home, search presents address choices, then opens plans',async t=>{
  const app=create(t,{fetcher:action=>action==='search'?{places:[{lat:52.2,lon:21.1,display_name:'First place'},{lat:52.21,lon:21.11,display_name:'Second place'}]}:undefined});
  await settle(()=>app.document.querySelector('[data-detail]'));app.click('[data-detail]');assert.equal(app.screen(),'detail');assert.equal(app.document.querySelector('[data-action=walkToGoal]'),null);app.click('#detail [data-action=back]');assert.equal(app.screen(),'home');
  app.submit('Test');await settle(()=>app.document.querySelector('[data-place="1"]'));assert.equal(app.screen(),'home');app.click('[data-place="1"]');await settle(()=>app.document.querySelector('#decisionPlan [data-detail]'));assert.equal(app.screen(),'choices');assert.equal(app.document.getElementById('choiceDest').textContent,'Second place');
});
test('late city response cannot replace a newer city and generated names stay readable',async t=>{
  let finish;const slow=new Promise(r=>finish=r);const app=create(t,{fetcher:(action,params)=>action==='official-parking'&&params.get('city_id')==='warszawa'?slow:undefined});
  await settle(()=>app.document.getElementById('citySelect').options.length===2);app.change('citySelect','krakow');await settle(()=>app.document.getElementById('homeParkingList').textContent.includes('Kraków'));finish({parkings:[parking()]});await settle();assert.equal(app.document.getElementById('cityLabel').textContent,'KRAKÓW');assert.ok(!app.document.getElementById('homeParkingList').textContent.includes('Parking way'));
});
test('car can be selected without GPS, saved, and deleted without resurrection',async t=>{
  const app=create(t);await settle(()=>app.document.querySelector('[data-detail]'));app.click('.nav [data-go=car]');assert.equal(app.document.getElementById('carMapWrap').hidden,true);assert.equal(app.document.getElementById('findCar').hidden,true);
  app.click('[data-action=pickCar]');await settle();app.click('[data-action=useMapCenter]');app.click('[data-action=saveSelected]');await settle(()=>core.readCar(app.disk)?.pending===false);assert.equal(app.document.getElementById('carMapWrap').hidden,false);assert.equal(app.document.getElementById('findCar').hidden,false);
  app.click('#car [data-action=deleteCar]');await settle(()=>core.readCar(app.disk)?.deleted&&!core.readCar(app.disk)?.pending);assert.equal(app.document.getElementById('carMapWrap').hidden,true);app.click('.nav [data-go=home]');app.click('.nav [data-go=car]');await settle();assert.equal(core.readCar(app.disk).deleted,true);
});
test('late GPS cannot save or redirect after the user leaves',async t=>{
  let complete;const app=create(t,{geo:yes=>complete=yes});await settle();app.click('.nav [data-go=car]');app.click('#car [data-action=saveGPS]');app.click('.nav [data-go=home]');complete({coords:{latitude:52.2,longitude:21.1,accuracy:5}});await settle();assert.equal(app.screen(),'home');assert.equal(core.readCar(app.disk),null);
});
test('route details and external walking link remain usable when map library is missing',async t=>{
  const car={revision:100,time:100,lat:52.2,lon:21.1,deleted:false,name:'Test spot',pending:false};
  const app=create(t,{map:false,stored:{[core.CAR_KEY]:JSON.stringify(car)},geo:yes=>yes({coords:{latitude:52.21,longitude:21.11,accuracy:5}}),fetcher:action=>action==='route'?{route:{duration:120,distance:150,geometry:{type:'LineString',coordinates:[[21.11,52.21],[21.1,52.2]]}}}:undefined});
  await settle();app.click('.nav [data-go=car]');app.click('[data-action=findCar]');await settle(()=>app.document.getElementById('routeInfo').textContent.includes('150 m'));assert.equal(app.screen(),'route');assert.ok(app.document.getElementById('externalRoute').href.includes('travelmode=walking'));assert.equal(app.document.getElementById('routeSave').hidden,true);
});
test('corrupted caches and unsupported saved settings fall back without crashing',async t=>{
  const app=create(t,{stored:{parkbuddy_theme:'invalid',parkbuddy_cities_cache:'{}',parkbuddy_parkings_warszawa:'{"bad":true}',parkbuddy_language:'tr'},fetcher:()=>{throw Error('Offline')}});await settle(()=>app.document.querySelector('[data-action=reloadCity]'));assert.equal(app.document.documentElement.lang,'tr');assert.equal(app.document.documentElement.dataset.theme,'dark');app.change('headerLanguage','en');assert.ok(app.document.querySelector('[data-action=reloadCity]'));
});
