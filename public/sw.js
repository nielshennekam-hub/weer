// WeerMix service worker: app-shell uit cache, weerdata netwerk-eerst met
// offline-terugval op de laatst opgehaalde gegevens.

const VERSION = 'v1';
const STATIC_CACHE = `weermix-static-${VERSION}`;
const DATA_CACHE = `weermix-data-${VERSION}`;

const APP_SHELL = [
  '/',
  '/style.css',
  '/app.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/icon-180.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith('weermix-') && key !== STATIC_CACHE && key !== DATA_CACHE)
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

// Weerdata: probeer het netwerk en bewaar het antwoord; offline serveren we de
// laatst bekende data voor die locatie, herkenbaar aan de X-Weermix-Offline-header.
async function networkFirstWeather(request) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) {
      const headers = new Headers(cached.headers);
      headers.set('X-Weermix-Offline', '1');
      return new Response(cached.body, { status: 200, headers });
    }
    return new Response(
      JSON.stringify({ error: 'Je bent offline en er zijn nog geen opgeslagen gegevens voor deze locatie.' }),
      { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
    );
  }
}

// App-shell: direct uit cache, en op de achtergrond verversen.
async function staleWhileRevalidate(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);
  return cached ?? (await network) ?? new Response('Offline', { status: 503 });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (url.pathname === '/api/weather') {
    event.respondWith(networkFirstWeather(request));
    return;
  }
  if (url.pathname.startsWith('/api/')) return; // geocoderen alleen online

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/').then((r) => r ?? new Response('Offline', { status: 503 }))),
    );
    return;
  }
  event.respondWith(staleWhileRevalidate(request));
});
