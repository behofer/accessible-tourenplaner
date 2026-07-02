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
  const feature = data.features[0];
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

async function fetchValhallaRoute(locations, activity) {
  const config = ACTIVITY_CONFIG[activity];
  const body = {
    locations: locations.map((loc, i) => ({
      lat: loc[0],
      lon: loc[1],
      type: i === 0 || i === locations.length - 1 ? "break" : "through",
    })),
    costing: config.costing,
    costing_options: config.options ? { [config.costing]: config.options } : undefined,
    language: "de-DE",
    units: "kilometers",
  };
  const res = await fetch(VALHALLA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).error || ""; } catch (e) { /* ignorieren */ }
    throw new Error(`Routenberechnung fehlgeschlagen. ${detail}`);
  }
  return res.json();
}

// Abbiegehinweise für eine vorhandene Route: die BRouter-Geometrie wird als
// Zwischenpunkte an Valhalla übergeben, das denselben Weg dann verbalisiert
async function fetchInstructionsForTrack(points, activity) {
  const via = samplePoints(points, 17).slice(1, -1).map((s) => s.point);
  const locations = [points[0], ...via, points[points.length - 1]];
  const data = await fetchValhallaRoute(locations, activity);
  return data.trip.legs.flatMap((l) => l.maneuvers);
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
  const res = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "data=" + encodeURIComponent(query),
  });
  if (!res.ok) throw new Error("Overpass nicht erreichbar");
  const data = await res.json();
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
function buildGpx(route) {
  const name = escapeXml(route.name);
  const trkpts = route.points
    .map((p, i) => {
      const ele = route.elevations ? route.elevations[i] : null;
      const eleTag = ele !== null && ele !== undefined ? `<ele>${Number(ele).toFixed(1)}</ele>` : "";
      return `      <trkpt lat="${p[0].toFixed(6)}" lon="${p[1].toFixed(6)}">${eleTag}</trkpt>`;
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
    <trkseg>
${trkpts}
    </trkseg>
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

function renderRoute({ activity, points, elevations, brouterProps, maneuvers, placeNames }) {
  const config = ACTIVITY_CONFIG[activity];
  const cumDist = cumulativeDistances(points);
  const distanceKm = cumDist[cumDist.length - 1] / 1000;

  const routeName = `${placeNames.start} nach ${placeNames.ziel} (${config.label})`;
  state.route = { name: routeName, points, elevations };

  // Höhenstatistik aus den BRouter-Höhen
  let elevation = null;
  if (elevations && elevations.every((e) => e !== undefined && e !== null)) {
    const samples = samplePoints(points, 200).map((s) => ({ ...s, elevation: elevations[s.index] }));
    elevation = { samples, stats: elevationStats(samples) };
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
  } else {
    const li = document.createElement("li");
    li.textContent = "Die Abbiegehinweise konnten für diese Route nicht erzeugt werden. Die GPX-Datei enthält den vollständigen Streckenverlauf.";
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
    let points, elevations = null, brouterProps = null, maneuvers = null;
    try {
      const brouterRoute = await fetchBrouterRoute(locations, activity);
      points = brouterRoute.points;
      elevations = brouterRoute.elevations;
      brouterProps = brouterRoute.properties;
      setStatus("Erzeuge Wegbeschreibung …");
      maneuvers = await fetchInstructionsForTrack(points, activity).catch(() => null);
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

    const { cumDist } = renderRoute({ activity, points, elevations, brouterProps, maneuvers, placeNames });
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
