import {VERSION, CAR_KEY, normalizePoint, validRows, validRoute, isPoint, isGeneratedName, escapeHTML as esc, parseJSON, readCar, writeCar, nextRevision, reconcileCar, ownerToken, knownPrice, walkingMinutes, distanceMeters, rankParkings, navigationURL} from './core.mjs?v=rc4';
import {translator} from './i18n.mjs?v=rc4';

const API='https://oespoljjeslpsnhjwsra.supabase.co/functions/v1/parkbuddy-api';
const $=id=>document.getElementById(id);
const stored=(key,fallback)=>{try{return localStorage.getItem(key) ?? fallback;}catch{return fallback;}};
const defaults={theme:'system',pref:'balanced',maxWalk:10,budget:0,vehicle:'standard'};
let settings={theme:stored('parkbuddy_theme','system'),pref:stored('parkbuddy_pref','balanced'),maxWalk:Number(stored('parkbuddy_max_walk',10)),budget:Number(stored('parkbuddy_budget',0)),vehicle:stored('parkbuddy_vehicle','standard')};
if(!['system','light','dark'].includes(settings.theme))settings.theme='system';
if(!['standard','large'].includes(settings.vehicle))settings.vehicle='standard';
if(!['balanced','near','capacity','cheap'].includes(settings.pref))settings.pref='balanced';
if(![5,10,15,20].includes(settings.maxWalk))settings.maxWalk=10;
if(![0,5,10,15].includes(settings.budget))settings.budget=0;
let language=stored('parkbuddy_language','pl');
if(!['pl','tr','en'].includes(language))language='pl';
let t=translator(language), currentCityId=stored('parkbuddy_city','warszawa');
let cities=[],parkings=[],nearby=[],destination=null,selectedParking=null,currentScreen='home',currentFilter='all';
let cityRequest=0,searchRequest=0,routeRequest=0,cityAbort=null,searchAbort=null,routeAbort=null;
let maps={},mapLayers={},userPosition=null,routeContext=null,picking=false,pickedPoint=null,toastTimer;
let syncPromise=null,syncAgain=false,historyDepth=0,geoBusy=false,geoRequest=0,syncRetry=null,syncDelay=2000;
let searchPlaces=[],searchResultHost=null,parkingLoadState="loading";
const city=()=>cities.find(c=>c.id===currentCityId)||{id:'warszawa',name:'Warszawa',lat:52.2297,lon:21.0122};
const point=normalizePoint;
const latLng=p=>[Number(p.lat),Number(p.lon)];
const typeLabel=p=>t(['surface','underground','multi_storey','municipal','park_and_ride'].includes(p.parking_type)?p.parking_type:'parking');
function parkingName(p){return !p.name||isGeneratedName(p.name)?`${typeLabel(p)} · ${p.city||cities.find(c=>c.id===p.city_id)?.name||city().name}`:p.name;}
function fmtDistance(m){return m==null||!Number.isFinite(Number(m))?'—':Number(m)<1000?`${Math.round(m)} m`:`${(m/1000).toLocaleString(language,{maximumFractionDigits:1})} km`;}
function fmtWalk(p){const n=walkingMinutes(p);return n===null?t('walkUnknown'):t('minutes',{n});}
function priceText(p){const n=knownPrice(p);return n===null?t('priceUnknown'):`${n.toLocaleString(language)} ${p.currency||'PLN'} / h`;}
function toast(message){$('toast').textContent=message;$('toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('show'),4200);}
function persist(key,value){try{localStorage.setItem(key,String(value));return true;}catch{toast(t('storageError'));return false;}}
function getCar(){try{return readCar(localStorage);}catch{return null;}}
function setCar(value){try{writeCar(localStorage,value);return true;}catch{toast(t('storageError'));return false;}}
function applyTheme(){const active=settings.theme==='system'?(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'):settings.theme;document.documentElement.dataset.theme=active;$('themeToggle').textContent=active==='dark'?'☀':'☾';document.querySelectorAll('[data-theme-choice]').forEach(b=>{const on=b.dataset.themeChoice===settings.theme;b.classList.toggle('on',on);b.setAttribute('aria-pressed',String(on));});}
function applyLanguage(){
  t=translator(language);document.documentElement.lang=language;
  document.querySelectorAll('[data-i18n]').forEach(el=>el.textContent=t(el.getAttribute('data-i18n')));
  document.querySelectorAll('[data-label]').forEach(el=>el.setAttribute('aria-label',t(el.dataset.label)));
  document.querySelectorAll('[data-placeholder]').forEach(el=>el.placeholder=t(el.dataset.placeholder));
  $('headerLanguage').value=language;$('languageSelect').value=language;
  Array.from($('walkSelect').options).forEach(o=>o.textContent=t('minutes',{n:o.value}));
  syncProfile();applyTheme();renderHome();if(destination)renderChoices();if(selectedParking)renderDetail();if(currentScreen==='car')renderCar();
  if(currentScreen==='route'&&routeContext)renderRouteText();
  if(searchResultHost)renderSearchPlaces();
  if(maps.mapbox)renderMarkers();
}
function syncProfile(){
  $('prefSelect').value=settings.pref;$('walkSelect').value=String(settings.maxWalk);$('budgetSelect').value=String(settings.budget);$('vehicleSelect').value=settings.vehicle;
  const prices=parkings.filter(p=>knownPrice(p)!==null).length;
  $('cheapOption').disabled=prices===0;
  $('preferenceNotice').textContent=prices===0?t('cheapUnavailable'):'';
  $('priceCoverage').textContent=t('priceCoverage',{known:prices,total:parkings.length});
}
function usableSettings(){return {...settings,pref:settings.pref==='cheap'&&!parkings.some(p=>knownPrice(p)!==null)?'near':settings.pref};}
function visibleScreen(id){
  if(!$(id)?.classList.contains('screen'))id='home';
  if(id==='detail'&&!selectedParking)id='home';
  if(id==='choices'&&!destination)id='home';
  if(id==='route'&&!routeContext)id='home';
  if(currentScreen!==id){
    geoRequest++;
    if(currentScreen==='route'){routeRequest++;routeAbort?.abort();if(routeContext&&!routeContext.summary)routeContext.error='routeError';}
    if(['home','explore'].includes(currentScreen)&&id!=='choices'){searchRequest++;searchAbort?.abort();setSearchBusy(false);}
  }
  if(currentScreen==='car'&&id!=='car'){picking=false;pickedPoint=null;}
  currentScreen=id;
  document.querySelectorAll('.screen').forEach(s=>s.classList.toggle('active',s.id===id));
  document.querySelectorAll('.nav [data-go]').forEach(b=>{const active=b.dataset.go===(['detail','choices','route'].includes(id)?'home':id);b.classList.toggle('active',active);if(active)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
  window.scrollTo({top:0,behavior:'instant'});
  const heading=$(id).querySelector('h1,h2');if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});}
  if(id==='profile')syncProfile();
  if(id==='route'&&routeContext)renderRouteText();
  if(id==='car'){renderCar();void syncCar();}
  requestAnimationFrame(()=>{if(id==='explore'){ensureMap('mapbox',city(),11.5);renderMarkers();}if(id==='car'&&maps.carMap)maps.carMap.invalidateSize({pan:false});if(id==='route'&&maps.routeMap)maps.routeMap.invalidateSize({pan:false});});
}
function go(id){if(id===currentScreen)return visibleScreen(id);historyDepth++;history.pushState({parkbuddy:true,screen:id,depth:historyDepth},'');visibleScreen(id);}
function back(){if(historyDepth>0)history.back();else visibleScreen('home');}
history.replaceState({parkbuddy:true,screen:'home',depth:0},'');
window.addEventListener('popstate',e=>{historyDepth=e.state?.depth||0;visibleScreen(e.state?.screen||'home');});

async function api(action,params={},options={}){
  const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),12000);
  const abort=()=>controller.abort();options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)controller.abort();
  try{
    const url=new URL(API);url.search=new URLSearchParams({action,...params}).toString();
    const headers={...options.headers};if(options.body)headers['Content-Type']='application/json';
    const r=await fetch(url,{...options,headers,cache:'no-store',signal:controller.signal});
    const payload=await r.json().catch(()=>({}));
    if(!r.ok){const e=new Error(payload.error||'Request failed');e.status=r.status;throw e;}
    return payload;
  }finally{clearTimeout(timeout);options.signal?.removeEventListener('abort',abort);}
}
async function loadCities(){
  try{const data=await api('cities');cities=validRows(data.cities).filter(c=>typeof c.id==='string'&&typeof c.name==='string').sort((a,b)=>a.name.localeCompare(b.name,'pl'));try{localStorage.setItem('parkbuddy_cities_cache',JSON.stringify(cities));}catch{}}
  catch{cities=validRows(parseJSON(stored('parkbuddy_cities_cache',null),[])).filter(c=>typeof c.id==='string'&&typeof c.name==='string');if(!cities.length)cities=[{id:'warszawa',name:'Warszawa',lat:52.2297,lon:21.0122}];toast(t('loadError'));}
  if(!cities.some(c=>c.id===currentCityId))currentCityId=cities.some(c=>c.id==='warszawa')?'warszawa':cities[0].id;
  $('citySelect').replaceChildren(...cities.map(c=>{const o=document.createElement('option');o.value=c.id;o.textContent=c.name;return o;}));$('citySelect').value=currentCityId;
  await loadParkings();
}
async function loadParkings(){
  const requestedCity=currentCityId,version=++cityRequest;parkingLoadState='loading';
  cityAbort?.abort();cityAbort=new AbortController();
  $('cityLabel').textContent=city().name.toLocaleUpperCase(language);$('exploreTitle').textContent=city().name;$('homeParkingList').innerHTML=`<p>${esc(t('loading'))}</p>`;
  try{
    const data=await api('official-parking',{city_id:requestedCity},{signal:cityAbort.signal});if(version!==cityRequest)return;
    parkings=validRows(data.parkings);parkingLoadState='ready';
    try{localStorage.setItem('parkbuddy_parkings_'+requestedCity,JSON.stringify(parkings));}catch{}
  }catch{
    if(version!==cityRequest)return;
    parkings=validRows(parseJSON(stored('parkbuddy_parkings_'+requestedCity,null),[]));parkingLoadState=parkings.length?'cached':'error';
    if(!parkings.length){$('homeParkingList').innerHTML=`<p>${esc(t('loadError'))}</p><button class="ghost" data-action="reloadCity">${esc(t('retry'))}</button>`;$('parkingCount').textContent='';syncProfile();return;}
    toast(t('localCache'));
  }
  $('parkingCount').textContent=t('options',{n:parkings.length});renderHome();renderMarkers();syncProfile();
}
async function changeCity(id){
  if(!cities.some(c=>c.id===id))return;
  currentCityId=id;persist('parkbuddy_city',id);searchRequest++;searchAbort?.abort();routeRequest++;routeAbort?.abort();
  destination=null;selectedParking=null;nearby=[];routeContext=null;parkings=[];
  searchPlaces=[];searchResultHost=null;document.querySelectorAll('.searchResults').forEach(el=>el.replaceChildren());setSearchBusy(false);
  $('q').value='';$('exploreQ').value='';$('searchStatus').textContent='';$('decisionPlan').replaceChildren();$('nearbyList').replaceChildren();
  mapLayers.mapbox?.clearLayers();maps.mapbox?.setView(latLng(city()),11.5);await loadParkings();
}
function parkingRow(p){
  return `<div class="row"><div><b class="rowTitle">${esc(parkingName(p))}</b><small>${esc(typeLabel(p))}${p.distance_m!=null?' · '+esc(fmtDistance(p.distance_m)):''}</small><small>${esc(priceText(p))}</small><button class="ghost" data-detail="${esc(p.id)}">${esc(t('details'))}</button></div><span class="labelPill">P</span></div>`;
}
function renderHome(){
  if(!cities.length)return;
  if(parkingLoadState==='loading'){$('homeParkingList').innerHTML=`<p>${esc(t('loading'))}</p>`;return;}
  if(parkingLoadState==='error'){$('homeParkingList').innerHTML=`<p>${esc(t('loadError'))}</p><button class="ghost" data-action="reloadCity">${esc(t('retry'))}</button>`;return;}
  $('homeCacheNotice').textContent=parkingLoadState==='cached'?t('localCache'):'';
  $('parkingCount').textContent=t('options',{n:parkings.length});
  const nearCenter=parkings.map(p=>({...p,distance_m:distanceMeters(point(p),point(city()))})).sort((a,b)=>a.distance_m-b.distance_m);
  $('homeParkingList').innerHTML=nearCenter.length?nearCenter.slice(0,6).map(p=>parkingRow({...p,distance_m:null})).join(''):`<p>${esc(t('noResults'))}</p>`;
}
function setSearchBusy(busy){
  for(const form of document.querySelectorAll('form[role=search]')){form.querySelector('button').disabled=busy;form.setAttribute('aria-busy',String(busy));}
  for(const el of document.querySelectorAll('[data-search-status]'))el.textContent=busy?t('searching'):'';
}
function renderSearchPlaces(){
  if(!searchResultHost)return;
  searchResultHost.innerHTML=searchPlaces.length?`<p>${esc(t('chooseAddress'))}</p>`+searchPlaces.map((p,i)=>`<button class="ghost full placeChoice" data-place="${i}">${esc(p.display_name)}</button>`).join(''):'';
}
async function selectPlace(index){
  const place=searchPlaces[index];if(!place||!isPoint(point(place)))return;
  destination={...point(place),name:place.display_name};nearby=[];selectedParking=null;
  searchPlaces=[];searchResultHost?.replaceChildren();searchResultHost=null;go('choices');
  await loadNearby();
}
async function search(form){
  const input=form.querySelector('input'),query=input.value.trim();if(!query)return toast(t('searchRequired'));
  const req=++searchRequest,cid=currentCityId;
  searchAbort?.abort();searchAbort=new AbortController();
  searchPlaces=[];document.querySelectorAll('.searchResults').forEach(el=>el.replaceChildren());searchResultHost=$(form.id+'Results');setSearchBusy(true);
  try{
    const result=await api('search',{q:query,city_id:cid,lang:language},{signal:searchAbort.signal});if(req!==searchRequest||cid!==currentCityId)return;
    searchPlaces=validRows(result.places);if(!searchPlaces.length)throw new Error('noAddress');
    if(searchPlaces.length===1)await selectPlace(0);else renderSearchPlaces();
  }catch(e){if(req===searchRequest)toast(t(e.message==='noAddress'?'noAddress':'loadError'));}
  finally{if(req===searchRequest)setSearchBusy(false);}
}
async function loadNearby(request=searchRequest){
  if(!destination)return;
  const target={...destination},cid=currentCityId;
  $('decisionPlan').replaceChildren();$('nearbyList').innerHTML=`<p>${esc(t('loading'))}</p>`;$('choicesNotice').textContent='';
  try{
    const data=await api('nearby',{lat:String(target.lat),lon:String(target.lon),radius:'5000',limit:'12',city_id:cid},{signal:searchAbort?.signal});
    if(request!==searchRequest||cid!==currentCityId||destination?.name!==target.name)return;
    nearby=validRows(data.parkings);renderChoices();
  }catch{if(request===searchRequest){$('nearbyList').innerHTML=`<p>${esc(t('loadError'))}</p><button class="ghost" data-action="retryNearby">${esc(t('retry'))}</button>`;}}
}
function metrics(p){return `<div class="metrics"><div class="metric">${esc(t('distance'))}<b>${esc(fmtDistance(p.distance_m))}</b></div><div class="metric">${esc(t('walk'))}<b>${esc(fmtWalk(p))}</b></div><div class="metric">${esc(t('capacity'))}<b>${p.capacity==null?'—':esc(p.capacity)}</b></div></div>`;}
function renderChoices(){
  if(!destination)return;$('choiceDest').textContent=destination.name;
  const ranked=rankParkings(nearby,usableSettings());
  const warning=[];
  if(settings.budget&&nearby.length&&!ranked.length)warning.push(t('budgetNoResults'));
  if(nearby.length&&!nearby.some(p=>walkingMinutes(p)!==null))warning.push(t('walkUnknown'));
  if(settings.pref==='cheap'&&!nearby.some(p=>knownPrice(p)!==null))warning.push(t('cheapUnavailable'));
  $('choicesNotice').textContent=warning.join(' ');
  $('decisionPlan').innerHTML=ranked.slice(0,2).map((p,i)=>`<div class="card ${i?'blue':'featured'}"><div class="eyebrow">${esc(t(i?'planB':'planA'))}</div><h2>${esc(parkingName(p))}</h2>${metrics(p)}<p class="priceNote">${esc(priceText(p))}</p>${walkingMinutes(p)>settings.maxWalk?`<p class="helper warning">${esc(t('walkOverLimit'))}</p>`:''}<button class="${i?'outline':'primary'} full" data-detail="${esc(p.id)}">${esc(t('choose'))}</button></div>`).join('');
  $('nearbyList').innerHTML=ranked.length>2?`<h3>${esc(t('alternatives'))}</h3><div class="card flat">${ranked.slice(2).map(parkingRow).join('')}</div>`:ranked.length?'':`<p>${esc(t('noResults'))}</p>`;
}
function openDetail(id){
  selectedParking=nearby.find(p=>String(p.id)===id)||parkings.find(p=>String(p.id)===id);
  if(!selectedParking)return;renderDetail();go('detail');
}
function renderDetail(){
  const p=selectedParking;if(!p)return;
  $('detailContent').innerHTML=`<div class="card featured"><div class="eyebrow">${esc(typeLabel(p))}</div><h2>${esc(parkingName(p))}</h2></div>${destination&&p.distance_m!=null?metrics(p):`<p class="helper">${esc(t('setGoalForWalk'))}</p>`}<div class="card flat"><b>${esc(t('price'))}</b><p>${esc(priceText(p))}</p><p class="helper">${esc(t('priceHint'))}</p><p class="helper">${esc(t('noLive'))}</p><p class="helper">${esc(t('hours'))}</p>${settings.vehicle==='large'?`<p class="helper warning">${esc(t('largeHint'))}</p>`:''}</div><div class="routeActions"><button class="primary full" data-action="drive">${esc(t('drive'))}</button>${destination?`<button class="outline full" data-action="walkToGoal">${esc(t('walkToGoal'))}</button>`:''}<a class="ghost buttonLink" href="${esc(navigationURL(point(p),'driving'))}" target="_blank" rel="noopener noreferrer">${esc(t('external'))}</a></div>`;
}

