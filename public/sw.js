const CACHE_NAME = 'bigfive-offline-v1';

// Derive the app's base path from the SW's own location.
// e.g. if SW is at /bigfive-test/sw.js, BASE = '/bigfive-test/'
//      if SW is at /sw.js,              BASE = '/'
const BASE = self.location.pathname.replace(/sw\.js$/, '');

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.add(BASE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
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

  // For navigation requests (HTML), serve the cached shell
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.match(BASE).then(cached => cached || fetch(request))
    );
    return;
  }

  // For all other assets: cache-first, falling back to network
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
