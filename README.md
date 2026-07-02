# Barrierefreier Tourenplaner (Proof of Concept)

Screenreader-freundliche Web-App zur Planung von Wander- und Radrouten —
als Antwort auf die Barrieren in der Komoot-App und im Komoot-Feature von ChatGPT.

## Hintergrund: Warum nicht direkt über Komoot?

**Komoot bietet keine öffentliche API.** Die „Komoot API“ ist eine reine
Partner-Schnittstelle für GPS-Geräte- und Hardware-Hersteller (Garmin, Bosch,
Suunto …) und erfordert einen Partnervertrag. Inoffizielle Zugänge
(z. B. die internen `api.komoot.de/v007`-Endpunkte, Projekte wie KomootGPX oder
kompy) erfordern Login-Daten, sind nicht dokumentiert, können jederzeit brechen
und verstoßen potenziell gegen die Nutzungsbedingungen — keine tragfähige Basis.

**Die Lösung:** Die eigentlichen Probleme aus dem Forum-Post lassen sich ohne
Komoot-Daten lösen, mit offenen Diensten — und das Ergebnis lässt sich als
GPX-Datei **in Komoot importieren** (komoot.com/upload), sodass die Navigation
weiterhin mit der Komoot-App (oder jeder anderen App) möglich ist.

| Problem aus dem Post | Lösung in diesem POC |
|---|---|
| Komoot GPT kann keine Touren von A nach B berechnen | Freies Routing (BRouter + Valhalla), inkl. Zwischenziel |
| Nur vorhandene Komoot-Touren, Filter führen zu Null-Ergebnissen | Jede beliebige Route wird individuell berechnet |
| Ergebnisse als Karten-Schalter, mit Screenreader oft nicht auslesbar | Reine Text-Ausgabe: Übersicht, Höhenprofil als Text, Wegbeschreibung als Liste — ganz ohne Karte |
| Keine Fitness-/Schwierigkeitseinschätzung | Gehzeit nach DIN 33466, Anstieg/Abstieg, Schwierigkeitseinstufung |
| Highlights nur aus Komoot | Gipfel, Aussichtspunkte, Hütten, Burgen etc. aus OpenStreetMap, mit Kilometerangabe entlang der Route |
| Geteilte Komoot-Touren sind in der App schwer zugänglich | „Komoot-Tour vorlesen“: Link einfügen → komplette Tour als Text (Übersicht, Wegarten, Beläge, Abbiegehinweise, GPX) |
| „Welche fertigen Touren gibt es hier?“ | Suche nach offiziell markierten Wander-/Radwegen der Region (Waymarked Trails/OSM) |

## Routenwahl: Wanderwege statt Bundesstraßen (Hybrid-Ansatz)

Komoot nutzt eine **eigene, proprietäre Routing-Engine** (auf OSM-Basis, nicht
öffentlich zugänglich). Valhallas Fußgänger-Modus optimiert auf Distanz und
schickt einen dabei auch mal die Bundesstraße entlang. Deshalb arbeitet der
Planer zweistufig:

1. **BRouter** (Profile `hiking-mountain`, `trekking`, `mtb`, `fastbike`)
   berechnet die Geometrie — diese Profile bevorzugen markierte Wanderwege,
   Pfade und Wald-/Feldwege und meiden große Straßen. BRouter liefert außerdem
   Höhendaten pro Punkt und die Wegarten-Statistik (sichtbar in der Übersicht).
2. **Valhalla** bekommt die BRouter-Geometrie als Zwischenpunkte und
   verbalisiert denselben Weg als deutsche Abbiegehinweise mit Straßennamen
   und Wegweiser-Zielen.

Fällt BRouter aus, greift automatisch das direkte Valhalla-Routing
(plus Open-Meteo für Höhen) als Fallback.

## Komoot-Community-Touren

