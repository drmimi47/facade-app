/**
 * solar.test.ts — sun geometry, checked against facts that are true independent of this
 * code: the equinox/solstice declinations, the sun rising in the east and setting in the
 * west, noon in the southern sky from the northern hemisphere, and a wall only seeing the
 * sun when the sun is in front of it.
 *
 * This is the module where a wrong sign or a swapped sin/cos produces output that still
 * LOOKS plausible — a dome, a heatmap, numbers — while being wrong. Hence real astronomy
 * as the oracle rather than snapshots of whatever the code currently returns.
 */
import { describe, it, expect } from "vitest";
import {
  declination,
  sunPosition,
  sunDirectionModel,
  wallIncidenceCos,
  bearingToModelDir,
  dayOfYearToDate,
  equationOfTime,
  OMAHA,
} from "./solar";

const DEG = Math.PI / 180;
const toDeg = (rad: number) => rad / DEG;

// Days of year for the astronomical markers (non-leap year).
const MAR_EQUINOX = 80;   // ~Mar 21
const JUN_SOLSTICE = 172; // ~Jun 21
const SEP_EQUINOX = 264;  // ~Sep 21
const DEC_SOLSTICE = 355; // ~Dec 21

describe("declination", () => {
  it("is ~0° at both equinoxes", () => {
    expect(Math.abs(toDeg(declination(MAR_EQUINOX)))).toBeLessThan(1.5);
    expect(Math.abs(toDeg(declination(SEP_EQUINOX)))).toBeLessThan(1.5);
  });

  it("peaks near +23.45° at the June solstice and −23.45° in December", () => {
    expect(toDeg(declination(JUN_SOLSTICE))).toBeCloseTo(23.45, 0);
    expect(toDeg(declination(DEC_SOLSTICE))).toBeCloseTo(-23.45, 0);
  });

  it("never leaves the axial-tilt envelope", () => {
    for (let d = 1; d <= 365; d++) {
      expect(Math.abs(toDeg(declination(d)))).toBeLessThanOrEqual(23.46);
    }
  });
});

describe("sunPosition", () => {
  it("puts the equinox sun on the horizon at 6am and 6pm", () => {
    // At declination 0 the sun rises due east at 06:00 solar and sets due west at 18:00,
    // at EVERY latitude — the cleanest check there is that the hour angle is right.
    const dawn = sunPosition(OMAHA.latitude, MAR_EQUINOX, 6);
    const dusk = sunPosition(OMAHA.latitude, MAR_EQUINOX, 18);
    expect(Math.abs(toDeg(dawn.altitude))).toBeLessThan(1.5);
    expect(Math.abs(toDeg(dusk.altitude))).toBeLessThan(1.5);
    expect(toDeg(dawn.azimuth)).toBeCloseTo(90, 0);  // due east
    expect(toDeg(dusk.azimuth)).toBeCloseTo(270, 0); // due west
  });

  it("places solar noon due SOUTH from the northern hemisphere", () => {
    const noon = sunPosition(OMAHA.latitude, JUN_SOLSTICE, 12);
    expect(toDeg(noon.azimuth)).toBeCloseTo(180, 5);
  });

  it("gives noon altitude = 90 − |lat − declination|", () => {
    // The textbook identity for solar noon altitude.
    for (const doy of [MAR_EQUINOX, JUN_SOLSTICE, DEC_SOLSTICE]) {
      const expected = 90 - Math.abs(OMAHA.latitude - toDeg(declination(doy)));
      expect(toDeg(sunPosition(OMAHA.latitude, doy, 12).altitude)).toBeCloseTo(expected, 6);
    }
  });

  it("is higher in summer than in winter, at the same hour", () => {
    const summer = sunPosition(OMAHA.latitude, JUN_SOLSTICE, 12).altitude;
    const winter = sunPosition(OMAHA.latitude, DEC_SOLSTICE, 12).altitude;
    expect(summer).toBeGreaterThan(winter);
  });

  it("puts the sun below the horizon at solar midnight", () => {
    expect(sunPosition(OMAHA.latitude, JUN_SOLSTICE, 0).altitude).toBeLessThan(0);
  });

  it("keeps the sun up all day inside the arctic circle at the June solstice", () => {
    for (const hour of [0, 6, 12, 18]) {
      expect(sunPosition(80, JUN_SOLSTICE, hour).altitude).toBeGreaterThan(0);
    }
  });

  it("is symmetric about solar noon", () => {
    const before = sunPosition(OMAHA.latitude, JUN_SOLSTICE, 10);
    const after = sunPosition(OMAHA.latitude, JUN_SOLSTICE, 14);
    expect(toDeg(before.altitude)).toBeCloseTo(toDeg(after.altitude), 6);
    // Azimuths mirror across due south (180°).
    expect(toDeg(before.azimuth) + toDeg(after.azimuth)).toBeCloseTo(360, 5);
  });
});

