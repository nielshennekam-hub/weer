// WeerMix frontend: haalt gecombineerde data op bij de eigen server en rendert het dashboard.

const DEFAULT_LOCATION = { name: 'Amsterdam', region: 'Noord-Holland', lat: 52.3676, lon: 4.9041 };
const REFRESH_MS = 10 * 60_000;

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

async function loadWeather() {
  const status = el('status');
  const content = el('content');
  status.hidden = false;
  status.classList.remove('error');
  status.textContent = `Weer ophalen voor ${location.name}…`;
  clearTimeout(refreshTimer);

  try {
    const res = await fetch(`/api/weather?lat=${location.lat}&lon=${location.lon}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    render(data);
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

function render(data) {
  renderCurrent(data);
  renderRain(data.rain2h);
  renderHourly(data.hourly);
  renderDaily(data.daily, data.sources);
  renderReport(data.report);
}

function renderCurrent(data) {
  const c = data.current;
  const fallbackIcon = wmoIcon(c.wmo, c.isDay);
  const icon = c.iconUrl
    ? `<img src="${escapeHtml(c.iconUrl)}" alt="" loading="lazy" onerror="this.outerHTML='${fallbackIcon}'">`
    : fallbackIcon;
  const description = c.description ?? wmoDesc(c.wmo);
  const updated = new Date(data.fetchedAt).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });

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
      <span class="meta">bijgewerkt ${updated}</span>
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

function renderRain(rain) {
  const card = el('card-rain');
  if (!rain) {
    card.innerHTML = `
      <h2>Neerslag komende 2 uur <span class="badge">Buienradar</span></h2>
      <p class="rain-summary">Geen buienverwachting beschikbaar voor deze locatie.</p>
      <p class="meta" style="color:var(--muted);font-size:.85rem">De buienverwachting van Buienradar dekt alleen Nederland en omgeving.</p>`;
    return;
  }
  card.innerHTML = `
    <h2>Neerslag komende 2 uur <span class="badge">Buienradar</span></h2>
    <p class="rain-summary">${escapeHtml(rain.summary)}</p>
    <div class="rain-chart">${rainChartSvg(rain.points)}</div>`;
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

  const ticks = points
    .map((p, i) => (i % 6 === 0 ? `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${p.time}</text>` : ''))
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
        const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
        show(await res.json());
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
