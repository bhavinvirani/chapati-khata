import { describe, it, expect } from "vitest";
import { commitMessage } from "./git.mjs";

describe("commitMessage", () => {
  it("names the single setting that changed", () => {
    expect(commitMessage([{ label: "Default price per chapati", value: 0.75 }])).toBe(
      "chore: set default price per chapati to 0.75",
    );
  });

  it("summarises when several changed", () => {
    expect(
      commitMessage([
        { label: "Default price per chapati", value: 0.75 },
        { label: "Currency symbol", value: "₹" },
      ]),
    ).toBe("chore: update app config");
  });

  it("never inlines a secret value", () => {
    expect(commitMessage([{ label: "Entry code", value: "1234", secret: true }])).toBe(
      "chore: update entry code",
    );
  });
});
