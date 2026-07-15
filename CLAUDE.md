# Barrierefreier Tourenplaner

Screenreader-first Web-App für Wander-/Radtourenplanung. Entstanden, weil die
Komoot-App und das Komoot-Feature in ChatGPT für Screenreader-Nutzende
unzugänglich sind (Anlass: Post im ofsight-Forum). Mit NVDA getestet.

## Nicht verhandelbare Prinzipien

- **Kartenfrei**: Alle Informationen als strukturierter Text. Eine Karte darf
  höchstens als progressive enhancement dazukommen, nie als Ersatz.
- **Nur native HTML-Elemente** (Formulare, Buttons, Listen); einzige
  ARIA-Widgets: die Tabs (WAI-ARIA-Muster) und die `role="status"`-Live-Region.
- **Statusmeldungen** laufen über die eine globale Live-Region `#status`
  (liegt außerhalb der Tab-Panels). Erfolgsmeldungen nennen die Überschrift,
  unter der das Ergebnis steht („… unter der Überschrift ‚Ihre Route‘“).
- Deutsch als UI-Sprache (Zielgruppe), deutsche Zahlenformate
  (`toLocaleString("de-DE")`), Kontrast > 7:1, sichtbarer Fokus, Dark Mode.
- **Kein Build-Schritt, keine API-Schlüssel, kein Backend** — statisches
  HTML/CSS/JS, alle Dienste werden direkt aus dem Browser aufgerufen.

## Dateien

- `index.html` — vier Tabs: Tourenplaner, Komoot-Tour als Text anzeigen,
  Markierte Wege finden, Touren in der Nähe. Footer listet immer alle
  genutzten Schnittstellen.
- `app.js` — gesamte Logik, nach Diensten in Abschnitte gegliedert.
- `style.css` — Kontrast/Fokus/Tabs.
- Starten: `python -m http.server 8000` im Projektordner.

## Architektur-Entscheidungen (und warum)

**Hybrid-Routing** (Kern der App): Valhalla allein optimiert auf Distanz und
routet Fußgänger über Bundesstraßen. Komoots eigene Engine ist proprietär und
nicht zugänglich (keine öffentliche API, Partner-API nur für Hardware-Hersteller).
Deshalb:
1. **BRouter** berechnet die Geometrie (Profile: `hiking-mountain`, `trekking`,
   `mtb`, `fastbike`) — bevorzugt Wanderwege/Pfade, liefert Höhe pro Punkt und
   die Wegarten-Statistik (WayTags in `properties.messages`).
2. **Valhalla** bekommt die BRouter-Geometrie als ~15 `through`-Punkte
   (mit `radius: 50`, Wiederholung mit 7 bzw. 0 Punkten bei Fehlschlag) und
   verbalisiert denselben Weg als deutsche Abbiegehinweise. Weicht die
   Valhalla-Länge > 15 % von der BRouter-Länge ab, steht ein Hinweis unter
   der Wegbeschreibung.
   Wichtig: `pedestrian` braucht `max_hiking_difficulty: 6`, sonst weigert sich
   Valhalla, den Bergpfaden zu folgen.
3. Fallback bei BRouter-Ausfall: direktes Valhalla-Routing + Open-Meteo-Höhen.

**„Mein Standort“ als Start**: Geolocation-API, bewusst **ohne Reverse-Geocoding**
(auf Tour gibt es keine Adresse). Der Fix wird als synthetisches Photon-Feature
(`properties.name = "Mein Standort"`) in `state.places.start` eingespeist, der
restliche Ablauf bleibt unverändert. Erkennung über `isLocationQuery()`
(Eingabe beginnt mit „mein standort“); beim Berechnen wird immer frisch
geortet (Rückfall: letzter Fix, höchstens 5 Minuten alt). Zweistufige Ortung:
GPS mit 12 s Timeout, danach Netzwerkortung. Braucht Secure Context
(https oder localhost).

**Komoot-Tour-Anzeige**: Öffentliche Komoot-Touren sind **anonym lesbar** —
`www.komoot.com/api/v007/tours/{id}` bzw. `smart_tours/{id}`, plus
`/directions` und `/coordinates` (Header `Accept: application/hal+json` nötig).
Die API sendet `Access-Control-Allow-Origin: *`. `share_token` aus
Freigabe-Links wird durchgereicht. Es gibt bewusst **keine Komoot-Tour-Suche**:
dafür existiert kein anonymer/offizieller Endpunkt (Suche nur mit Login =
ToS-Grauzone).

