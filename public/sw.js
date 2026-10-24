// Service worker: offline app shell + cache-first for (immutable) voice notes.
const VERSION = 'voicely-v3';
const SHELL = ['/', '/index.html', '/css/tokens.css', '/css/base.css', '/css/app.css', '/fonts/InterVariable.woff2',
  '/js/theme-boot.js', '/js/main.js', '/js/util.js', '/js/api.js', '/js/illustrations.js', '/js/player.js', '/js/timeline.js', '/js/composer.js',
  '/js/capture.js', '/js/audio-tools.js', '/js/mini-recorder.js', '/js/gestures.js', '/js/theme.js', '/manifest.webmanifest',
  '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/socket.io') || url.pathname.startsWith('/api/')) return; // realtime/API: never cache
  if (url.pathname.startsWith('/audio/')) {
    if (e.request.headers.has('range')) return;                // let range requests hit the network
    e.respondWith(caches.open(VERSION + '-audio').then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok && res.status === 200) c.put(e.request, res.clone());
      return res;
    }));
    return;
  }
  // App shell: network first, fall back to cache (and to index.html for /r/<room> links)
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok && SHELL.includes(url.pathname)) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(async () => (await caches.match(e.request)) || caches.match('/index.html')));
// Note: private (DM) audio is cached only on the device that played it.
});
