import { describe, it, expect } from "vitest";
import { parseEnv, setEnvLine, toState } from "./dotenv.mjs";

const ENV = `# Copy this file to ".env" and fill in your project's values.

VITE_SUPABASE_URL=https://abc123.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGci.eyJpc3Mi.c2ln

# Local dev only: 4-digit access code for the gate.
# VITE_ENTRY_CODE=1234
`;

describe("parseEnv", () => {
  it("reads real keys", () => {
    expect(parseEnv(ENV).get("VITE_SUPABASE_URL")).toBe("https://abc123.supabase.co");
  });

  it("does not treat a commented-out key as set", () => {
    expect(parseEnv(ENV).has("VITE_ENTRY_CODE")).toBe(false);
  });

  it("ignores blank lines and prose comments", () => {
    expect([...parseEnv(ENV).keys()]).toEqual(["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"]);
  });
});

describe("setEnvLine", () => {
  it("replaces an existing key in place", () => {
    const out = setEnvLine(ENV, "VITE_SUPABASE_URL", "https://xyz789.supabase.co");
    expect(out).toContain("VITE_SUPABASE_URL=https://xyz789.supabase.co");
    expect(out.split("\n").length).toBe(ENV.split("\n").length);
  });

  it("appends a key that is absent, leaving the commented example alone", () => {
    const out = setEnvLine(ENV, "VITE_ENTRY_CODE", "9999");
    expect(out).toContain("# VITE_ENTRY_CODE=1234");
    expect(out).toContain("\nVITE_ENTRY_CODE=9999\n");
  });

  it("leaves comments and unrelated keys byte-identical", () => {
    const out = setEnvLine(ENV, "VITE_SUPABASE_URL", "https://xyz789.supabase.co");
    const untouched = (text) => text.split("\n").filter((l) => !l.startsWith("VITE_SUPABASE_URL="));
    expect(untouched(out)).toEqual(untouched(ENV));
  });

  it("adds a trailing newline when the file lacks one", () => {
    expect(setEnvLine("A=1", "B", "2")).toBe("A=1\nB=2\n");
  });
});

describe("parseEnv with edge cases", () => {
  it("maps a bare KEY= line to an empty string", () => {
    const envWithEmpty = "KEY_WITH_VALUE=abc\nKEY_EMPTY=\nKEY_WITH_VALUE2=def";
    const parsed = parseEnv(envWithEmpty);
    expect(parsed.get("KEY_EMPTY")).toBe("");
  });

  it("returns an empty map for empty text (absent .env)", () => {
    expect(parseEnv("")).toEqual(new Map());
  });
});

describe("toState", () => {
  it("returns { known: true, present: false } for undefined", () => {
    expect(toState(undefined)).toEqual({ known: true, present: false });
  });

  it("returns { known: true, present: false } for empty string", () => {
    expect(toState("")).toEqual({ known: true, present: false });
  });

  it("returns { known: true, present: true, value } for a real value", () => {
    expect(toState("https://example.com")).toEqual({
      known: true,
      present: true,
      value: "https://example.com",
    });
  });
});