**Touren in der Nähe** (Suche ohne Start/Ziel): komplett über Overpass, weil
Waymarked Trails keine Geometrie-API hat (alle `details/relation/{id}/geometry*`-
Pfade → 404; nur Tags/Längen via `details/relation/{id}`). Eine Abfrage liefert
Kandidaten + Länge (`foreach.routen->.r( way(r.r); make laenge id=r.u(id()),
meter=sum(length()); out; )`), eine zweite die Geometrie aller Treffer mit
Clipping (`out geom(bbox)` — hält Fernwanderwege klein; wenn geclippt, steht
ein Hinweis am Treffer). Waldanteil: 12 Stichprobenpunkte je Tour per
`is_in(...)->.p; area.p[~"^(landuse|natural)$"~"^(forest|wood)$"]; out count;`
— die count-Elemente kommen in Blockreihenfolge zurück. GPX lädt die volle
Geometrie erst beim Klick (`out geom` ohne bbox). Eigene Rundtouren-Generierung
(osmnx/networkx) bräuchte ein Python-Backend → verstößt gegen „kein Backend“;
browsertauglicher Weg wäre OpenRouteService `round_trip` (siehe Ideen).

## Stolperfallen (gemerkt, weil selbst hineingelaufen)

- Komoot-Belagscodes haben Präfix `sf#`, Wegarten `wt#` (nicht `sb#`).
- Komoot-Richtungscodes (TL, TR, TS, TFL, TFR, TLL, TLR, TSL, TSR, TU, S)
  sind empirisch ermittelt; unbekannte Codes fallen auf
  „Weiter Richtung <Himmelsrichtung>“ zurück.
- Overpass blockiert den Node-Default-User-Agent `node` mit HTTP 406 —
  betrifft nur Node-Testskripte (User-Agent setzen), nie den Browser.
- Overpass-POST braucht `Content-Type: application/x-www-form-urlencoded`.
- Waymarked Trails erwartet die bbox in **EPSG:3857** (Web Mercator),
  nicht in WGS84-Grad (`toMercator()` in app.js).
- OpenTopoData hat keine CORS-Header (deshalb Open-Meteo für Höhen);
  Valhallas `/height` liefert auf dem FOSSGIS-Server nur `null`.
- Valhalla-Polylines haben Genauigkeit 1e-6 (nicht 1e-5); pro Leg dekodieren,
  verkettete Shape-Strings sind nicht dekodierbar.
- Valhalla mit `through`-Punkten: **ein** schlecht aufs Wegenetz einrastender
  Zwischenpunkt lässt die ganze Anfrage mit HTTP 400 („No path could be
  found“) scheitern — Hauptursache für „Wegbeschreibung fehlt oft“. Abhilfe:
  `radius: 50` an den Zwischenpunkten, nahe Duplikate herausfiltern
  (`dropClosePoints`, BRouter wiederholt Punkte an Via-Übergängen) und mit
  weniger Zwischenpunkten wiederholen (15 → 7 → 0). Der FOSSGIS-Server
  liefert außerdem sporadisch 429/5xx → wie bei Overpass wiederholen.
- Overpass (overpass-api.de) antwortet unter Last sporadisch mit 429/502/504 —
  `overpassQuery()` wiederholt deshalb bis zu 3-mal mit wachsender Pause.
  Mehr als ~12 `is_in`-Blöcke pro Abfrage provozieren 504.
- Der OSM-`distance`-Tag ist laut Wiki in km, kommt aber auch als „12,5“,
  „12.5 km“ oder „450 m“ vor (`parseDistanceKm()`); die aus den Wegen
  summierte Länge (`sum(length())`) ist verlässlicher, wenn > 0.

## Testen

Kein Test-Framework. Muster: Node-Skript lädt `app.js` per `vm.runInContext`
mit DOM-Stub und ruft die Funktionen gegen die Live-APIs auf (siehe
Scratchpad-Skripte `test.js`/`test2.js` früherer Sessions — bei Bedarf neu
anlegen, User-Agent-Wrapper für Overpass nicht vergessen). Nach UI-Änderungen
prüfen, dass alle `el("…")`-IDs aus app.js in index.html existieren.
Referenz-Testfall: Saulgrub → Bad Kohlgrub (Wandern), mit Zwischenziel
„Hinteres Hörnle“; öffentliche Komoot-Tour-ID zum Testen: 1088672553.

## Fair-Use-Hinweis

Alle Dienste sind kostenlose Community-Server für moderate Nutzung. Für einen
öffentlichen Betrieb: Valhalla/BRouter/Photon selbst hosten oder auf
OpenRouteService/GraphHopper mit API-Schlüssel wechseln.

## Nächste Schritte (Ideen)

- Rundtouren („10 km ab X“) via OpenRouteService `round_trip` (kostenloser Key)
- „Touren in der Nähe“: mehr Filterkriterien (Anstieg, Belag), Ergebnis
  direkt im Tourenplaner-Tab als Text-Wegbeschreibung öffnen
- URL-Sharing der geplanten Route, GPX-Import markierter Wege als Tourbasis
- ÖPNV-Anbindung von Start/Ziel
- Weitere Tests mit Screenreader-Nutzenden (JAWS, VoiceOver, TalkBack)
