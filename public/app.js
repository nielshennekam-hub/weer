// WeerMix frontend: haalt gecombineerde weerdata op en rendert het dashboard.
// Werkt in twee modi: via de eigen Node-backend (/api/weather) of — op statische
// hosting zoals GitHub Pages — door de bronnen rechtstreeks te bevragen en
// client-side te combineren met dezelfde logica (combine.js).

import { combineWeather, searchPlaces, BUIENRADAR_FEED, RAINTEXT_URL, OPEN_METEO_URL } from './combine.js';

const DEFAULT_LOCATION = { name: 'Amsterdam', region: 'Noord-Holland', lat: 52.3676, lon: 4.9041 };
const REFRESH_MS = 10 * 60_000;

// null = nog onbekend; wordt bepaald bij de eerste fetch en onthouden.
let hasBackend = { 1: true, 0: false }[localStorage.getItem('weermix-backend')] ?? null;

function rememberBackend(value) {
  hasBackend = value;
  localStorage.setItem('weermix-backend', value ? '1' : '0');
}

// WMO-weercode -> [icoon overdag, icoon 's nachts, Nederlandse omschrijving]
const WMO = {
  0: ['☀️', '🌙', 'Onbewolkt'],
  1: ['🌤️', '🌙', 'Vrijwel onbewolkt'],
  2: ['⛅', '☁️', 'Half bewolkt'],
  3: ['☁️', '☁️', 'Bewolkt'],
  45: ['🌫️', '🌫️', 'Mist'],
  48: ['🌫️', '🌫️', 'Aanvriezende mist'],
  51: ['🌦️', '🌧️', 'Lichte motregen'],
  53: ['🌦️', '🌧️', 'Motregen'],
  55: ['🌧️', '🌧️', 'Dichte motregen'],
  56: ['🌧️', '🌧️', 'Aanvriezende motregen'],
  57: ['🌧️', '🌧️', 'Aanvriezende motregen'],
  61: ['🌧️', '🌧️', 'Lichte regen'],
  63: ['🌧️', '🌧️', 'Regen'],
  65: ['🌧️', '🌧️', 'Zware regen'],
  66: ['🌧️', '🌧️', 'IJzel'],
  67: ['🌧️', '🌧️', 'Zware ijzel'],
  71: ['🌨️', '🌨️', 'Lichte sneeuw'],
  73: ['🌨️', '🌨️', 'Sneeuw'],
  75: ['❄️', '❄️', 'Zware sneeuw'],
  77: ['❄️', '❄️', 'Motsneeuw'],
  80: ['🌦️', '🌧️', 'Lichte buien'],
  81: ['🌧️', '🌧️', 'Buien'],
  82: ['⛈️', '⛈️', 'Zware buien'],
  85: ['🌨️', '🌨️', 'Sneeuwbuien'],
  86: ['🌨️', '🌨️', 'Zware sneeuwbuien'],
  95: ['⛈️', '⛈️', 'Onweer'],
  96: ['⛈️', '⛈️', 'Onweer met hagel'],
  99: ['⛈️', '⛈️', 'Zwaar onweer met hagel'],
};
const wmoIcon = (code, isDay = 1) => (WMO[code] ?? ['❔', '❔'])[isDay ? 0 : 1];
const wmoDesc = (code) => (WMO[code] ?? [, , 'Onbekend'])[2];

const nf1 = new Intl.NumberFormat('nl-NL', { maximumFractionDigits: 1 });
const el = (id) => document.getElementById(id);
const hhmm = (iso) => (iso ? String(iso).slice(11, 16) : '–');
const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function parseLocalDate(dateStr) {
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}

function dayLabel(dateStr, index) {
  if (index === 0) return 'Vandaag';
  if (index === 1) return 'Morgen';
  return parseLocalDate(dateStr).toLocaleDateString('nl-NL', { weekday: 'long' });
}

const dayDate = (dateStr) =>
  parseLocalDate(dateStr).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });

// ---------- state ----------

