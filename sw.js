// Service worker for Ledger PWA.
// Scope is /macros-tracker/ — all cached paths are relative to this file's location,
// so they resolve correctly under the repo subpath without hardcoding the origin.
const CACHE = 'ledger-v58';
const FONT_CACHE = 'ledger-fonts-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './core.js',
  './css/style.css',
  './js/state.js',
  './js/compute.js',
  './js/ui.js',
  './js/food.js',
  './js/today.js',
  './js/plan.js',
  './js/trends.js',
  './js/lift.js',
  './js/sync.js',
  './js/app.js'
];

// The app claims to work offline, so the typefaces have to be there too. They
// live on Google's origins, are immutable once fetched, and are kept in their
// own cache that an app version bump deliberately does not evict.
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  // Drop old app caches on version bump so a redeploy actually ships new code.
  // The font cache is keyed separately and survives.
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys
        .filter(k => k !== CACHE && k !== FONT_CACHE)
        .map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // Fonts: stale-while-revalidate in their own cache. Serving the stylesheet and
  // the woff2 files from cache is what keeps the app looking like itself offline.
  if (FONT_HOSTS.indexOf(url.hostname) >= 0) {
    e.respondWith(
      caches.open(FONT_CACHE).then(c =>
        c.match(e.request).then(cached => {
          const network = fetch(e.request).then(resp => {
            if (resp && (resp.ok || resp.type === 'opaque')) c.put(e.request, resp.clone());
            return resp;
          }).catch(() => cached);
          return cached || network;
        }))
    );
    return;
  }

  // Never cache API traffic (USDA / Gemini / Supabase sync) — always hit the
  // network, so a stale answer can never be mistaken for a fresh one.
  if (url.hostname.includes('api.') || url.hostname.includes('googleapis') ||
      url.hostname.includes('nal.usda.gov') || url.hostname.includes('supabase') ||
      url.hostname.includes('openrouter.ai')) {
    return; // let it go to network normally
  }

  // App shell: cache-first, fall back to network, update the cache on success.
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(resp => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return resp;
      }).catch(() => cached);
    })
  );
});
