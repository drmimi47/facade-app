/**
 * core/gazetteer.ts
 *
 * OFFLINE ADDRESS RESOLUTION — turns the free text typed into the Location field
 * into a site latitude / longitude / elevation / time zone, with NO API key, NO
 * network request, and no third party involved. The place data is bundled (see
 * core/gazetteerData.ts, GeoNames CC BY 4.0); this module is the loader + matcher.
 *
 * This module is PURE DATA/LOGIC — no DOM, no React, no canvas.
 *
 * ── WHY OFFLINE, AND WHY CITY-LEVEL IS ENOUGH ────────────────────────────────
 * Noon solar altitude tracks latitude 1:1, and one degree of latitude is ~111 km.
 * A metro area spans well under half a degree, so resolving "123 Main St, Omaha"
 * to the Omaha centroid moves the sun by a fraction of a degree — far below the
 * error already carried by the CLEAR-SKY model in core/radiation.ts, which ignores
 * weather entirely. Street-level accuracy would buy nothing measurable here while
 * costing an API key, a network dependency, a rate limit, and an outage mode.
 *
 * ── HOW THE MATCH WORKS ──────────────────────────────────────────────────────
 * The user types a whole address ("123 Main St, Omaha, NE 68102"), not a bare city,
 * so this scans the query for the LONGEST place name that appears in it as a run of
 * whole words, then scores the candidates:
 *
 *   1. More words matched wins   — "New York" beats the "York" inside it.
 *   2. A corroborating region wins — "Springfield, IL" beats Springfield, Missouri
 *      because the admin-1 code "IL" (or "Illinois", or "US") also appears.
 *   3. Bigger city wins           — a bare "Springfield" resolves to the largest one.
 *      This falls out of the data being stored population-descending, so first hit
 *      wins with no population field shipped.
 *
 * A name may also match on a multi-word PREFIX, which is what lets the stored
 * "New York City" answer a query for "New York" (see {@link PARTIAL_NAME_PENALTY}).
 * GeoNames stores the common ENGLISH name, so "Munich" and "Vienna" resolve while
 * "München" and "Wien" do not — {@link parseCoordinates} is the escape hatch.
 *
 * Matching is diacritic- and case-insensitive on both sides, so "Münster",
 * "munster", and "MUNSTER" all resolve. Rule 3 is a heuristic, which is exactly why
 * {@link resolvePlace} returns ALTERNATIVES alongside the best hit and the UI shows
 * what it picked — the user can see and correct the guess rather than be silently
 * given the wrong Springfield.
 *
 * ── LOADING ──────────────────────────────────────────────────────────────────
 * The ~1 MB dataset is behind a dynamic import() so it stays OUT of the main bundle
 * and is fetched only when a user actually resolves an address. {@link loadGazetteer}
 * caches the parsed index and de-duplicates concurrent calls.
 */

/** A resolved place: everything the solar study needs about a site. */
export interface Place {
  /** Place name as GeoNames spells it (e.g. "Omaha"). */
  name: string;
  /** Admin-1 region name (e.g. "Nebraska"). Empty for countries without one. */
  region: string;
  /** ISO 3166-1 alpha-2 country code (e.g. "US"). */
  country: string;
  /** Latitude, degrees north. */
  lat: number;
  /** Longitude, degrees east. */
  lng: number;
  /** IANA time-zone name (e.g. "America/Chicago") — drives solar time to clock time. */
  timeZone: string;
  /** Site elevation, METRES above sea level. Feeds Hottel transmittance in radiation.ts. */
  elevationM: number;
}

/** The outcome of resolving a typed address. */
export interface PlaceMatch {
  /** Best-scoring place. */
  place: Place;
  /** Other plausible readings, best first — shown so an ambiguous name is correctable. */
  alternatives: Place[];
}

/** Format a place for display: "Omaha, Nebraska, US". */
export function formatPlace(p: Place): string {
  return [p.name, p.region, p.country].filter(Boolean).join(", ");
}

/**
 * The text the Location field should show once a resolution lands, so the box and the
 * site driving the study always read as the same thing.
 *
 * For a PLACE match this is the matched place ("Omaha, Nebraska, US"), which re-resolves
 * to itself — the name matches and the region and country corroborate it, so committing
 * the field again is a no-op rather than a drift.
 *
 * For COORDINATES it is the numbers, normalised. Substituting the nearby place's label
 * here would look tidier but would be lossy: the next commit would resolve that label to
 * the city CENTROID, silently discarding the exact point the user supplied.
 */