let location = loadLocation();
let refreshTimer = null;
// Gekozen tijdsbereik van de buienverwachting: '2h' (radar) of '24h' (uurlijks).
let rainRange = localStorage.getItem('weermix-rain-range') ?? '24h';

function loadLocation() {
  try {
    const saved = JSON.parse(localStorage.getItem('weermix-location'));
    if (saved && Number.isFinite(saved.lat) && Number.isFinite(saved.lon)) return saved;
  } catch { /* negeer kapotte opslag */ }
  return DEFAULT_LOCATION;
}

function setLocation(loc) {
  location = loc;
  localStorage.setItem('weermix-location', JSON.stringify(loc));
  loadWeather();
}

// ---------- data laden ----------

// Probeert de eigen backend; zonder backend (statische hosting) halen we de
// bronnen rechtstreeks op. Geeft { data, offline } terug.
async function fetchWeatherPayload(lat, lon) {
  if (hasBackend !== false) {
    try {
      const res = await fetch(`api/weather?lat=${lat}&lon=${lon}`);
      if ((res.headers.get('Content-Type') ?? '').includes('json')) {
        rememberBackend(true);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        // De offline-header wordt gezet door de service worker.
        return { data, offline: res.headers.get('X-Weermix-Offline') === '1' };
      }
      rememberBackend(false); // geen JSON (bijv. 404-pagina) -> geen backend
    } catch (err) {
      if (hasBackend === true) throw err;
      rememberBackend(false);
    }
  }
  return fetchWeatherDirect(lat, lon);
}

async function fetchWeatherDirect(lat, lon) {
  const [omRes, brRes, rainRes] = await Promise.allSettled([
    fetch(OPEN_METEO_URL(lat, lon)),
    fetch(BUIENRADAR_FEED),
    fetch(RAINTEXT_URL(lat, lon)),
  ]);
  if (omRes.status === 'rejected' || !omRes.value.ok) {
    throw new Error('Open-Meteo is niet bereikbaar. Controleer je internetverbinding.');
  }
  const omResponse = omRes.value;
  const om = await omResponse.json();
  const br = brRes.status === 'fulfilled' && brRes.value.ok
    ? await brRes.value.json().catch(() => null)
    : null;
  const raintextRaw = rainRes.status === 'fulfilled' && rainRes.value.ok
    ? await rainRes.value.text().catch(() => null)
    : null;

  const data = combineWeather({ om, br, raintextRaw, lat, lon });
  // Offline serveert de service worker opgeslagen antwoorden, met deze headers.
  const offline = omResponse.headers.get('X-Weermix-Offline') === '1';
  if (offline) data.fetchedAt = omResponse.headers.get('X-Weermix-Fetched-At') ?? data.fetchedAt;
  return { data, offline };
}

async function loadWeather() {
  const status = el('status');
  const content = el('content');
  status.hidden = false;
  status.classList.remove('error');
  status.textContent = `Weer ophalen voor ${location.name}…`;
  clearTimeout(refreshTimer);

  try {
    const { data, offline } = await fetchWeatherPayload(location.lat, location.lon);
    render(data, offline);
    status.hidden = true;
    content.hidden = false;
  } catch (err) {
    content.hidden = true;
    status.classList.add('error');
    status.innerHTML = `Kon het weer niet ophalen: ${escapeHtml(err.message)} <button id="retry-btn">Opnieuw</button>`;
    el('retry-btn').addEventListener('click', loadWeather);
  } finally {
    refreshTimer = setTimeout(loadWeather, REFRESH_MS);
  }
}

// ---------- renderen ----------

function render(data, offline = false) {
  renderCurrent(data, offline);
  renderRain(data.rain2h, data.rain24h);
  renderHourly(data.hourly);
  renderDaily(data.daily, data.sources);
  renderReport(data.report);
}

