// Cash Ledger service worker — bump CACHE when you deploy new files
const CACHE = 'cash-ledger-v11';
const FONTS = 'cash-ledger-fonts-v1';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'config.js', 'manifest.json', 'icon.svg',
               'icon-48.png', 'logo-white.png', 'logo-dark.png', 'modules/scrap.js'];

self.addEventListener('install', e => {
  // one missing file must not block the update, so each file is cached on its own
  e.waitUntil(caches.open(CACHE)
    .then(c => Promise.all(FILES.map(f => c.add(new Request(f, { cache: 'reload' })).catch(() => {}))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== FONTS).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Page (index.html): network first, but never wait more than 2.5 s — then use the cached copy.
// CSS / JS / images: served instantly from cache, refreshed in the background (stale-while-revalidate).
// Google Fonts: cache first (they never change).
// API calls (script.google.com) are never touched or cached.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(FONTS).then(c => c.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok || res.type === 'opaque') c.put(req, res.clone());
      return res;
    }))));
    return;
  }
  if (url.origin !== location.origin) return;

  if (req.mode === 'navigate') {
    e.respondWith(networkFirst(req, 2500));
    return;
  }
  e.respondWith(staleWhileRevalidate(req, e));
});

function networkFirst(req, ms) {
  return new Promise(resolve => {
    let done = false;
    const fromCache = () => caches.match(req).then(r => r || caches.match('index.html'));
    const timer = setTimeout(() => fromCache().then(r => { if (r && !done) { done = true; resolve(r); } }), ms);
    fetch(req).then(res => {
      clearTimeout(timer);
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put('index.html', copy)); }
      if (!done) { done = true; resolve(res); }
    }).catch(() => {
      clearTimeout(timer);
      fromCache().then(r => { if (!done) { done = true; resolve(r || Response.error()); } });
    });
  });
}

function staleWhileRevalidate(req, e) {
  return caches.open(CACHE).then(c => c.match(req, { ignoreSearch: true }).then(hit => {
    const net = fetch(req).then(res => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => hit);
    if (hit) { e.waitUntil(net); return hit; }
    return net;
  }));
}