describe("sunDirectionModel", () => {
  it("returns a unit vector", () => {
    const v = sunDirectionModel(sunPosition(OMAHA.latitude, JUN_SOLSTICE, 15), 0);
    expect(Math.hypot(v.x, v.y, v.z)).toBeCloseTo(1, 12);
  });

  it("points UP while the sun is up and DOWN once it has set", () => {
    expect(sunDirectionModel(sunPosition(OMAHA.latitude, JUN_SOLSTICE, 12), 0).z).toBeGreaterThan(0);
    expect(sunDirectionModel(sunPosition(OMAHA.latitude, DEC_SOLSTICE, 23), 0).z).toBeLessThan(0);
  });

  it("rotates with the sketch's north offset", () => {
    const pos = sunPosition(OMAHA.latitude, JUN_SOLSTICE, 12);
    const plain = sunDirectionModel(pos, 0);
    const turned = sunDirectionModel(pos, 90);
    // Turning north by 90° must not change the sun's HEIGHT, only its bearing.
    expect(turned.z).toBeCloseTo(plain.z, 12);
    expect(turned.x).not.toBeCloseTo(plain.x, 6);
  });
});

describe("wallIncidenceCos", () => {
  const noon = sunPosition(OMAHA.latitude, JUN_SOLSTICE, 12); // sun due south, high

  // CONTRACT: this returns the RAW cosine in [-1, 1] and does NOT clamp. A negative
  // value means the sun is behind the wall. core/radiation.ts is what discards the beam
  // (`cosInc > 0 ? dni * cosInc : 0`), so the sign here is load-bearing — clamping it
  // inside this function would silently light up every north facade.
  it("is positive for a wall FACING the sun and NEGATIVE behind it", () => {
    expect(wallIncidenceCos(noon, 180)).toBeGreaterThan(0); // south-facing, sun on it
    expect(wallIncidenceCos(noon, 0)).toBeLessThan(0);      // north-facing, self-shaded
  });

  it("stays within [-1, 1] for every orientation", () => {
    for (let bearing = 0; bearing < 360; bearing += 15) {
      const c = wallIncidenceCos(noon, bearing);
      expect(c).toBeGreaterThanOrEqual(-1);
      expect(c).toBeLessThanOrEqual(1);
    }
  });

  it("does NOT account for night on its own — the caller must gate on altitude", () => {
    // cos(altitude) is positive even below the horizon, so a wall facing the night sun's
    // bearing still reports a positive cosine. Pinning this keeps someone from "fixing"
    // radiation.ts by trusting this value unguarded.
    const night = sunPosition(OMAHA.latitude, DEC_SOLSTICE, 2);
    expect(night.altitude).toBeLessThan(0);
    expect(wallIncidenceCos(night, (night.azimuth * 180) / Math.PI)).toBeGreaterThan(0);
  });

  it("favours an EAST wall in the morning and a WEST wall in the afternoon", () => {
    const morning = sunPosition(OMAHA.latitude, MAR_EQUINOX, 9);
    const afternoon = sunPosition(OMAHA.latitude, MAR_EQUINOX, 15);
    expect(wallIncidenceCos(morning, 90)).toBeGreaterThan(wallIncidenceCos(morning, 270));
    expect(wallIncidenceCos(afternoon, 270)).toBeGreaterThan(wallIncidenceCos(afternoon, 90));
  });

  it("peaks at 1 when the sun is square-on the wall", () => {
    // Sun on the horizon (altitude 0) directly along the wall's bearing.
    const horizon = { altitude: 0, azimuth: Math.PI }; // due south, on the horizon
    expect(wallIncidenceCos(horizon, 180)).toBeCloseTo(1, 12);
  });
});

describe("bearingToModelDir", () => {
  it("maps north/east/south/west onto model axes (+X east, +Y north)", () => {
    const n = bearingToModelDir(0, 0);
    const e = bearingToModelDir(90, 0);
    expect(n.x).toBeCloseTo(0, 12);
    expect(n.y).toBeCloseTo(1, 12);
    expect(e.x).toBeCloseTo(1, 12);
    expect(e.y).toBeCloseTo(0, 12);
  });

  it("returns unit vectors for every bearing", () => {
    for (let b = 0; b < 360; b += 30) {
      const d = bearingToModelDir(b, 17);
      expect(Math.hypot(d.x, d.y)).toBeCloseTo(1, 12);
    }
  });
});

describe("dayOfYearToDate", () => {
  it("maps the boundaries of the year", () => {
    expect(dayOfYearToDate(1)).toEqual({ month: 1, day: 1 });
    expect(dayOfYearToDate(365)).toEqual({ month: 12, day: 31 });
  });

  it("maps the start of each month to day 1", () => {
    // Cumulative days before each month in a non-leap year.
    const firsts = [1, 32, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
    firsts.forEach((doy, i) => {
      expect(dayOfYearToDate(doy)).toEqual({ month: i + 1, day: 1 });
    });
  });
});

describe("equationOfTime", () => {
  it("stays inside its real-world envelope of about ±17 minutes", () => {
    for (let d = 1; d <= 365; d++) {
      expect(Math.abs(equationOfTime(d))).toBeLessThan(17.5);
    }
  });

  it("is near its early-November maximum and mid-February minimum", () => {
    expect(equationOfTime(307)).toBeGreaterThan(10);  // ~Nov 3, sundial ahead
    expect(equationOfTime(43)).toBeLessThan(-10);     // ~Feb 12, sundial behind
  });
});