function mapMessage(id,show){const el=$(id+'Message');if(el){el.hidden=!show;el.textContent=show?t('mapError'):'';}}
function ensureMap(id,center,zoom=15){
  if(maps[id]){maps[id].invalidateSize({pan:false});return maps[id];}
  if(!window.L){mapMessage(id,true);return null;}
  try{
    const m=L.map(id,{zoomControl:true,scrollWheelZoom:false}).setView(latLng(center),zoom);maps[id]=m;mapLayers[id]=L.layerGroup().addTo(m);
    const tiles=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>'}).addTo(m);
    let errors=0;tiles.on('tileerror',()=>{if(++errors>=3)mapMessage(id,true);});tiles.on('tileload',()=>{errors=0;mapMessage(id,false);});
    if(window.ResizeObserver)new ResizeObserver(()=>m.invalidateSize({pan:false})).observe($(id));
    if(id==='carMap')m.on('click',e=>{if(picking){pickedPoint={lat:e.latlng.lat,lon:e.latlng.lng};renderPickedPoint();}});
    return m;
  }catch{mapMessage(id,true);return null;}
}
function addPoint(id,p,kind='parking',title=''){
  if(!maps[id]||!isPoint(point(p)))return null;
  const html=kind==='car'?`<div class="carIcon">${esc(t('carMarker'))}</div>`:kind==='goal'?'<div class="goalIcon"></div>':`<div class="parkingIcon ${p.parking_type==='park_and_ride'?'pr':['underground','multi_storey'].includes(p.parking_type)?'structured':''}">P</div>`;
  const marker=L.marker(latLng(p),{icon:L.divIcon({html,className:'',iconSize:kind==='car'?[60,28]:[28,28],iconAnchor:[14,14]}),title:title||parkingName(p)}).addTo(mapLayers[id]);
  return marker;
}
function renderMarkers(){
  if(!maps.mapbox)return;mapLayers.mapbox.clearLayers();
  parkings.filter(p=>currentFilter==='all'||(currentFilter==='structured'?['underground','multi_storey'].includes(p.parking_type):p.parking_type===currentFilter)).forEach(p=>{
    const marker=addPoint('mapbox',p);if(!marker)return;
    const div=document.createElement('div'),label=document.createElement('b'),button=document.createElement('button');label.textContent=parkingName(p);button.className='ghost';button.textContent=t('details');button.addEventListener('click',()=>openDetail(String(p.id)));div.append(label,document.createElement('br'),button);marker.bindPopup(div);
  });
  if(userPosition)L.circleMarker(latLng(userPosition),{radius:7,color:'#fff',weight:3,fillColor:'#536fee',fillOpacity:1}).addTo(mapLayers.mapbox);
}
async function geo(){
  if(!navigator.geolocation)throw new Error('geoUnavailable');
  return await new Promise((resolve,reject)=>navigator.geolocation.getCurrentPosition(p=>resolve({lat:p.coords.latitude,lon:p.coords.longitude,accuracy:p.coords.accuracy}),e=>reject(new Error(e.code===1?'geoDenied':e.code===3?'geoTimeout':'geoUnavailable')),{enableHighAccuracy:true,timeout:10000,maximumAge:0}));
}
async function locate(){try{userPosition=await geo();go('explore');requestAnimationFrame(()=>{const map=ensureMap('mapbox',userPosition);map?.setView(latLng(userPosition),15);renderMarkers();});}catch(e){toast(t(e.message));}}
function renderRouteText(){if(!routeContext)return;$('routeInfo').textContent=routeContext.summary?t('routeSummary',{time:t('minutes',{n:Math.max(1,Math.ceil(routeContext.summary.duration/60))}),distance:fmtDistance(routeContext.summary.distance)}):t(routeContext.error||'routeLoading');$('routeTitle').textContent=t(routeContext.mode==='driving'?'drive':routeContext.forCar?'findCar':'walkToGoal');$('placeName').textContent=routeContext.name;$('externalRoute').href=navigationURL(routeContext.target,routeContext.mode);$('routeSave').hidden=routeContext.mode!=='driving';}
async function startRoute(target,mode='driving',origin=null,forCar=false){
  const req=++routeRequest;routeAbort?.abort();routeAbort=new AbortController();
  routeContext={target:{...point(target)},mode,name:target.name||t('savedCar'),forCar};go('route');renderRouteText();$('routeInfo').textContent=t('routeLoading');
  const map=ensureMap('routeMap',target);mapLayers.routeMap?.clearLayers();addPoint('routeMap',target,forCar?'car':'goal',routeContext.name);map?.setView(latLng(target),15);
  try{
    const start=origin||await geo();if(req!==routeRequest)return;
    userPosition=start;addPoint('routeMap',start,'goal',t('locate'));
    const data=await api('route',{from_lat:String(start.lat),from_lon:String(start.lon),to_lat:String(target.lat),to_lon:String(target.lon),mode},{signal:routeAbort.signal});
    if(req!==routeRequest)return;
    const route=data.route;if(!validRoute(route))throw new Error('routeError');
    routeContext.summary={duration:route.duration,distance:route.distance};
    if(map&&mapLayers.routeMap){const line=L.geoJSON({type:'Feature',properties:{},geometry:route.geometry},{style:{color:mode==='walking'?'#008565':'#526ff1',weight:5}}).addTo(mapLayers.routeMap);
    map.fitBounds(line.getBounds().extend(latLng(start)).extend(latLng(target)),{padding:[28,28],maxZoom:16});}
    $('routeInfo').textContent=t('routeSummary',{time:t('minutes',{n:Math.max(1,Math.ceil(route.duration/60))}),distance:fmtDistance(route.distance)});
  }catch(e){if(req===routeRequest){routeContext.error=['geoDenied','geoTimeout','geoUnavailable'].includes(e.message)?e.message:'routeError';renderRouteText();}}
}

