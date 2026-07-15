/* Barrierefreier Tourenplaner – Proof of Concept, Ausbaustufe 2
 *
 * Genutzte offene Dienste (alle ohne API-Schlüssel, CORS-tauglich):
 *  - Photon (photon.komoot.io): Ortssuche / Geocoding
 *  - BRouter (brouter.de): Routenberechnung mit Wanderweg-Präferenz
 *    (Profile hiking-mountain, trekking, mtb, fastbike) inkl. Höhendaten
 *  - Valhalla (valhalla1.openstreetmap.de, FOSSGIS e.V.): verbalisiert die
 *    BRouter-Route als deutsche Abbiegehinweise (Hybrid-Ansatz)
 *  - Overpass API (overpass-api.de): Sehenswürdigkeiten aus OpenStreetMap
 *  - Komoot v007-API (nur lesend, anonym): öffentliche Touren als Text
 *  - Waymarked Trails (waymarkedtrails.org): markierte Wander-/Radwege
 */

"use strict";

const PHOTON_URL = "https://photon.komoot.io/api";
const VALHALLA_URL = "https://valhalla1.openstreetmap.de/route";
const BROUTER_URL = "https://brouter.de/brouter";
const ELEVATION_URL = "https://api.open-meteo.com/v1/elevation";
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const KOMOOT_API_URL = "https://www.komoot.com/api/v007";
const WMT_URLS = { wandern: "https://hiking.waymarkedtrails.org", rad: "https://cycling.waymarkedtrails.org" };

// Aktivität -> BRouter-Profil (Routenwahl) und Valhalla-Kostenmodell (Ansagen)
const ACTIVITY_CONFIG = {
  wandern:      { brouterProfile: "hiking-mountain", costing: "pedestrian", label: "Wandern",
                  options: { max_hiking_difficulty: 6 } },
  fahrrad:      { brouterProfile: "trekking",        costing: "bicycle",    label: "Fahrradtour",
                  options: { bicycle_type: "hybrid" } },
  mountainbike: { brouterProfile: "mtb",             costing: "bicycle",    label: "Mountainbike-Tour",
                  options: { bicycle_type: "mountain", use_roads: 0.2 } },
  rennrad:      { brouterProfile: "fastbike",        costing: "bicycle",    label: "Rennradtour",
                  options: { bicycle_type: "road", use_roads: 0.9 } },
};

// Anwendungszustand
const state = {
  places: {},        // feldname -> Array von Photon-Treffern
  chosen: {},        // feldname -> Index des gewählten Treffers
  route: null,       // letzte berechnete Route (für GPX-Export)
  komootTour: null,  // zuletzt geladene Komoot-Tour (für GPX-Export)
  lastPosition: null, // letzter Geolocation-Fix { lat, lon, accuracy, timestamp }
};

const el = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

function setStatus(text) {
  el("status").textContent = text;
}

function fmtKm(km) {
  return km.toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " km";
}

function fmtM(m) {
  return Math.round(m).toLocaleString("de-DE") + " m";
}

function fmtDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const min = Math.round((seconds % 3600) / 60);
  if (h === 0) return `${min} Minuten`;
  return `${h} ${h === 1 ? "Stunde" : "Stunden"} und ${min} Minuten`;
}

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// WGS84 -> Web Mercator (EPSG:3857), von Waymarked Trails erwartet
function toMercator(lon, lat) {
  const x = (lon * 20037508.34) / 180;
  const y = (Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) / Math.PI) * 20037508.34;
  return [x, y];
}

// Valhalla liefert die Route als Polyline mit Genauigkeit 1e-6
function decodePolyline6(str) {
  const points = [];
  let index = 0, lat = 0, lon = 0;
  while (index < str.length) {
    for (const which of [0, 1]) {
      let shift = 0, result = 0, byte;
      do {
        byte = str.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += delta; else lon += delta;
    }
    points.push([lat / 1e6, lon / 1e6]);
  }
  return points;
}

// Punktliste auf höchstens n Punkte ausdünnen (erster und letzter bleiben)
function samplePoints(points, n) {
  if (points.length <= n) return points.map((p, i) => ({ point: p, index: i }));
  const out = [];
  for (let i = 0; i < n; i++) {
    const index = Math.round((i * (points.length - 1)) / (n - 1));
    out.push({ point: points[index], index });
  }
  return out;
}

// Kumulierte Distanz (Meter) für jeden Punkt der Route
function cumulativeDistances(points) {
  const dist = [0];
  for (let i = 1; i < points.length; i++) {
    dist.push(dist[i - 1] + haversineM(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]));
  }
  return dist;
}

function placeLabel(feature) {
  const p = feature.properties;
  const parts = [p.name];
  if (p.osm_value && OSM_VALUE_LABELS[p.osm_value]) parts.push(`(${OSM_VALUE_LABELS[p.osm_value]})`);
  const region = [p.city, p.county, p.state, p.country].filter((x) => x && x !== p.name);
  if (region.length) parts.push("– " + region.slice(0, 3).join(", "));
  return parts.join(" ");
}

const OSM_VALUE_LABELS = {
  village: "Dorf", town: "Stadt", city: "Stadt", hamlet: "Weiler",
  peak: "Gipfel", station: "Bahnhof", halt: "Haltepunkt", alpine_hut: "Berghütte",
  viewpoint: "Aussichtspunkt", suburb: "Ortsteil", locality: "Flurname",
};

// ---------------------------------------------------------------------------
// Geocoding (Photon)
// ---------------------------------------------------------------------------

