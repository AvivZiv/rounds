// Service worker: makes the app installable and opens offline with the last-loaded shell.
// Data (Supabase) and the embedding model are never cached here.
const CACHE = 'rounds-shell-v1';
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (e.request.mode === 'navigate') {
    // Network first for the page, so updates arrive; fall back to cache offline.
    e.respondWith(fetch(e.request).then((r) => { const c = r.clone(); caches.open(CACHE).then((cc) => cc.put(e.request, c)); return r; })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('./'))));
    return;
  }
  // Hashed build assets: cache first.
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => {
    if (r.ok) { const c = r.clone(); caches.open(CACHE).then((cc) => cc.put(e.request, c)); }
    return r;
  })));
});
