importScripts('precache.js');
const {VERSION,LOCAL,REMOTE}=self.PRECACHE;
const REMOTE_HOSTS=['cdn.jsdelivr.net','storage.googleapis.com'];

// インストール時：アプリ本体と、解析エンジン・モデルをまとめて保存
self.addEventListener('install',e=>{
  e.waitUntil((async()=>{
    const c=await caches.open(VERSION);
    await c.addAll(LOCAL.map(f=>new Request(f,{cache:'reload'})));
    for(const u of REMOTE){
      if(await c.match(u)) continue;
      const res=await fetch(new Request(u,{mode:'cors',cache:'reload'}));
      if(!res.ok) throw new Error('取得失敗: '+u);
      await c.put(u,res);
    }
    await self.skipWaiting();
  })());
});
self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys()
    .then(ks=>Promise.all(ks.filter(k=>k!==VERSION).map(k=>caches.delete(k))))
    .then(()=>self.clients.claim()));
});
// 端末内に保存したものを優先して使う。無いものだけ通信し、エンジン・モデルは保存しておく
self.addEventListener('fetch',e=>{
  const req=e.request;
  if(req.method!=='GET') return;
  const url=new URL(req.url);
  const remote=REMOTE_HOSTS.includes(url.host);
  if(url.origin!==location.origin && !remote) return;
  e.respondWith((async()=>{
    const hit=await caches.match(req.url,{ignoreSearch:!remote});
    if(hit) return hit;
    try{
      const res=await fetch(req);
      if(remote && res.ok){ const c=await caches.open(VERSION); c.put(req.url,res.clone()); }
      return res;
    }catch(err){
      if(req.mode==='navigate'){ const p=await caches.match('./index.html'); if(p) return p; }
      return Response.error();
    }
  })());
});
self.addEventListener('message',e=>{
  if(e.data!=='recache') return;
  e.waitUntil((async()=>{
    const c=await caches.open(VERSION);
    await c.addAll(LOCAL.map(f=>new Request(f,{cache:'reload'})));
    for(const u of REMOTE){ try{ const r=await fetch(new Request(u,{mode:'cors',cache:'reload'})); if(r.ok) await c.put(u,r); }catch(_){ } }
    (await self.clients.matchAll()).forEach(cl=>cl.postMessage('recached'));
  })());
});