function renderCurrent(data, offline = false) {
  const c = data.current;
  const fallbackIcon = wmoIcon(c.wmo, c.isDay);
  const icon = c.iconUrl
    ? `<img src="${escapeHtml(c.iconUrl)}" alt="" loading="lazy" onerror="this.outerHTML='${fallbackIcon}'">`
    : fallbackIcon;
  const description = c.description ?? wmoDesc(c.wmo);
  const updated = new Date(data.fetchedAt).toLocaleString('nl-NL', {
    ...(offline ? { weekday: 'short' } : {}), hour: '2-digit', minute: '2-digit',
  });
  const updatedNote = offline
    ? `⚠️ offline — opgeslagen gegevens van ${updated}`
    : `bijgewerkt ${updated}`;

  const details = [
    ['Gevoelstemperatuur', c.feelsLike != null ? `${nf1.format(c.feelsLike)} °C` : null],
    ['Wind', c.windBft != null ? `${c.windDir ?? ''} ${c.windBft} Bft (${nf1.format(c.windSpeedMs)} m/s)` : null],
    ['Windstoten', c.windGustsMs != null ? `${nf1.format(c.windGustsMs)} m/s` : null],
    ['Luchtvochtigheid', c.humidity != null ? `${Math.round(c.humidity)}%` : null],
    ['Luchtdruk', c.pressure != null ? `${nf1.format(c.pressure)} hPa` : null],
    ['Zicht', c.visibilityM != null ? `${Math.round(c.visibilityM / 1000)} km` : null],
    ['Neerslag nu', c.precipitationMmh != null ? `${nf1.format(c.precipitationMmh)} mm/u` : null],
    ['Afgelopen uur', c.rainLastHourMm != null ? `${nf1.format(c.rainLastHourMm)} mm` : null],
    ['Zon op / onder', c.sunrise ? `${hhmm(c.sunrise)} / ${hhmm(c.sunset)}` : null],
  ].filter(([, v]) => v != null);

  const sourceLine = c.source === 'buienradar'
    ? `Meting: ${escapeHtml(c.station)} (${c.stationDistanceKm} km) om ${hhmm(c.time)} · bron: Buienradar`
    : 'Bron: Open-Meteo (buiten bereik van de Buienradar-meetstations)';

  el('card-current').innerHTML = `
    <h2>Nu in ${escapeHtml(location.name)}
      <span class="badge">${c.source === 'buienradar' ? 'Buienradar' : 'Open-Meteo'}</span>
      <span class="meta">${updatedNote}</span>
    </h2>
    <div class="current-main">
      <div class="current-icon">${icon}</div>
      <div class="current-temp">${c.temperature != null ? nf1.format(c.temperature) : '–'}°</div>
      <div class="current-desc">
        ${escapeHtml(description)}
        <div class="sub">voelt als ${c.feelsLike != null ? nf1.format(c.feelsLike) : '–'}°</div>
      </div>
    </div>
    <div class="current-details">
      ${details.map(([label, value]) => `
        <div class="detail"><div class="label">${label}</div><div class="value">${value}</div></div>`).join('')}
    </div>
    <div class="current-foot">${sourceLine}</div>`;
}

function renderRain(rain2h, rain24h) {
  const card = el('card-rain');
  const has = { '2h': !!rain2h, '24h': !!rain24h };
  if (!has['2h'] && !has['24h']) {
    card.innerHTML = `
      <h2>Buienverwachting</h2>
      <p class="rain-summary">Geen buienverwachting beschikbaar voor deze locatie.</p>`;
    return;
  }
  if (!has[rainRange]) rainRange = has['24h'] ? '24h' : '2h';

  const draw = () => {
    const is24 = rainRange === '24h';
    const rain = is24 ? rain24h : rain2h;
    const badge = is24 || rain2h.source === 'open-meteo' ? 'Open-Meteo' : 'Buienradar';
    const tab = (range, label) =>
      has[range] ? `<button type="button" role="tab" data-range="${range}"
        class="${rainRange === range ? 'active' : ''}" aria-selected="${rainRange === range}">${label}</button>` : '';

    card.innerHTML = `
      <h2>Buienverwachting
        <span class="rain-toggle" role="tablist">${tab('2h', '2 uur')}${tab('24h', '24 uur')}</span>
        <span class="badge">${badge}</span>
      </h2>
      <p class="rain-summary">${escapeHtml(rain.summary)}</p>
      <div class="rain-chart">${is24 ? rain24hChartSvg(rain.points) : rainChartSvg(rain.points)}</div>
      ${is24 ? `<div class="rain-legend"><span><i class="sw-bar"></i> neerslag (mm/u)</span><span><i class="sw-line"></i> kans op neerslag</span></div>` : ''}`;

    for (const btn of card.querySelectorAll('.rain-toggle button')) {
      btn.addEventListener('click', () => {
        rainRange = btn.dataset.range;
        localStorage.setItem('weermix-rain-range', rainRange);
        draw();
      });
    }
  };
  draw();
}

