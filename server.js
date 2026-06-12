// WeerMix — combineert Buienradar en Open-Meteo in één API + webapp.
// Geen dependencies; vereist Node 18+. De combineer-logica zelf staat in
// public/combine.js zodat de frontend hem ook zonder backend kan gebruiken
// (bijvoorbeeld op GitHub Pages).

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, normalize, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { combineWeather, searchPlaces, BUIENRADAR_FEED, RAINTEXT_URL, OPEN_METEO_URL } from './public/combine.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = fileURLToPath(new URL('./public', import.meta.url));

async function fetchWithTimeout(url, ms = 8000) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(ms),
    headers: { 'User-Agent': 'WeerMix/0.1 (persoonlijke weer-app)' },
  });
  if (!res.ok) throw new Error(`${res.status} voor ${url}`);
  return res;
}
const fetchJson = (url, ms) => fetchWithTimeout(url, ms).then((r) => r.json());
const fetchText = (url, ms) => fetchWithTimeout(url, ms).then((r) => r.text());

// Eenvoudige in-memory cache zodat we de bronnen niet vaker dan nodig bevragen.
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await fn();
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  cache.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}

const getBuienradarFeed = () => cached('br-feed', 5 * 60_000, () => fetchJson(BUIENRADAR_FEED));

async function getWeather(lat, lon) {
  const key = `weather:${lat.toFixed(3)},${lon.toFixed(3)}`;
  return cached(key, 5 * 60_000, async () => {
    const [omRes, brRes, rainRes] = await Promise.allSettled([
      fetchJson(OPEN_METEO_URL(lat, lon)),
      getBuienradarFeed(),
      fetchText(RAINTEXT_URL(lat, lon)),
    ]);
    if (omRes.status === 'rejected') {
      throw new Error(`Open-Meteo niet bereikbaar: ${omRes.reason?.message ?? omRes.reason}`);
    }
    return combineWeather({
      om: omRes.value,
      br: brRes.status === 'fulfilled' ? brRes.value : null,
      raintextRaw: rainRes.status === 'fulfilled' ? rainRes.value : null,
      lat,
      lon,
    });
  });
}

const geocode = (q) => cached(`geo:${q.toLowerCase()}`, 60 * 60_000, () => searchPlaces(q, fetchJson));

// ---------- HTTP-server ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(body));
}

async function serveStatic(res, pathname) {
  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  let filePath = resolve(join(PUBLIC_DIR, safePath === '/' ? 'index.html' : safePath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Verboden');
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
      // De service worker moet snel ververst worden, anders blijven updates hangen.
      'Cache-Control': filePath.endsWith('sw.js') ? 'no-cache' : 'max-age=300',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Niet gevonden');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  try {
    if (url.pathname === '/api/weather') {
      const lat = Number(url.searchParams.get('lat'));
      const lon = Number(url.searchParams.get('lon'));
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        return sendJson(res, 400, { error: 'Geef geldige lat/lon parameters mee.' });
      }
      return sendJson(res, 200, await getWeather(lat, lon));
    }
    if (url.pathname === '/api/geocode') {
      const q = (url.searchParams.get('q') ?? '').trim();
      if (q.length < 2) return sendJson(res, 200, []);
      return sendJson(res, 200, await geocode(q));
    }
    if (url.pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: 'Onbekend endpoint.' });
    }
    return await serveStatic(res, url.pathname);
  } catch (err) {
    console.error(`${req.method} ${req.url} ->`, err.message);
    return sendJson(res, 502, { error: `Weerdata ophalen mislukt: ${err.message}` });
  }
});

server.listen(PORT, () => {
  console.log(`WeerMix draait op http://localhost:${PORT}`);
});