async function geocode(query) {
  const url = `${PHOTON_URL}?q=${encodeURIComponent(query)}&lang=de&limit=5`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Ortssuche fehlgeschlagen (HTTP ${res.status})`);
  const data = await res.json();
  return (data.features || []).filter((f) => f.geometry && f.geometry.type === "Point");
}

// ---------------------------------------------------------------------------
// Standortbestimmung (Geolocation-API des Browsers)
//
// „Mein Standort“ läuft bewusst ohne Reverse-Geocoding: Auf Tour gibt es oft
// keine Adresse, die Koordinaten reichen für BRouter/Valhalla vollständig aus.
// Der Standort wird als synthetisches Photon-Feature in die bestehende
// Orts-Pipeline eingespeist (state.places), damit der restliche Ablauf
// unverändert funktioniert.
// ---------------------------------------------------------------------------

const LOCATION_NAME = "Mein Standort";

// Erkennt sowohl den vom Knopf eingetragenen Text „Mein Standort (47.65, 11.03)“
// als auch ein von Hand getipptes „mein Standort“
function isLocationQuery(query) {
  return /^mein standort\b/i.test(query.trim());
}

function getPositionOnce(options) {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, options);
  });
}

function geolocationErrorMessage(err) {
  // Eigene Fehler (kein Geolocation-Support, unsicherer Kontext) bringen
  // bereits eine verständliche Meldung mit – nicht durch die generische ersetzen
  if (err && typeof err.code !== "number" && typeof err.message === "string" && err.message) {
    return err.message;
  }
  if (err && typeof err.code === "number") {
    if (err.code === 1) {
      return "Der Zugriff auf den Standort wurde nicht erlaubt. Bitte erlauben Sie " +
        "die Standortfreigabe für diese Seite in den Browser-Einstellungen und " +
        "versuchen Sie es erneut – oder tippen Sie den Startort ein.";
    }
    if (err.code === 2) {
      return "Der Standort konnte nicht bestimmt werden (kein GPS- oder Netzwerk-Signal). " +
        "Bitte erneut versuchen oder den Startort eintippen.";
    }
    if (err.code === 3) {
      return "Die Standortbestimmung hat zu lange gedauert. Bitte erneut versuchen – " +
        "unter freiem Himmel klappt es meist besser.";
    }
  }
  return "Der Standort konnte nicht ermittelt werden. Bitte den Startort eintippen.";
}

// Robuste Ortung: erst präzise (GPS), bei Zeitüberschreitung ein zweiter,
// schnellerer Versuch per Netzwerkortung. Liefert { lat, lon, accuracy, timestamp }.
async function locateUser() {
  if (!("geolocation" in navigator)) {
    throw new Error("Dieser Browser unterstützt keine Standortabfrage. Bitte den Startort eintippen.");
  }
  if (window.isSecureContext === false) {
    throw new Error("Die Standortabfrage funktioniert nur über eine sichere Verbindung (https oder localhost).");
  }
  let position;
  try {
    position = await getPositionOnce({ enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
  } catch (err) {
    if (err && err.code === 3) {
      // GPS-Fix dauert zu lange -> grobe, aber schnelle Netzwerkortung reicht zum Routen
      position = await getPositionOnce({ enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 });
    } else {
      throw err;
    }
  }
  const fix = {
    lat: position.coords.latitude,
    lon: position.coords.longitude,
    accuracy: position.coords.accuracy,
    timestamp: position.timestamp || Date.now(),
  };
  state.lastPosition = fix;
  return fix;
}

function locationFeature(fix) {
  return {
    geometry: { type: "Point", coordinates: [fix.lon, fix.lat] },
    properties: { name: LOCATION_NAME },
  };
}

function locationInputValue(fix) {
  return `${LOCATION_NAME} (${fix.lat.toFixed(5)}, ${fix.lon.toFixed(5)})`;
}

function describeAccuracy(fix) {
  if (!fix.accuracy) return "";
  const rounded = fix.accuracy < 100 ? Math.max(10, Math.round(fix.accuracy / 10) * 10) : Math.round(fix.accuracy / 100) * 100;
  let text = `Genauigkeit etwa ${rounded.toLocaleString("de-DE")} Meter.`;
  if (fix.accuracy > 500) text += " Der Standort ist nur grob bestimmt (Netzwerkortung).";
  return text;
}

// Aktuellen Standort als Start-Feature bereitstellen. Schlägt die frische
// Ortung fehl, dient ein höchstens 5 Minuten alter letzter Fix als Rückfall.
async function currentLocationFeature() {
  try {
    return locationFeature(await locateUser());
  } catch (err) {
    const last = state.lastPosition;
    if (last && Date.now() - last.timestamp < 5 * 60 * 1000) {
      return locationFeature(last);
    }
    throw new Error(geolocationErrorMessage(err));
  }
}

// Knopf „Meinen Standort als Start verwenden“
async function useCurrentLocationAsStart() {
  const button = el("standort-knopf");
  button.disabled = true;
  try {
    setStatus("Ermittle Standort … Bitte erlauben Sie die Standortabfrage, falls der Browser nachfragt.");
    const fix = await locateUser();
    el("start").value = locationInputValue(fix);
    state.places.start = [locationFeature(fix)];
    state.chosen.start = 0;
    setStatus(
      `Standort gefunden und als Start eingetragen: Breite ${fix.lat.toFixed(5)}, Länge ${fix.lon.toFixed(5)}. ` +
      `${describeAccuracy(fix)} Sie können jetzt das Ziel eingeben und die Route berechnen.`
    );
  } catch (err) {
    setStatus(`Fehler: ${geolocationErrorMessage(err)}`);
  } finally {
    button.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Routenberechnung: BRouter wählt den Weg (bevorzugt Wanderwege),
// Valhalla verbalisiert ihn als deutsche Abbiegehinweise
// ---------------------------------------------------------------------------

async function fetchBrouterRoute(locations, activity) {
  const profile = ACTIVITY_CONFIG[activity].brouterProfile;
  const lonlats = locations.map((l) => `${l[1].toFixed(6)},${l[0].toFixed(6)}`).join("|");
  const url = `${BROUTER_URL}?lonlats=${lonlats}&profile=${profile}&alternativeidx=0&format=geojson`;
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`BRouter: ${text.slice(0, 120)}`);
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error(`BRouter: ${text.slice(0, 120)}`); }
  const feature = data.features && data.features[0];
  if (!feature) throw new Error("BRouter: keine Route gefunden");
  return {
    // Koordinaten kommen als [lon, lat, ele] -> [lat, lon] plus Höhenliste
    points: feature.geometry.coordinates.map((c) => [c[1], c[0]]),
    elevations: feature.geometry.coordinates.map((c) => c[2]),
    properties: feature.properties,
  };
}

// Wegarten-Statistik aus den BRouter-Segmentdaten (WayTags), in Metern
const HIGHWAY_LABELS = {
  path: "Pfad", track: "Wald-/Feldweg", footway: "Fußweg", steps: "Treppe",
  cycleway: "Radweg", bridleway: "Reitweg", pedestrian: "Fußgängerzone",
  residential: "Wohnstraße", living_street: "Spielstraße", service: "Zufahrtsweg",
  unclassified: "Nebenstraße", tertiary: "Landstraße", secondary: "Landstraße",
  primary: "Bundes-/Hauptstraße", trunk: "Schnellstraße",
};

function wayTypeBreakdown(properties) {
  const rows = (properties.messages || []).slice(1); // erste Zeile ist die Kopfzeile
  const meters = {};
  let total = 0;
  for (const row of rows) {
    const dist = parseInt(row[3], 10) || 0;
    const highway = ((row[9] || "").match(/highway=([a-z_]+)/) || [])[1];
    const label = HIGHWAY_LABELS[highway] || "sonstiger Weg";
    meters[label] = (meters[label] || 0) + dist;
    total += dist;
  }
  if (total === 0) return [];
  return Object.entries(meters)
    .sort((a, b) => b[1] - a[1])
    .map(([label, m]) => `${Math.round((m / total) * 100)} % ${label}`)
    .filter((s) => !s.startsWith("0 %"));
}

async function fetchValhallaRoute(locations, activity, throughRadius) {
  const config = ACTIVITY_CONFIG[activity];
  const body = {
    locations: locations.map((loc, i) => {
      const isBreak = i === 0 || i === locations.length - 1;
      const location = { lat: loc[0], lon: loc[1], type: isBreak ? "break" : "through" };
      // Zwischenpunkte stammen aus der BRouter-Geometrie und liegen oft neben
      // dem Valhalla-Wegenetz – ohne Suchradius rasten sie nicht ein
      if (!isBreak && throughRadius) location.radius = throughRadius;
      return location;
    }),
    costing: config.costing,
    costing_options: config.options ? { [config.costing]: config.options } : undefined,
    language: "de-DE",
    units: "kilometers",
  };
  // Der FOSSGIS-Server antwortet unter Last sporadisch mit 429/5xx – kurz
  // wiederholen; echte Routing-Fehler (HTTP 400) sofort melden
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(VALHALLA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();
    if (attempt < 3 && [429, 500, 502, 503, 504].includes(res.status)) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
      continue;
    }
    let detail = "";
    try { detail = (await res.json()).error || ""; } catch (e) { /* ignorieren */ }
    throw new Error(`Routenberechnung fehlgeschlagen. ${detail}`);
  }
}

// Aufeinanderfolgende, (fast) identische Punkte entfernen – die BRouter-
// Geometrie wiederholt Punkte an Via-Übergängen, und doppelte Zwischenpunkte
// lassen Valhalla-Anfragen scheitern
function dropClosePoints(points, minMeters) {
  const out = [points[0]];
  for (const p of points.slice(1)) {
    const last = out[out.length - 1];
    if (haversineM(last[0], last[1], p[0], p[1]) >= minMeters) out.push(p);
  }
  return out;
}

// Abbiegehinweise für eine vorhandene Route: die BRouter-Geometrie wird als
// Zwischenpunkte an Valhalla übergeben, das denselben Weg dann verbalisiert.
// Ein einziger Zwischenpunkt, der schlecht auf das Valhalla-Wegenetz
// einrastet, lässt die ganze Anfrage mit HTTP 400 („No path could be found“)
// scheitern – deshalb wird mit immer weniger Zwischenpunkten wiederholt.
// Liefert { maneuvers, lengthKm } (Valhalla-Länge zum Abgleich mit BRouter).
async function fetchInstructionsForTrack(points, activity) {
  const start = points[0];
  const end = points[points.length - 1];
  let lastError;
  for (const viaCount of [15, 7, 0]) {
    const via = samplePoints(points, viaCount + 2).slice(1, -1).map((s) => s.point);
    const locations = dropClosePoints([start, ...via], 25);
    const last = locations[locations.length - 1];
    if (locations.length > 1 && haversineM(last[0], last[1], end[0], end[1]) < 25) locations.pop();
    locations.push(end);
    try {
      const data = await fetchValhallaRoute(locations, activity, 50);
      return {
        maneuvers: data.trip.legs.flatMap((l) => l.maneuvers),
        lengthKm: data.trip.summary ? data.trip.summary.length : null,
      };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Höhenauswertung
// ---------------------------------------------------------------------------

// Fallback, falls BRouter keine Höhen liefert (max. 100 Punkte pro Anfrage)
async function fetchElevations(points) {
  const sampled = samplePoints(points, 100);
  const lats = sampled.map((s) => s.point[0].toFixed(5)).join(",");
  const lons = sampled.map((s) => s.point[1].toFixed(5)).join(",");
  const res = await fetch(`${ELEVATION_URL}?latitude=${lats}&longitude=${lons}`);
  if (!res.ok) throw new Error("Höhendaten nicht verfügbar");
  const data = await res.json();
  return sampled.map((s, i) => ({ ...s, elevation: data.elevation[i] }));
}

// Anstieg/Abstieg mit Schwellwert gegen Messrauschen
function elevationStats(samples) {
  const threshold = 8; // Meter
  let ascent = 0, descent = 0;
  let reference = samples[0].elevation;
  let min = Infinity, max = -Infinity;
  for (const s of samples) {
    min = Math.min(min, s.elevation);
    max = Math.max(max, s.elevation);
    const diff = s.elevation - reference;
    if (diff >= threshold) { ascent += diff; reference = s.elevation; }
    else if (diff <= -threshold) { descent -= diff; reference = s.elevation; }
  }
  return { ascent, descent, min, max };
}

// Höhenprofil als Text: Route in Abschnitte gleicher Tendenz einteilen
function describeProfile(samples, cumDist) {
  const totalKm = cumDist[cumDist.length - 1] / 1000;
  const sectionCount = Math.min(6, Math.max(3, Math.round(totalKm / 3)));
  const lines = [];
  for (let i = 0; i < sectionCount; i++) {
    const a = Math.round((i * (samples.length - 1)) / sectionCount);
    const b = Math.round(((i + 1) * (samples.length - 1)) / sectionCount);
    const from = samples[a], to = samples[b];
    const kmA = cumDist[from.index] / 1000;
    const kmB = cumDist[to.index] / 1000;
    const diff = to.elevation - from.elevation;
    const distKm = kmB - kmA;
    const gradient = Math.abs(diff) / (distKm * 1000) * 100;
    let trend;
    if (Math.abs(diff) < 15) trend = "weitgehend eben";
    else {
      const direction = diff > 0 ? "Anstieg" : "Abstieg";
      let steepness = "sanfter";
      if (gradient >= 10) steepness = "steiler";
      else if (gradient >= 5) steepness = "moderater";
      trend = `${steepness} ${direction} von ${fmtM(from.elevation)} auf ${fmtM(to.elevation)}`;
    }
    lines.push(
      `Kilometer ${kmA.toLocaleString("de-DE", { maximumFractionDigits: 1 })} bis ` +
      `${kmB.toLocaleString("de-DE", { maximumFractionDigits: 1 })}: ${trend}.`
    );
  }
  return lines;
}

// Gehzeit nach DIN 33466 (Bergwandern): 4 km/h horizontal,
// 300 Hm/h bergauf, 500 Hm/h bergab; kleinerer Wert zählt zur Hälfte
function hikingTimeSeconds(distanceKm, ascent, descent) {
  const horizontal = (distanceKm / 4) * 3600;
  const vertical = (ascent / 300) * 3600 + (descent / 500) * 3600;
  return Math.max(horizontal, vertical) + Math.min(horizontal, vertical) / 2;
}

function difficulty(activity, distanceKm, ascent) {
  const isHiking = activity === "wandern";
  const easy = isHiking ? distanceKm < 10 && ascent < 300 : distanceKm < 30 && ascent < 300;
  const medium = isHiking ? distanceKm < 18 && ascent < 800 : distanceKm < 60 && ascent < 900;
  if (easy) return "leicht – auch für wenig Geübte geeignet";
  if (medium) return "mittel – gute Grundkondition empfohlen";
  return "schwer – sehr gute Kondition erforderlich";
}

// ---------------------------------------------------------------------------
// Sehenswürdigkeiten entlang der Route (Overpass)
// ---------------------------------------------------------------------------

const POI_LABELS = {
  viewpoint: "Aussichtspunkt", peak: "Gipfel", alpine_hut: "Berghütte",
  wilderness_hut: "Schutzhütte", castle: "Burg/Schloss", ruins: "Ruine",
  waterfall: "Wasserfall", chapel: "Kapelle", monastery: "Kloster",
};

// Overpass ist ein Community-Server und antwortet unter Last mit 429/502/504 –
// ein Wiederholungsversuch nach kurzer Pause fängt das meiste ab
async function overpassQuery(query) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "data=" + encodeURIComponent(query),
    });
    if (res.ok) return res.json();
    if (attempt >= 4 || ![429, 502, 504].includes(res.status)) {
      throw new Error(`Overpass nicht erreichbar (HTTP ${res.status})`);
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 4000));
  }
}

async function fetchPois(points) {
  // Route auf ~25 Stützpunkte ausdünnen und als Korridor (400 m) abfragen
  const corridor = samplePoints(points, 25)
    .map((s) => `${s.point[0].toFixed(5)},${s.point[1].toFixed(5)}`)
    .join(",");
  const query = `
    [out:json][timeout:20];
    (
      node["tourism"="viewpoint"](around:400,${corridor});
      node["natural"="peak"]["name"](around:400,${corridor});
      node["tourism"="alpine_hut"](around:400,${corridor});
      node["tourism"="wilderness_hut"](around:400,${corridor});
      node["historic"="castle"](around:400,${corridor});
      node["historic"="ruins"]["name"](around:400,${corridor});
      node["waterway"="waterfall"]["name"](around:400,${corridor});
      node["building"="chapel"]["name"](around:400,${corridor});
    );
    out body 40;`;
  const data = await overpassQuery(query);
  return data.elements || [];
}

// Für jeden POI: Kilometerstelle an der Route und Abstand zur Route bestimmen
function locatePois(pois, points, cumDist) {
  return pois
    .map((poi) => {
      let bestDist = Infinity, bestIndex = 0;
      // Route grob abtasten reicht für die Ortsangabe
      for (let i = 0; i < points.length; i += 3) {
        const d = haversineM(poi.lat, poi.lon, points[i][0], points[i][1]);
        if (d < bestDist) { bestDist = d; bestIndex = i; }
      }
      const tags = poi.tags || {};
      const kind =
        POI_LABELS[tags.tourism] || POI_LABELS[tags.natural] || POI_LABELS[tags.historic] ||
        POI_LABELS[tags.waterway] || POI_LABELS[tags.building] || "Sehenswürdigkeit";
      return {
        name: tags.name || kind,
        kind,
        ele: tags.ele ? parseFloat(tags.ele) : null,
        km: cumDist[bestIndex] / 1000,
        offset: bestDist,
      };
    })
    .sort((a, b) => a.km - b.km);
}

// ---------------------------------------------------------------------------
// GPX-Export
// ---------------------------------------------------------------------------

function escapeXml(s) {
  return s.replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
}

// route: { name, points: [[lat,lon],...], elevations: [ele,...] | null }
// oder   { name, segments: [[[lat,lon],...], ...] } für OSM-Relationen,
// deren Strecke aus mehreren (nicht verbundenen) Wegen besteht
function buildGpx(route) {
  const name = escapeXml(route.name);
  const segments = route.segments || [route.points];
  const trksegs = segments
    .map((points) => {
      const trkpts = points
        .map((p, i) => {
          const ele = !route.segments && route.elevations ? route.elevations[i] : null;
          const eleTag = ele !== null && ele !== undefined ? `<ele>${Number(ele).toFixed(1)}</ele>` : "";
          return `      <trkpt lat="${p[0].toFixed(6)}" lon="${p[1].toFixed(6)}">${eleTag}</trkpt>`;
        })
        .join("\n");
      return `    <trkseg>\n${trkpts}\n    </trkseg>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Barrierefreier Tourenplaner (POC)"
     xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${name}</name>
    <desc>Erstellt mit dem barrierefreien Tourenplaner. Daten: OpenStreetMap (ODbL).</desc>
  </metadata>
  <trk>
    <name>${name}</name>
${trksegs}
  </trk>
</gpx>`;
}

function triggerGpxDownload(route) {
  const gpx = buildGpx(route);
  const blob = new Blob([gpx], { type: "application/gpx+xml" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const safeName = route.name.toLowerCase()
    .replace(/[äöüß]/g, (c) => ({ ä: "ae", ö: "oe", ü: "ue", ß: "ss" }[c]))
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  a.download = `tour-${safeName}.gpx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
  setStatus("GPX-Datei wurde heruntergeladen.");
}