export function canonicalAddress(site: SiteResolution): string {
  return site.kind === "coordinates" ? `${site.lat}, ${site.lng}` : site.label;
}

// ---------------------------------------------------------------------------
// NORMALISATION
// ---------------------------------------------------------------------------

/**
 * Fold text for comparison: lowercase, strip diacritics, and reduce anything that
 * isn't a letter or digit to a single space. Applied to BOTH the query and the place
 * names, so "Münster" matches "munster" and "St.-Denis" matches "st denis".
 *
 * NFD splits an accented character into its base letter plus a combining mark, which
 * the U+0300–U+036F range then removes — the standard diacritic fold, no data needed.
 */
function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// THE INDEX
// ---------------------------------------------------------------------------

/** One gazetteer row, pre-folded for matching. Order = population descending. */
interface Entry {
  place: Place;
  /** Folded name split into words — the token run we look for in the query. */
  words: string[];
  /** Folded region name, for the corroboration bonus. Empty when there is none. */
  foldedRegion: string;
  /** Folded country code, likewise. */
  foldedCountry: string;
  /**
   * Folded admin-1 CODE ("ny", "il", "ca") — what people actually type in a US or
   * Canadian address. Numeric for countries that code regions by number, which simply
   * never matches a typed word, so it costs nothing to carry.
   */
  foldedAdmin: string;
}

interface Index {
  entries: Entry[];
  /** Folded FIRST word of a name -> entry indices, so we only test plausible rows. */
  byFirstWord: Map<string, number[]>;
}

let cached: Index | null = null;
let inFlight: Promise<Index> | null = null;

/** Parse the bundled tables into the match index. Runs once per session. */
function buildIndex(regionsRaw: string, zonesRaw: string, citiesRaw: string): Index {
  const regions = regionsRaw.split("\n").map((r) => {
    const [region, country, admin] = r.split("\u001f");
    return { region: region ?? "", country: country ?? "", admin: admin ?? "" };
  });
  const zones = zonesRaw.split("\n");

  const entries: Entry[] = [];
  const byFirstWord = new Map<string, number[]>();

  for (const line of citiesRaw.split("\n")) {
    if (!line) continue;
    const f = line.split("\t");
    const reg = regions[Number(f[1])] ?? { region: "", country: "", admin: "" };
    const words = fold(f[0]).split(" ").filter(Boolean);
    if (words.length === 0) continue;

    const place: Place = {
      name: f[0],
      region: reg.region,
      country: reg.country,
      lat: Number(f[2]),
      lng: Number(f[3]),
      timeZone: zones[Number(f[4])] ?? "UTC",
      // Stored in decametres to keep the file small — see gazetteerData.ts.
      elevationM: Number(f[5]) * 10,
    };

    const i = entries.length;
    entries.push({
      place,
      words,
      foldedRegion: fold(reg.region),
      foldedCountry: fold(reg.country),
      foldedAdmin: fold(reg.admin),
    });
    const key = words[0];
    const bucket = byFirstWord.get(key);
    if (bucket) bucket.push(i);
    else byFirstWord.set(key, [i]);
  }

  return { entries, byFirstWord };
}

/**
 * Load (and cache) the bundled place data. The first call pays the dynamic import;
 * later calls resolve immediately. Concurrent callers share one in-flight load.
 */
export async function loadGazetteer(): Promise<void> {
  if (cached) return;
  if (!inFlight) {
    inFlight = import("./gazetteerData").then((m) => {
      cached = buildIndex(m.REGIONS, m.ZONES, m.CITIES);
      inFlight = null;
      return cached;
    });
  }
  await inFlight;
}

/** True once the dataset is in memory (so the UI can skip a "resolving…" flash). */
export function isGazetteerLoaded(): boolean {
  return cached !== null;
}

// ---------------------------------------------------------------------------
// MATCHING
// ---------------------------------------------------------------------------

/** How many alternatives to hand back for disambiguation. */
const MAX_ALTERNATIVES = 4;

/**
 * Score bonus when the query also names the candidate's region or admin-1 code. This
 * is the STRONG corroboration: it singles out one place among same-named duplicates.
 */
