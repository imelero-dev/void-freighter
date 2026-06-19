// Void Freighter service worker: the game runs fully offline (OfflineWorld),
// so the whole client shell is cacheable. Strategy:
//   - navigations + /api: network-first (deploys and live data propagate),
//     cached shell as the offline fallback for navigations
//   - same-origin static assets (hashed JS/CSS, icons): cache-first
//   - /ws (game websocket): never touched
// Bump CACHE to invalidate everything after a breaking deploy.
const CACHE = 'vf-static-v1';

self.addEventListener('install', (ev) => {
  ev.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(['./', './manifest.webmanifest', './icon-192.png', './icon-512.png']))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.includes('/ws')) return;

  const networkFirst = req.mode === 'navigate' || url.pathname.includes('/api/');
  if (networkFirst) {
    ev.respondWith(
      fetch(req)
        .then((res) => {
          if (req.mode === 'navigate' && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit ?? caches.match('./'))),
    );
    return;
  }

  ev.respondWith(
    caches.match(req).then((hit) => hit ?? fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    })),
  );
});
