// __BUILD_VERSION__ is replaced at build time by the Vite plugin.
// During development it stays as-is and the SW uses a dev cache name.
const BUILD_VERSION = '__BUILD_VERSION__';
const CACHE_NAME = 'bigfive-' + BUILD_VERSION;

const BASE = self.location.pathname.replace(/sw\.js$/, '');

self.addEventListener('install', (event) => {
  // Take over immediately — don't wait for old tabs to close
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.add(BASE))
  );
});

self.addEventListener('activate', (event) => {
  // Delete every cache except the current version
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (!request.url.startsWith(self.location.origin)) return;

  // Navigation requests (HTML pages): cache-first, network fallback.
  // The SW install event always fetches fresh HTML into the new cache,
  // so after an update the reload will serve the latest version
  // without needing to hit the network on every page load.
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.match(BASE).then(cached => cached || fetch(request))
    );
    return;
  }

  // Hashed assets (JS/CSS bundles): cache-first.
  // Vite gives them unique filenames so staleness isn't an issue.
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        if (response.ok) {
          const ct = response.headers.get('Content-Type') || '';
          if (ct.startsWith('text/') || ct.startsWith('application/javascript') || ct.startsWith('application/json') || ct.startsWith('image/')) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
          }
        }
        return response;
      });
    })
  );
});
