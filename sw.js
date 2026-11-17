// БЛАИНД: страница открывается даже без интернета — сначала сеть, при обрыве сохранённая копия.
const CACHE = 'blaind-v3';
const FONTS = ['playfair-display', 'cormorant-garamond'].flatMap(f => ['cyrillic', 'latin'].flatMap(s => [600, 700].map(w => `fonts/${f}-${s}-${w}-normal.woff2`)))
  .concat(['cyrillic', 'latin'].flatMap(s => [500, 700, 800].map(w => `fonts/manrope-${s}-${w}-normal.woff2`)));
const FILES = ['./', 'js/config.js', 'css/fonts.css'].concat(FONTS);
self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES))); });
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
));
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;                 // запросы к базе не кешируем
  if (/\/(fonts|css)\//.test(url.pathname)) {                // шрифты и стили: из кеша, иначе из сети
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return res; })));
    return;
  }
  const isPage = req.mode === 'navigate';
  const isConfig = url.pathname.endsWith('/js/config.js');
  if (!isPage && !isConfig) return;
  const key = isPage ? './' : 'js/config.js';
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key, copy)); }
      return res;
    }).catch(() => caches.match(key))
  );
});
