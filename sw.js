const PREFIX='parkbuddy-'+encodeURIComponent(new URL(self.registration.scope).pathname)+'-';
const CACHE=PREFIX+'rc4.1';
const SHELL=['./','./index.html','./assets/styles.css?v=rc4','./assets/app.mjs?v=rc4','./assets/core.mjs?v=rc4','./assets/i18n.mjs?v=rc4','./assets/vendor/leaflet.js','./assets/vendor/leaflet.css'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith(PREFIX)&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  // API responses, private coordinates and third-party map tiles are never cached.
  if(event.request.method!=='GET'||url.origin!==self.location.origin)return;
  if(!SHELL.some(path=>new URL(path,self.registration.scope).pathname===url.pathname))return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE);
    // Versioned assets stay together; navigation checks the network for updates.
    if(event.request.mode!=='navigate'){const cached=await cache.match(event.request);if(cached)return cached;}
    try{const response=await fetch(event.request);if(response.ok){const copy=response.clone();event.waitUntil(cache.put(event.request,copy));}return response;}
    catch{return await cache.match(event.request)||(event.request.mode==='navigate'?await cache.match(new URL('index.html',self.registration.scope)):undefined)||Response.error();}
  })());
});
