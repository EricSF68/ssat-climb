// Offline cache for SSAT Climb.
// Strategy: when online, always fetch the latest files (so every launch is up to date);
// when offline or the network is slow, fall back to the saved copy.
const VERSION = 'climb-v1.2';
const SHELL = ['./', 'index.html', 'app.js', 'data.js', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
function timeout(ms) { return new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)); }
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return; // word lookups go straight to the network
  const key = e.request.mode === 'navigate' ? 'index.html' : e.request;
  e.respondWith(
    Promise.race([fetch(e.request, { cache: 'no-cache' }), timeout(3500)])
      .then(r => { if (r && r.ok) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(key, copy)); } return r; })
      .catch(() => caches.match(key, { ignoreSearch: true }).then(hit => hit || caches.match('index.html')))
  );
});
