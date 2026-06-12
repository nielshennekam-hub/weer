// WeerMix — combineert Buienradar en Open-Meteo in één API + webapp.
// Geen dependencies; vereist Node 18+.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, normalize, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = fileURLToPath(new URL('./public', import.meta.url));

const BUIENRADAR_FEED = 'https://data.buienradar.nl/2.0/feed/json';
const RAINTEXT_URL = (lat, lon) =>
  `https://gpsgadget.buienradar.nl/data/raintext?lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}`;
const OPEN_METEO_URL = (lat, lon) =>
  'https://api.open-meteo.com/v1/forecast' +
  `?latitude=${lat}&longitude=${lon}&timezone=auto&forecast_days=16&forecast_hours=48` +
  '&wind_speed_unit=ms' +
  '&current=temperature_2m,apparent_temperature,relative_humidity_2m,is_day,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl,cloud_cover' +
  '&hourly=temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_direction_10m,is_day' +
  '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant,sunrise,sunset,uv_index_max,sunshine_duration';
const GEOCODE_URL = (q) =>
  `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=nl&format=json`;

// De feed van Buienradar bevat geen stationscoördinaten meer; dit zijn de
// vaste KNMI-locaties van de meetstations (id -> [lat, lon]).
const STATION_COORDS = {
  6209: [52.465, 4.518], 6215: [52.141, 4.437], 6225: [52.463, 4.555],
  6229: [53.0, 4.72], 6235: [52.928, 4.781], 6239: [54.854, 4.696],
  6240: [52.318, 4.79], 6242: [53.241, 4.921], 6248: [52.634, 5.174],
  6249: [52.644, 4.979], 6251: [53.392, 5.346], 6257: [52.506, 4.603],
  6258: [52.649, 5.401], 6260: [52.1, 5.18], 6267: [52.898, 5.384],
  6269: [52.458, 5.52], 6270: [53.224, 5.752], 6273: [52.703, 5.888],
  6275: [52.056, 5.873], 6277: [53.413, 6.2], 6278: [52.435, 6.259],
  6279: [52.75, 6.574], 6280: [53.125, 6.585], 6283: [52.069, 6.657],
  6286: [53.196, 7.15], 6290: [52.274, 6.891], 6310: [51.442, 3.596],
  6319: [51.226, 3.861], 6323: [51.527, 3.884], 6330: [51.992, 4.122],
  6340: [51.449, 4.342], 6343: [51.893, 4.313], 6344: [51.962, 4.447],
  6348: [51.97, 4.926], 6350: [51.566, 4.936], 6356: [51.859, 5.146],
  6370: [51.451, 5.377], 6375: [51.659, 5.707], 6377: [51.198, 5.763],
  6380: [50.906, 5.762], 6391: [51.498, 6.197], 6392: [51.451, 5.977],
};
const MAX_STATION_DISTANCE_KM = 80;

const WIND_DIRECTIONS = ['N', 'NNO', 'NO', 'ONO', 'O', 'OZO', 'ZO', 'ZZO', 'Z', 'ZZW', 'ZW', 'WZW', 'W', 'WNW', 'NW', 'NNW'];
// Beaufort-ondergrenzen in m/s voor 1..12 Bft.
const BEAUFORT_MS = [0.3, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7];

const degToDir = (deg) =>
  deg == null ? null : WIND_DIRECTIONS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];

const msToBft = (ms) => {
  if (ms == null) return null;
  let bft = 0;
  while (bft < BEAUFORT_MS.length && ms >= BEAUFORT_MS[bft]) bft++;
  return bft;
};

function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

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

function parseRaintext(text) {
  const points = [];
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^(\d{3})\|(\d{1,2}:\d{2})$/);
    if (!m) continue;
    const raw = Number(m[1]);
    // Buienradar-schaal: neerslag in mm/u = 10^((waarde - 109) / 32).
    const mmh = raw <= 0 ? 0 : Math.round(10 ** ((raw - 109) / 32) * 100) / 100;
    points.push({ time: m[2].padStart(5, '0'), mmh: mmh < 0.05 ? 0 : mmh });
  }
  return points;
}

function rainSummary(points) {
  const WET = 0.1;
  const max = Math.max(...points.map((p) => p.mmh), 0);
  const intensity = max < 1 ? 'lichte' : max < 2.5 ? 'matige' : 'zware';
  const firstWet = points.findIndex((p) => p.mmh >= WET);
  if (firstWet === -1) return 'De komende 2 uur blijft het droog.';
  if (firstWet === 0) {
    const firstDry = points.findIndex((p) => p.mmh < WET);
    return firstDry === -1
      ? `Het regent en dat houdt de komende 2 uur aan (${intensity} neerslag).`
      : `Het regent nu; rond ${points[firstDry].time} wordt het droog.`;
  }
  return `Vanaf ${points[firstWet].time} kans op ${intensity} neerslag (max ${max.toFixed(1).replace('.', ',')} mm/u).`;
}