// 24-uurs meteogram: staven = neerslag (mm/u, linkeras), lijn = neerslagkans
// (%, rechteras). Nachturen krijgen een subtiele schaduw; middernacht een lijn.
function rain24hChartSvg(points) {
  const W = 660, H = 210, padL = 26, padR = 30, padT = 14, padB = 28;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const n = points.length;
  const colW = innerW / n;
  const maxMm = Math.max(...points.map((p) => p.mm ?? 0), 0);
  const cap = Math.max(1, Math.ceil(maxMm * 1.25 * 2) / 2);
  const barW = colW * 0.62;
  const xCenter = (i) => padL + (i + 0.5) * colW;
  const yMm = (v) => padT + (1 - Math.min(v, cap) / cap) * innerH;
  const y0 = yMm(0);
  const yProb = (v) => padT + (1 - (v ?? 0) / 100) * innerH;

  let night = '';
  for (let i = 0; i < n; i++) {
    if (points[i].isDay === 0) {
      night += `<rect class="rain-night" x="${(padL + i * colW).toFixed(1)}" y="${padT}" width="${colW.toFixed(1)}" height="${innerH}"></rect>`;
    }
  }

  let midnights = '';
  points.forEach((p, i) => {
    if (String(p.time).slice(11, 16) === '00:00') {
      const x = padL + i * colW;
      const label = parseLocalDate(p.time).toLocaleDateString('nl-NL', { weekday: 'short' });
      midnights += `<line class="rain-midnight" x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${padT}" y2="${y0}"></line>
        <text class="rain-daylabel" x="${(x + 4).toFixed(1)}" y="${padT + 10}">${label}</text>`;
    }
  });

  const bars = points.map((p, i) => {
    const mm = p.mm ?? 0;
    if (mm < 0.05) return '';
    const x = xCenter(i) - barW / 2;
    const y = yMm(mm);
    const cls = mm < 1 ? 'light' : mm < 2.5 ? 'medium' : 'heavy';
    return `<rect class="rain-bar ${cls}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${(y0 - y).toFixed(1)}" rx="1.5"></rect>`;
  }).join('');

  const probLine = points.map((p, i) => `${xCenter(i).toFixed(1)},${yProb(p.prob).toFixed(1)}`).join(' ');

  const leftAxis = `
    <text class="rain-axis mm" x="${padL - 4}" y="${y0 + 4}" text-anchor="end">0</text>
    <text class="rain-axis mm" x="${padL - 4}" y="${yMm(cap) + 9}" text-anchor="end">${nf1.format(cap)}</text>`;
  const rightAxis = [0, 50, 100]
    .map((v) => `<text class="rain-axis prob" x="${W - padR + 4}" y="${yProb(v) + 4}">${v}%</text>`)
    .join('');

  const labels = points
    .map((p, i) => (i % 3 === 0 ? `<text class="rain-tick" x="${xCenter(i)}" y="${H - 8}" text-anchor="middle">${String(p.time).slice(11, 16)}</text>` : ''))
    .join('');

  return `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Neerslag en neerslagkans komende 24 uur">
      ${night}${midnights}
      <line class="axis" x1="${padL}" x2="${W - padR}" y1="${y0}" y2="${y0}"></line>
      ${bars}
      <polyline class="rain-prob" points="${probLine}"></polyline>
      ${leftAxis}${rightAxis}${labels}
    </svg>`;
}

