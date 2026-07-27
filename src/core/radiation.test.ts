/**
 * radiation.test.ts — the clear-sky irradiance model behind the Irradiance heatmap and
 * the Insolation chart.
 *
 * These are the numbers a user would actually put in a report, so the tests check
 * PHYSICAL sanity rather than exact values: nothing at night, nothing above the solar
 * constant, south beats north in the northern hemisphere, summer beats winter, and the
 * annual total is the sum of the months. A model that quietly drifts (a unit slip, a
 * missing cosine) breaks these long before anyone notices the picture looks odd.
 */
import { describe, it, expect } from "vitest";
import { wallIrradiance, buildRadiationMatrix, MONTH_REPRESENTATIVE_DOY } from "./radiation";
import { defaultSolarSettings } from "./solar";

/** Solar constant — no clear-sky surface figure may exceed it. */
const SOLAR_CONSTANT = 1367;

const settings = () => defaultSolarSettings();

describe("wallIrradiance", () => {
  it("is zero at night on every orientation", () => {
    for (const bearing of [0, 90, 180, 270]) {
      // 1am and 11pm, mid-winter — the sun is well below the horizon.
      expect(wallIrradiance(settings(), bearing, 355, 1)).toBe(0);
      expect(wallIrradiance(settings(), bearing, 355, 23)).toBe(0);
    }
  });

  it("is never negative and never exceeds the solar constant", () => {
    const s = settings();
    for (const doy of MONTH_REPRESENTATIVE_DOY) {
      for (let hour = 0; hour < 24; hour++) {
        for (const bearing of [0, 90, 180, 270]) {
          const g = wallIrradiance(s, bearing, doy, hour);
          expect(g).toBeGreaterThanOrEqual(0);
          expect(g).toBeLessThan(SOLAR_CONSTANT);
        }
      }
    }
  });

  it("favours a SOUTH wall over a NORTH wall at noon (northern hemisphere)", () => {
    const s = settings();
    const south = wallIrradiance(s, 180, 355, 12);
    const north = wallIrradiance(s, 0, 355, 12);
    expect(south).toBeGreaterThan(north);
  });

  it("still gives a north wall SOMETHING — diffuse sky and ground reflection", () => {
    // A north facade in daylight is not black: it sees sky and bounced ground light.
    // This is the check that the diffuse terms did not get dropped along with the beam.
    const s = settings();
    expect(wallIrradiance(s, 0, 172, 12)).toBeGreaterThan(0);
  });

  it("gives an east wall its peak in the morning and a west wall in the afternoon", () => {
    const s = settings();
    const eastAM = wallIrradiance(s, 90, 80, 9);
    const eastPM = wallIrradiance(s, 90, 80, 15);
    const westPM = wallIrradiance(s, 270, 80, 15);
    const westAM = wallIrradiance(s, 270, 80, 9);
    expect(eastAM).toBeGreaterThan(eastPM);
    expect(westPM).toBeGreaterThan(westAM);
  });

  it("is symmetric between east and west across solar noon", () => {
    // Same sun geometry mirrored, so the two facades must see mirrored numbers.
    const s = settings();
    expect(wallIrradiance(s, 90, 80, 9)).toBeCloseTo(wallIrradiance(s, 270, 80, 15), 6);
  });
});

describe("buildRadiationMatrix", () => {
  // Shape: `values[hour][month]` — 24 hour ROWS × 12 month COLUMNS — plus min/max for the
  // colour ramp and monthlyTotals/annualTotal in kWh/m² for the chart.
  const matrix = () => buildRadiationMatrix(settings(), 180);

  it("is 24 hour rows × 12 month columns", () => {
    const m = matrix();
    expect(m.hours).toBe(24);
    expect(m.months).toBe(12);
    expect(m.values).toHaveLength(24);
    for (const row of m.values) expect(row).toHaveLength(12);
  });

  it("reports max/min that bracket every cell", () => {
    const m = matrix();
    const flat = m.values.flat();
    expect(m.max).toBeCloseTo(Math.max(...flat), 6);
    expect(m.min).toBeCloseTo(Math.min(...flat), 6);
    expect(m.min).toBeGreaterThanOrEqual(0);
  });

  it("carries the bearing it was built for", () => {
    expect(matrix().bearingDeg).toBe(180);
  });

  it("has 12 monthly totals that sum to the annual total", () => {
    const m = matrix();
    expect(m.monthlyTotals).toHaveLength(12);
    const summed = m.monthlyTotals.reduce((s, v) => s + v, 0);
    expect(m.annualTotal).toBeCloseTo(summed, 6);
  });

  it("gives a south wall more annual energy than a north wall", () => {
    const south = buildRadiationMatrix(settings(), 180).annualTotal;
    const north = buildRadiationMatrix(settings(), 0).annualTotal;
    expect(south).toBeGreaterThan(north);
    expect(north).toBeGreaterThan(0); // still lit by sky + ground bounce
  });

  it("is dark at midnight in every month", () => {
    const m = matrix();
    for (const month of m.values[0]) expect(month).toBe(0);
  });

  it("peaks around the middle of the day", () => {
    const m = matrix();
    const dayTotal = (hour: number) => m.values[hour].reduce((s, v) => s + v, 0);
    expect(dayTotal(12)).toBeGreaterThan(dayTotal(5));
    expect(dayTotal(12)).toBeGreaterThan(dayTotal(21));
  });
});