function nearestStation(measurements, lat, lon) {
  let best = null;
  for (const st of measurements ?? []) {
    const coords = STATION_COORDS[st.StationId];
    if (!coords || st.Temperature == null) continue;
    const distanceKm = haversineKm(lat, lon, coords[0], coords[1]);
    if (!best || distanceKm < best.distanceKm) best = { station: st, distanceKm };
  }
  return best && best.distanceKm <= MAX_STATION_DISTANCE_KM ? best : null;
}

const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const avg = (a, b) => (a == null ? b : b == null ? a : (a + b) / 2);

function buildCurrent(nearest, br, om) {
  const omCur = om.current ?? {};
  if (nearest) {
    const st = nearest.station;
    return {
      source: 'buienradar',
      station: st.StationName,
      stationDistanceKm: Math.round(nearest.distanceKm),
      time: st.Timestamp ?? null,
      temperature: round1(st.Temperature),
      feelsLike: round1(st.FeelTemperature ?? omCur.apparent_temperature),
      description: st.WeatherDescription ?? null,
      iconUrl: st.FullIconUrl ?? null,
      wmo: omCur.weather_code ?? null,
      isDay: omCur.is_day ?? 1,
      windSpeedMs: round1(st.Windspeed),
      windGustsMs: round1(st.WindGusts),
      windBft: msToBft(st.Windspeed),
      windDirDeg: st.WindDirectionDegrees ?? null,
      windDir: degToDir(st.WindDirectionDegrees),
      humidity: st.Humidity ?? omCur.relative_humidity_2m ?? null,
      pressure: round1(st.AirPressure ?? omCur.pressure_msl),
      visibilityM: st.Visibility ?? null,
      precipitationMmh: st.Precipitation ?? null,
      rainLastHourMm: st.RainfallLastHour ?? null,
      sunPowerWm2: st.Sunpower ?? null,
      sunrise: br.Actual?.Sunrise ?? om.daily?.sunrise?.[0] ?? null,
      sunset: br.Actual?.Sunset ?? om.daily?.sunset?.[0] ?? null,
    };
  }
  return {
    source: 'open-meteo',
    station: null,
    stationDistanceKm: null,
    time: omCur.time ?? null,
    temperature: round1(omCur.temperature_2m),
    feelsLike: round1(omCur.apparent_temperature),
    description: null, // frontend leidt dit af uit de WMO-code
    iconUrl: null,
    wmo: omCur.weather_code ?? null,
    isDay: omCur.is_day ?? 1,
    windSpeedMs: round1(omCur.wind_speed_10m),
    windGustsMs: round1(omCur.wind_gusts_10m),
    windBft: msToBft(omCur.wind_speed_10m),
    windDirDeg: omCur.wind_direction_10m ?? null,
    windDir: degToDir(omCur.wind_direction_10m),
    humidity: omCur.relative_humidity_2m ?? null,
    pressure: round1(omCur.pressure_msl),
    visibilityM: null,
    precipitationMmh: omCur.precipitation ?? null,
    rainLastHourMm: null,
    sunPowerWm2: null,
    sunrise: om.daily?.sunrise?.[0] ?? null,
    sunset: om.daily?.sunset?.[0] ?? null,
  };
}

function buildHourly(om) {
  const h = om.hourly ?? {};
  return (h.time ?? []).map((time, i) => ({
    time,
    temp: round1(h.temperature_2m?.[i]),
    feels: round1(h.apparent_temperature?.[i]),
    precipMm: h.precipitation?.[i] ?? null,
    precipProb: h.precipitation_probability?.[i] ?? null,
    wmo: h.weather_code?.[i] ?? null,
    isDay: h.is_day?.[i] ?? 1,
    windMs: round1(h.wind_speed_10m?.[i]),
    windBft: msToBft(h.wind_speed_10m?.[i]),
    windDir: degToDir(h.wind_direction_10m?.[i]),
  }));
}