function renderCar(){
  const c=getCar(),hasCar=!!c&&!c.deleted;
  $('carEmpty').hidden=hasCar||picking;$('carMapWrap').hidden=false;$('carInfo').hidden=!hasCar||picking;$('carPicking').hidden=!picking;$('carActions').hidden=picking;$('findCar').hidden=!hasCar;$('deleteCar').hidden=!hasCar;
  $('carSyncStatus').textContent=c?.pending?t(c.deleted?'deletePending':'savedLocal'):'';
  if(picking){requestAnimationFrame(renderPickedPoint);return;}
  if(hasCar){
    $('carInfo').innerHTML=`<b>${esc(c.name||t('savedCar'))}</b><p class="carDate">${esc(new Date(c.time).toLocaleString(language))}</p>`;
    requestAnimationFrame(()=>{if(currentScreen!=='car'||picking)return;const m=ensureMap('carMap',c);mapLayers.carMap?.clearLayers();addPoint('carMap',c,'car',t('savedCar'));m?.setView(latLng(c),16);});
  }else requestAnimationFrame(()=>{if(currentScreen!=='car'||picking)return;const center=userPosition||city();const m=ensureMap('carMap',center,14);mapLayers.carMap?.clearLayers();m?.setView(latLng(center),14);});
}
function pickCar(initial=null){go('car');picking=true;pickedPoint=initial&&isPoint(initial)?initial:null;$('saveSelected').disabled=!pickedPoint;renderCar();requestAnimationFrame(()=>{const center=pickedPoint||getCar()||userPosition||city();const m=ensureMap('carMap',isPoint(center)?center:city(),15);mapLayers.carMap?.clearLayers();m?.setView(latLng(isPoint(center)?center:city()),15);renderPickedPoint();});}
function renderPickedPoint(){if(!picking)return;ensureMap('carMap',pickedPoint||city(),15);mapLayers.carMap?.clearLayers();if(pickedPoint)addPoint('carMap',pickedPoint,'car',t('selectedSpot'));$('saveSelected').disabled=!pickedPoint;}
function savePoint(p,name=''){
  if(!isPoint(p))return;
  const c={...point(p),name:name||t('savedCar'),revision:nextRevision(getCar()),time:Date.now(),deleted:false,pending:true};
  if(!setCar(c))return;picking=false;pickedPoint=null;go('car');renderCar();toast(t('saved'));void syncCar();
}
async function saveGPS(){
  if(geoBusy)return;geoBusy=true;document.querySelectorAll('[data-action=saveGPS]').forEach(b=>b.disabled=true);toast(t('locating'));
  const request=++geoRequest,name=currentScreen==='route'&&routeContext?.mode==='driving'?routeContext.name:t('savedCar');
  try{const p=await geo();if(request!==geoRequest)return;userPosition=p;if(p.accuracy>100){pickCar(p);toast(t('geoInaccurate'));}else savePoint(p,name);}
  catch(e){if(request===geoRequest){toast(t(e.message));go('car');}}
  finally{geoBusy=false;document.querySelectorAll('[data-action=saveGPS]').forEach(b=>b.disabled=false);}
}
function deleteCar(){
  const c=getCar();if(!c||c.deleted)return toast(t('carEmpty'));
  if(!confirm(t('deleteConfirm')))return;
  if(!setCar({revision:nextRevision(c),deleted:true,pending:true}))return;
  routeRequest++;routeAbort?.abort();if(routeContext?.forCar){routeContext=null;mapLayers.routeMap?.clearLayers();}
  picking=false;renderCar();toast(t('deleted'));void syncCar();
}
async function syncCar(){
  if(!navigator.onLine||(!getCar()&&!stored('parkbuddy_owner_token',null)&&!stored('parkbuddy_device_id',null)))return;
  if(syncPromise){syncAgain=true;return syncPromise;}
  syncPromise=(async()=>{
    try{
      const headers={'x-parkbuddy-token':ownerToken(localStorage,crypto)};
      let c=getCar();
      if(c?.pending){
        const data=await api('park',{}, {method:'POST',headers,body:JSON.stringify(c)});
        const merged=reconcileCar(getCar(),data.state);if(merged)setCar(merged);
      }else{
        const data=await api('latest',{}, {headers});
        const merged=reconcileCar(getCar(),data.state);if(merged)setCar(merged);
      }
      syncDelay=2000;clearTimeout(syncRetry);syncRetry=null;
    }catch{
      if(getCar()?.pending&&!syncRetry){syncRetry=setTimeout(()=>{syncRetry=null;void syncCar();},syncDelay);syncDelay=Math.min(syncDelay*2,60000);}
    }
    finally{syncPromise=null;if(currentScreen==='car')renderCar();if(syncAgain){syncAgain=false;void syncCar();}}
  })();return syncPromise;
}