function rainChartSvg(points) {
  const W = 640, H = 190, padL = 34, padR = 10, padT = 12, padB = 26;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const maxVal = Math.max(...points.map((p) => p.mmh), 0);
  const cap = Math.min(10, Math.max(1.5, Math.ceil(maxVal * 1.25 * 2) / 2));
  const x = (i) => padL + (i / Math.max(points.length - 1, 1)) * innerW;
  const y = (v) => padT + (1 - Math.min(v, cap) / cap) * innerH;

  const linePts = points.map((p, i) => `${x(i).toFixed(1)},${y(p.mmh).toFixed(1)}`).join(' ');
  const area = `M${x(0).toFixed(1)},${y(0)} L${linePts.replaceAll(' ', ' L')} L${x(points.length - 1).toFixed(1)},${y(0)} Z`;

  const guides = [[1, 'matig'], [2.5, 'zwaar']]
    .filter(([v]) => v < cap)
    .map(([v, label]) => `
      <line class="axis" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"></line>
      <text x="${padL - 4}" y="${y(v) + 4}" text-anchor="end">${nf1.format(v)}</text>
      <text x="${W - padR}" y="${y(v) - 4}" text-anchor="end">${label}</text>`)
    .join('');

  // Buienradar levert punten per 5 min (±24), Open-Meteo per kwartier (±9):
  // kies de labelafstand zo dat er altijd ~5 tijdslabels staan.
  const tickStep = Math.max(1, Math.round((points.length - 1) / 4));
  const ticks = points
    .map((p, i) => (i % tickStep === 0 ? `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${p.time}</text>` : ''))
    .join('');

  return `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Neerslagintensiteit komende 2 uur in mm per uur">
      <line class="axis" x1="${padL}" x2="${W - padR}" y1="${y(0)}" y2="${y(0)}"></line>
      <text x="${padL - 4}" y="${y(0) + 4}" text-anchor="end">0</text>
      ${guides}
      <path class="area" d="${area}"></path>
      <polyline class="line" points="${linePts}"></polyline>
      ${ticks}
    </svg>`;
}

function renderHourly(hourly) {
  const items = hourly.map((h) => {
    const time = hhmm(h.time);
    const isMidnight = time === '00:00';
    const label = isMidnight
      ? parseLocalDate(h.time).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric' })
      : time;
    const rain = (h.precipProb ?? 0) >= 10 || (h.precipMm ?? 0) > 0
      ? `💧 ${h.precipProb ?? 0}%`
      : '';
    return `
      <div class="hour${isMidnight ? ' day-start' : ''}">
        <div class="time">${label}</div>
        <div class="icon">${wmoIcon(h.wmo, h.isDay)}</div>
        <div class="temp">${Math.round(h.temp)}°</div>
        <div class="rain">${rain}</div>
        <div class="wind">${h.windDir ?? ''} ${h.windBft ?? ''} Bft</div>
      </div>`;
  }).join('');

  el('card-hourly').innerHTML = `
    <h2>Komende 48 uur <span class="badge">Open-Meteo</span></h2>
    <div class="hourly-strip">${items}</div>`;
}

