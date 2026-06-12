# WeerMix ⛅

Een weer-app die **Buienradar** en **Open-Meteo** combineert tot één overzicht, met een verwachting tot **16 dagen** vooruit.

## Wat zit erin?

| Onderdeel | Bron |
|---|---|
| Actueel weer (temperatuur, wind, vochtigheid, luchtdruk, zicht) | Buienradar — dichtstbijzijnd KNMI-meetstation |
| Neerslag komende 2 uur (per 5 minuten, met grafiek) | Buienradar buienverwachting |
| Weerbericht van de meteoroloog + korte termijn | Buienradar |
| Uurverwachting komende 48 uur | Open-Meteo |
| 16-daagse verwachting | Open-Meteo, dag 1–5 **gecombineerd** met de 5-daagse van Buienradar |
| Plaatsen zoeken (wereldwijd) | Open-Meteo Geocoding |

Voor dag 1 t/m 5 worden de temperatuur en neerslagkans van beide bronnen gemiddeld; in het uitklapbare dagdetail zie je de bronnen naast elkaar. Buiten Nederland valt de app automatisch terug op alleen Open-Meteo.

## Starten

Vereist alleen **Node.js 18+** — geen dependencies, geen build-stap.

```bash
npm start
# of: node server.js
```

Open daarna <http://localhost:3000>. Andere poort: `PORT=8080 npm start`.

## Gebruik

- Zoek een plaats via het zoekveld (wereldwijd) of gebruik 📍 voor je eigen locatie.
- Klik op een dag in de 16-daagse lijst voor details en de bronvergelijking.
- De laatst gekozen locatie wordt onthouden; de data ververst elke 10 minuten.

## PWA: installeren op je telefoon of desktop

WeerMix is een Progressive Web App:

- **Installeerbaar** — in Chrome/Edge via het installatie-icoon in de adresbalk; op iOS via Safari → Deel → "Zet op beginscherm".
- **Offline** — de app-shell wordt gecachet en zonder verbinding zie je de laatst opgehaalde weergegevens, met een duidelijke offline-melding erbij.
- Zodra de verbinding terug is, ververst de app automatisch.

Installatie vereist een veilige context: `http://localhost` werkt direct; voor gebruik op je telefoon moet de app via **HTTPS** bereikbaar zijn (bijvoorbeeld achter een reverse proxy of op een gratis Node-host).

## API

De server biedt twee endpoints die de bronnen combineren (en 5 minuten cachen):

- `GET /api/weather?lat=52.37&lon=4.89` — actueel, buien (2 u), uurlijks (48 u), 16-daags, weerbericht
- `GET /api/geocode?q=Utrecht` — plaatsnamen zoeken

## Bronnen & voorwaarden

- [Buienradar.nl](https://www.buienradar.nl) — de feed is vrij te gebruiken **met bronvermelding inclusief hyperlink** naar buienradar.nl (staat in de footer van de app).
- [Open-Meteo.com](https://open-meteo.com/) — gratis voor niet-commercieel gebruik, data onder CC BY 4.0.

## Goed om te weten

- De Buienradar-meetstations en buienverwachting dekken alleen Nederland (en directe omgeving); elders schakelt de app automatisch over op Open-Meteo.
- Een verwachting van meer dan ~7 dagen vooruit is indicatief: hoe verder weg, hoe onzekerder.