function buildDaily(om, br) {
  const d = om.daily ?? {};
  const brDays = new Map(
    (br?.Forecast?.FiveDayForecast ?? [])
      .filter((day) => day?.Day)
      .map((day) => [String(day.Day).slice(0, 10), day]),
  );

  return (d.time ?? []).map((date, i) => {
    const omDay = {
      tmin: round1(d.temperature_2m_min?.[i]),
      tmax: round1(d.temperature_2m_max?.[i]),
      precipMm: round1(d.precipitation_sum?.[i]),
      precipProb: d.precipitation_probability_max?.[i] ?? null,
    };
    const b = brDays.get(date);
    const brDay = b
      ? {
          tmin: round1(avg(b.MinTemperatureMin, b.MinTemperatureMax)),
          tmax: round1(avg(b.MaxTemperatureMin, b.MaxTemperatureMax)),
          rainChance: b.RainChance ?? null,
          sunChance: b.SunChance ?? null,
          rainMinMm: b.RainMinMm ?? null,
          rainMaxMm: b.RainMaxMm ?? null,
          windDir: typeof b.WindDirection === 'string' ? b.WindDirection.toUpperCase() : null,
          description: b.WeatherDescription ?? null,
          iconUrl: b.FullIconUrl ?? null,
        }
      : null;

    return {
      date,
      wmo: d.weather_code?.[i] ?? null,
      // Gecombineerde waarden: gemiddelde van beide bronnen waar beschikbaar.
      tmin: Math.round(avg(omDay.tmin, brDay?.tmin)),
      tmax: Math.round(avg(omDay.tmax, brDay?.tmax)),
      precipMm: omDay.precipMm,
      precipProb: brDay ? Math.round(avg(omDay.precipProb, brDay.rainChance)) : omDay.precipProb,
      description: brDay?.description ?? null,
      windBft: msToBft(d.wind_speed_10m_max?.[i]),
      windGustsMs: round1(d.wind_gusts_10m_max?.[i]),
      windDir: degToDir(d.wind_direction_10m_dominant?.[i]),
      sunrise: d.sunrise?.[i] ?? null,
      sunset: d.sunset?.[i] ?? null,
      uvIndex: round1(d.uv_index_max?.[i]),
      sunshineH: d.sunshine_duration?.[i] != null ? Math.round(d.sunshine_duration[i] / 360) / 10 : null,
      sources: brDay ? ['buienradar', 'open-meteo'] : ['open-meteo'],
      openMeteo: omDay,
      buienradar: brDay,
    };
  });
}

function buildReport(br) {
  const rep = br?.Forecast?.WeatherReport;
  if (!rep?.Text && !rep?.Summary) return null;
  return {
    title: rep.Title ?? null,
    summary: rep.Summary ?? null,
    text: rep.Text ?? null,
    published: rep.Published ?? null,
    author: rep.Author ?? null,
    shortTerm: br?.Forecast?.ShortTermForecast?.Forecast ?? null,
  };
}

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
    const om = omRes.value;
    const br = brRes.status === 'fulfilled' ? brRes.value : null;
    const rainPoints = rainRes.status === 'fulfilled' ? parseRaintext(rainRes.value) : [];

    // De 5-daagse en het weerbericht van Buienradar zijn landelijk (NL); alleen
    // combineren als de locatie binnen bereik van een Nederlands meetstation ligt.
    const nearest = br ? nearestStation(br.Actual?.WeatherStationMeasurements, lat, lon) : null;
    const current = buildCurrent(nearest, br, om);
    const daily = buildDaily(om, nearest ? br : null);
    return {
      fetchedAt: new Date().toISOString(),
      location: { lat, lon, timezone: om.timezone ?? null },
      sources: {
        openMeteo: true,
        buienradar: br != null && daily.some((d) => d.buienradar),
        buienradarStation: current.source === 'buienradar',
        rain2h: rainPoints.length > 0,
      },
      current,
      rain2h: rainPoints.length
        ? { summary: rainSummary(rainPoints), points: rainPoints }
        : null,
      hourly: buildHourly(om),
      daily,
      report: nearest ? buildReport(br) : null,
    };
  });
}

// De geocoder van Open-Meteo kent een aantal gangbare Nederlandse (bij)namen
// niet; vertaal die vooraf en probeer anders zonder het "'s-"-voorvoegsel.
const GEO_ALIASES = {
  'den bosch': 'Hertogenbosch',
  "'s-hertogenbosch": 'Hertogenbosch',
  "'s-gravenhage": 'Den Haag',
  's-gravenhage': 'Den Haag',
};

async function geocode(q) {
  const data = await cached(`geo:${q.toLowerCase()}`, 60 * 60_000, async () => {
    const alias = GEO_ALIASES[q.toLowerCase()];
    let result = await fetchJson(GEOCODE_URL(alias ?? q));
    if (!result.results?.length && /^'?s[- ]/i.test(q)) {
      result = await fetchJson(GEOCODE_URL(q.replace(/^'?s[- ]/i, '')));
    }
    return result;
  });
  return (data.results ?? []).map((r) => ({
    name: r.name,
    region: r.admin1 ?? null,
    country: r.country ?? r.country_code ?? null,
    lat: r.latitude,
    lon: r.longitude,
  }));
}

// ---------- HTTP-server ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
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
      'Cache-Control': 'max-age=300',
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
