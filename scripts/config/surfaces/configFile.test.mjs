import { describe, it, expect } from "vitest";
import { readConstants, setConstant } from "./configFile.mjs";

const SOURCE = `// ─────────────────────────────────────────────────────────────
// The only things you change to run this for your group.
// ─────────────────────────────────────────────────────────────

export const DEFAULT_PRICE = 0.5; // price per chapati at the default rate
export const CURRENCY = "$";
export const SPLITWISE_CURRENCY = "CAD";
export const SPLITWISE_CATEGORY_NAME = "Groceries";
`;

describe("readConstants", () => {
  it("reads numbers and strings with their kinds", () => {
    const got = readConstants(SOURCE);
    expect(got.get("DEFAULT_PRICE")).toEqual({ kind: "number", value: 0.5 });
    expect(got.get("CURRENCY")).toEqual({ kind: "string", value: "$" });
    expect(got.get("SPLITWISE_CATEGORY_NAME")).toEqual({
      kind: "string",
      value: "Groceries",
    });
  });

  it("finds all four constants", () => {
    expect([...readConstants(SOURCE).keys()]).toEqual([
      "DEFAULT_PRICE",
      "CURRENCY",
      "SPLITWISE_CURRENCY",
      "SPLITWISE_CATEGORY_NAME",
    ]);
  });
});

describe("setConstant", () => {
  it("replaces a number and preserves the trailing comment", () => {
    const out = setConstant(SOURCE, "DEFAULT_PRICE", 0.75);
    expect(out).toContain(
      "export const DEFAULT_PRICE = 0.75; // price per chapati at the default rate",
    );
  });

  it("keeps a string literal quoted", () => {
    const out = setConstant(SOURCE, "CURRENCY", "₹");
    expect(out).toContain('export const CURRENCY = "₹";');
  });

  it("escapes a quote inside a string value", () => {
    const out = setConstant(SOURCE, "SPLITWISE_CATEGORY_NAME", 'Bread "n" butter');
    expect(out).toContain('export const SPLITWISE_CATEGORY_NAME = "Bread \\"n\\" butter";');
  });

  it("leaves every other line byte-identical", () => {
    const out = setConstant(SOURCE, "DEFAULT_PRICE", 0.75);
    const before = SOURCE.split("\n").filter((l) => !l.includes("DEFAULT_PRICE"));
    const after = out.split("\n").filter((l) => !l.includes("DEFAULT_PRICE"));
    expect(after).toEqual(before);
  });

  it("refuses a key that is not declared", () => {
    expect(() => setConstant(SOURCE, "NOT_THERE", 1)).toThrow(/not found/);
  });

  it("refuses a key declared more than once", () => {
    const dupe = SOURCE + 'export const CURRENCY = "€";\n';
    expect(() => setConstant(dupe, "CURRENCY", "$")).toThrow(/declared 2 times/);
  });
});