Öffentliche Komoot-Touren sind anonym lesbar (`www.komoot.com/api/v007/tours/{id}`
bzw. `smart_tours/{id}`, mit `Accept: application/hal+json` auch `/directions`
und `/coordinates`; API sendet `Access-Control-Allow-Origin: *`). Der Bereich
„Komoot-Tour als Text vorlesen“ nutzt das rein lesend: Link oder Tour-Nummer
einfügen (auch `share_token`-Freigabe-Links), und die Tour erscheint als Text
mit Wegarten-/Belags-Anteilen, Abbiegehinweisen und GPX-Download.
Eine *Suche* nach Komoot-Touren gibt es bewusst nicht — dafür existiert kein
offizieller bzw. anonymer Endpunkt.

## Genutzte Dienste (alle offen, ohne API-Schlüssel)

- **Photon** (`photon.komoot.io`) — Ortssuche/Geocoding. Wird übrigens von
  Komoot selbst als offener Dienst betrieben.
- **BRouter** (`brouter.de`) — Routengeometrie mit Wanderweg-Präferenz und
  Höhendaten pro Punkt.
- **Valhalla** (`valhalla1.openstreetmap.de`, FOSSGIS e. V.) — verbalisiert die
  Route als **deutsche Abbiegehinweise**; Fallback-Routing.
- **Open-Meteo** (`api.open-meteo.com/v1/elevation`) — Höhendaten im
  Fallback-Fall (max. 100 Punkte pro Anfrage).
- **Overpass API** (`overpass-api.de`) — Sehenswürdigkeiten aus OpenStreetMap
  im 400-m-Korridor um die Route.
- **Komoot v007-API** (`www.komoot.com/api/v007`) — nur lesend für öffentliche
  Touren (Tour-Vorleser).
- **Waymarked Trails** (`hiking.`/`cycling.waymarkedtrails.org`) — offiziell
  markierte Wege einer Region (bbox in EPSG:3857).

Alle Dienste senden `Access-Control-Allow-Origin: *` und sind direkt aus dem
Browser nutzbar (getestet am 02.07.2026). Es handelt sich um Fair-Use-Dienste
für moderate Nutzung; für einen öffentlichen Betrieb mit vielen Nutzenden wäre
eigenes Hosting (Valhalla und Photon sind Open Source) oder ein API-Schlüssel
bei z. B. OpenRouteService/GraphHopper der saubere Weg.

## Starten

Statische Web-App ohne Build-Schritt. Einen lokalen Webserver im
Projektordner starten, z. B.:

```
npx serve .
```

oder

```
python -m http.server 8000
```

Dann im Browser `http://localhost:8000` öffnen.

## Barrierefreiheit (umgesetzt)

- Komplett kartenfrei: alle Informationen als strukturierter Text
- Semantisches HTML: Landmarken, Überschriften-Hierarchie, echte Formular-Labels
- `role="status"`-Live-Region: Screenreader werden über Fortschritt und
  Ergebnis informiert, ohne den Fokus zu verlieren
- Skip-Link, sichtbarer Fokus-Indikator, Kontrast > 7:1, Dark-Mode-Unterstützung
- Vollständig per Tastatur bedienbar, keine custom Widgets — nur native
  Formularelemente
- Mehrdeutige Ortsnamen: gefundene Orte werden als native `<select>`-Listen
  zur Bestätigung angeboten

## Dateien

- `index.html` — Struktur und Formular
- `style.css` — Kontrast, Fokus, Responsivität
- `app.js` — Geocoding, Routing, Höhenprofil, POIs, GPX-Export

## Ideen für die nächsten Schritte

- Rundtouren („10 km ab Saulgrub“) — z. B. über OpenRouteService
  (`round_trip`-Option, kostenloser API-Schlüssel nötig)
- ÖPNV-Anbindung von Start/Ziel anzeigen
- Route direkt teilen (URL-Parameter)
- GPX-Import einer markierten Route (Waymarked Trails) als Tourbasis
- Optionale Karte als *Ergänzung* (progressive enhancement), niemals als Ersatz
- Eigenes Hosting von Valhalla/BRouter/Photon für den Produktivbetrieb
- Test mit echten Screenreader-Nutzenden (NVDA/JAWS/VoiceOver)

## Lizenz-Hinweise

Kartendaten © OpenStreetMap-Mitwirkende (ODbL). Routing: Valhalla via
FOSSGIS e. V. Höhendaten: Open-Meteo (CC-BY 4.0, Copernicus DEM).
