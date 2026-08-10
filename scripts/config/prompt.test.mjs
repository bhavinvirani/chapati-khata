import { describe, it, expect } from "vitest";
import { ansi, bold, dim, red, green, yellow } from "./prompt.mjs";

const ESC = String.fromCharCode(27);

describe("ansi", () => {
  it("wraps text in a real escape sequence when enabled", () => {
    expect(ansi("1", "hello", true)).toBe(`${ESC}[1mhello${ESC}[0m`);
  });

  it("emits the ESC byte itself, not the printable text that follows it", () => {
    // The bug this pins down: a template written without the escape byte
    // produces the literal characters "[1m", which a terminal prints as
    // visible garbage instead of styling. Piped output never shows it,
    // because useColor is false whenever stdout is not a TTY — so every
    // test and CI run looked clean while a real terminal did not.
    const out = ansi("1", "hello", true);
    expect(out.charCodeAt(0)).toBe(27);
    expect(out.startsWith("[1m")).toBe(false);
  });

  it("returns the bare string when disabled", () => {
    expect(ansi("1", "hello", false)).toBe("hello");
    expect(ansi("31", "hello", false)).not.toContain("[");
  });

  it("stringifies a non-string value", () => {
    expect(ansi("1", 0.5, false)).toBe("0.5");
  });
});

describe("style helpers", () => {
  // These read process.stdout.isTTY at module load. Under vitest stdout is
  // not a TTY, so they must pass text through untouched — asserting that is
  // what proves nothing leaks escape characters into piped or redirected
  // output, which is where this script's output usually goes.
  it.each([
    ["bold", bold],
    ["dim", dim],
    ["red", red],
    ["green", green],
    ["yellow", yellow],
  ])("%s passes text through unchanged when stdout is not a TTY", (_name, fn) => {
    expect(fn("plain")).toBe("plain");
  });
});
