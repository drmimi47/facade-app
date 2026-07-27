/**
 * units.test.ts — the display-unit layer every dimension label, statistic, and input
 * routes through.
 *
 * The app currently pins itself to imperial, but this module still carries the whole
 * metric path — so these tests are what keep that path honest while it is unused, and
 * what a restored unit switch would land on. Round trips matter most: a value typed into
 * a field goes fromDisplayLength → model → toDisplayLength on the way back out, and any
 * asymmetry there silently resizes the user's building.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  FEET_PER_METRE,
  getUnitSystem,
  setUnitSystem,
  isMetric,
  toDisplayLength,
  fromDisplayLength,
  toDisplayArea,
  lengthAbbr,
  areaAbbr,
  fmtLength,
  fmtArea,
  fmtLengthTick,
} from "./units";

beforeEach(() => {
  setUnitSystem("imperial"); // the app's own default; each test opts into metric
});

describe("unit system", () => {
  it("round-trips the setting", () => {
    expect(getUnitSystem()).toBe("imperial");
    expect(isMetric()).toBe(false);
    setUnitSystem("metric");
    expect(getUnitSystem()).toBe("metric");
    expect(isMetric()).toBe(true);
  });
});

describe("length conversion", () => {
  it("is the identity in imperial (the model IS feet)", () => {
    expect(toDisplayLength(12.5)).toBe(12.5);
    expect(fromDisplayLength(12.5)).toBe(12.5);
  });

  it("converts feet to metres in metric", () => {
    setUnitSystem("metric");
    expect(toDisplayLength(FEET_PER_METRE)).toBeCloseTo(1, 9);
    expect(toDisplayLength(0)).toBe(0);
  });

  it("round-trips in BOTH systems", () => {
    // A field's value survives display → model → display unchanged; otherwise typing a
    // dimension and reading it back would drift.
    for (const system of ["imperial", "metric"] as const) {
      setUnitSystem(system);
      for (const feet of [0, 1, 13.75, 1234.5]) {
        expect(toDisplayLength(fromDisplayLength(toDisplayLength(feet)))).toBeCloseTo(
          toDisplayLength(feet),
          9,
        );
      }
    }
  });

  it("is monotonic — bigger model values are bigger display values", () => {
    setUnitSystem("metric");
    expect(toDisplayLength(100)).toBeGreaterThan(toDisplayLength(10));
  });
});

describe("area conversion", () => {
  it("is the identity in imperial", () => {
    expect(toDisplayArea(400)).toBe(400);
  });

  it("scales by the SQUARE of the length factor in metric", () => {
    setUnitSystem("metric");
    // 1 m² = FEET_PER_METRE² ft², so that many square feet must read as 1.
    expect(toDisplayArea(FEET_PER_METRE ** 2)).toBeCloseTo(1, 9);
  });
});

describe("labels", () => {
  it("names the active unit", () => {
    expect(lengthAbbr()).toBe("ft");
    expect(areaAbbr()).toBe("ft²");
    setUnitSystem("metric");
    expect(lengthAbbr()).toBe("m");
    expect(areaAbbr()).toBe("m²");
  });
});

describe("formatting", () => {
  it("formats a length with the unit and the requested precision", () => {
    expect(fmtLength(12.3456, 2)).toBe("12.35 ft");
    expect(fmtLength(12.3456, 0)).toBe("12 ft");
  });

  it("formats an area with the unit", () => {
    expect(fmtArea(200, 1)).toBe("200.0 ft²");
  });

  it("uses the tick form for on-canvas dimensions", () => {
    // The canvas labels use the surveyor's tick rather than the spelled-out unit.
    expect(fmtLengthTick(12.5, 2)).toContain("′");
    expect(fmtLengthTick(12.5, 2)).not.toContain("ft");
  });

  it("switches every formatter with the system", () => {
    setUnitSystem("metric");
    expect(fmtLength(FEET_PER_METRE, 2)).toBe("1.00 m");
    expect(fmtArea(FEET_PER_METRE ** 2, 2)).toBe("1.00 m²");
  });
});
