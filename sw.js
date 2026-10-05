/* LUMINA : l'application s'ouvre même sans réseau, pour regarder les vidéos téléchargées. */
const V = 'lumina-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icon-192.png', '/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.origin === location.origin) {
    if (u.pathname.startsWith('/api/') || u.pathname.startsWith('/media/') || u.pathname.startsWith('/convert')) return; // toujours le réseau
    if (req.mode === 'navigate' || SHELL.includes(u.pathname)) {
      e.respondWith(
        fetch(req).then((r) => { if (r.ok) { const c = r.clone(); caches.open(V).then((x) => x.put(req, c)); } return r; })
          .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('/')))
      );
    }
    return;
  }
  // Bibliothèques externes (lecteur HLS, conversion) : gardées en cache après le premier chargement.
  if (/(^|\.)cdn\.jsdelivr\.net$|(^|\.)cdnjs\.cloudflare\.com$/.test(u.host)) {
    e.respondWith(caches.match(req).then((r) => r || fetch(req).then((res) => { const c = res.clone(); caches.open(V).then((x) => x.put(req, c)); return res; })));
  }
});
