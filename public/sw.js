// Light Type service worker, shared by / (the sweep app) and /simple/ (the knot app). Network-first:
// with signal the network copy is served and cached; with no signal the cached copy opens.
// A navigation under /simple falls back to the cached /simple/ shell, every other navigation to /.
// The socket (/ws) and the API (/api) are never cached.
const VERSION = '2026-11-06-1815';   // the same stamp is in app.js; scripts/stamp.mjs sets both
const CACHE = 'light-type-shell-' + VERSION;
const SHELL = [
  '/', '/app.js', '/style.css', '/dot7.js', '/manifest.webmanifest',
  '/help/', '/help/qr.svg',
  '/simple/', '/simple/app.js', '/simple/style.css', '/simple/manifest.webmanifest',
  '/vendor/qrcode.js', '/wake.mp4', '/fonts/Px437_IBM_VGA_9x16.ttf',
  '/icons/apple-touch-icon.png', '/icons/icon-192.png', '/icons/icon-512.png',
];
const shellFor = (path) => (path === '/simple' || path.startsWith('/simple/') ? '/simple/'
  : path === '/help' || path.startsWith('/help/') ? '/help/' : '/');

// What both apps need to open with no signal. If one of these fails to load, the install fails and the
// previous complete release stays in charge (the browser tries again on the next launch).
const NEEDED = new Set(['/', '/app.js', '/style.css', '/dot7.js', '/simple/', '/simple/app.js', '/simple/style.css',
  '/vendor/qrcode.js', '/fonts/Px437_IBM_VGA_9x16.ttf']);

// each file on its own, so an optional file (icon, video) failing does not drop the rest; a redirected
// response is not kept (Safari refuses a navigation answered with one)
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => Promise.all(SHELL.map((u) => fetch(u, { cache: 'reload' })
      .then((res) => { if (res.ok && !res.redirected) return c.put(u, res); throw new Error(u + ' ' + res.status); })
      .catch((err) => { if (NEEDED.has(u)) throw err; }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// the page asks for the version before it reloads, and can ask a waiting worker to take over
self.addEventListener('message', (e) => {
  const m = e.data || {};
  if (m.t === 'skip') self.skipWaiting();
  if (m.t === 'version' && e.ports && e.ports[0]) e.ports[0].postMessage({ version: VERSION });
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/ws') || url.pathname.startsWith('/api')) return;
  if (req.headers.get('upgrade') === 'websocket') return;
  const key = req.mode === 'navigate' ? shellFor(url.pathname) : url.pathname;
  e.respondWith((async () => {
    try {
      const res = await fetch(req, { cache: 'no-store' });
      if (res && res.ok && res.type === 'basic' && !res.redirected) {
        const c = await caches.open(CACHE);
        c.put(key, res.clone());
      }
      return res;
    } catch (err) {
      const c = await caches.open(CACHE);
      const hit = await c.match(key, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
