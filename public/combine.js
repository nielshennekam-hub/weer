// Gedeelde logica voor het combineren van Buienradar en Open-Meteo.
// Draait zowel in Node (server.js) als in de browser (app.js, statische hosting
// zoals GitHub Pages) en gebruikt daarom alleen standaard JavaScript.

export const BUIENRADAR_FEED = 'https://data.buienradar.nl/2.0/feed/json';
export const RAINTEXT_URL = (lat, lon) =>
  `https://gpsgadget.buienradar.nl/data/raintext?lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}`;
export const OPEN_METEO_URL = (lat, lon) =>
  'https://api.open-meteo.com/v1/forecast' +
  `?latitude=${lat}&longitude=${lon}&timezone=auto&forecast_days=16&forecast_hours=48` +
  '&wind_speed_unit=ms' +
  '&current=temperature_2m,apparent_temperature,relative_humidity_2m,is_day,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl,cloud_cover' +
  '&hourly=temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_direction_10m,is_day' +
  '&minutely_15=precipitation&forecast_minutely_15=9' +
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

const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const avg = (a, b) => (a == null ? b : b == null ? a : (a + b) / 2);

function parseRaintext(text) {
  const points = [];
  for (const line of String(text ?? '').split('\n')) {
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

function buildRain2h(raintextRaw, om) {
  const brPoints = parseRaintext(raintextRaw);
  if (brPoints.length) {
    return { source: 'buienradar', summary: rainSummary(brPoints), points: brPoints };
  }
  // Buiten het bereik van de Buienradar-radar: kwartierdata van Open-Meteo.
  const m = om.minutely_15 ?? {};
  const omPoints = (m.time ?? []).map((t, i) => ({
    time: String(t).slice(11, 16),
    mmh: round1((m.precipitation?.[i] ?? 0) * 4), // mm per kwartier -> mm/u
  }));
  if (!omPoints.length) return null;
  return { source: 'open-meteo', summary: rainSummary(omPoints), points: omPoints };
}

function rain24hSummary(points) {
  const WET_MM = 0.2, WET_PROB = 40;
  const isWet = (p) => (p.mm ?? 0) >= WET_MM || (p.prob ?? 0) >= WET_PROB;
  const hh = (p) => String(p.time).slice(11, 16);
  const total = points.reduce((s, p) => s + (p.mm ?? 0), 0);
  const maxMm = Math.max(...points.map((p) => p.mm ?? 0), 0);
  const hasAmount = total >= 0.1;
  const totalClause = hasAmount ? ` (totaal ~${total.toFixed(1).replace('.', ',')} mm)` : '';
  const intensity = maxMm < 1 ? 'lichte' : maxMm < 2.5 ? 'matige' : 'zware';

  const firstWet = points.findIndex(isWet);
  if (firstWet === -1) return 'De komende 24 uur blijft het vrijwel droog.';
  if (firstWet === 0) {
    const firstDry = points.findIndex((p, i) => i > 0 && !isWet(p));
    if (firstDry === -1) return `Vrijwel onafgebroken kans op neerslag${totalClause}.`;
    return `Nu kans op neerslag; rond ${hh(points[firstDry])} wordt het droger${totalClause}.`;
  }
  if (!hasAmount) {
    return `Droog tot ${hh(points[firstWet])}, daarna wat kans op een bui (weinig neerslag verwacht).`;
  }
  return `Droog tot ${hh(points[firstWet])}, daarna kans op ${intensity} neerslag${totalClause}.`;
}

// Uurlijkse neerslagverwachting voor de komende 24 uur (Open-Meteo).
function buildRain24h(om) {
  const h = om.hourly ?? {};
  const times = h.time ?? [];
  const points = [];
  for (let i = 0; i < Math.min(24, times.length); i++) {
    points.push({
      time: times[i],
      mm: round1(h.precipitation?.[i] ?? 0),
      prob: h.precipitation_probability?.[i] ?? null,
      isDay: h.is_day?.[i] ?? 1,
    });
  }
  if (!points.length) return null;
  return { summary: rain24hSummary(points), points };
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

// Combineert de ruwe antwoorden van de bronnen tot één payload.
// `om` is verplicht; `br` (feed-JSON) en `raintextRaw` (tekst) mogen null zijn.
export function combineWeather({ om, br, raintextRaw, lat, lon }) {
  // De 5-daagse en het weerbericht van Buienradar zijn landelijk (NL); alleen
  // combineren als de locatie binnen bereik van een Nederlands meetstation ligt.
  const nearest = br ? nearestStation(br.Actual?.WeatherStationMeasurements, lat, lon) : null;
  const current = buildCurrent(nearest, br, om);
  const daily = buildDaily(om, nearest ? br : null);
  const rain2h = buildRain2h(raintextRaw, om);
  const rain24h = buildRain24h(om);

  return {
    fetchedAt: new Date().toISOString(),
    location: { lat, lon, timezone: om.timezone ?? null },
    sources: {
      openMeteo: true,
      buienradar: br != null && daily.some((d) => d.buienradar),
      buienradarStation: current.source === 'buienradar',
      rain2h: rain2h != null,
      rain24h: rain24h != null,
    },
    current,
    rain2h,
    rain24h,
    hourly: buildHourly(om),
    daily,
    report: nearest ? buildReport(br) : null,
  };
}

// De geocoder van Open-Meteo kent een aantal gangbare Nederlandse (bij)namen
// niet; vertaal die vooraf en probeer anders zonder het "'s-"-voorvoegsel.
const GEO_ALIASES = {
  'den bosch': 'Hertogenbosch',
  "'s-hertogenbosch": 'Hertogenbosch',
  "'s-gravenhage": 'Den Haag',
  's-gravenhage': 'Den Haag',
};

// Zoekt plaatsen op naam; `fetchJson` wordt meegegeven zodat server (eigen
// cache/timeout) en browser (kale fetch) hun eigen transport gebruiken.
export async function searchPlaces(q, fetchJson) {
  const alias = GEO_ALIASES[q.toLowerCase()];
  let data = await fetchJson(GEOCODE_URL(alias ?? q));
  if (!data.results?.length && /^'?s[- ]/i.test(q)) {
    data = await fetchJson(GEOCODE_URL(q.replace(/^'?s[- ]/i, '')));
  }
  return (data.results ?? []).map((r) => ({
    name: r.name,
    region: r.admin1 ?? null,
    country: r.country ?? r.country_code ?? null,
    lat: r.latitude,
    lon: r.longitude,
  }));
}
