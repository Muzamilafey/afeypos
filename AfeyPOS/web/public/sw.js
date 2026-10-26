/* Afey POS service worker: makes the web app installable and quick to open, and shows it offline.
 * Data always comes from the server: API, realtime and health requests are never cached.
 * The build stamps VERSION with a build id, so every release installs a new worker and drops old caches. */
const VERSION = '__BUILD_ID__';
const SHELL = `afey-shell-${VERSION}`;
const ASSETS = `afey-assets-${VERSION}`;
const PRECACHE = ['/', '/manifest.webmanifest', '/favicon.svg', '/logo.svg', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).catch(() => undefined));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('afey-') && k !== SHELL && k !== ASSETS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// The page asks a waiting worker to take over when the user accepts "Update now".
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

const neverCache = (url) => /^\/(api|socket\.io|health)(\/|$)/.test(url.pathname);

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || neverCache(url)) return;

  // Pages: network first so a new release shows at once; the cached app shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) caches.open(SHELL).then((c) => c.put('/', res.clone()));
          return res;
        })
        .catch(() => caches.match('/').then((r) => r || new Response('<h1>Afey POS is offline</h1><p>Check the network connection to the server, then reload.</p>', { headers: { 'Content-Type': 'text/html' } }))),
    );
    return;
  }

  // Built files have content hashes in their names: cache first. Icons, fonts and images: cache, refresh in the background.
  if (/^\/(assets|icons|images)\//.test(url.pathname) || /\.(svg|png|webp|jpg|woff2?)$/.test(url.pathname)) {
    event.respondWith(
      caches.open(ASSETS).then(async (cache) => {
        const hit = await cache.match(req);
        const fresh = fetch(req).then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        });
        if (hit) {
          if (!url.pathname.startsWith('/assets/')) fresh.catch(() => undefined);
          return hit;
        }
        return fresh;
      }),
    );
  }
});
