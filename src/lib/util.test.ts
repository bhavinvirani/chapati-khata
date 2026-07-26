import { describe, expect, it } from "vitest";
import { normalizeName } from "./util";

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
