// Light Type service worker: the app shell, network-first.
// A redeploy is picked up on the next launch with signal; with no signal the cached shell opens.
// The socket (/ws) and the API (/api) are never cached.
const CACHE = 'light-type-shell-v5';
const SHELL = [
  '/', '/index.html', '/app.js', '/style.css', '/manifest.webmanifest',
  '/vendor/qrcode.js', '/wake.mp4', '/fonts/Px437_IBM_VGA_9x16.ttf',
  '/icons/apple-touch-icon.png', '/icons/icon-192.png', '/icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/ws') || url.pathname.startsWith('/api')) return;
  if (req.headers.get('upgrade') === 'websocket') return;
  const isNav = req.mode === 'navigate';
  e.respondWith((async () => {
    try {
      const res = await fetch(req, { cache: 'no-store' });
      if (res && res.ok && res.type === 'basic') {
        const c = await caches.open(CACHE);
        c.put(isNav ? '/' : url.pathname, res.clone());
      }
      return res;
    } catch (err) {
      const c = await caches.open(CACHE);
      const hit = isNav ? (await c.match('/')) || (await c.match('/index.html'))
                        : await c.match(url.pathname, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