function renderDaily(daily, sources) {
  const tMinAll = Math.min(...daily.map((d) => d.tmin));
  const tMaxAll = Math.max(...daily.map((d) => d.tmax));
  const span = Math.max(tMaxAll - tMinAll, 1);

  const rows = daily.map((d, i) => {
    const left = ((d.tmin - tMinAll) / span) * 100;
    const width = Math.max(((d.tmax - d.tmin) / span) * 100, 5);
    const rain = d.precipProb != null ? `<span class="rain">💧 ${d.precipProb}%${d.precipMm ? ` · ${nf1.format(d.precipMm)} mm` : ''}</span>` : '';
    return `
      <div class="day-row" data-idx="${i}" role="button" aria-expanded="false" tabindex="0">
        <div class="name">${dayLabel(d.date, i)}<span class="sub">${dayDate(d.date)}</span></div>
        <div class="icon" title="${escapeHtml(wmoDesc(d.wmo))}">${wmoIcon(d.wmo)}</div>
        <div class="mid">
          ${rain}
          <span>${d.windDir ?? ''} ${d.windBft ?? '–'} Bft</span>
          ${d.sources.length > 1 ? '<span class="badge">2 bronnen</span>' : ''}
        </div>
        <div class="temp-range">
          <span class="min">${d.tmin}°</span>
          <span class="temp-bar"><i style="left:${left.toFixed(1)}%;width:${width.toFixed(1)}%"></i></span>
          <span class="max">${d.tmax}°</span>
        </div>
        <div class="day-detail" hidden>${dayDetailHtml(d)}</div>
      </div>`;
  }).join('');

  const sourceNote = sources.buienradar
    ? 'Dag 1–5: gemiddelde van Buienradar en Open-Meteo · daarna Open-Meteo'
    : 'Bron: Open-Meteo (Buienradar geldt alleen voor Nederland)';

  el('card-daily').innerHTML = `
    <h2>16-daagse verwachting <span class="meta">${sourceNote}</span></h2>
    <div class="daily-list">${rows}</div>`;

  for (const row of el('card-daily').querySelectorAll('.day-row')) {
    const toggle = () => {
      const detail = row.querySelector('.day-detail');
      detail.hidden = !detail.hidden;
      row.setAttribute('aria-expanded', String(!detail.hidden));
    };
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
    row.querySelector('.day-detail').addEventListener('click', (e) => e.stopPropagation());
  }
}

function dayDetailHtml(d) {
  const stats = [
    ['Beschrijving', d.description ?? wmoDesc(d.wmo)],
    ['Neerslag', d.precipMm != null ? `${nf1.format(d.precipMm)} mm` : null],
    ['Zonuren', d.sunshineH != null ? `${nf1.format(d.sunshineH)} u` : null],
    ['Zonkans', d.buienradar?.sunChance != null ? `${d.buienradar.sunChance}%` : null],
    ['UV-index', d.uvIndex != null ? nf1.format(d.uvIndex) : null],
    ['Windstoten', d.windGustsMs != null ? `${nf1.format(d.windGustsMs)} m/s` : null],
    ['Zon op / onder', d.sunrise ? `${hhmm(d.sunrise)} / ${hhmm(d.sunset)}` : null],
  ].filter(([, v]) => v != null);

  let compare = '';
  if (d.buienradar) {
    const b = d.buienradar, o = d.openMeteo;
    const brRain = b.rainMinMm != null && b.rainMaxMm != null ? `${b.rainMinMm}–${b.rainMaxMm} mm` : '–';
    compare = `
      <table class="compare">
        <caption>Bronnen naast elkaar</caption>
        <thead><tr><th>Bron</th><th>Max</th><th>Min</th><th>Neerslagkans</th><th>Neerslag</th></tr></thead>
        <tbody>
          <tr><td>Buienradar</td><td>${b.tmax ?? '–'}°</td><td>${b.tmin ?? '–'}°</td><td>${b.rainChance ?? '–'}%</td><td>${brRain}</td></tr>
          <tr><td>Open-Meteo</td><td>${o.tmax ?? '–'}°</td><td>${o.tmin ?? '–'}°</td><td>${o.precipProb ?? '–'}%</td><td>${o.precipMm != null ? nf1.format(o.precipMm) + ' mm' : '–'}</td></tr>
          <tr class="combined"><td>Gecombineerd</td><td>${d.tmax}°</td><td>${d.tmin}°</td><td>${d.precipProb ?? '–'}%</td><td></td></tr>
        </tbody>
      </table>`;
  }

  return `
    <div class="stats">
      ${stats.map(([label, value]) => `<div>${label}: <b>${escapeHtml(String(value))}</b></div>`).join('')}
    </div>
    ${compare}`;
}