const REGION_BONUS = 100;

/**
 * Score bonus when the query names the candidate's COUNTRY. Deliberately an order of
 * magnitude weaker than {@link REGION_BONUS}, because a country is shared by thousands
 * of places and so discriminates almost nothing. Scoring the two equally would let
 * "Springfield, Illinois, US" tie with Springfield, Missouri on the shared "US" alone —
 * and the population tie-break would then hand it to the wrong Springfield.
 */
const COUNTRY_BONUS = 10;

/**
 * Penalty for matching only a PREFIX of a multi-word name (the stored "New York City"
 * answering a query for "New York"). Set below the 1000-per-word weight so an extra
 * matched word always wins, but above zero so an EXACT name beats a prefix of the same
 * length — "York" as a whole name outranks a 1-word slice of something longer.
 */
const PARTIAL_NAME_PENALTY = 500;

/**
 * Resolve a typed address to a place, or null when nothing in the query matches.
 * Requires {@link loadGazetteer} to have completed; returns null if it has not, so
 * callers should await the load first.
 *
 * Scoring: (words matched × 1000) + (region corroborated ? 100 : 0), with ties broken
 * by the data's population-descending order. See the file header for the rationale.
 */
export function resolvePlace(query: string): PlaceMatch | null {
  const index = cached;
  if (!index) return null;

  const qWords = fold(query).split(" ").filter(Boolean);
  if (qWords.length === 0) return null;
  // Whole-word membership test for the region/country corroboration bonus.
  const qSet = new Set(qWords);

  interface Scored {
    entryIndex: number;
    score: number;
  }
  const scored: Scored[] = [];

  // Only entries whose name STARTS with a word the user actually typed can match, so
  // walk the query once and test just those buckets instead of all 34k rows.
  for (let start = 0; start < qWords.length; start++) {
    const bucket = index.byFirstWord.get(qWords[start]);
    if (!bucket) continue;

    for (const ei of bucket) {
      const entry = index.entries[ei];
      const w = entry.words;

      // Count how many of the name's words run consecutively from here.
      const limit = Math.min(w.length, qWords.length - start);
      let matched = 0;
      while (matched < limit && qWords[start + matched] === w[matched]) matched++;

      const full = matched === w.length;
      // A LONE leading word of a multi-word name is too weak to be a match — it would
      // let "New Delhi" answer a query for "New Cairo". Two or more words is a real
      // signal, and is what lets "New York" find the stored "New York City".
      if (!full && matched < 2) continue;

      // Graded, not pooled — see COUNTRY_BONUS for why these must differ in weight.
      const regionMatch =
        (entry.foldedAdmin !== "" && qSet.has(entry.foldedAdmin)) ||
        (entry.foldedRegion !== "" &&
          // Region names can be multi-word ("new york"); require every word present.
          entry.foldedRegion.split(" ").every((rw) => qSet.has(rw)));
      const countryMatch = entry.foldedCountry !== "" && qSet.has(entry.foldedCountry);

      scored.push({
        entryIndex: ei,
        score:
          matched * 1000 +
          (regionMatch ? REGION_BONUS : 0) +
          (countryMatch ? COUNTRY_BONUS : 0) -
          (full ? 0 : PARTIAL_NAME_PENALTY),
      });
    }
  }

  if (scored.length === 0) return null;

  // Higher score first; equal scores keep the data's population-descending order, so
  // a bare "Springfield" lands on the largest one.
  scored.sort((a, b) => b.score - a.score || a.entryIndex - b.entryIndex);

  // Collapse duplicate rows for the same place name+region (GeoNames carries a few).
  const seen = new Set<string>();
  const unique: Place[] = [];
  for (const s of scored) {
    const p = index.entries[s.entryIndex].place;
    const key = `${p.name}|${p.region}|${p.country}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(p);
    if (unique.length > MAX_ALTERNATIVES) break;
  }

  return { place: unique[0], alternatives: unique.slice(1) };
}

/**
 * Convenience: load the data if needed, then resolve. This is what the UI calls on
 * address commit (Enter / blur), so the very first lookup transparently pays the
 * one-time import and every later one is synchronous-fast.
 */
export async function geocode(query: string): Promise<PlaceMatch | null> {
  if (query.trim() === "") return null;
  await loadGazetteer();
  return resolvePlace(query);
}

// ---------------------------------------------------------------------------
// COORDINATE ENTRY (the offline escape hatch for sites no gazetteer will have)
// ---------------------------------------------------------------------------

/**
 * What the Location field resolved the typed text to. This is the single shape both
 * the left panel's Location section and the Solar Study's location field consume, so
 * the two surfaces cannot drift apart in how they interpret an address.
 */
export interface SiteResolution {
  /** Whether the text was read as a place name or as literal coordinates. */
  kind: "place" | "coordinates";
  lat: number;
  lng: number;
  /** IANA zone — the matched place's, or the nearest place's for typed coordinates. */
  timeZone: string;
  /** Site elevation in metres, same provenance as `timeZone`. */
  elevationM: number;
  /** Display label, e.g. "Omaha, Nebraska, US" or "near Omaha, Nebraska, US". */
  label: string;
  /** Other plausible place readings, so an ambiguous name stays correctable. */
  alternatives: Place[];
}

/**
 * Resolve typed Location text to a site — the one call the UI makes.
 *
 * Accepts EITHER a place/address ("123 Main St, Omaha, NE") or literal coordinates
 * ("41.26, -95.94"), because a single field is what the panel has room for and the
 * two are unambiguous to tell apart. Coordinates are used verbatim and take their
 * zone/elevation from the nearest known place; see {@link nearestPlace}.
 *
 * Returns null when the text is neither, which the UI reports rather than silently
 * falling back to the default site.
 */
export async function resolveSite(text: string): Promise<SiteResolution | null> {
  if (text.trim() === "") return null;
  await loadGazetteer();

  const coords = parseCoordinates(text);
  if (coords) {
    const near = nearestPlace(coords.lat, coords.lng);
    return {
      kind: "coordinates",
      lat: coords.lat,
      lng: coords.lng,
      timeZone: near ? near.timeZone : "UTC",
      elevationM: near ? near.elevationM : 0,
      label: near ? `near ${formatPlace(near)}` : "coordinates",
      alternatives: [],
    };
  }

  const match = resolvePlace(text);
  if (!match) return null;
  return {
    kind: "place",
    lat: match.place.lat,
    lng: match.place.lng,
    timeZone: match.place.timeZone,
    elevationM: match.place.elevationM,
    label: formatPlace(match.place),
    alternatives: match.alternatives,
  };
}

/**
 * The gazetteer entry closest to a coordinate, by great-circle distance, or null if
 * the data is not loaded. Typed coordinates are exact but carry no time zone or
 * elevation of their own, so the study borrows those from the nearest known place —
 * both vary slowly enough over the tens of kilometres involved for that to be sound,
 * and the UI names the place it borrowed from rather than implying an exact match.
 */
export function nearestPlace(lat: number, lng: number): Place | null {
  const index = cached;
  if (!index || index.entries.length === 0) return null;

  const toRad = Math.PI / 180;
  const latR = lat * toRad;
  const cosLat = Math.cos(latR);

  let best: Place | null = null;
  let bestD = Infinity;
  for (const e of index.entries) {
    const p = e.place;
    // Equirectangular approximation: exact ordering is not needed, only the nearest,
    // and this avoids 34k trig calls per lookup.
    const dLat = (p.lat - lat) * toRad;
    const dLng = (p.lng - lng) * toRad * cosLat;
    const d = dLat * dLat + dLng * dLng;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

/**
 * Parse a typed "lat, lng" pair, so a user with survey coordinates can bypass name
 * matching entirely — the rural / unlisted-site fallback. Accepts decimal degrees
 * with an optional N/S/E/W suffix: "41.26, -95.94", "41.26 N, 95.94 W".
 * Returns null when the text isn't a coordinate pair or is out of range.
 */
export function parseCoordinates(text: string): { lat: number; lng: number } | null {
  const m = text
    .trim()
    .match(/^(-?\d+(?:\.\d+)?)\s*([NnSs])?\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*([EeWw])?$/);
  if (!m) return null;

  let lat = Number(m[1]);
  let lng = Number(m[3]);
  if (m[2] && m[2].toLowerCase() === "s") lat = -lat;
  if (m[4] && m[4].toLowerCase() === "w") lng = -lng;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}