// ---------------------------------------------------------------------------
// Komoot-Tour vorlesen (öffentliche Touren, anonym lesbar)
// ---------------------------------------------------------------------------

const KOMOOT_SPORT_LABELS = {
  hike: "Wanderung", touringbicycle: "Radtour", mtb: "Mountainbike-Tour",
  racebike: "Rennradtour", jogging: "Lauf", e_touringbicycle: "E-Bike-Tour",
  e_mtb: "E-Mountainbike-Tour", mtb_easy: "Gravel-Tour", climbing: "Klettertour",
  mountaineering: "Bergtour", skitour: "Skitour", nordicwalking: "Nordic Walking",
};

const KOMOOT_GRADE_LABELS = { EASY: "leicht", MODERATE: "mittel", DIFFICULT: "schwer" };

const KOMOOT_WAYTYPE_LABELS = {
  trail: "Pfad", track: "Wald-/Feldweg", footway: "Fußweg", cycleway: "Radweg",
  way: "Weg", street: "Straße", primary: "Bundes-/Hauptstraße", secondary: "Landstraße",
  tertiary: "Landstraße", residential: "Wohnstraße", service: "Zufahrtsweg",
  unclassified: "Nebenstraße", ferry: "Fähre", alpine_bike: "alpiner Trail",
  hike_d2: "Bergweg (T2)", hike_d3: "Bergweg (T3)", hike_d4: "alpiner Steig (T4)",
  hike_d5: "anspruchsvoller alpiner Steig (T5)", movable_bridge: "bewegliche Brücke",
};

