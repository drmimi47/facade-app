/**
 * tools/build-gazetteer.mjs
 *
 * Regenerates `src/core/gazetteerData.ts` — the bundled offline place database behind
 * the Location field's address resolution (see src/core/gazetteer.ts for the matcher).
 *
 * This is a BUILD-TIME tool, not part of the app: it is run by hand when refreshing
 * the dataset, and nothing in src/ imports it. Plain Node, no dependencies.
 *
 * ── USAGE ───────────────────────────────────────────────────────────────────────
 *   1. Download the two GeoNames exports (free, no account):
 *        https://download.geonames.org/export/dump/cities15000.zip
 *        https://download.geonames.org/export/dump/admin1CodesASCII.txt
 *   2. Unzip cities15000.zip so you have cities15000.txt.
 *   3. Put both .txt files in a folder and run:
 *        node tools/build-gazetteer.mjs <folder>
 *      (defaults to ./tmp when no folder is given)
 *
 * It writes src/core/gazetteerData.ts and prints the resulting size.
 *
 * ── LICENCE ─────────────────────────────────────────────────────────────────────
 * GeoNames data is CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).
 * Attribution is required and is surfaced in the app's Location panel.
 *
 * ── SIZE / COVERAGE TRADE-OFF ───────────────────────────────────────────────────
 * `cities15000` (every place over 15,000 people) is ~34k rows, ~1.1 MB, ~560 KB
 * gzipped. It is loaded through a dynamic import() so it never enters the main
 * bundle. To trade coverage for size, raise MIN_POPULATION below — at 50,000 the file
 * is roughly a third the size, at the cost of dropping smaller towns and suburbs.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Drop places below this population. 15000 keeps everything in the source file. */
const MIN_POPULATION = 15000;

/** Field separator inside a REGIONS row (a control char that cannot occur in a name). */
const UNIT = "\u001f";

const srcDir = resolve(process.argv[2] ?? "tmp");
const outFile = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "core", "gazetteerData.ts");

// --- admin1 codes: "US.NE" -> "Nebraska" -------------------------------------
const admin1 = new Map();
for (const line of readFileSync(join(srcDir, "admin1CodesASCII.txt"), "utf8").split("\n")) {
  if (!line.trim()) continue;
  const f = line.split("\t");
  admin1.set(f[0], f[1]);
}

// --- cities ------------------------------------------------------------------
// GeoNames column order is documented at
// https://download.geonames.org/export/dump/readme.txt
const NAME = 1, LAT = 4, LNG = 5, COUNTRY = 8, ADMIN1 = 10, POP = 14, DEM = 16, TZ = 17;

