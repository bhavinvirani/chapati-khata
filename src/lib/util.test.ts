import { describe, expect, it } from "vitest";
import { dateRangeLabel, normalizeName, weekLabel } from "./util";

describe("dateRangeLabel", () => {
  it("formats a same-month range", () => {
    expect(dateRangeLabel(new Date(2026, 6, 13), new Date(2026, 6, 19))).toBe("Jul 13 – 19");
  });

  it("formats a cross-month range", () => {
    expect(dateRangeLabel(new Date(2026, 5, 30), new Date(2026, 6, 6))).toBe("Jun 30 – Jul 6");
  });

  it("appends the year only when asked", () => {
    expect(dateRangeLabel(new Date(2026, 6, 13), new Date(2026, 6, 19), true)).toBe("Jul 13 – 19, 2026");
  });
});

describe("weekLabel", () => {
  it("still formats a week's own Monday-to-Sunday span", () => {
    expect(weekLabel("2026-07-13")).toBe("Jul 13 – 19");
  });
});

describe("normalizeName", () => {
  it("lowercases plain input", () => {
    expect(normalizeName("Bhavin")).toBe("bhavin");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeName("  bhavin  ")).toBe("bhavin");
  });

  it("strips a zero-width space, which trim() alone would leave behind", () => {
    expect(normalizeName("bhavin​")).toBe("bhavin");
  });

  it("strips a soft hyphen", () => {
    expect(normalizeName("bha­vin")).toBe("bhavin");
  });

  it("collapses whitespace-only input to an empty string", () => {
    expect(normalizeName("   ")).toBe("");
  });
});