const KOMOOT_SURFACE_LABELS = {
  asphalt: "Asphalt", paved: "befestigt", unpaved: "unbefestigt", gravel: "Schotter",
  ground: "Naturboden", compacted: "fester Kiesbelag", cobblestone: "Kopfsteinpflaster",
  cobbles: "Kopfsteinpflaster", concrete: "Beton", paving_stones: "Pflastersteine",
  sand: "Sand", stone: "Stein", wood: "Holz", grass_paver: "Rasengittersteine",
  nature: "Naturboden", alpin: "alpines Gelände", unknown: "unbekannter Belag",
};

// Richtungscodes der Komoot-API (empirisch ermittelt; unbekannte Codes
// werden generisch als "Weiter Richtung …" ausgegeben)
const KOMOOT_DIRECTION_LABELS = {
  S: "Start", F: "Ziel erreicht", TS: "Geradeaus weiter",
  TL: "Links abbiegen", TR: "Rechts abbiegen",
  TSL: "Leicht links abbiegen", TSR: "Leicht rechts abbiegen",
  TSHL: "Scharf links abbiegen", TSHR: "Scharf rechts abbiegen",
  TFL: "An der Gabelung links halten", TFR: "An der Gabelung rechts halten",
  TLL: "Links halten", TLR: "Rechts halten",
  TU: "Wenden", P: "Passieren", PT: "Passieren",
  EL: "Ausfahrt links nehmen", ER: "Ausfahrt rechts nehmen",
  RE: "In den Kreisverkehr", EXIT: "Kreisverkehr verlassen",
};

const CARDINAL_LABELS = {
  N: "Norden", NE: "Nordosten", E: "Osten", SE: "Südosten",
  S: "Süden", SW: "Südwesten", W: "Westen", NW: "Nordwesten",
};

// Erkennt Komoot-URLs wie komoot.com/tour/123, komoot.de/de-de/tour/123,
// komoot.com/smarttour/456 – oder eine reine Zahlen-ID
function parseKomootReference(input) {
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/(tour|smarttour)\/(\d+)/);
  const tokenMatch = trimmed.match(/share_token=([A-Za-z0-9_-]+)/);
  if (urlMatch) {
    return {
      endpoint: urlMatch[1] === "smarttour" ? "smart_tours" : "tours",
      id: urlMatch[2],
      shareToken: tokenMatch ? tokenMatch[1] : null,
    };
  }
  if (/^\d+$/.test(trimmed)) return { endpoint: "tours", id: trimmed, shareToken: null };
  return null;
}

async function fetchKomoot(path, shareToken) {
  const token = shareToken ? `${path.includes("?") ? "&" : "?"}share_token=${shareToken}` : "";
  const res = await fetch(`${KOMOOT_API_URL}/${path}${token}`, {
    headers: { Accept: "application/hal+json,application/json" },
  });
  if (res.status === 403 || res.status === 404) {
    throw new Error("Tour nicht gefunden oder nicht öffentlich. Private Touren sind nur mit einem Freigabe-Link (share_token) lesbar.");
  }
  if (!res.ok) throw new Error(`Komoot antwortet nicht (HTTP ${res.status}).`);
  return res.json();
}