const actions={useMapCenter:()=>{const center=maps.carMap?.getCenter();if(picking&&center){pickedPoint={lat:center.lat,lon:center.lng};renderPickedPoint();}},back,locate,saveGPS,pickCar:()=>pickCar(),cancelPick:()=>{picking=false;pickedPoint=null;renderCar();},saveSelected:()=>pickedPoint?savePoint(pickedPoint,t('savedCar')):toast(t('pickRequired')),deleteCar,reloadCity:loadParkings,retryNearby:()=>loadNearby(),findCar:()=>{const c=getCar();if(c&&!c.deleted)void startRoute(c,'walking',null,true);},drive:()=>{if(selectedParking)void startRoute({...point(selectedParking),name:parkingName(selectedParking)},'driving');},walkToGoal:()=>{if(destination&&selectedParking)void startRoute(destination,'walking',point(selectedParking));},toggleTheme:()=>setTheme(document.documentElement.dataset.theme==='dark'?'light':'dark'),reset:()=>{if(!confirm(t('resetConfirm')))return;settings={...defaults};for(const[key,storageKey]of Object.entries({theme:'theme',pref:'pref',maxWalk:'max_walk',budget:'budget',vehicle:'vehicle'}))persist('parkbuddy_'+storageKey,settings[key]);syncProfile();applyTheme();renderChoices();toast(t('saved'));}};
function setTheme(value){settings.theme=value;persist('parkbuddy_theme',value);applyTheme();}
document.addEventListener('click',e=>{
  const button=e.target.closest('button');if(!button||button.disabled)return;
  if(button.dataset.place!==undefined)void selectPlace(Number(button.dataset.place));
  else if(button.dataset.go)go(button.dataset.go);
  else if(button.dataset.detail)openDetail(button.dataset.detail);
  else if(button.dataset.filter){currentFilter=button.dataset.filter;document.querySelectorAll('[data-filter]').forEach(b=>{b.classList.toggle('on',b===button);b.setAttribute('aria-pressed',String(b===button));});renderMarkers();}
  else if(button.dataset.themeChoice)setTheme(button.dataset.themeChoice);
  else if(actions[button.dataset.action])void actions[button.dataset.action]();
});
for(const id of ['homeSearch','exploreSearch'])$(id).addEventListener('submit',e=>{e.preventDefault();void search(e.currentTarget);});
$('citySelect').addEventListener('change',e=>void changeCity(e.target.value));
for(const id of ['headerLanguage','languageSelect'])$(id).addEventListener('change',e=>{language=e.target.value;persist('parkbuddy_language',language);applyLanguage();});
for(const[id,key,storageKey]of [['prefSelect','pref','pref'],['walkSelect','maxWalk','max_walk'],['budgetSelect','budget','budget'],['vehicleSelect','vehicle','vehicle']])$(id).addEventListener('change',e=>{settings[key]=['maxWalk','budget'].includes(key)?Number(e.target.value):e.target.value;persist('parkbuddy_'+storageKey,settings[key]);renderChoices();if(selectedParking)renderDetail();toast(t('saved'));});
matchMedia('(prefers-color-scheme: light)').addEventListener('change',()=>{if(settings.theme==='system')applyTheme();});
window.addEventListener('storage',e=>{if(e.key===CAR_KEY){if(currentScreen==='car')renderCar();void syncCar();}});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void syncCar();});
function connectionChanged(){$('connectionNotice').hidden=navigator.onLine;if(navigator.onLine)void syncCar();}
window.addEventListener('online',connectionChanged);window.addEventListener('offline',connectionChanged);
$('version').textContent=VERSION;applyLanguage();connectionChanged();void loadCities();
if('serviceWorker' in navigator)navigator.serviceWorker.register('sw.js').catch(()=>{});