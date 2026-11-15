/* Offline support: the app itself and each city's data are kept on the device
   after first use. Map background tiles are not stored and still need a connection. */
const SHELL = 'shell-v1', DATA = 'data-v1';
const SHELL_FILES = ['./', 'index.html', 'style.css', 'app.js', 'config.js', 'vendor/leaflet.js', 'vendor/leaflet.css',
  'manifest.webmanifest', 'icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== DATA).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;   // tiles, address search: straight to network
  const isData = url.pathname.includes('/data/');
  e.respondWith((async () => {
    const cache = await caches.open(isData ? DATA : SHELL);
    try {
      // network first, so a refreshed snapshot or app update arrives when online
      const fresh = await fetch(e.request, isData ? {} : { cache: 'no-cache' });
      if (fresh.ok) cache.put(e.request, fresh.clone());
      return fresh;
    } catch {
      const hit = await cache.match(e.request, { ignoreSearch: true });
      if (hit) return hit;
      throw new Error('offline and not cached');
    }
  })());
});
