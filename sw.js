// Service worker for Ledger PWA.
// Scope is /macros-tracker/ — all cached paths are relative to this file's location,
// so they resolve correctly under the repo subpath without hardcoding the origin.
const CACHE = 'ledger-v4';
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  // Drop old caches on version bump so a redeploy actually ships new code.
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Never cache API traffic (USDA / Gemini later) — always hit network, fail loud.
  if (url.hostname.includes('api.') || url.hostname.includes('googleapis') || url.hostname.includes('nal.usda.gov')) {
    return; // let it go to network normally
  }
  // App shell: cache-first, fall back to network, update cache on success.
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(resp => {
        if (resp.ok && e.request.method === 'GET') {
          const clone = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return resp;
      }).catch(() => cached);
    })
  );
});
