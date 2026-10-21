const CACHE_NAME='slide-shell-v1.4.0';
const APP_SHELL=['./','./index.html','./styles.css','./app.js','./threshold-alerts.js','./manifest.webmanifest','./assets/slide-logo.png','./assets/icon-192.png','./assets/icon-512.png','./assets/icon-maskable-512.png'];

self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(APP_SHELL)).then(()=>self.skipWaiting()));
});

self.addEventListener('activate',event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE_NAME).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));
});

self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  const requestUrl=new URL(event.request.url);
  // Station readings, exports and commands must always come from the live
  // same-origin API. Never cache sensor data or last-known values.
  if(requestUrl.origin!==self.location.origin||requestUrl.pathname.startsWith('/api/')||requestUrl.pathname==='/healthz')return;
  if(event.request.mode==='navigate'){
    event.respondWith(fetch(event.request).then(response=>{const copy=response.clone();caches.open(CACHE_NAME).then(cache=>cache.put('./index.html',copy));return response;}).catch(()=>caches.match('./index.html')));
    return;
  }
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE_NAME);
    try{
      const response=await fetch(event.request,{cache:'no-cache'});
      if(response.ok)await cache.put(event.request,response.clone());
      return response;
    }catch(error){
      const cached=await cache.match(event.request);
      if(cached)return cached;
      throw error;
    }
  })());
});
