/* radio_rainy service worker.
 * It only caches the app shell so the page opens instantly / offline ("the radio is offline" is shown by the app itself).
 * The live stream and every API call are NEVER touched: they go straight to the network (a cached stream would be stale audio). */
const VERSION = 'v1';
const SHELL = `rr-shell-${VERSION}`;
const ASSETS = `rr-assets-${VERSION}`;
const PRECACHE = ['/', '/listen', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== ASSETS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const isApi = (url) => url.pathname.startsWith('/radio') || url.pathname.startsWith('/admin') || url.pathname.startsWith('/portal') || url.pathname.startsWith('/metrics');

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || isApi(url) || req.headers.has('range')) return; // network only (streams, API, audio ranges)

  // pages: network first, cached shell when offline
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).then((res) => {
      const copy = res.clone();
      void caches.open(SHELL).then((c) => c.put('/', copy));
      return res;
    }).catch(() => caches.match('/').then((r) => r ?? Response.error())));
    return;
  }

  // built assets (hashed file names) + icons: cache first, refreshed in the background
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/') || url.pathname === '/manifest.webmanifest') {
    event.respondWith(
      caches.open(ASSETS).then(async (cache) => {
        const hit = await cache.match(req);
        const fresh = fetch(req).then((res) => {
          if (res.ok) void cache.put(req, res.clone());
          return res;
        });
        return hit ?? fresh;
      }),
    );
  }
});
