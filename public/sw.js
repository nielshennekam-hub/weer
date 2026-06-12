// WeerMix service worker: app-shell uit cache, weerdata netwerk-eerst met
// offline-terugval op de laatst opgehaalde gegevens. Paden zijn relatief zodat
// dit ook werkt op een subpad (bijv. https://gebruiker.github.io/weer/).

const VERSION = 'v2';
const STATIC_CACHE = `weermix-static-${VERSION}`;
const DATA_CACHE = `weermix-data-${VERSION}`;

const APP_SHELL = [
  './',
  './style.css',
  './app.js',
  './combine.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/icon-180.png',
];

// Zonder backend bevraagt de app deze bronnen rechtstreeks; die antwoorden
// cachen we net zo voor offline gebruik. (De geocoder bewust niet.)
const DATA_HOSTS = ['api.open-meteo.com', 'data.buienradar.nl', 'gpsgadget.buienradar.nl'];

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

// Bewaar bij het cachen wanneer de data is opgehaald, zodat de app offline de
// echte ophaaltijd kan tonen in plaats van "nu".
async function putWithTimestamp(cache, request, response) {
  const headers = new Headers(response.headers);
  headers.set('X-Weermix-Fetched-At', new Date().toISOString());
  const body = await response.arrayBuffer();
  await cache.put(request, new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  }));
}

// Weerdata: probeer het netwerk en bewaar het antwoord; offline serveren we de
// laatst bekende data, herkenbaar aan de X-Weermix-Offline-header.
async function networkFirstWeather(request) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await putWithTimestamp(cache, request, response.clone());
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
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  const isWeatherData = (sameOrigin && url.pathname.endsWith('/api/weather'))
    || DATA_HOSTS.includes(url.hostname);
  if (isWeatherData) {
    event.respondWith(networkFirstWeather(request));
    return;
  }
  if (!sameOrigin || url.pathname.includes('/api/')) return; // o.a. geocoder: alleen online

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('./').then((r) => r ?? new Response('Offline', { status: 503 }))),
    );
    return;
  }
  event.respondWith(staleWhileRevalidate(request));
});
