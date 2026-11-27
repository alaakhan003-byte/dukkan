/* دكّان — works offline, and always takes the newest copy when there is internet */
const VERSION = '__VERSION__';
const CACHE = 'dukkan-' + VERSION;
const CORE = ['./', './index.html', './site.js', './cloud.js', './manifest.webmanifest', './vendor/zxing.min.js', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE.map(u => new Request(u, {cache: 'reload'})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('dukkan-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
const timeout = (p, ms) => new Promise((ok, bad) => { const t = setTimeout(() => bad(new Error('timeout')), ms); p.then(r => { clearTimeout(t); ok(r); }, e => { clearTimeout(t); bad(e); }); });
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.endsWith('/version.json')) return;            // always from the internet
  const fixed = /\/(icons|vendor)\//.test(url.pathname);
  if (fixed) {                                                     // pictures and the barcode library: from the phone first
    e.respondWith(caches.match(req).then(r => r || fetch(req).then(res => { if (res.ok) { const cp = res.clone(); caches.open(CACHE).then(c => c.put(req, cp)); } return res; })));
    return;
  }
  // the app itself: the newest copy from the internet, the saved copy when offline or slow
  const fresh = req.mode === 'navigate' ? fetch(url.href, {cache: 'no-store', credentials: 'same-origin'}) : fetch(req, {cache: 'no-store'});
  e.respondWith(timeout(fresh, 5000).then(res => {
    if (res.ok) { const cp = res.clone(); caches.open(CACHE).then(c => c.put(req.mode === 'navigate' ? './index.html' : req, cp)); }
    return res;
  }).catch(() => caches.match(req.mode === 'navigate' ? './index.html' : req, {ignoreSearch: true}).then(r => r || caches.match('./index.html'))));
});

/* real notifications: they arrive even when the app is closed and the phone is locked */
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = {title: 'دكّان', body: e.data ? e.data.text() : ''}; }
  e.waitUntil(self.registration.showNotification(d.title || 'دكّان', {
    body: d.body || '', icon: './icons/icon-192.png', badge: './icons/icon-192.png', tag: d.tag || undefined,
    data: {url: d.url || './'}, dir: 'rtl', lang: 'ar', timestamp: Date.now()
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(list => {
    for (const c of list) if (c.url.startsWith(self.registration.scope)) { c.focus(); try { c.navigate(url); } catch (x) {} return; }
    return self.clients.openWindow(url);
  }));
});