function renderReport(report) {
  const card = el('card-report');
  if (!report) {
    card.innerHTML = `
      <h2>Weerbericht <span class="badge">Buienradar</span></h2>
      <p style="color:var(--muted)">Geen weerbericht beschikbaar.</p>`;
    return;
  }
  const published = report.published
    ? new Date(report.published).toLocaleString('nl-NL', { weekday: 'long', hour: '2-digit', minute: '2-digit' })
    : null;
  card.innerHTML = `
    <h2>Weerbericht <span class="badge">Buienradar</span></h2>
    <p class="report-title">${escapeHtml(report.title ?? '')}</p>
    <p class="report-text">${escapeHtml(report.text ?? report.summary ?? '')}</p>
    ${report.shortTerm ? `<div class="report-short"><b>Komende dagen:</b> ${escapeHtml(report.shortTerm)}</div>` : ''}
    <p class="report-meta">${report.author ? `Door ${escapeHtml(report.author)}` : ''}${published ? ` · ${published}` : ''}</p>`;
}

// ---------- zoeken & locatie ----------

function setupSearch() {
  const input = el('search-input');
  const list = el('search-results');
  let debounce = null;
  let results = [];

  const hide = () => { list.hidden = true; list.innerHTML = ''; };

  const show = (items) => {
    results = items;
    if (!items.length) {
      list.innerHTML = '<li class="sub">Geen plaatsen gevonden</li>';
    } else {
      list.innerHTML = items.map((r, i) => `
        <li data-idx="${i}">
          ${escapeHtml(r.name)}
          <span class="sub">${escapeHtml([r.region, r.country].filter(Boolean).join(', '))}</span>
        </li>`).join('');
    }
    list.hidden = false;
  };

  const pick = (r) => {
    if (!r) return;
    input.value = '';
    hide();
    setLocation({ name: r.name, region: r.region, lat: r.lat, lon: r.lon });
  };

  input.addEventListener('input', () => {
    clearTimeout(debounce);
    const q = input.value.trim();
    if (q.length < 2) return hide();
    debounce = setTimeout(async () => {
      try {
        if (hasBackend === true) {
          const res = await fetch(`api/geocode?q=${encodeURIComponent(q)}`);
          show(await res.json());
        } else {
          show(await searchPlaces(q, (url) => fetch(url).then((r) => r.json())));
        }
      } catch { hide(); }
    }, 300);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') pick(results[0]);
    if (e.key === 'Escape') hide();
  });
  input.addEventListener('blur', () => setTimeout(hide, 150));

  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[data-idx]');
    if (li) pick(results[Number(li.dataset.idx)]);
  });

  el('geo-btn').addEventListener('click', () => {
    if (!navigator.geolocation) return alert('Geolocatie wordt niet ondersteund door deze browser.');
    navigator.geolocation.getCurrentPosition(
      (pos) => setLocation({
        name: 'Mijn locatie',
        region: null,
        lat: Math.round(pos.coords.latitude * 10000) / 10000,
        lon: Math.round(pos.coords.longitude * 10000) / 10000,
      }),
      () => alert('Kon je locatie niet bepalen. Controleer de browserrechten.'),
    );
  });
}

setupSearch();
loadWeather();

// PWA: service worker voor offline gebruik; bij terugkerende verbinding direct verversen.
// Relatief pad, zodat het ook werkt op een subpad zoals https://gebruiker.github.io/weer/.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker niet geregistreerd:', err));
  // Bij het eerste bezoek is de service worker pas actief ná de eerste fetch;
  // haal de data dan één keer opnieuw op zodat die ook in de offline-cache belandt.
  let refreshedOnControl = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshedOnControl) return;
    refreshedOnControl = true;
    loadWeather();
  });
}
window.addEventListener('online', loadWeather);