function komootBreakdownText(list, labels, prefix) {
  if (!list || list.length === 0) return null;
  const parts = list
    .filter((entry) => entry.amount >= 0.005)
    .sort((a, b) => b.amount - a.amount)
    .map((entry) => {
      const code = entry.type.replace(/^(wt|sb|sf)#/, "");
      return `${Math.round(entry.amount * 100)} % ${labels[code] || code.replace(/_/g, " ")}`;
    });
  return parts.length ? parts.join(", ") : null;
}

async function readKomootTour() {
  const input = el("komoot-url").value;
  const ref = parseKomootReference(input);
  const button = el("komoot-lesen-knopf");
  el("komoot-ergebnis").hidden = true;
  if (!ref) {
    setStatus("Das sieht nicht nach einem Komoot-Link oder einer Tour-Nummer aus. Beispiel: https://www.komoot.com/tour/123456789");
    return;
  }
  button.disabled = true;
  try {
    setStatus("Lade Tour von Komoot …");
    const tour = await fetchKomoot(`${ref.endpoint}/${ref.id}`, ref.shareToken);

    // Übersicht
    const dl = el("komoot-uebersicht");
    dl.innerHTML = "";
    const addRow = (term, value) => {
      if (value === null || value === undefined || value === "") return;
      const dt = document.createElement("dt");
      dt.textContent = term;
      const dd = document.createElement("dd");
      dd.textContent = value;
      dl.appendChild(dt);
      dl.appendChild(dd);
    };
    addRow("Name", tour.name);
    addRow("Art", KOMOOT_SPORT_LABELS[tour.sport] || tour.sport);
    if (tour.distance) addRow("Distanz", fmtKm(tour.distance / 1000));
    if (tour.duration) addRow("Dauer laut Komoot", fmtDuration(tour.duration));
    if (tour.elevation_up !== undefined) addRow("Anstieg", fmtM(tour.elevation_up));
    if (tour.elevation_down !== undefined) addRow("Abstieg", fmtM(tour.elevation_down));
    if (tour.difficulty && tour.difficulty.grade) {
      addRow("Schwierigkeit laut Komoot", KOMOOT_GRADE_LABELS[tour.difficulty.grade] || tour.difficulty.grade);
    }
    const summary = tour.summary || {};
    addRow("Wegarten", komootBreakdownText(summary.waytypes, KOMOOT_WAYTYPE_LABELS));
    addRow("Beläge", komootBreakdownText(summary.surfaces, KOMOOT_SURFACE_LABELS));

    // Abbiegehinweise und Koordinaten parallel laden
    setStatus("Lade Wegbeschreibung und Streckenverlauf …");
    const [directions, coordinates] = await Promise.all([
      fetchKomoot(`${ref.endpoint}/${ref.id}/directions`, ref.shareToken).catch(() => null),
      fetchKomoot(`${ref.endpoint}/${ref.id}/coordinates`, ref.shareToken).catch(() => null),
    ]);

    const dirList = el("komoot-wegbeschreibung");
    dirList.innerHTML = "";
    if (directions && directions.items && directions.items.length) {
      let meters = 0;
      for (const item of directions.items) {
        const li = document.createElement("li");
        const base = KOMOOT_DIRECTION_LABELS[item.type] ||
          `Weiter Richtung ${CARDINAL_LABELS[item.cardinal_direction] || item.cardinal_direction || "unbekannt"}`;
        const street = item.street_name ? ` auf ${item.street_name}` : "";
        const km = (meters / 1000).toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
        li.textContent = `Bei Kilometer ${km}: ${base}${street}.`;
        dirList.appendChild(li);
        meters += item.distance || 0;
      }
    } else {
      const li = document.createElement("li");
      li.textContent = "Für diese Tour stellt Komoot keine Abbiegehinweise bereit.";
      dirList.appendChild(li);
    }

    // GPX vorbereiten
    if (coordinates && coordinates.items && coordinates.items.length) {
      state.komootTour = {
        name: tour.name || `Komoot-Tour ${ref.id}`,
        points: coordinates.items.map((c) => [c.lat, c.lng]),
        elevations: coordinates.items.map((c) => c.alt),
      };
      el("komoot-gpx-knopf").hidden = false;
    } else {
      state.komootTour = null;
      el("komoot-gpx-knopf").hidden = true;
    }

    el("komoot-ergebnis").hidden = false;
    setStatus(`Komoot-Tour geladen: ${tour.name}. Die Details stehen unter der Überschrift „Tour im Detail“.`);
  } catch (err) {
    setStatus(`Fehler: ${err.message}`);
  } finally {
    button.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Markierte Wander-/Radwege in der Region (Waymarked Trails / OpenStreetMap)
// ---------------------------------------------------------------------------

const WMT_GROUP_LABELS = {
  INT: "internationaler Fernweg", NAT: "nationaler Fernweg",
  REG: "regionaler Weg", LOC: "lokaler Weg",
};
const WMT_GROUP_ORDER = { LOC: 0, REG: 1, NAT: 2, INT: 3 };

async function searchMarkedTrails() {
  const query = el("wege-ort").value.trim();
  const kind = el("wege-art").value;
  const button = el("wege-suchen-knopf");
  if (!query) {
    setStatus("Bitte einen Ort für die Wegsuche eingeben.");
    return;
  }
  button.disabled = true;
  el("wege-ergebnis").hidden = true;
  try {
    setStatus("Suche Ort …");
    const places = await geocode(query);
    if (places.length === 0) {
      setStatus(`Kein Ort für „${query}“ gefunden.`);
      return;
    }
    const place = places[0];
    const [lon, lat] = place.geometry.coordinates;

    setStatus(`Suche markierte Wege rund um ${place.properties.name} …`);
    const radiusDeg = 0.09; // etwa 7–10 km
    const [x1, y1] = toMercator(lon - radiusDeg, lat - radiusDeg * 0.7);
    const [x2, y2] = toMercator(lon + radiusDeg, lat + radiusDeg * 0.7);
    const base = WMT_URLS[kind];
    const res = await fetch(`${base}/api/v1/list/by_area?bbox=${x1},${y1},${x2},${y2}&limit=15`);
    if (!res.ok) throw new Error(`Waymarked Trails antwortet nicht (HTTP ${res.status}).`);
    const data = await res.json();
    const results = (data.results || []).sort(
      (a, b) => (WMT_GROUP_ORDER[a.group] ?? 9) - (WMT_GROUP_ORDER[b.group] ?? 9)
    );

    // Details (Länge, Website) für die Trefferliste nachladen
    const details = await Promise.all(
      results.map((r) =>
        fetch(`${base}/api/v1/details/relation/${r.id}`).then((d) => (d.ok ? d.json() : null)).catch(() => null)
      )
    );

    const list = el("wege-liste");
    list.innerHTML = "";
    el("wege-status").textContent =
      results.length === 0
        ? `Rund um ${place.properties.name} sind in OpenStreetMap keine markierten ${kind === "wandern" ? "Wanderwege" : "Radwege"} eingetragen.`
        : `${results.length} markierte ${kind === "wandern" ? "Wanderwege" : "Radwege"} rund um ${place.properties.name} (Daten: OpenStreetMap):`;

    results.forEach((r, i) => {
      const li = document.createElement("li");
      const detail = details[i];
      const parts = [];
      let title = r.name || r.ref || "Unbenannter Weg";
      if (r.ref && r.name) title += ` (Markierung: ${r.ref})`;
      parts.push(title);
      parts.push(WMT_GROUP_LABELS[r.group] || "Weg");
      const lengthM = detail && (detail.official_length || (detail.route && detail.route.length));
      if (lengthM) parts.push(`Gesamtlänge etwa ${fmtKm(lengthM / 1000)}`);
      li.textContent = parts.join(", ") + ".";
      if (detail && detail.url) {
        li.append(" ");
        const a = document.createElement("a");
        a.href = detail.url;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = "Offizielle Website (öffnet in neuem Tab)";
        li.appendChild(a);
      }
      list.appendChild(li);
    });

    el("wege-ergebnis").hidden = false;
    setStatus(`Wegsuche abgeschlossen: ${results.length} Treffer. Die Liste steht unter der Überschrift „Markierte Wege“.`);
  } catch (err) {
    setStatus(`Fehler: ${err.message}`);
  } finally {
    button.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Touren in der Nähe: komplette Touren aus OpenStreetMap finden, ohne Start
// und Ziel zu kennen. Overpass liefert die Routen-Relationen samt Länge und
// (geclippter) Geometrie; der Waldanteil wird über Stichprobenpunkte entlang
// der Strecke per is_in gegen landuse=forest / natural=wood geschätzt.
// ---------------------------------------------------------------------------

const NEARBY_CONFIG = {
  wandern: { relationFilter: '["route"~"^(hiking|foot)$"]', fallbackKind: "Wanderroute", plural: "Wandertouren" },
  rad:     { relationFilter: '["route"="bicycle"]',         fallbackKind: "Radroute",    plural: "Radtouren" },
  mtb:     { relationFilter: '["route"="mtb"]',             fallbackKind: "Mountainbike-Route", plural: "Mountainbike-Touren" },
};

const NETWORK_LABELS = {
  lwn: "lokaler Wanderweg", rwn: "regionaler Wanderweg",
  nwn: "nationaler Fernwanderweg", iwn: "internationaler Fernwanderweg",
  lcn: "lokales Radnetz", rcn: "regionales Radnetz",
  ncn: "nationaler Radfernweg", icn: "internationaler Radfernweg",
};

const NEARBY_MAX_RESULTS = 10;  // Touren pro Suche (begrenzt die Folgeabfragen)
const FOREST_SAMPLES = 12;      // Stichprobenpunkte je Tour für den Waldanteil

// Der distance-Tag ist laut OSM-Wiki in Kilometern; "12,5", "12.5 km"
// und explizite Meterangaben ("450 m") kommen trotzdem vor
function parseDistanceKm(value) {
  if (!value) return null;
  const num = parseFloat(String(value).replace(",", "."));
  if (!isFinite(num) || num <= 0) return null;
  if (/\d\s*m(?![a-z])/i.test(value) && !/km/i.test(value)) return num / 1000;
  return num;
}

// Alle Routen-Relationen im Umkreis, mit Tags, Mittelpunkt und der aus den
// Mitglieds-Wegen aufsummierten Länge (eine einzige Overpass-Abfrage)
async function fetchNearbyCandidates(lat, lon, radiusM, art) {
  const filter = NEARBY_CONFIG[art].relationFilter;
  const query = `
    [out:json][timeout:60];
    relation["type"="route"]${filter}(around:${radiusM},${lat.toFixed(5)},${lon.toFixed(5)})->.routen;
    .routen out tags center;
    foreach.routen->.r(
      way(r.r);
      make laenge id=r.u(id()), meter=sum(length());
      out;
    );`;
  const data = await overpassQuery(query);
  const meters = {};
  const relations = [];
  for (const e of data.elements || []) {
    if (e.type === "laenge" && e.tags) meters[e.tags.id] = parseFloat(e.tags.meter) || 0;
    else if (e.type === "relation") relations.push(e);
  }
  return relations.map((r) => {
    const mappedKm = (meters[String(r.id)] || 0) / 1000;
    return {
      id: r.id,
      tags: r.tags || {},
      lengthKm: mappedKm > 0.1 ? mappedKm : parseDistanceKm((r.tags || {}).distance),
      centerKm: r.center ? haversineM(lat, lon, r.center.lat, r.center.lon) / 1000 : null,
    };
  });
}

// Geometrie einer Relation aus einer Overpass-out-geom-Antwort einsammeln
function relationSegments(rel) {
  return (rel.members || [])
    .filter((m) => m.type === "way" && Array.isArray(m.geometry))
    .map((m) => m.geometry.filter(Boolean).map((g) => [g.lat, g.lon]))
    .filter((s) => s.length > 1);
}

// Streckenverläufe mehrerer Relationen, auf das Suchgebiet zugeschnitten
// (Clipping hält die Antwort klein, auch wenn ein Fernwanderweg dabei ist)
async function fetchNearbyGeometries(ids, lat, lon, radiusM) {
  const dLat = (radiusM + 20000) / 111320;
  const dLon = dLat / Math.cos((lat * Math.PI) / 180);
  const bbox = `${lat - dLat},${lon - dLon},${lat + dLat},${lon + dLon}`;
  const data = await overpassQuery(
    `[out:json][timeout:60];relation(id:${ids.join(",")});out geom(${bbox});`
  );
  const segments = {};
  for (const e of data.elements || []) {
    if (e.type === "relation") segments[e.id] = relationSegments(e);
  }
  return segments;
}

// Vollständige Geometrie einer einzelnen Relation (für den GPX-Export)
async function fetchFullTrailGeometry(id) {
  const data = await overpassQuery(`[out:json][timeout:60];relation(${id});out geom;`);
  const rel = (data.elements || []).find((e) => e.type === "relation");
  const segments = rel ? relationSegments(rel) : [];
  if (!segments.length) throw new Error("Kein Streckenverlauf für diese Tour verfügbar.");
  return segments;
}

// Waldanteil je Tour: prüft für Stichprobenpunkte per is_in, ob sie in einer
// Wald-Fläche liegen. Punkte werden gebündelt abgefragt; schlägt eine
// Teilabfrage trotz Wiederholungen fehl, bleibt der Waldanteil der
// betroffenen Touren unbekannt (null), die Suche läuft weiter.
async function computeForestShares(sampleSets, onProgress) {
  const jobs = [];
  sampleSets.forEach((points, routeIndex) => {
    (points || []).forEach(([lat, lon]) => jobs.push({ routeIndex, lat, lon }));
  });
  const inForest = sampleSets.map(() => 0);
  const failed = new Set();
  const chunkSize = FOREST_SAMPLES;
  const chunkCount = Math.ceil(jobs.length / chunkSize);
  for (let i = 0; i < jobs.length; i += chunkSize) {
    const chunk = jobs.slice(i, i + chunkSize);
    if (onProgress) onProgress(i / chunkSize + 1, chunkCount);
    const query = "[out:json][timeout:30];\n" + chunk.map((j) =>
      `is_in(${j.lat.toFixed(5)},${j.lon.toFixed(5)})->.p;` +
      `area.p[~"^(landuse|natural)$"~"^(forest|wood)$"];out count;`
    ).join("\n");
    try {
      const data = await overpassQuery(query);
      const counts = (data.elements || []).filter((e) => e.type === "count");
      counts.forEach((c, k) => {
        if (k < chunk.length && parseInt(c.tags && c.tags.total, 10) > 0) {
          inForest[chunk[k].routeIndex] += 1;
        }
      });
    } catch (err) {
      chunk.forEach((j) => failed.add(j.routeIndex));
    }
  }
  return sampleSets.map((points, i) =>
    points && points.length && !failed.has(i)
      ? Math.round((inForest[i] / points.length) * 100)
      : null
  );
}

function nearbyTourTitle(tags) {
  return tags.name || tags.ref || "Unbenannte Tour";
}

function renderNearbyTours(tours, placeName, art) {
  const list = el("naehe-liste");
  list.innerHTML = "";
  el("naehe-status").textContent = tours.length === 0
    ? `Rund um ${placeName} wurde keine passende Tour gefunden. Versuchen Sie einen größeren Suchradius oder weniger strenge Filter.`
    : `${tours.length} ${tours.length === 1 ? "Tour" : "Touren"} rund um ${placeName}, sortiert nach Entfernung (Daten: OpenStreetMap):`;

  for (const tour of tours) {
    const tags = tour.tags;
    const li = document.createElement("li");
    const title = nearbyTourTitle(tags);
    const parts = [title + (tags.name && tags.ref ? ` (Markierung: ${tags.ref})` : "")];
    const network = (tags.network || "").split(";")[0].trim();
    parts.push(NETWORK_LABELS[network] || NEARBY_CONFIG[art].fallbackKind);
    if (tags.roundtrip === "yes") parts.push("Rundtour");
    parts.push(tour.lengthKm ? `Länge etwa ${fmtKm(tour.lengthKm)}` : "Länge unbekannt");
    if (tour.nearestKm !== null) {
      parts.push(tour.nearestKm < 0.3
        ? "verläuft direkt am gewählten Ort"
        : `kürzeste Entfernung zum Ort etwa ${fmtKm(tour.nearestKm)}`);
    }
    parts.push(tour.forestShare !== null
      ? `Waldanteil etwa ${tour.forestShare} %`
      : "Waldanteil derzeit nicht ermittelbar");
    let text = parts.join(", ") + ".";
    if (tour.clipped) {
      text += " Die Tour führt über das Suchgebiet hinaus; Entfernung und Waldanteil beziehen sich auf den nahen Abschnitt.";
    }
    const description = tags.description || tags.note;
    if (description) text += ` Beschreibung: ${description}${/[.!?]$/.test(description) ? "" : "."}`;
    li.textContent = text;

    if (tags.website || tags.url) {
      li.append(" ");
      const a = document.createElement("a");
      a.href = tags.website || tags.url;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "Website der Tour (öffnet in neuem Tab)";
      li.appendChild(a);
    }

    li.append(" ");
    const gpxButton = document.createElement("button");
    gpxButton.type = "button";
    gpxButton.textContent = `GPX-Datei für „${title}“ herunterladen`;
    gpxButton.addEventListener("click", async () => {
      gpxButton.disabled = true;
      try {
        setStatus(`Lade vollständigen Streckenverlauf von „${title}“ …`);
        const segments = await fetchFullTrailGeometry(tour.id);
        triggerGpxDownload({ name: title, segments });
      } catch (err) {
        setStatus(`Fehler: ${err.message}`);
      } finally {
        gpxButton.disabled = false;
      }
    });
    li.appendChild(gpxButton);

    list.appendChild(li);
  }
  el("naehe-ergebnis").hidden = false;
}

async function searchNearbyTours() {
  const query = el("naehe-ort").value.trim();
  const art = el("naehe-art").value;
  const radiusM = parseInt(el("naehe-radius").value, 10) * 1000;
  const minKm = parseFloat(el("naehe-min").value) || null;
  const maxKm = parseFloat(el("naehe-max").value) || null;
  const minForest = parseInt(el("naehe-wald").value, 10) || null;
  const button = el("naehe-suchen-knopf");
  if (!query) {
    setStatus("Bitte einen Ort für die Tourensuche eingeben.");
    return;
  }
  button.disabled = true;
  el("naehe-ergebnis").hidden = true;
  try {
    setStatus("Suche Ort …");
    const places = await geocode(query);
    if (places.length === 0) {
      setStatus(`Kein Ort für „${query}“ gefunden.`);
      return;
    }
    const place = places[0];
    const placeName = place.properties.name;
    const [lon, lat] = place.geometry.coordinates;

    setStatus(`Suche ${NEARBY_CONFIG[art].plural} rund um ${placeName} … Das kann eine halbe Minute dauern.`);
    const candidates = await fetchNearbyCandidates(lat, lon, radiusM, art);

    // Längenfilter; ohne bekannte Länge ist der Filter nicht prüfbar
    let filtered = candidates.filter((c) => {
      if (minKm === null && maxKm === null) return true;
      if (c.lengthKm === null) return false;
      return (minKm === null || c.lengthKm >= minKm) && (maxKm === null || c.lengthKm <= maxKm);
    });
    filtered.sort((a, b) => (a.centerKm ?? Infinity) - (b.centerKm ?? Infinity));
    const shown = filtered.slice(0, NEARBY_MAX_RESULTS);

    if (shown.length === 0) {
      renderNearbyTours([], placeName, art);
      setStatus(
        `Keine passende Tour rund um ${placeName} gefunden` +
        (candidates.length ? ` (${candidates.length} Touren lagen außerhalb der Längenfilter)` : "") +
        ". Versuchen Sie einen größeren Suchradius oder andere Filterwerte."
      );
      return;
    }

    setStatus(`Lade Streckenverläufe von ${shown.length} Touren …`);
    const geometries = await fetchNearbyGeometries(shown.map((c) => c.id), lat, lon, radiusM);

    const sampleSets = [];
    for (const tour of shown) {
      const segments = geometries[tour.id] || [];
      const flat = segments.flat();
      tour.segments = segments;
      tour.nearestKm = null;
      tour.clipped = false;
      tour.forestShare = null;
      if (flat.length) {
        let nearest = Infinity;
        const step = Math.max(1, Math.floor(flat.length / 300));
        for (let i = 0; i < flat.length; i += step) {
          nearest = Math.min(nearest, haversineM(lat, lon, flat[i][0], flat[i][1]));
        }
        tour.nearestKm = nearest / 1000;
        // Wurde die Geometrie am Suchgebietsrand abgeschnitten?
        let fetchedM = 0;
        for (const seg of segments) {
          for (let i = 1; i < seg.length; i++) {
            fetchedM += haversineM(seg[i - 1][0], seg[i - 1][1], seg[i][0], seg[i][1]);
          }
        }
        tour.clipped = tour.lengthKm !== null && fetchedM / 1000 < tour.lengthKm * 0.85;
      }
      sampleSets.push(flat.length ? samplePoints(flat, FOREST_SAMPLES).map((s) => s.point) : null);
    }

    const shares = await computeForestShares(sampleSets, (step, total) =>
      setStatus(`Ermittle Waldanteil entlang der Touren (Abfrage ${step} von ${total}) …`)
    );
    shown.forEach((tour, i) => { tour.forestShare = shares[i]; });

    // Touren mit unbekanntem Waldanteil (Overpass-Teilausfall) bleiben in der
    // Liste und werden entsprechend gekennzeichnet
    let result = shown;
    if (minForest !== null) {
      result = result.filter((t) => t.forestShare === null || t.forestShare >= minForest);
    }
    result.sort((a, b) => (a.nearestKm ?? a.centerKm ?? Infinity) - (b.nearestKm ?? b.centerKm ?? Infinity));

    renderNearbyTours(result, placeName, art);
    setStatus(
      `Tourensuche abgeschlossen: ${result.length} ${result.length === 1 ? "Tour" : "Touren"} rund um ${placeName}` +
      (filtered.length > shown.length ? ` (die ${NEARBY_MAX_RESULTS} nächstgelegenen von ${filtered.length})` : "") +
      ". Die Liste steht unter der Überschrift „Gefundene Touren“."
    );
  } catch (err) {
    setStatus(`Fehler: ${err.message}`);
  } finally {
    button.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Darstellung des Routenplaners
// ---------------------------------------------------------------------------

function renderPlaceChoices(fields) {
  const container = el("ortsauswahl-felder");
  container.innerHTML = "";
  const fieldLabels = { start: "Start", via: "Zwischenziel", ziel: "Ziel" };
  for (const field of fields) {
    const features = state.places[field];
    if (!features || features.length === 0) continue;
    const wrapper = document.createElement("div");
    wrapper.className = "formularfeld";
    const label = document.createElement("label");
    label.setAttribute("for", `auswahl-${field}`);
    label.textContent = `${fieldLabels[field]}: gefundener Ort`;
    const select = document.createElement("select");
    select.id = `auswahl-${field}`;
    features.forEach((f, i) => {
      const option = document.createElement("option");
      option.value = String(i);
      option.textContent = placeLabel(f);
      if (i === (state.chosen[field] || 0)) option.selected = true;
      select.appendChild(option);
    });
    select.addEventListener("change", () => {
      state.chosen[field] = parseInt(select.value, 10);
    });
    wrapper.appendChild(label);
    wrapper.appendChild(select);
    container.appendChild(wrapper);
  }
  el("ortsauswahl").hidden = false;
}

function renderRoute({ activity, points, elevations, brouterProps, maneuvers, maneuversKm, placeNames }) {
  const config = ACTIVITY_CONFIG[activity];
  const cumDist = cumulativeDistances(points);
  const distanceKm = cumDist[cumDist.length - 1] / 1000;

  const routeName = `${placeNames.start} nach ${placeNames.ziel} (${config.label})`;
  state.route = { name: routeName, points, elevations };

  // Höhenstatistik aus den BRouter-Höhen; vereinzelte Lücken in den
  // Höhenwerten werden übersprungen statt die ganze Auswertung zu verwerfen
  let elevation = null;
  if (elevations) {
    const samples = samplePoints(points, 200)
      .map((s) => ({ ...s, elevation: elevations[s.index] }))
      .filter((s) => typeof s.elevation === "number" && isFinite(s.elevation));
    if (samples.length >= 10) elevation = { samples, stats: elevationStats(samples) };
  }

  // Übersicht
  const dl = el("uebersicht-liste");
  dl.innerHTML = "";
  const addRow = (term, value) => {
    if (!value) return;
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = value;
    dl.appendChild(dt);
    dl.appendChild(dd);
  };
  addRow("Strecke", `${placeNames.start} nach ${placeNames.ziel}` + (placeNames.via ? ` über ${placeNames.via}` : ""));
  addRow("Aktivität", config.label);
  addRow("Distanz", fmtKm(distanceKm));

  if (activity === "wandern" && elevation) {
    addRow("Gehzeit (nach DIN 33466)", fmtDuration(hikingTimeSeconds(distanceKm, elevation.stats.ascent, elevation.stats.descent)));
  } else if (brouterProps && brouterProps["total-time"]) {
    addRow("Fahrzeit (geschätzt)", fmtDuration(parseInt(brouterProps["total-time"], 10)));
  }

  if (elevation) {
    addRow("Anstieg gesamt", fmtM(elevation.stats.ascent));
    addRow("Abstieg gesamt", fmtM(elevation.stats.descent));
    addRow("Höchster Punkt", fmtM(elevation.stats.max));
    addRow("Tiefster Punkt", fmtM(elevation.stats.min));
  }
  addRow("Schwierigkeit", difficulty(activity, distanceKm, elevation ? elevation.stats.ascent : 0));

  // Wegarten aus den BRouter-Segmentdaten – zeigt, wie viel echter
  // Wanderweg (Pfad, Wald-/Feldweg) in der Route steckt
  if (brouterProps) {
    const breakdown = wayTypeBreakdown(brouterProps);
    if (breakdown.length) addRow("Wegarten", breakdown.join(", "));
  }

  // Höhenprofil als Text
  const profileList = el("hoehenprofil-liste");
  profileList.innerHTML = "";
  const profileLines = elevation ? describeProfile(elevation.samples, cumDist) : ["Höhendaten sind derzeit nicht verfügbar."];
  for (const line of profileLines) {
    const li = document.createElement("li");
    li.textContent = line;
    profileList.appendChild(li);
  }

  // Wegbeschreibung
  const stepsList = el("wegbeschreibung-liste");
  stepsList.innerHTML = "";
  if (maneuvers && maneuvers.length) {
    let kmSoFar = 0;
    for (const m of maneuvers) {
      const li = document.createElement("li");
      const kmText = kmSoFar.toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
      li.textContent = `Bei Kilometer ${kmText}: ${m.instruction}`;
      stepsList.appendChild(li);
      kmSoFar += m.length;
    }
    // Der Ansage-Dienst folgt der Route nicht immer exakt – bei deutlicher
    // Abweichung ehrlich darauf hinweisen (wichtig für die Navigation)
    if (maneuversKm && Math.abs(maneuversKm - distanceKm) / distanceKm > 0.15) {
      const li = document.createElement("li");
      li.textContent =
        `Hinweis: Die Wegbeschreibung weicht stellenweise von der berechneten Route ab ` +
        `(Ansagen für ${fmtKm(maneuversKm)}, Route ${fmtKm(distanceKm)}). ` +
        `Distanz und Höhenprofil oben gelten für die Route; die GPX-Datei enthält den exakten Verlauf.`;
      stepsList.appendChild(li);
    }
  } else {
    const li = document.createElement("li");
    li.textContent =
      "Die Abbiegehinweise konnten gerade nicht erzeugt werden – der Ansage-Dienst war " +
      "nicht erreichbar oder konnte dem Weg nicht folgen. Meist hilft es, die Route über " +
      "„Mit dieser Auswahl neu berechnen“ noch einmal zu berechnen. " +
      "Die GPX-Datei enthält den vollständigen Streckenverlauf.";
    stepsList.appendChild(li);
  }

  el("ergebnis").hidden = false;
  return { cumDist };
}

function renderPois(pois) {
  const list = el("highlights-liste");
  list.innerHTML = "";
  const statusEl = el("highlights-status");
  if (pois.length === 0) {
    statusEl.textContent = "Entlang dieser Route sind in OpenStreetMap keine Sehenswürdigkeiten eingetragen.";
    return;
  }
  statusEl.textContent = `${pois.length} ${pois.length === 1 ? "Eintrag" : "Einträge"} gefunden (aus OpenStreetMap, im Umkreis von 400 Metern um die Route):`;
  for (const poi of pois) {
    const li = document.createElement("li");
    const parts = [`${poi.kind}: ${poi.name}`];
    if (poi.ele) parts.push(`Höhe ${fmtM(poi.ele)}`);
    parts.push(`bei Kilometer ${poi.km.toLocaleString("de-DE", { maximumFractionDigits: 1 })}`);
    if (poi.offset > 60) parts.push(`etwa ${Math.round(poi.offset / 10) * 10} Meter abseits der Route`);
    li.textContent = parts.join(", ") + ".";
    list.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// Ablaufsteuerung Routenplaner
// ---------------------------------------------------------------------------

async function planRoute({ regeocode }) {
  const button = el("berechnen-knopf");
  button.disabled = true;
  el("ergebnis").hidden = true;
  try {
    const queries = {
      start: el("start").value.trim(),
      via: el("via").value.trim(),
      ziel: el("ziel").value.trim(),
    };
    const activity = el("aktivitaet").value;
    const fields = ["start", "via", "ziel"].filter((f) => queries[f] !== "");

    if (regeocode) {
      setStatus("Suche Orte …");
      for (const field of fields) {
        if (field === "start" && isLocationQuery(queries.start)) {
          // Beim Berechnen immer frisch orten – auf Tour ändert sich der
          // Standort zwischen zwei Berechnungen
          setStatus("Ermittle aktuellen Standort …");
          const feature = await currentLocationFeature();
          el("start").value = locationInputValue(state.lastPosition);
          state.places.start = [feature];
          state.chosen.start = 0;
          continue;
        }
        state.places[field] = await geocode(queries[field]);
        state.chosen[field] = 0;
        if (state.places[field].length === 0) {
          setStatus(`Kein Ort für „${queries[field]}“ gefunden. Bitte Schreibweise prüfen oder einen größeren Ort in der Nähe angeben.`);
          el("ortsauswahl").hidden = true;
          return;
        }
      }
      renderPlaceChoices(fields);
    }

    const placeNames = {};
    const locations = [];
    for (const field of fields) {
      const feature = state.places[field][state.chosen[field] || 0];
      placeNames[field] = feature.properties.name;
      locations.push([feature.geometry.coordinates[1], feature.geometry.coordinates[0]]);
    }

    setStatus("Berechne Route (Wanderwege werden bevorzugt) …");
    let points, elevations = null, brouterProps = null, maneuvers = null, maneuversKm = null;
    try {
      const brouterRoute = await fetchBrouterRoute(locations, activity);
      points = brouterRoute.points;
      elevations = brouterRoute.elevations;
      brouterProps = brouterRoute.properties;
      setStatus("Erzeuge Wegbeschreibung …");
      try {
        const instructions = await fetchInstructionsForTrack(points, activity);
        maneuvers = instructions.maneuvers;
        maneuversKm = instructions.lengthKm;
      } catch (e2) {
        // Route trotzdem anzeigen – renderRoute erklärt die fehlenden Hinweise
      }
    } catch (e) {
      // Fallback: direkte Valhalla-Route, wenn BRouter nicht erreichbar ist
      setStatus("Wanderweg-Routing nicht erreichbar, nutze Standard-Routing …");
      const data = await fetchValhallaRoute(locations, activity);
      points = data.trip.legs.flatMap((l) => decodePolyline6(l.shape));
      maneuvers = data.trip.legs.flatMap((l) => l.maneuvers);
      try {
        const samples = await fetchElevations(points);
        elevations = points.map((p, i) => {
          let best = samples[0];
          for (const s of samples) if (Math.abs(s.index - i) < Math.abs(best.index - i)) best = s;
          return best.elevation;
        });
      } catch (e2) { /* Route auch ohne Höhendaten anzeigen */ }
    }

    const { cumDist } = renderRoute({ activity, points, elevations, brouterProps, maneuvers, maneuversKm, placeNames });
    setStatus(
      `Route gefunden: ${fmtKm(cumDist[cumDist.length - 1] / 1000)} von ${placeNames.start} nach ${placeNames.ziel}. ` +
      `Die Ergebnisse stehen unter der Überschrift „Ihre Route“.`
    );

    // Sehenswürdigkeiten nachladen (nicht blockierend für das Hauptergebnis)
    el("highlights-status").textContent = "Suche Sehenswürdigkeiten …";
    el("highlights-liste").innerHTML = "";
    try {
      const pois = await fetchPois(points);
      renderPois(locatePois(pois, points, cumDist));
    } catch (e) {
      el("highlights-status").textContent = "Sehenswürdigkeiten konnten nicht geladen werden.";
    }
  } catch (err) {
    setStatus(`Fehler: ${err.message}`);
  } finally {
    button.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Tabs (WAI-ARIA-Muster: Pfeiltasten wechseln, Fokus folgt der Auswahl)
// ---------------------------------------------------------------------------

function setupTabs() {
  const tablist = el("bereiche-tabs");
  const tabs = Array.from(tablist.querySelectorAll("[role=tab]"));

  function selectTab(tab, focus) {
    for (const t of tabs) {
      const selected = t === tab;
      t.setAttribute("aria-selected", String(selected));
      t.tabIndex = selected ? 0 : -1;
      el(t.getAttribute("aria-controls")).hidden = !selected;
    }
    if (focus) tab.focus();
  }

  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => selectTab(tab, false));
    tab.addEventListener("keydown", (event) => {
      let target = null;
      if (event.key === "ArrowRight") target = tabs[(i + 1) % tabs.length];
      else if (event.key === "ArrowLeft") target = tabs[(i - 1 + tabs.length) % tabs.length];
      else if (event.key === "Home") target = tabs[0];
      else if (event.key === "End") target = tabs[tabs.length - 1];
      if (target) {
        event.preventDefault();
        selectTab(target, true);
      }
    });
  });
}

setupTabs();

// ---------------------------------------------------------------------------
// Ereignisse
// ---------------------------------------------------------------------------

el("routen-formular").addEventListener("submit", (event) => {
  event.preventDefault();
  planRoute({ regeocode: true });
});

el("neu-berechnen-knopf").addEventListener("click", () => {
  planRoute({ regeocode: false });
});

el("standort-knopf").addEventListener("click", () => {
  useCurrentLocationAsStart();
});

el("gpx-knopf").addEventListener("click", () => {
  if (state.route) triggerGpxDownload(state.route);
});

el("komoot-formular").addEventListener("submit", (event) => {
  event.preventDefault();
  readKomootTour();
});

el("komoot-gpx-knopf").addEventListener("click", () => {
  if (state.komootTour) triggerGpxDownload(state.komootTour);
});

el("wege-formular").addEventListener("submit", (event) => {
  event.preventDefault();
  searchMarkedTrails();
});

el("naehe-formular").addEventListener("submit", (event) => {
  event.preventDefault();
  searchNearbyTours();
});