const rows = [];
for (const line of readFileSync(join(srcDir, "cities15000.txt"), "utf8").split("\n")) {
  if (!line.trim()) continue;
  const f = line.split("\t");
  const name = f[NAME].trim();
  const lat = Number(f[LAT]);
  const lng = Number(f[LNG]);
  const country = f[COUNTRY].trim();
  const a1 = f[ADMIN1].trim();
  const pop = Number(f[POP]) || 0;
  const dem = Number(f[DEM]);
  const tz = f[TZ].trim();
  if (!name || !country || !tz || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
  if (pop < MIN_POPULATION) continue;
  const region = admin1.get(country + "." + a1) || "";
  // `dem` is metres; -9999 marks unknown. Clamp junk to sea level, and store in
  // DECAMETRES: site altitude only tunes Hottel's atmospheric transmittance, where
  // 10 m is far below the model's own error, and the coarser value compresses better.
  const elev = Number.isFinite(dem) && dem > -500 ? Math.round(dem / 10) : 0;
  rows.push({ name, region, country, a1, lat, lng, tz, elev, pop });
}

// Population DESCENDING, so array order doubles as the "biggest city wins" tie-break
// when a name is ambiguous — no population field needs to ship.
rows.sort((a, b) => b.pop - a.pop);

// --- dedupe the repeated strings into side tables -----------------------------
const tzTable = [], tzIdx = new Map();
const regTable = [], regIdx = new Map();
const idx = (table, map, key) => {
  let i = map.get(key);
  if (i === undefined) {
    i = table.length;
    table.push(key);
    map.set(key, i);
  }
  return i;
};

// 2 decimal places ~ 1.1 km. Noon solar altitude tracks latitude 1:1, so this caps the
// induced sun error at ~0.01 degrees — orders of magnitude below the clear-sky model's
// own error. Coordinates are high-entropy digits, so the shorter form is also the
// single biggest lever on the shipped file size.
const r2 = (n) => String(Math.round(n * 100) / 100);

const lines = rows.map((r) => {
  // The admin1 CODE rides along in the region table (~2.8k rows, not 34k), so
  // corroborating "Springfield, IL" costs essentially nothing in file size.
  const ri = idx(regTable, regIdx, r.region + UNIT + r.country + UNIT + r.a1);
  const ti = idx(tzTable, tzIdx, r.tz);
  return [r.name, ri, r2(r.lat), r2(r.lng), ti, r.elev].join("\t");
});

/** Escape for embedding inside a TS template literal. */
const esc = (s) => s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");

const out = [
  "/**",
  " * core/gazetteerData.ts",
  " *",
  " * GENERATED — do not hand-edit. Run `node tools/build-gazetteer.mjs <folder>` to",
  " * refresh it; that file's header lists the two GeoNames downloads it needs.",
  " *",
  " * The bundled offline place database powering the Location field's address",
  " * resolution (see core/gazetteer.ts for the matcher).",
  " *",
  ' * SOURCE: GeoNames "cities15000" (every place over 15,000 population) plus',
  " * admin1CodesASCII for readable region names. Licensed CC BY 4.0 —",
  " * https://www.geonames.org/ — attribution is shown in the app's Location panel.",
  " *",
  " * WHY BUNDLED (per CLAUDE.md's working agreement): resolving an address to a",
  " * latitude is the one input the solar study cannot compute for itself. Shipping the",
  " * data keeps the app fully offline — no API key, no network, no rate limit, no",
  " * third-party outage mode, and identical behaviour in the Docker deploy. The cost is",
  " * a data file, not a runtime dependency. It is loaded through a dynamic import() so",
  " * it stays OUT of the main bundle and is fetched only when a user actually resolves",
  " * an address.",
  " *",
  " * RESOLUTION: city-level. Noon solar altitude moves ~1 degree per degree of latitude",
  " * (~111 km), so resolving a street address to its city centroid shifts the sun by a",
  " * small fraction of a degree — far below the error already carried by the clear-sky",
  " * model in core/radiation.ts, which ignores weather entirely.",
  " *",
  " * FORMAT: three newline-delimited tables. CITIES rows are tab-separated",
  " * `name, regionIndex, lat, lng, zoneIndex, elevationDecametres`, sorted by",
  ' * POPULATION DESCENDING so array order doubles as the "biggest city wins" tie-break',
  " * when a name is ambiguous (e.g. the many Springfields).",
  " */",
  "",
  "/** `<region>\\u001f<ISO country code>\\u001f<admin1 code>`. Indexed by CITIES field 1. */",
  "export const REGIONS = `" + esc(regTable.join("\n")) + "`;",
  "",
  "/** IANA time-zone names. Indexed by CITIES field 4. */",
  "export const ZONES = `" + esc(tzTable.join("\n")) + "`;",
  "",
  "/** " + rows.length + " places, population-descending. See the format note above. */",
  "export const CITIES = `" + esc(lines.join("\n")) + "`;",
  "",
].join("\n");

writeFileSync(outFile, out, "utf8");

console.log(`places  : ${rows.length} (population >= ${MIN_POPULATION})`);
console.log(`regions : ${regTable.length}`);
console.log(`zones   : ${tzTable.length}`);
console.log(`raw     : ${(Buffer.byteLength(out, "utf8") / 1024 / 1024).toFixed(2)} MB`);
console.log(`gzipped : ${(gzipSync(Buffer.from(out, "utf8")).length / 1024).toFixed(0)} KB`);
console.log(`written : ${outFile}`);
