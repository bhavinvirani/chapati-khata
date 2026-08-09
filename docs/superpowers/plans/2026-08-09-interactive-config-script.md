# Interactive Config Script Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `scripts/config.mjs` — one interactive front door that reads and writes every Chapati Khata configuration value across `src/config.ts`, `.env`, Supabase edge-function secrets, and GitHub repo/environment secrets.

**Architecture:** A registry of **logical settings**, each fanning out to one or more `(surface, key)` **targets**. Five surface modules share a `probe`/`list`/`read`/`write` interface and are the only code that knows the difference between a file and a CLI. Three flows — status screen, quick-tweak menu, setup wizard — are three walks over the same registry. All risky text manipulation lives in pure string functions with `fs` at the edges, which is what makes it testable.

**Tech Stack:** Plain ES modules (`.mjs`) on Node 20, `node:readline/promises` for input, `node:child_process` for the `supabase` and `gh` CLIs, Vitest for tests. No new dependencies.

**Source spec:** `docs/superpowers/specs/2026-08-09-interactive-config-script-design.md`

**Branch:** `interactive-config-script` (already checked out, spec committed as `8f78723`)

## Global Constraints

- **No new dependencies.** Not in `dependencies`, not in `devDependencies`. Plain `.mjs`, no TypeScript runner, no prompt library, no build step.
- **Node 20.** `package.json` declares `"node": ">=20.19.0"`. Every API used must exist in Node 20 — `fetch`, `AbortController`, `node:readline/promises`, and `structuredClone` all do.
- **Secrets never reach argv.** Never `supabase secrets set K=V`, never `gh secret set NAME --body V`. Supabase writes go through a `0600` temp file passed to `--env-file`; GitHub writes go through the child process's stdin.
- **Secrets are never echoed, printed, or put in a commit message.** Any setting with `secret: true` is prompted with echo suppressed and rendered only as "set · 12d ago".
- **Never `git add -A`.** Stage by explicit path only.
- **Never delete a secret.** Strays are reported, never removed.
- **Platform-managed Supabase secrets are invisible.** `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_DB_URL`, `SUPABASE_JWKS`, `SUPABASE_PUBLISHABLE_KEYS`, `SUPABASE_SECRET_KEYS`, `SUPABASE_SERVICE_ROLE_KEY` are never offered for editing and never counted as strays.
- **A surface that is unavailable degrades, never crashes.** `probe()` failure hides that surface's settings with a reason; the rest of the script keeps working.
- **Prettier formats everything.** Run `npx prettier --write` on touched files before every commit; `npm run format:check` must pass at the end.
- **Validation always precedes any write.** No partial application of an invalid value.

## File Structure

| File                                     | Responsibility                                          |
| ---------------------------------------- | ------------------------------------------------------- |
| `scripts/config.mjs`                     | Entry point: arg parsing, mode routing, the three flows |
| `scripts/config/registry.mjs`            | The settings table — single source of truth             |
| `scripts/config/validate.mjs`            | Pure validators                                         |
| `scripts/config/atomic.mjs`              | `atomicWrite` — temp file + rename                      |
| `scripts/config/prompt.mjs`              | `ask` / `askSecret` / `confirm` / `choose` / `openUrl`  |
| `scripts/config/git.mjs`                 | Branch, diff, stage-by-path, commit, push               |
| `scripts/config/render.mjs`              | Pure formatting of setting state into screen lines      |
| `scripts/config/surfaces/configFile.mjs` | `src/config.ts` constants                               |
| `scripts/config/surfaces/dotenv.mjs`     | `.env`                                                  |
| `scripts/config/surfaces/supabase.mjs`   | `supabase secrets list \| set`                          |
| `scripts/config/surfaces/github.mjs`     | `gh secret list \| set`, repo and environment scope     |
| `scripts/config/surfaces/index.mjs`      | `SURFACES` map from surface id to module                |

**Two deliberate deviations from spec §4**, both additive:

1. `atomic.mjs` and `render.mjs` were not in the spec's file list. `atomicWrite` is needed identically by two surfaces (DRY), and pulling screen formatting out of the flows is what makes the status screen testable at all.
2. The spec writes GitHub targets as `github/repo:` and `github/env:production:`. The implementation registers **two surface ids** — `github-repo` and `github-env` — built from one module. Same semantics, but it keeps `read(key)` uniform across all five surfaces instead of giving one of them an extra scope parameter.

---

### Task 1: Repo wiring and validators

The validators are pure functions with no dependencies, so they come first — and they're the reason the test runner needs widening before anything else can be tested.

**Files:**

- Modify: `vitest.config.ts:11`
- Modify: `eslint.config.js:24-41`
- Modify: `package.json:10-19`
- Create: `scripts/config/validate.mjs`
- Test: `scripts/config/validate.test.mjs`

**Interfaces:**

- Consumes: nothing.
- Produces: nine validators, each `(raw: unknown) => Result`, where `Result` is `{ ok: true, value: string | number, warn?: string }` or `{ ok: false, reason: string }`. Named exports: `positiveNumber`, `currencySymbol`, `currencyCode`, `nonEmpty`, `token`, `fourDigits`, `groupId`, `supabaseUrl`, `anonKey`. Every consumer treats `ok: false` as re-prompt with `reason`, and `warn` as print-and-continue.

- [ ] **Step 1: Widen the Vitest include**

`vitest.config.ts` currently only matches `src/**`, so nothing under `scripts/` would ever run.

```ts
    include: ["src/**/*.{test,spec}.{ts,tsx}", "scripts/**/*.{test,spec}.mjs"],
```

- [ ] **Step 2: Give `.mjs` files Node globals in ESLint**

The block supplying `globals.node` is scoped to `files: ["**/*.{ts,tsx}"]`, so `.mjs` would fail `no-undef` on `process` and `console`. Add this as a new block after the existing one (before `prettier`):

```js
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
  },
```

- [ ] **Step 3: Add the npm scripts**

In `package.json`, alongside the existing scripts:

```json
    "config": "node scripts/config.mjs",
    "setup": "node scripts/config.mjs --setup",
```

- [ ] **Step 4: Write the failing tests**

Create `scripts/config/validate.test.mjs`:

```js
import { describe, it, expect } from "vitest";
import {
  positiveNumber,
  currencySymbol,
  currencyCode,
  nonEmpty,
  token,
  fourDigits,
  groupId,
  supabaseUrl,
  anonKey,
} from "./validate.mjs";

describe("positiveNumber", () => {
  it("accepts a decimal price", () => {
    expect(positiveNumber("0.75")).toEqual({ ok: true, value: 0.75 });
  });
  it("trims whitespace", () => {
    expect(positiveNumber("  1.5  ")).toEqual({ ok: true, value: 1.5 });
  });
  it.each(["0", "-1", "abc", "", "Infinity", "NaN"])("rejects %j", (raw) => {
    expect(positiveNumber(raw).ok).toBe(false);
  });
});

describe("currencySymbol", () => {
  it("accepts a single symbol", () => {
    expect(currencySymbol("$")).toEqual({ ok: true, value: "$" });
  });
  it("accepts up to three characters", () => {
    expect(currencySymbol("CA$")).toEqual({ ok: true, value: "CA$" });
  });
  it.each(["", "abcd", "a b"])("rejects %j", (raw) => {
    expect(currencySymbol(raw).ok).toBe(false);
  });
});

describe("currencyCode", () => {
  it("uppercases a lowercase code", () => {
    expect(currencyCode("cad")).toEqual({ ok: true, value: "CAD" });
  });
  it.each(["CA", "CADD", "C4D", ""])("rejects %j", (raw) => {
    expect(currencyCode(raw).ok).toBe(false);
  });
});

describe("nonEmpty", () => {
  it("accepts text with inner spaces", () => {
    expect(nonEmpty(" Groceries ")).toEqual({ ok: true, value: "Groceries" });
  });
  it("rejects whitespace only", () => {
    expect(nonEmpty("   ").ok).toBe(false);
  });
});

describe("token", () => {
  it("accepts an opaque token", () => {
    expect(token("sbp_abc123")).toEqual({ ok: true, value: "sbp_abc123" });
  });
  it.each(["", "has space"])("rejects %j", (raw) => {
    expect(token(raw).ok).toBe(false);
  });
});

describe("fourDigits", () => {
  it("accepts exactly four digits", () => {
    expect(fourDigits("1234")).toEqual({ ok: true, value: "1234" });
  });
  it.each(["123", "12345", "12a4", ""])("rejects %j", (raw) => {
    expect(fourDigits(raw).ok).toBe(false);
  });
});

describe("groupId", () => {
  it("accepts digits", () => {
    expect(groupId("87654321")).toEqual({ ok: true, value: "87654321" });
  });
  it("rejects a pasted group URL", () => {
    const result = groupId("https://secure.splitwise.com/groups/87654321");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not the whole URL/);
  });
});

describe("supabaseUrl", () => {
  it("accepts a project URL", () => {
    expect(supabaseUrl("https://abc123.supabase.co")).toEqual({
      ok: true,
      value: "https://abc123.supabase.co",
    });
  });
  it("strips a trailing slash", () => {
    expect(supabaseUrl("https://abc123.supabase.co/").value).toBe("https://abc123.supabase.co");
  });
  it.each(["http://abc123.supabase.co", "https://supabase.co", "abc123"])("rejects %j", (raw) => {
    expect(supabaseUrl(raw).ok).toBe(false);
  });
});

describe("anonKey", () => {
  it("accepts a legacy JWT", () => {
    expect(anonKey("eyJhbGci.eyJpc3Mi.c2ln").warn).toBeUndefined();
  });
  it("accepts a publishable key", () => {
    expect(anonKey("sb_publishable_abc123").warn).toBeUndefined();
  });
  it("warns but accepts an unrecognised format", () => {
    const result = anonKey("something-else-entirely");
    expect(result.ok).toBe(true);
    expect(result.warn).toMatch(/live check/);
  });
  it("rejects empty", () => {
    expect(anonKey("").ok).toBe(false);
  });
});
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `npx vitest run scripts/config/validate.test.mjs`
Expected: FAIL — `Failed to load url ./validate.mjs`.

- [ ] **Step 6: Write the validators**

Create `scripts/config/validate.mjs`:

```js
// Every validator takes raw input and returns either
//   { ok: true, value, warn? }   — `warn` means print it and continue
//   { ok: false, reason }        — re-prompt with `reason`

const clean = (raw) => String(raw ?? "").trim();

export function positiveNumber(raw) {
  const n = Number(clean(raw));
  if (clean(raw) === "" || !Number.isFinite(n) || n <= 0) {
    return { ok: false, reason: "must be a number greater than 0" };
  }
  return { ok: true, value: n };
}

export function currencySymbol(raw) {
  const s = clean(raw);
  if (s.length < 1 || s.length > 3) return { ok: false, reason: "must be 1–3 characters" };
  if (/\s/.test(s)) return { ok: false, reason: "must not contain spaces" };
  return { ok: true, value: s };
}

export function currencyCode(raw) {
  const s = clean(raw).toUpperCase();
  if (!/^[A-Z]{3}$/.test(s)) return { ok: false, reason: "must be a 3-letter code like CAD" };
  return { ok: true, value: s };
}

export function nonEmpty(raw) {
  const s = clean(raw);
  if (!s) return { ok: false, reason: "must not be empty" };
  return { ok: true, value: s };
}

export function token(raw) {
  const s = clean(raw);
  if (!s) return { ok: false, reason: "must not be empty" };
  if (/\s/.test(s)) return { ok: false, reason: "must not contain spaces" };
  return { ok: true, value: s };
}

export function fourDigits(raw) {
  const s = clean(raw);
  if (!/^\d{4}$/.test(s)) return { ok: false, reason: "must be exactly 4 digits" };
  return { ok: true, value: s };
}

export function groupId(raw) {
  const s = clean(raw);
  if (!/^\d+$/.test(s)) {
    return {
      ok: false,
      reason: "must be digits only — just the number from the group's URL, not the whole URL",
    };
  }
  return { ok: true, value: s };
}

export function supabaseUrl(raw) {
  const s = clean(raw).replace(/\/+$/, "");
  if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(s)) {
    return { ok: false, reason: "must look like https://<project-ref>.supabase.co" };
  }
  return { ok: true, value: s };
}

export function anonKey(raw) {
  const s = clean(raw);
  if (!s) return { ok: false, reason: "must not be empty" };
  if (/\s/.test(s)) return { ok: false, reason: "must not contain spaces" };
  const known = /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(s) || /^sb_publishable_[\w-]+$/.test(s);
  if (known) return { ok: true, value: s };
  return {
    ok: true,
    value: s,
    warn: "that doesn't look like a JWT or an sb_publishable_ key — continuing anyway, the live check will confirm it",
  };
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run scripts/config/validate.test.mjs`
Expected: PASS, 30+ assertions.

- [ ] **Step 8: Verify the repo wiring holds**

Run: `npm run lint && npm test`
Expected: lint clean (proving the ESLint `.mjs` block works), and the new tests run alongside the existing `src/lib` suites.

- [ ] **Step 9: Commit**

```bash
npx prettier --write vitest.config.ts eslint.config.js package.json scripts/config/validate.mjs scripts/config/validate.test.mjs
git add vitest.config.ts eslint.config.js package.json scripts/config/validate.mjs scripts/config/validate.test.mjs
git commit -m "feat(config): add config validators and wire scripts/ into vitest and eslint"
```

---

### Task 2: The `src/config.ts` surface

The riskiest write in the whole script, because it edits real source that must still compile. Pure string layer first, `fs` at the edges, post-write verification with restore.

**Files:**

- Create: `scripts/config/atomic.mjs`
- Create: `scripts/config/surfaces/configFile.mjs`
- Test: `scripts/config/surfaces/configFile.test.mjs`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `atomicWrite(path: string, contents: string): Promise<void>` from `atomic.mjs`.
  - From `configFile.mjs` — pure: `readConstants(source: string): Map<string, {kind, value}>` where `kind` is `"string" | "number" | "other"`; `setConstant(source: string, key: string, value: string|number): string` which **throws** on zero or multiple declarations. Surface: `{ id: "config-file", label, effect: "needs-deploy", probe(), list(), read(key), write(key, value) }`.
  - `TargetState` shape used by every surface from here on: `{ known: true, present: true, value }` | `{ known: false, present: true, updatedAt?, digest? }` | `{ known: false, present: false }` | `{ known: true, present: false }`.

- [ ] **Step 1: Write the failing tests**

Create `scripts/config/surfaces/configFile.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run scripts/config/surfaces/configFile.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the atomic writer**

Create `scripts/config/atomic.mjs`:

```js
import { writeFile, rename } from "node:fs/promises";
import { dirname, basename, join } from "node:path";

/**
 * Write via a temp file in the same directory, then rename. A crash or a
 * Ctrl-C can leave the temp file behind, but never a half-written target.
 * Same-directory is required — rename is only atomic within one filesystem.
 */
export async function atomicWrite(path, contents) {
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}`);
  await writeFile(tmp, contents, "utf8");
  await rename(tmp, path);
}
```

- [ ] **Step 4: Write the config-file surface**

Create `scripts/config/surfaces/configFile.mjs`:

```js
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { atomicWrite } from "../atomic.mjs";

// fileURLToPath, not URL.pathname — pathname is percent-encoded, so a space
// anywhere in the repo's path would arrive here as %20 and fail to open.
const FILE = fileURLToPath(new URL("../../../src/config.ts", import.meta.url));

const DECLARATION = /^\s*export const ([A-Z_][A-Z0-9_]*)\s*=\s*([^;]+);/gm;

function parseLiteral(literal) {
  const t = literal.trim();
  const quoted = t.match(/^"(.*)"$/s) || t.match(/^'(.*)'$/s);
  if (quoted) return { kind: "string", value: quoted[1].replace(/\\"/g, '"') };
  const n = Number(t);
  if (t !== "" && Number.isFinite(n)) return { kind: "number", value: n };
  return { kind: "other", value: t };
}

export function readConstants(source) {
  const out = new Map();
  for (const [, key, literal] of source.matchAll(DECLARATION)) {
    out.set(key, parseLiteral(literal));
  }
  return out;
}

export function setConstant(source, key, value) {
  const re = new RegExp(`^(\\s*export const ${key}\\s*=\\s*)([^;]+)(;)`, "gm");
  const hits = source.match(re) ?? [];
  if (hits.length === 0) {
    throw new Error(`${key} not found in src/config.ts — edit that file by hand.`);
  }
  if (hits.length > 1) {
    throw new Error(
      `${key} declared ${hits.length} times in src/config.ts — edit that file by hand.`,
    );
  }
  const literal = typeof value === "number" ? String(value) : JSON.stringify(value);
  return source.replace(re, (_all, head, _old, semi) => `${head}${literal}${semi}`);
}

export const id = "config-file";
export const label = "src/config.ts";
export const effect = "needs-deploy";

export async function probe() {
  try {
    await readFile(FILE, "utf8");
    return { available: true };
  } catch {
    return { available: false, reason: "src/config.ts is missing" };
  }
}

export async function list() {
  return [...readConstants(await readFile(FILE, "utf8")).keys()];
}

export async function read(key) {
  const found = readConstants(await readFile(FILE, "utf8")).get(key);
  if (!found) return { known: true, present: false };
  return { known: true, present: true, value: found.value };
}

export async function write(key, value) {
  const original = await readFile(FILE, "utf8");
  const next = setConstant(original, key, value);
  await atomicWrite(FILE, next);

  // The regex above is deliberately simple. Confirm it did what we meant,
  // and put the file back exactly as it was if it didn't.
  const check = readConstants(await readFile(FILE, "utf8")).get(key);
  if (!check || check.value !== value) {
    await atomicWrite(FILE, original);
    throw new Error(
      `Writing ${key} produced an unexpected result — restored src/config.ts unchanged.`,
    );
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run scripts/config/surfaces/configFile.test.mjs`
Expected: PASS.

- [ ] **Step 6: Verify against the real file, non-destructively**

```bash
node -e '
import("./scripts/config/surfaces/configFile.mjs").then(async (m) => {
  console.log(await m.probe());
  console.log(await m.list());
  console.log(await m.read("DEFAULT_PRICE"));
});
'
```

Expected: `{ available: true }`, the four constant names, and `{ known: true, present: true, value: 0.5 }`. Then confirm nothing changed: `git diff --exit-code src/config.ts` exits 0.

- [ ] **Step 7: Commit**

```bash
npx prettier --write scripts/config/atomic.mjs scripts/config/surfaces/configFile.mjs scripts/config/surfaces/configFile.test.mjs
git add scripts/config/atomic.mjs scripts/config/surfaces/configFile.mjs scripts/config/surfaces/configFile.test.mjs
git commit -m "feat(config): add the src/config.ts surface with verified writes"
```

---

### Task 3: The `.env` surface

Line-wise editing that preserves comments, ordering, and unrelated keys byte-for-byte. The commented-out `# VITE_ENTRY_CODE=1234` line in `.env.example` must not be mistaken for a real key.

**Files:**

- Create: `scripts/config/surfaces/dotenv.mjs`
- Test: `scripts/config/surfaces/dotenv.test.mjs`

**Interfaces:**

- Consumes: `atomicWrite` from `scripts/config/atomic.mjs` (Task 2).
- Produces: pure `parseEnv(text: string): Map<string, string>` and `setEnvLine(text: string, key: string, value: string): string`; surface `{ id: "dotenv", label, effect: "needs-restart", probe(), list(), read(key), write(key, value) }`.

- [ ] **Step 1: Write the failing tests**

Create `scripts/config/surfaces/dotenv.test.mjs`:

```js
import { describe, it, expect } from "vitest";
import { parseEnv, setEnvLine } from "./dotenv.mjs";

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run scripts/config/surfaces/dotenv.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the dotenv surface**

Create `scripts/config/surfaces/dotenv.mjs`:

```js
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { atomicWrite } from "../atomic.mjs";

// fileURLToPath, not URL.pathname — pathname is percent-encoded, so a space
// anywhere in the repo's path would arrive here as %20 and fail to open.
const FILE = fileURLToPath(new URL("../../../.env", import.meta.url));

// Anchored at line start with no leading `#`, so a commented-out example
// line is never mistaken for a set value.
const ASSIGNMENT = /^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(.*)$/;

export function parseEnv(text) {
  const out = new Map();
  for (const line of text.split("\n")) {
    const m = line.match(ASSIGNMENT);
    if (m) out.set(m[1], m[2].trim());
  }
  return out;
}

export function setEnvLine(text, key, value) {
  const re = new RegExp(`^[ \\t]*${key}[ \\t]*=.*$`, "m");
  const line = `${key}=${value}`;
  if (re.test(text)) return text.replace(re, line);
  const gap = text === "" || text.endsWith("\n") ? "" : "\n";
  return `${text}${gap}${line}\n`;
}

async function contents() {
  try {
    return await readFile(FILE, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return "";
    throw err;
  }
}

export const id = "dotenv";
export const label = ".env";
export const effect = "needs-restart";

export async function probe() {
  return { available: true }; // an absent .env is created on first write
}

export async function list() {
  return [...parseEnv(await contents()).keys()];
}

export async function read(key) {
  const value = parseEnv(await contents()).get(key);
  if (value === undefined || value === "") return { known: true, present: false };
  return { known: true, present: true, value };
}

export async function write(key, value) {
  await atomicWrite(FILE, setEnvLine(await contents(), key, value));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run scripts/config/surfaces/dotenv.test.mjs`
Expected: PASS.

- [ ] **Step 5: Verify against the real `.env`, read-only**

```bash
node -e '
import("./scripts/config/surfaces/dotenv.mjs").then(async (m) => {
  console.log(await m.list());
  const r = await m.read("VITE_SUPABASE_URL");
  console.log({ present: r.present, startsWith: String(r.value).slice(0, 8) });
});
'
```

Expected: the three `VITE_*` names and `{ present: true, startsWith: 'https://' }`. Confirm no write happened: `git status --porcelain .env` prints nothing (`.env` is gitignored, so also check its mtime is unchanged if you want certainty).

- [ ] **Step 6: Commit**

```bash
npx prettier --write scripts/config/surfaces/dotenv.mjs scripts/config/surfaces/dotenv.test.mjs
git add scripts/config/surfaces/dotenv.mjs scripts/config/surfaces/dotenv.test.mjs
git commit -m "feat(config): add the .env surface with comment-preserving writes"
```

---

### Task 4: The Supabase secrets surface

Two things make this surface different: `supabase secrets list -o json` returns a **SHA-256 digest** of each value rather than the value, which makes drift provable; and the write path must keep the secret out of argv.

**Files:**

- Create: `scripts/config/surfaces/supabase.mjs`
- Test: `scripts/config/surfaces/supabase.test.mjs`

**Interfaces:**

- Consumes: nothing.
- Produces: pure `digestMatches(digest: string, plaintext: string): boolean` and `isPlatformManaged(name: string): boolean`; surface `{ id: "supabase", label, effect: "immediate", probe(), list(), read(key), write(key, value) }`. `read` returns `{ known: false, present: true, updatedAt, digest }` when set.

- [ ] **Step 1: Write the failing tests**

Create `scripts/config/surfaces/supabase.test.mjs`. The two pure exports are what's worth testing; the CLI calls are verified by running them in Step 5.

```js
import { describe, it, expect } from "vitest";
import { digestMatches, isPlatformManaged } from "./supabase.mjs";

describe("digestMatches", () => {
  // sha256("1234") — the digest `supabase secrets list` returns for ENTRY_CODE=1234
  const DIGEST_OF_1234 = "03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4";

  it("matches the plaintext that produced it", () => {
    expect(digestMatches(DIGEST_OF_1234, "1234")).toBe(true);
  });

  it("does not match a different plaintext", () => {
    expect(digestMatches(DIGEST_OF_1234, "1235")).toBe(false);
  });

  it("is false when there is no digest", () => {
    expect(digestMatches(undefined, "1234")).toBe(false);
  });
});

describe("isPlatformManaged", () => {
  it.each([
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "SUPABASE_DB_URL",
    "SUPABASE_JWKS",
    "SUPABASE_PUBLISHABLE_KEYS",
    "SUPABASE_SECRET_KEYS",
    "SUPABASE_SERVICE_ROLE_KEY",
  ])("hides %s", (name) => {
    expect(isPlatformManaged(name)).toBe(true);
  });

  it.each(["ENTRY_CODE", "SPLITWISE_API_KEY", "SPLITWISE_GROUP_ID"])("does not hide %s", (name) => {
    expect(isPlatformManaged(name)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run scripts/config/surfaces/supabase.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the Supabase surface**

Create `scripts/config/surfaces/supabase.mjs`:

```js
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { writeFile, unlink, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = promisify(execFile);

// Injected by Supabase into every project's function environment. Not ours to
// edit, and not strays.
const PLATFORM_MANAGED = new Set([
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_DB_URL",
  "SUPABASE_JWKS",
  "SUPABASE_PUBLISHABLE_KEYS",
  "SUPABASE_SECRET_KEYS",
  "SUPABASE_SERVICE_ROLE_KEY",
]);

export function isPlatformManaged(name) {
  return PLATFORM_MANAGED.has(name);
}

/** `supabase secrets list` returns sha256(plaintext), never the plaintext. */
export function digestMatches(digest, plaintext) {
  if (!digest) return false;
  return digest === createHash("sha256").update(String(plaintext)).digest("hex");
}

export const id = "supabase";
export const label = "Supabase secrets";
export const effect = "immediate";

let cache = null; // Map<name, { updatedAt, digest }>, one fetch per run

async function fetchSecrets() {
  if (cache) return cache;
  const { stdout } = await run("supabase", ["secrets", "list", "-o", "json"]);
  cache = new Map(
    JSON.parse(stdout).map((s) => [s.name, { updatedAt: s.updated_at, digest: s.value }]),
  );
  return cache;
}

export async function probe() {
  try {
    await run("supabase", ["--version"]);
  } catch {
    return {
      available: false,
      reason: "Supabase CLI not installed — see supabase.com/docs/guides/cli",
    };
  }
  try {
    await fetchSecrets();
    return { available: true };
  } catch (err) {
    const text = `${err.stderr ?? ""}${err.message ?? ""}`;
    if (/not logged in|access token|login/i.test(text)) {
      return { available: false, reason: "not logged in — run 'supabase login'" };
    }
    if (/not linked|link your project|project ref/i.test(text)) {
      return { available: false, reason: "project not linked — run 'supabase link'" };
    }
    return {
      available: false,
      reason: text.trim().split("\n")[0] || "supabase secrets list failed",
    };
  }
}

export async function list() {
  return [...(await fetchSecrets()).keys()].filter((n) => !isPlatformManaged(n));
}

export async function read(key) {
  const found = (await fetchSecrets()).get(key);
  if (!found) return { known: false, present: false };
  return { known: false, present: true, updatedAt: found.updatedAt, digest: found.digest };
}

export async function write(key, value) {
  // `supabase secrets set KEY=VALUE` would put the secret in argv, where any
  // other user on the machine can read it out of `ps`. --env-file does not.
  const dir = await mkdtemp(join(tmpdir(), "chapati-config-"));
  const file = join(dir, "secrets.env");
  try {
    await writeFile(file, `${key}=${value}\n`, { encoding: "utf8", mode: 0o600 });
    await run("supabase", ["secrets", "set", "--env-file", file]);
    cache = null; // force a re-read so status reflects the new digest
  } finally {
    await unlink(file).catch(() => {});
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run scripts/config/surfaces/supabase.test.mjs`
Expected: PASS.

- [ ] **Step 5: Verify the CLI path against the real project, read-only**

```bash
node -e '
import("./scripts/config/surfaces/supabase.mjs").then(async (m) => {
  console.log(await m.probe());
  console.log("editable:", await m.list());
  const r = await m.read("ENTRY_CODE");
  console.log({ present: r.present, known: r.known, hasDigest: !!r.digest });
});
'
```

Expected: `{ available: true }`; `editable:` lists exactly `ENTRY_CODE`, `SPLITWISE_API_KEY`, `SPLITWISE_GROUP_ID` with all seven platform secrets filtered out; and `{ present: true, known: false, hasDigest: true }`.

Then confirm the digest comparison works end to end against the real `.env`:

```bash
node -e '
Promise.all([
  import("./scripts/config/surfaces/supabase.mjs"),
  import("./scripts/config/surfaces/dotenv.mjs"),
]).then(async ([sb, env]) => {
  const remote = await sb.read("ENTRY_CODE");
  const local = await env.read("VITE_ENTRY_CODE");
  console.log("matches:", sb.digestMatches(remote.digest, local.value));
});
'
```

Expected: `matches: true`. **No write is performed in this task** — the write path is exercised in Task 11's end-to-end pass.

- [ ] **Step 6: Commit**

```bash
npx prettier --write scripts/config/surfaces/supabase.mjs scripts/config/surfaces/supabase.test.mjs
git add scripts/config/surfaces/supabase.mjs scripts/config/surfaces/supabase.test.mjs
git commit -m "feat(config): add the Supabase secrets surface with digest-based drift detection"
```

---

### Task 5: The GitHub secrets surface

One module, two surface objects — `github-repo` and `github-env` — so `read(key)` stays uniform. Writes go through stdin. A missing `production` environment is detected, because `gh secret set -e production` fails without it.

**Files:**

- Create: `scripts/config/surfaces/github.mjs`
- Test: `scripts/config/surfaces/github.test.mjs`

**Interfaces:**

- Consumes: nothing.
- Produces: pure `parseSecretList(json: string): Map<string, {updatedAt}>`; two surface objects, `repoSurface` and `envSurface`, each `{ id, label, effect, probe(), list(), read(key), write(key, value) }`; plus `ensureEnvironment(): Promise<boolean>` on the env surface, returning `true` if the environment exists or was created.

- [ ] **Step 1: Write the failing tests**

Create `scripts/config/surfaces/github.test.mjs`:

```js
import { describe, it, expect } from "vitest";
import { parseSecretList, repoSurface, envSurface } from "./github.mjs";

describe("parseSecretList", () => {
  const JSON_OUT =
    '[{"name":"SUPABASE_URL","updatedAt":"2026-07-15T23:21:52Z"},' +
    '{"name":"SUPABASE_ANON_KEY","updatedAt":"2026-07-15T23:21:36Z"}]';

  it("maps names to update times", () => {
    const got = parseSecretList(JSON_OUT);
    expect(got.get("SUPABASE_URL")).toEqual({ updatedAt: "2026-07-15T23:21:52Z" });
  });

  it("returns an empty map for an empty list", () => {
    expect(parseSecretList("[]").size).toBe(0);
  });
});

describe("surface identity", () => {
  it("exposes two distinct surfaces with distinct effects", () => {
    expect(repoSurface.id).toBe("github-repo");
    expect(envSurface.id).toBe("github-env");
    expect(repoSurface.effect).toBe("needs-deploy");
    expect(envSurface.effect).toBe("next-deploy");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run scripts/config/surfaces/github.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the GitHub surface**

Create `scripts/config/surfaces/github.mjs`:

```js
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const ENVIRONMENT = "production";

export function parseSecretList(json) {
  return new Map(JSON.parse(json).map((s) => [s.name, { updatedAt: s.updatedAt }]));
}

async function repoSlug() {
  const { stdout } = await run("gh", [
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "-q",
    ".nameWithOwner",
  ]);
  return stdout.trim();
}

/** `gh secret set NAME --body VALUE` leaks the value into argv; stdin does not. */
function setViaStdin(args, value) {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { stdio: ["pipe", "ignore", "pipe"] });
    // A child that exits before draining stdin raises EPIPE on this stream.
    // Swallow it here: the real failure is already reported by the close
    // handler below, and an unhandled stream error would crash the script.
    child.stdin.on("error", () => {});
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(stderr.trim() || `gh exited ${code}`)),
    );
    child.stdin.end(value);
  });
}

async function baseProbe() {
  try {
    await run("gh", ["--version"]);
  } catch {
    return { available: false, reason: "GitHub CLI not installed — see cli.github.com" };
  }
  try {
    await run("gh", ["auth", "status"]);
  } catch {
    return { available: false, reason: "not authenticated — run 'gh auth login'" };
  }
  try {
    await repoSlug();
  } catch {
    return { available: false, reason: "no GitHub remote for this repo" };
  }
  return { available: true };
}

function makeSurface({ id, label, effect, ghArgs, cacheKey }) {
  const caches = makeSurface.caches ?? (makeSurface.caches = new Map());

  async function fetchSecrets() {
    if (caches.has(cacheKey)) return caches.get(cacheKey);
    const { stdout } = await run("gh", ["secret", "list", ...ghArgs, "--json", "name,updatedAt"]);
    const parsed = parseSecretList(stdout);
    caches.set(cacheKey, parsed);
    return parsed;
  }

  return {
    id,
    label,
    effect,
    async probe() {
      const base = await baseProbe();
      if (!base.available) return base;
      try {
        await fetchSecrets();
        return { available: true };
      } catch (err) {
        const text = `${err.stderr ?? ""}${err.message ?? ""}`;
        if (ghArgs.length && /not found|does not exist/i.test(text)) {
          return {
            available: false,
            reason: `the '${ENVIRONMENT}' environment does not exist yet`,
          };
        }
        return { available: false, reason: text.trim().split("\n")[0] || "gh secret list failed" };
      }
    },
    async list() {
      return [...(await fetchSecrets()).keys()];
    },
    async read(key) {
      const found = (await fetchSecrets()).get(key);
      if (!found) return { known: false, present: false };
      return { known: false, present: true, updatedAt: found.updatedAt };
    },
    async write(key, value) {
      await setViaStdin(["secret", "set", key, ...ghArgs], value);
      caches.delete(cacheKey);
    },
  };
}

export const repoSurface = makeSurface({
  id: "github-repo",
  label: "GitHub repo secrets",
  effect: "needs-deploy",
  ghArgs: [],
  cacheKey: "repo",
});

export const envSurface = {
  ...makeSurface({
    id: "github-env",
    label: `GitHub ${ENVIRONMENT} environment`,
    effect: "next-deploy",
    ghArgs: ["-e", ENVIRONMENT],
    cacheKey: "env",
  }),

  /** `gh secret set -e production` fails if the environment is absent. */
  async ensureEnvironment() {
    const slug = await repoSlug();
    try {
      await run("gh", ["api", `repos/${slug}/environments/${ENVIRONMENT}`]);
      return true;
    } catch {
      await run("gh", ["api", "-X", "PUT", `repos/${slug}/environments/${ENVIRONMENT}`]);
      return true;
    }
  },
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run scripts/config/surfaces/github.test.mjs`
Expected: PASS.

- [ ] **Step 5: Verify the CLI path against the real repo, read-only**

```bash
node -e '
import("./scripts/config/surfaces/github.mjs").then(async (m) => {
  console.log("repo:", await m.repoSurface.probe(), await m.repoSurface.list());
  console.log("env :", await m.envSurface.probe(), await m.envSurface.list());
  console.log("read:", await m.repoSurface.read("SUPABASE_URL"));
});
'
```

Expected: repo lists `ENTRY_CODE`, `SUPABASE_ANON_KEY`, `SUPABASE_URL`; env lists `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`; and `read` returns `{ known: false, present: true, updatedAt: '2026-07-15T23:21:52Z' }`. Note the repo's `ENTRY_CODE` — that's the known stray, and Task 9 must report it.

**Do not call `ensureEnvironment` or `write` here** — both mutate the real repo. They are exercised in Task 11.

- [ ] **Step 6: Commit**

```bash
npx prettier --write scripts/config/surfaces/github.mjs scripts/config/surfaces/github.test.mjs
git add scripts/config/surfaces/github.mjs scripts/config/surfaces/github.test.mjs
git commit -m "feat(config): add GitHub repo and environment secret surfaces"
```

---

### Task 6: The registry

Eleven settings, fourteen targets, and an integrity test that catches the typo you'd otherwise find at 11pm.

**Files:**

- Create: `scripts/config/surfaces/index.mjs`
- Create: `scripts/config/registry.mjs`
- Test: `scripts/config/registry.test.mjs`

**Interfaces:**

- Consumes: all five surfaces (Tasks 2–5), all nine validators (Task 1).
- Produces:
  - `SURFACES: Record<string, Surface>` from `surfaces/index.mjs`, keyed by `"config-file" | "dotenv" | "supabase" | "github-repo" | "github-env"`.
  - `SETTINGS: Setting[]` and `settingById(id): Setting | undefined` from `registry.mjs`. A `Setting` is `{ id, label, help, secret?, targets: {surface, key}[], validate, obtain: null | {url, instructions}, wizard: {step, required} }`.
  - `WIZARD_STEPS: {n, title}[]` describing the five steps, so the wizard can print headings without hardcoding them.

- [ ] **Step 1: Write the failing integrity test**

Create `scripts/config/registry.test.mjs`:

```js
import { describe, it, expect } from "vitest";
import { SETTINGS, settingById, WIZARD_STEPS } from "./registry.mjs";
import { SURFACES } from "./surfaces/index.mjs";

describe("registry integrity", () => {
  it("has eleven settings and fourteen targets", () => {
    expect(SETTINGS).toHaveLength(11);
    expect(SETTINGS.flatMap((s) => s.targets)).toHaveLength(14);
  });

  it("gives every setting a unique id", () => {
    const ids = SETTINGS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("points every target at a surface that exists", () => {
    for (const s of SETTINGS) {
      for (const t of s.targets) {
        expect(SURFACES[t.surface], `${s.id} -> ${t.surface}`).toBeDefined();
      }
    }
  });

  it("never lets two settings claim the same target", () => {
    const seen = new Set();
    for (const s of SETTINGS) {
      for (const t of s.targets) {
        const slot = `${t.surface}:${t.key}`;
        expect(seen.has(slot), `${slot} claimed twice`).toBe(false);
        seen.add(slot);
      }
    }
  });

  it("gives every setting a callable validator", () => {
    for (const s of SETTINGS) {
      expect(typeof s.validate, s.id).toBe("function");
    }
  });

  it("gives every setting a label and help text", () => {
    for (const s of SETTINGS) {
      expect(s.label, s.id).toBeTruthy();
      expect(s.help, s.id).toBeTruthy();
    }
  });

  it("assigns every setting to a declared wizard step", () => {
    const steps = new Set(WIZARD_STEPS.map((w) => w.n));
    for (const s of SETTINGS) {
      expect(steps.has(s.wizard.step), s.id).toBe(true);
    }
  });

  it("gives every obtain block a url and instructions", () => {
    for (const s of SETTINGS.filter((s) => s.obtain)) {
      expect(s.obtain.url, s.id).toMatch(/^https:\/\//);
      expect(s.obtain.instructions, s.id).toBeTruthy();
    }
  });

  it("marks exactly the sensitive settings as secret", () => {
    expect(
      SETTINGS.filter((s) => s.secret)
        .map((s) => s.id)
        .sort(),
    ).toEqual(["entry-code", "splitwise-api-key", "supabase-access-token", "supabase-db-password"]);
  });

  it("looks settings up by id", () => {
    expect(settingById("default-price").label).toBe("Default price per chapati");
    expect(settingById("nope")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run scripts/config/registry.test.mjs`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the surfaces index**

Create `scripts/config/surfaces/index.mjs`:

```js
import * as configFile from "./configFile.mjs";
import * as dotenv from "./dotenv.mjs";
import * as supabase from "./supabase.mjs";
import { repoSurface, envSurface } from "./github.mjs";

export const SURFACES = {
  "config-file": configFile,
  dotenv,
  supabase,
  "github-repo": repoSurface,
  "github-env": envSurface,
};

/** Human sentence for what a change costs, keyed by the surface's effect. */
export const EFFECT_TEXT = {
  "needs-deploy": "takes effect after a commit and push",
  "needs-restart": "restart `npm run dev` to pick it up",
  immediate: "live now",
  "next-deploy": "used by the next deploy",
};
```

- [ ] **Step 4: Write the registry**

Create `scripts/config/registry.mjs`:

```js
import * as v from "./validate.mjs";

export const WIZARD_STEPS = [
  { n: 1, title: "Connect your Supabase project" },
  { n: 2, title: "Set the sign-in code" },
  { n: 3, title: "Set your group's price and currency" },
  { n: 4, title: "Deploy credentials" },
  { n: 5, title: "Connect Splitwise (optional)" },
];

const SUPABASE_API_PAGE = "https://supabase.com/dashboard/project/_/settings/api";

export const SETTINGS = [
  {
    id: "supabase-url",
    label: "Supabase project URL",
    help: "Your project's API URL. Public by design — access is controlled by Row-Level Security.",
    targets: [
      { surface: "dotenv", key: "VITE_SUPABASE_URL" },
      { surface: "github-repo", key: "SUPABASE_URL" },
    ],
    validate: v.supabaseUrl,
    obtain: {
      url: SUPABASE_API_PAGE,
      instructions: "Project Settings → API. Copy the Project URL.",
    },
    wizard: { step: 1, required: true },
  },
  {
    id: "supabase-anon-key",
    label: "Supabase anon key",
    help: "The publishable key. Safe to ship in the frontend; the service_role key is the real secret and is never used here.",
    targets: [
      { surface: "dotenv", key: "VITE_SUPABASE_ANON_KEY" },
      { surface: "github-repo", key: "SUPABASE_ANON_KEY" },
    ],
    validate: v.anonKey,
    obtain: {
      url: SUPABASE_API_PAGE,
      instructions: "Project Settings → API. Copy the anon / publishable key — not service_role.",
    },
    wizard: { step: 1, required: true },
  },
  {
    id: "entry-code",
    label: "Entry code",
    help: "The 4-digit code your group types to sign in. Goes to .env for local dev and to Supabase for production, where validate-access checks it.",
    secret: true,
    targets: [
      { surface: "dotenv", key: "VITE_ENTRY_CODE" },
      { surface: "supabase", key: "ENTRY_CODE" },
    ],
    validate: v.fourDigits,
    obtain: null,
    wizard: { step: 2, required: true },
  },
  {
    id: "default-price",
    label: "Default price per chapati",
    help: "Applies to every entry. A day at a different rate is typed in the add box as `50x0.75` instead.",
    targets: [{ surface: "config-file", key: "DEFAULT_PRICE" }],
    validate: v.positiveNumber,
    obtain: null,
    wizard: { step: 3, required: true },
  },
  {
    id: "currency",
    label: "Currency symbol",
    help: "Shown next to every amount in the app.",
    targets: [{ surface: "config-file", key: "CURRENCY" }],
    validate: v.currencySymbol,
    obtain: null,
    wizard: { step: 3, required: true },
  },
  {
    id: "supabase-access-token",
    label: "Supabase access token",
    help: "Lets the deploy workflow push migrations and edge functions. Scoped to the production environment because it grants real write access.",
    secret: true,
    targets: [{ surface: "github-env", key: "SUPABASE_ACCESS_TOKEN" }],
    validate: v.token,
    obtain: {
      url: "https://supabase.com/dashboard/account/tokens",
      instructions: "Generate a new access token and copy it — it is shown only once.",
    },
    wizard: { step: 4, required: true },
  },
  {
    id: "supabase-db-password",
    label: "Supabase database password",
    help: "The password you set when creating the project. Used by the deploy workflow to apply migrations.",
    secret: true,
    targets: [{ surface: "github-env", key: "SUPABASE_DB_PASSWORD" }],
    validate: v.nonEmpty,
    obtain: {
      url: "https://supabase.com/dashboard/project/_/settings/database",
      instructions:
        "Project Settings → Database. Reset the password there if you no longer have it.",
    },
    wizard: { step: 4, required: true },
  },
  {
    id: "splitwise-api-key",
    label: "Splitwise API key",
    help: "Read only by the splitwise edge function — never reaches the browser.",
    secret: true,
    targets: [{ surface: "supabase", key: "SPLITWISE_API_KEY" }],
    validate: v.token,
    obtain: {
      url: "https://dev.splitwise.com/apps",
      instructions:
        "Register an application and copy its API key — not the Consumer Key/Secret, which are for OAuth.",
    },
    wizard: { step: 5, required: false },
  },
  {
    id: "splitwise-group-id",
    label: "Splitwise group id",
    help: "The group expenses are pushed into. Point it at a disposable test group while trying this out.",
    targets: [{ surface: "supabase", key: "SPLITWISE_GROUP_ID" }],
    validate: v.groupId,
    obtain: {
      url: "https://secure.splitwise.com/groups",
      instructions: "Open the target group. The number in the page URL is the group id.",
    },
    wizard: { step: 5, required: false },
  },
  {
    id: "splitwise-currency",
    label: "Splitwise currency code",
    help: "The currency the pushed expense is created in, independent of the symbol shown in the app.",
    targets: [{ surface: "config-file", key: "SPLITWISE_CURRENCY" }],
    validate: v.currencyCode,
    obtain: null,
    wizard: { step: 5, required: false },
  },
  {
    id: "splitwise-category",
    label: "Splitwise category",
    help: "The Splitwise category the pushed expense is filed under.",
    targets: [{ surface: "config-file", key: "SPLITWISE_CATEGORY_NAME" }],
    validate: v.nonEmpty,
    obtain: null,
    wizard: { step: 5, required: false },
  },
];

export function settingById(id) {
  return SETTINGS.find((s) => s.id === id);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run scripts/config/registry.test.mjs`
Expected: PASS, all ten integrity assertions.

- [ ] **Step 6: Commit**

```bash
npx prettier --write scripts/config/registry.mjs scripts/config/surfaces/index.mjs scripts/config/registry.test.mjs
git add scripts/config/registry.mjs scripts/config/surfaces/index.mjs scripts/config/registry.test.mjs
git commit -m "feat(config): add the settings registry with an integrity test"
```

---

### Task 7: Terminal prompts

No tests here — these are interactive by nature, and a mock would only prove the code calls the functions this plan says it calls. Verified by running it.

**Files:**

- Create: `scripts/config/prompt.mjs`

**Interfaces:**

- Consumes: nothing.
- Produces: `ask(question, {default?}): Promise<string>`, `askSecret(question): Promise<string>`, `confirm(question, {default = true}): Promise<boolean>`, `choose(question, choices: {key, label}[]): Promise<string>` returning the chosen `key`, `openUrl(url): boolean`, `pause(message): Promise<void>`, and the style helpers `bold`, `dim`, `green`, `yellow`, `red`.

- [ ] **Step 1: Write the prompt module**

Create `scripts/config/prompt.mjs`:

```js
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { Writable } from "node:stream";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `[${code}m${s}[0m` : String(s));

export const bold = paint("1");
export const dim = paint("2");
export const red = paint("31");
export const green = paint("32");
export const yellow = paint("33");

function rl() {
  return createInterface({ input: process.stdin, output: process.stdout });
}

export async function ask(question, { default: fallback } = {}) {
  const io = rl();
  try {
    const hint = fallback === undefined ? "" : dim(` [${fallback}]`);
    const answer = (await io.question(`${question}${hint}: `)).trim();
    return answer === "" && fallback !== undefined ? String(fallback) : answer;
  } finally {
    io.close();
  }
}

export async function askSecret(question) {
  // readline has no native echo suppression: write the prompt through a
  // stream we can mute, flip the mute once the question has been printed.
  const state = { muted: false };
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!state.muted) process.stdout.write(chunk, encoding);
      callback();
    },
  });
  const io = createInterface({ input: process.stdin, output, terminal: true });
  try {
    const pending = io.question(`${question}: `);
    state.muted = true;
    const answer = await pending;
    process.stdout.write("\n");
    return answer.trim();
  } finally {
    state.muted = false;
    io.close();
  }
}

export async function confirm(question, { default: fallback = true } = {}) {
  const hint = fallback ? "Y/n" : "y/N";
  const answer = (await ask(`${question} ${dim(`(${hint})`)}`)).toLowerCase();
  if (answer === "") return fallback;
  return answer === "y" || answer === "yes";
}

export async function choose(question, choices) {
  for (;;) {
    console.log();
    for (const c of choices) console.log(`  ${bold(c.key)}) ${c.label}`);
    console.log();
    const answer = (await ask(question)).toLowerCase();
    const hit = choices.find((c) => c.key.toLowerCase() === answer);
    if (hit) return hit.key;
    console.log(red("  Not one of the options."));
  }
}

export async function pause(message = "Press Enter to continue") {
  await ask(dim(message));
}

const OPENERS = { darwin: "open", linux: "xdg-open", win32: "start" };

export function openUrl(url) {
  const command = OPENERS[process.platform];
  if (!command) return false;
  try {
    const { status } = spawnSync(command, [url], { stdio: "ignore" });
    return status === 0;
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: Verify the prompts by hand**

```bash
node -e '
import("./scripts/config/prompt.mjs").then(async (p) => {
  console.log(p.bold("bold"), p.dim("dim"), p.green("green"), p.yellow("yellow"), p.red("red"));
  console.log("ask     ->", await p.ask("Type anything", { default: "fallback" }));
  console.log("secret  ->", (await p.askSecret("Type a secret")).replace(/./g, "*"));
  console.log("confirm ->", await p.confirm("Say yes"));
  console.log("choose  ->", await p.choose("Pick one", [{ key: "1", label: "One" }, { key: "q", label: "Quit" }]));
});
'
```

Verify by eye: pressing Enter at the first prompt returns `fallback`; **the secret you type does not appear on screen**; `confirm` accepts a bare Enter as yes; `choose` re-asks on a bad key. Skip testing `openUrl` here — the wizard exercises it in Task 11.

- [ ] **Step 3: Commit**

```bash
npx prettier --write scripts/config/prompt.mjs
git add scripts/config/prompt.mjs
git commit -m "feat(config): add terminal prompts with echo-suppressed secret input"
```

---

### Task 8: Git helpers

**Files:**

- Create: `scripts/config/git.mjs`
- Test: `scripts/config/git.test.mjs`

**Interfaces:**

- Consumes: nothing.
- Produces: pure `commitMessage(changes: {label, value}[]): string`; and `currentBranch()`, `isDirty(path)`, `diff(path)`, `commit(path, message)`, `push()` — all `Promise`-returning, all operating on explicit paths.

- [ ] **Step 1: Write the failing test**

Create `scripts/config/git.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run scripts/config/git.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the git helpers**

Create `scripts/config/git.mjs`:

```js
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export function commitMessage(changes) {
  if (changes.length === 1) {
    const [only] = changes;
    const name = only.label.toLowerCase();
    if (only.secret) return `chore: update ${name}`;
    return `chore: set ${name} to ${only.value}`;
  }
  return "chore: update app config";
}

export async function currentBranch() {
  const { stdout } = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  return stdout.trim();
}

export async function isDirty(path) {
  const { stdout } = await run("git", ["status", "--porcelain", "--", path]);
  return stdout.trim() !== "";
}

export async function diff(path) {
  const { stdout } = await run("git", ["diff", "--", path]);
  return stdout;
}

export async function commit(path, message) {
  // Stage by explicit path. Never `git add -A` — unrelated work stays untouched.
  await run("git", ["add", "--", path]);
  await run("git", ["commit", "-m", message]);
}

export async function push() {
  await run("git", ["push"]);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run scripts/config/git.test.mjs`
Expected: PASS.

- [ ] **Step 5: Verify the read-only helpers against the real repo**

```bash
node -e '
import("./scripts/config/git.mjs").then(async (g) => {
  console.log("branch:", await g.currentBranch());
  console.log("config.ts dirty:", await g.isDirty("src/config.ts"));
});
'
```

Expected: `branch: interactive-config-script` and `config.ts dirty: false`.

- [ ] **Step 6: Commit**

```bash
npx prettier --write scripts/config/git.mjs scripts/config/git.test.mjs
git add scripts/config/git.mjs scripts/config/git.test.mjs
git commit -m "feat(config): add git helpers with path-scoped staging"
```

---

### Task 9: The status screen

Everything up to now has been plumbing. This is the first runnable command. Formatting is pure and tested; gathering is not.

**Files:**

- Create: `scripts/config/render.mjs`
- Create: `scripts/config.mjs`
- Test: `scripts/config/render.test.mjs`

**Interfaces:**

- Consumes: `SETTINGS` and `SURFACES` (Task 6), `digestMatches` (Task 4), prompt style helpers (Task 7).
- Produces:
  - From `render.mjs`, pure: `describeSetting(setting, states): {text, warning}` where `states` is an array aligned to `setting.targets`; `maskValue(setting, value): string`; `sinceText(iso, now): string`.
  - From `config.mjs`: `gather(): Promise<Report>` where `Report` is `{ probes: Map<surfaceId, {available, reason}>, states: Map<settingId, TargetState[]>, strays: {surface, key}[] }`, plus `checkSupabase(url, key): Promise<{ok: true|false|null, reason?}>` — `null` means undetermined, which is a warning, not a failure.

- [ ] **Step 1: Write the failing tests**

Create `scripts/config/render.test.mjs`:

```js
import { describe, it, expect } from "vitest";
import { describeSetting, maskValue, sinceText } from "./render.mjs";
import { settingById } from "./registry.mjs";

const NOW = new Date("2026-08-09T12:00:00Z");

describe("sinceText", () => {
  it.each([
    ["2026-08-09T11:00:00Z", "today"],
    ["2026-08-06T12:00:00Z", "3d ago"],
    ["2026-07-20T12:00:00Z", "20d ago"],
  ])("renders %s as %s", (iso, expected) => {
    expect(sinceText(iso, NOW)).toBe(expected);
  });
});

describe("maskValue", () => {
  it("shows a plain value in full", () => {
    expect(maskValue(settingById("default-price"), 0.5)).toBe("0.5");
  });

  it("never shows a secret value", () => {
    expect(maskValue(settingById("entry-code"), "1234")).toBe("••••");
  });

  it("truncates a long value", () => {
    const long = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
    expect(maskValue(settingById("supabase-anon-key"), long)).toBe("eyJhbGciOiJI…");
  });
});

describe("describeSetting", () => {
  it("reports a single readable target", () => {
    const setting = settingById("default-price");
    const got = describeSetting(setting, [{ known: true, present: true, value: 0.5 }], NOW);
    expect(got.text).toBe("0.5");
    expect(got.warning).toBeNull();
  });

  it("reports both targets set", () => {
    const setting = settingById("supabase-url");
    const got = describeSetting(
      setting,
      [
        { known: true, present: true, value: "https://abc123.supabase.co" },
        { known: false, present: true, updatedAt: "2026-08-06T12:00:00Z" },
      ],
      NOW,
    );
    expect(got.text).toContain("https://abc1…");
    expect(got.text).toContain("both");
    expect(got.warning).toBeNull();
  });

  it("warns when one target is set and another is not", () => {
    const setting = settingById("entry-code");
    const got = describeSetting(
      setting,
      [
        { known: true, present: true, value: "1234" },
        { known: false, present: false },
      ],
      NOW,
    );
    expect(got.warning).toMatch(/Supabase secrets/);
    expect(got.warning).toMatch(/not set/);
  });

  it("confirms a digest match without revealing the value", () => {
    const setting = settingById("entry-code");
    const got = describeSetting(
      setting,
      [
        { known: true, present: true, value: "1234" },
        {
          known: false,
          present: true,
          updatedAt: "2026-08-06T12:00:00Z",
          digest: "03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4",
        },
      ],
      NOW,
    );
    expect(got.text).toContain("matches");
    expect(got.text).not.toContain("1234");
    expect(got.warning).toBeNull();
  });

  it("warns when the digest disagrees with the local value", () => {
    const setting = settingById("entry-code");
    const got = describeSetting(
      setting,
      [
        { known: true, present: true, value: "9999" },
        {
          known: false,
          present: true,
          updatedAt: "2026-08-06T12:00:00Z",
          digest: "03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4",
        },
      ],
      NOW,
    );
    expect(got.warning).toMatch(/differs/);
  });

  it("reports nothing set at all", () => {
    const setting = settingById("splitwise-group-id");
    const got = describeSetting(setting, [{ known: false, present: false }], NOW);
    expect(got.text).toBe("not set");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run scripts/config/render.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the renderer**

Create `scripts/config/render.mjs`:

```js
import { SURFACES } from "./surfaces/index.mjs";
import { digestMatches } from "./surfaces/supabase.mjs";

const MAX_SHOWN = 12;

export function maskValue(setting, value) {
  if (setting.secret) return "••••";
  const text = String(value);
  return text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN)}…` : text;
}

export function sinceText(iso, now = new Date()) {
  const days = Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000);
  return days <= 0 ? "today" : `${days}d ago`;
}

/**
 * One line of state for a setting, plus an optional warning.
 * `states` is aligned index-for-index with `setting.targets`.
 */
export function describeSetting(setting, states, now = new Date()) {
  const present = [];
  const absent = [];
  const blocked = [];
  const parts = [];
  let differs = false;

  // A locally readable value, if any — the only thing a digest can be compared against.
  const local = states.find((s) => s.known && s.present);
  const localValue = local ? local.value : null;

  states.forEach((state, i) => {
    const surface = SURFACES[setting.targets[i].surface];

    // Blocked is its own bucket, never folded into absent: a target we could
    // not reach is not a target we know to be unset, and saying otherwise
    // states something untrue.
    if (state.blocked) {
      blocked.push(surface.label);
      parts.push(`${surface.label} — not checked`);
      return;
    }
    if (!state.present) {
      absent.push(surface.label);
      return;
    }
    present.push(surface.label);

    if (state.known) {
      parts.push(maskValue(setting, state.value));
    } else if (state.digest && localValue !== null) {
      if (digestMatches(state.digest, localValue)) {
        parts.push(`${surface.label} ✓ matches`);
      } else {
        differs = true;
        parts.push(`${surface.label} ✓ ${sinceText(state.updatedAt, now)} — DIFFERENT`);
      }
    } else {
      parts.push(`${surface.label} set · ${sinceText(state.updatedAt, now)}`);
    }
  });

  if (present.length === 0 && blocked.length === 0) return { text: "not set", warning: null };
  // Nothing present and nothing confirmed absent either — every target was blocked.
  if (present.length === 0 && absent.length === 0) return { text: "not checked", warning: null };

  // A target we couldn't check is not evidence of drift: suppress the
  // warning rather than accuse a setting of being unset or disagreeing when
  // we simply never asked.
  let warning = null;
  if (blocked.length === 0) {
    if (absent.length > 0) {
      warning = `${setting.label} is set in ${present.join(", ")} but not set in ${absent.join(", ")}.`;
    } else if (differs) {
      warning = `${setting.label} differs between ${present.join(" and ")}.`;
    }
  }

  // "· both" is earned only when every target of a multi-target setting is
  // present and nothing disagrees — an unreachable target never earns it.
  const complete =
    setting.targets.length > 1 && absent.length === 0 && blocked.length === 0 && !differs;
  const text = complete ? `${parts.join(" · ")} · both` : parts.join(" · ");

  return { text, warning };
}
```

- [ ] **Step 4: Write the entry point with the status flow**

Create `scripts/config.mjs`:

```js
#!/usr/bin/env node
import { SETTINGS } from "./config/registry.mjs";
import { SURFACES, EFFECT_TEXT } from "./config/surfaces/index.mjs";
import { isPlatformManaged } from "./config/surfaces/supabase.mjs";
import { describeSetting } from "./config/render.mjs";
import { bold, dim, green, yellow, red } from "./config/prompt.mjs";

const GROUPS = [
  { title: "App settings", surface: "config-file" },
  { title: "Connection", surface: "dotenv" },
  { title: "Splitwise", surface: "supabase" },
  { title: "Deploy credentials", surface: "github-env" },
];

/** Read every surface once and every setting's targets from that read. */
export async function gather() {
  const probes = new Map();
  await Promise.all(
    Object.entries(SURFACES).map(async ([id, surface]) => {
      try {
        probes.set(id, await surface.probe());
      } catch (err) {
        probes.set(id, { available: false, reason: err.message });
      }
    }),
  );

  const states = new Map();
  for (const setting of SETTINGS) {
    const read = await Promise.all(
      setting.targets.map(async (t) => {
        if (!probes.get(t.surface)?.available)
          return { known: false, present: false, blocked: true };
        try {
          return await SURFACES[t.surface].read(t.key);
        } catch {
          return { known: false, present: false, blocked: true };
        }
      }),
    );
    states.set(setting.id, read);
  }

  const claimed = new Set(SETTINGS.flatMap((s) => s.targets.map((t) => `${t.surface}:${t.key}`)));
  const strays = [];
  for (const [id, surface] of Object.entries(SURFACES)) {
    if (!probes.get(id)?.available) continue;
    let keys = [];
    try {
      keys = await surface.list();
    } catch {
      continue;
    }
    for (const key of keys) {
      if (claimed.has(`${id}:${key}`)) continue;
      if (id === "supabase" && isPlatformManaged(key)) continue;
      if (id === "config-file" || id === "dotenv") continue; // local files hold more than we manage
      strays.push({ surface: surface.label, key });
    }
  }

  return { probes, states, strays };
}

/** The one live check: does this URL + anon key pair actually work? */
export async function checkSupabase(url, anonKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    // /auth/v1/health, not the REST root: a valid sb_publishable_ key gets a
    // 401 from `/rest/v1/`, so the obvious endpoint reports every modern key
    // as rejected. This one discriminates correctly and depends on no table,
    // schema, or RLS policy. Measured: valid key 200, bogus key 401.
    const res = await fetch(`${url}/auth/v1/health`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: `the key was rejected (HTTP ${res.status})` };
    }
    return { ok: true };
  } catch (err) {
    // Undetermined, not failed — being offline is not a configuration error.
    return { ok: null, reason: err.name === "AbortError" ? "timed out after 8s" : err.message };
  } finally {
    clearTimeout(timer);
  }
}

export function printStatus(report) {
  const warnings = [];
  console.log(`\n${bold("Chapati Khata — configuration")}\n`);

  for (const group of GROUPS) {
    const members = SETTINGS.filter((s) => s.targets[0].surface === group.surface);
    if (members.length === 0) continue;

    const surface = SURFACES[group.surface];
    const probe = report.probes.get(group.surface);
    const heading = `${dim(surface.label)} · ${dim(EFFECT_TEXT[surface.effect])}`;
    console.log(
      `  ${bold(group.title)}${" ".repeat(Math.max(1, 42 - group.title.length))}${heading}`,
    );

    if (!probe?.available) {
      console.log(
        `    ${yellow(probe?.reason ?? "unavailable")} — ${members.length} settings hidden\n`,
      );
      continue;
    }

    for (const setting of members) {
      const { text, warning } = describeSetting(setting, report.states.get(setting.id));
      const pad = " ".repeat(Math.max(1, 30 - setting.label.length));
      console.log(`    ${setting.label}${pad}${text}`);
      if (warning) warnings.push(warning);
    }
    console.log();
  }

  if (report.strays.length > 0) {
    console.log(`  ${bold("Not managed here")}`);
    for (const s of report.strays) console.log(`    ${dim(`${s.surface}`)}  ${s.key}`);
    console.log();
  }

  if (warnings.length > 0) {
    console.log(`  ${yellow(`⚠ ${warnings.length} issue${warnings.length === 1 ? "" : "s"}`)}`);
    for (const w of warnings) console.log(`    ${w}`);
    console.log();
  } else {
    console.log(`  ${green("✓ everything agrees")}\n`);
  }
}

async function main() {
  const report = await gather();
  printStatus(report);
}

// Only run when invoked directly, so tests can import gather/checkSupabase.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  main().catch((err) => {
    console.error(red(`\n${err.message}\n`));
    process.exit(1);
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run scripts/config/render.test.mjs`
Expected: PASS.

- [ ] **Step 6: Run the real status screen**

Run: `npm run config`

Expected against this project: all four groups render; `Entry code` shows `.env` alongside `Supabase secrets ✓ matches`; the `Not managed here` block lists the `ENTRY_CODE` GitHub repo secret; no Supabase platform secret appears anywhere. Confirm nothing was written: `git status --porcelain` is clean.

- [ ] **Step 7: Commit**

```bash
npx prettier --write scripts/config.mjs scripts/config/render.mjs scripts/config/render.test.mjs
git add scripts/config.mjs scripts/config/render.mjs scripts/config/render.test.mjs
git commit -m "feat(config): add the status screen with drift and stray reporting"
```

---

### Task 10: The edit flow and the menu

The first task that writes anything. Fan-out, partial-failure reporting, and the batched git offer all live here.

**Files:**

- Modify: `scripts/config.mjs`

**Interfaces:**

- Consumes: everything from Tasks 1–9.
- Produces: `editSetting(setting): Promise<{changed: boolean, value?}>` and `runMenu(): Promise<void>` in `scripts/config.mjs`. Note that `changed: true` means a write was attempted, **not** that every target succeeded — `applyToTargets` reports partial failure to the screen and its boolean return is deliberately unused. Also produces a module-level `session` object `{ configFileTouched: {label, value, secret}[], configFileDirtyBefore: boolean }` that Task 11's wizard reuses for the same git offer.

- [ ] **Step 1: Add the edit flow**

Add to `scripts/config.mjs`, above `main`:

```js
import { settingById } from "./config/registry.mjs"; // add to the existing registry import
import { ask, askSecret, confirm, choose, pause, openUrl } from "./config/prompt.mjs";
import * as git from "./config/git.mjs";

const session = { configFileTouched: [], configFileDirtyBefore: false };

async function promptValue(setting) {
  for (;;) {
    const raw = setting.secret
      ? await askSecret(`  ${setting.label}`)
      : await ask(`  ${setting.label}`);
    if (raw === "") return null; // empty input cancels
    const result = setting.validate(raw);
    if (!result.ok) {
      console.log(`  ${red(`✗ ${result.reason}`)}`);
      continue;
    }
    if (result.warn) console.log(`  ${yellow(`⚠ ${result.warn}`)}`);
    return result.value;
  }
}

/** Write every target, reporting exactly how far it got. No rollback. */
async function applyToTargets(setting, value) {
  const results = [];
  for (const target of setting.targets) {
    const surface = SURFACES[target.surface];
    try {
      await surface.write(target.key, value);
      results.push({ target, ok: true });
      console.log(`  ${green("✓")} ${surface.label.padEnd(24)} ${target.key}`);
    } catch (err) {
      results.push({ target, ok: false, error: err });
      console.log(`  ${red("✗")} ${surface.label.padEnd(24)} ${target.key} — ${err.message}`);
      const manual =
        target.surface === "supabase"
          ? `supabase secrets set ${target.key}=<value>`
          : target.surface.startsWith("github")
            ? `gh secret set ${target.key}${target.surface === "github-env" ? " -e production" : ""}`
            : `edit ${surface.label} by hand`;
      console.log(`    ${dim(`Finish by hand:  ${manual}`)}`);
    }
  }

  const effects = [
    ...new Set(
      results.filter((r) => r.ok).map((r) => EFFECT_TEXT[SURFACES[r.target.surface].effect]),
    ),
  ];
  if (effects.length > 0) console.log(`  ${dim(effects.join(" · "))}`);

  if (results.some((r) => r.ok && r.target.surface === "config-file")) {
    session.configFileTouched.push({ label: setting.label, value, secret: !!setting.secret });
  }
  return results.every((r) => r.ok);
}

export async function editSetting(setting) {
  console.log(`\n${bold(setting.label)}`);
  console.log(`  ${dim(setting.help)}`);

  if (setting.obtain) {
    console.log(`  ${dim(setting.obtain.instructions)}`);
    if (await confirm(`  Open ${setting.obtain.url}?`, { default: true })) {
      if (!openUrl(setting.obtain.url)) console.log(`  ${dim(setting.obtain.url)}`);
      await pause("  Press Enter once you have the value");
    }
  }

  const value = await promptValue(setting);
  if (value === null) {
    console.log(`  ${dim("left unchanged")}`);
    return { changed: false };
  }
  await applyToTargets(setting, value);
  return { changed: true, value };
}
```

- [ ] **Step 2: Add the git offer**

Add to `scripts/config.mjs`:

```js
async function offerCommit() {
  if (session.configFileTouched.length === 0) return;

  console.log(`\n${bold("src/config.ts changed")}`);
  console.log(await git.diff("src/config.ts"));

  if (session.configFileDirtyBefore) {
    console.log(`  ${yellow("⚠ src/config.ts already had uncommitted changes before this run.")}`);
    console.log(
      `  ${dim("Staging by path can't separate them from these, so they'd ride along. Commit it yourself.")}`,
    );
    return;
  }

  const message = git.commitMessage(session.configFileTouched);
  const branch = await git.currentBranch();
  const answer = await choose("What now?", [
    { key: "1", label: `Commit and push  ${dim(`(${message})`)}` },
    { key: "2", label: "Commit only" },
    { key: "3", label: "Leave it — I'll commit myself" },
  ]);
  if (answer === "3") return;

  await git.commit("src/config.ts", message);
  console.log(`  ${green("✓")} committed`);
  if (answer === "1") {
    if (branch !== "main") {
      console.log(
        `  ${yellow(`⚠ you're on '${branch}', not main — this push won't trigger the deploy.`)}`,
      );
      if (!(await confirm("  Push anyway?", { default: false }))) return;
    }
    await git.push();
    console.log(`  ${green("✓")} pushed`);
  }
}
```

- [ ] **Step 3: Add the menu loop**

Add to `scripts/config.mjs`:

```js
export async function runMenu() {
  session.configFileDirtyBefore = await git.isDirty("src/config.ts");

  for (;;) {
    const report = await gather();
    printStatus(report);

    const available = SETTINGS.filter((s) =>
      s.targets.every((t) => report.probes.get(t.surface)?.available),
    );
    const choices = available.map((s, i) => ({ key: String(i + 1), label: s.label }));
    choices.push({ key: "q", label: "Quit" });

    const picked = await choose("Change which setting?", choices);
    if (picked === "q") break;
    await editSetting(available[Number(picked) - 1]);
  }

  await offerCommit();
}
```

- [ ] **Step 4: Route `main` to the menu**

Replace the body of `main` in `scripts/config.mjs`:

```js
async function main() {
  if (process.argv.includes("--setup")) {
    await runWizard();
    return;
  }
  await runMenu();
}
```

`runWizard` arrives in Task 11. Until then, add this stub directly above `main` so the file stays runnable:

```js
async function runWizard() {
  console.log(dim("The setup wizard lands in the next task."));
}
```

- [ ] **Step 5: Verify the menu against a real, reversible change**

Run: `npm run config`

Change **Splitwise category** from `Groceries` to `Food`, confirm the write reports `✓ src/config.ts` with `takes effect after a commit and push`, then quit and choose **Leave it** at the git prompt. Confirm with `git diff src/config.ts` that exactly one line changed and the trailing comment on `DEFAULT_PRICE` is untouched. Then revert:

```bash
git checkout -- src/config.ts
```

Run it again and press Enter at a value prompt to confirm empty input cancels and leaves the file alone.

- [ ] **Step 6: Commit**

```bash
npx prettier --write scripts/config.mjs
git add scripts/config.mjs
git commit -m "feat(config): add the edit flow, quick-tweak menu, and batched git offer"
```

---

### Task 11: The setup wizard

**Files:**

- Modify: `scripts/config.mjs`

**Interfaces:**

- Consumes: `editSetting`, `offerCommit`, `gather`, `checkSupabase`, `session` (Task 10); `WIZARD_STEPS` (Task 6); `envSurface.ensureEnvironment` (Task 5).
- Produces: `runWizard(): Promise<void>`, replacing the Task 10 stub.

- [ ] **Step 1: Replace the wizard stub**

In `scripts/config.mjs`, replace the `runWizard` stub with:

```js
async function runWizard() {
  session.configFileDirtyBefore = await git.isDirty("src/config.ts");

  console.log(`\n${bold("Chapati Khata — setup")}`);
  console.log(dim("Follow along with the README. Enter keeps whatever is already set.\n"));

  let report = await gather();
  let skipSplitwise = false;

  for (const step of WIZARD_STEPS) {
    const members = SETTINGS.filter((s) => s.wizard.step === step.n);
    if (members.length === 0) continue;

    console.log(`\n${bold(`Step ${step.n} — ${step.title}`)}`);

    if (step.n === 5) {
      skipSplitwise = !(await confirm("  Connect Splitwise?", { default: false }));
      if (skipSplitwise) {
        console.log(`  ${dim("skipped — everything else works the same without it")}`);
        continue;
      }
    }

    // Environment secrets need the environment to exist first.
    if (members.some((s) => s.targets.some((t) => t.surface === "github-env"))) {
      const probe = report.probes.get("github-env");
      if (!probe?.available && /environment does not exist/.test(probe?.reason ?? "")) {
        if (
          await confirm("  The 'production' environment doesn't exist. Create it?", {
            default: true,
          })
        ) {
          await envSurface.ensureEnvironment();
          console.log(`  ${green("✓")} created`);
          report = await gather();
        }
      }
    }

    for (const setting of members) {
      const blocked = setting.targets.some((t) => !report.probes.get(t.surface)?.available);
      if (blocked) {
        const why = setting.targets
          .map((t) => report.probes.get(t.surface))
          .find((p) => !p?.available);
        console.log(`\n${bold(setting.label)}\n  ${yellow(`skipped — ${why?.reason}`)}`);
        continue;
      }

      const { text } = describeSetting(setting, report.states.get(setting.id));
      if (text !== "not set") {
        console.log(`\n${bold(setting.label)}  ${dim(text)}`);
        if (await confirm("  Keep this?", { default: true })) continue;
      }

      const result = await editSetting(setting);
      if (result.changed) report = await gather();
    }
  }

  await runLiveCheck(report);
  await offerCommit();
  printRemainingSteps();
}

async function runLiveCheck(report) {
  const url = report.states.get("supabase-url")?.[0];
  const key = report.states.get("supabase-anon-key")?.[0];
  if (!url?.present || !key?.present) return;

  console.log(`\n${bold("Checking the Supabase connection")}`);
  const result = await checkSupabase(url.value, key.value);
  if (result.ok === true) console.log(`  ${green("✓")} the URL and anon key work together`);
  else if (result.ok === false) console.log(`  ${red(`✗ ${result.reason}`)}`);
  else console.log(`  ${yellow(`⚠ couldn't check — ${result.reason}`)}`);
}

function printRemainingSteps() {
  console.log(`\n${bold("Left to do in a browser")}`);
  console.log('  • Settings → Pages → Build and deployment → Source: "GitHub Actions"');
  console.log("  • Push to main (or re-run the workflow) to deploy");
  console.log(`\n  ${dim("Run `npm run config` any time to change one thing.")}\n`);
}
```

- [ ] **Step 2: Add the missing imports**

At the top of `scripts/config.mjs`, extend the existing imports:

```js
import { SETTINGS, settingById, WIZARD_STEPS } from "./config/registry.mjs";
import { envSurface } from "./config/surfaces/github.mjs";
```

- [ ] **Step 3: Run the wizard end to end**

Run: `npm run setup`

Walk it with **Keep this?** answered yes at every prompt and **no** at "Connect Splitwise?". Verify: every step heading prints; already-set values are shown masked (the entry code as `••••`, never `1234`); the live check reports `✓ the URL and anon key work together`; and `git status --porcelain` is clean at the end.

- [ ] **Step 4: Verify the two write paths that have never run**

These are the only paths not yet exercised. Both write real values, so both re-set a value to what it already is.

```bash
# Supabase write via 0600 temp file — re-sets the entry code to its current value.
node -e '
Promise.all([
  import("./scripts/config/surfaces/supabase.mjs"),
  import("./scripts/config/surfaces/dotenv.mjs"),
]).then(async ([sb, env]) => {
  const local = await env.read("VITE_ENTRY_CODE");
  await sb.write("ENTRY_CODE", local.value);
  console.log("wrote; digest still matches:", sb.digestMatches((await sb.read("ENTRY_CODE")).digest, local.value));
});
'
```

Expected: `wrote; digest still matches: true`. Then confirm no temp file survived: `ls /tmp/chapati-config-* 2>/dev/null` prints nothing.

For the GitHub write path, use a throwaway name and delete it afterwards — this is the one place the script's no-delete rule doesn't apply, because you created the secret yourself for this check:

```bash
node -e '
import("./scripts/config/surfaces/github.mjs").then(async (m) => {
  await m.repoSurface.write("CHAPATI_CONFIG_SMOKE_TEST", "ok");
  console.log("wrote:", await m.repoSurface.read("CHAPATI_CONFIG_SMOKE_TEST"));
});
'
gh secret delete CHAPATI_CONFIG_SMOKE_TEST
```

Expected: `{ known: false, present: true, updatedAt: <now> }`, then a clean delete. Confirm with `ps` semantics rather than eyeballing — the value never appeared in a command line at any point.

- [ ] **Step 5: Commit**

```bash
npx prettier --write scripts/config.mjs
git add scripts/config.mjs
git commit -m "feat(config): add the setup wizard with live connection check"
```

---

### Task 12: Documentation and final verification

**Files:**

- Modify: `README.md:106-127` (Step 3), `README.md:154-183` (Step 4 setup list), `README.md:187-211` (Splitwise section), `README.md:277` (project layout)

**Interfaces:**

- Consumes: the finished script.
- Produces: nothing consumed by other tasks.

- [ ] **Step 1: Add the script to Step 3**

In `README.md`, immediately after the "Step 3" heading paragraph and before the `src/config.ts` code block, insert:

```markdown
The fastest way to set any of this is `npm run setup` for a guided first run,
or `npm run config` to change one thing later. Both show what's already set
across all four places config lives, and write each value everywhere it
belongs. The manual steps below are what those commands do.
```

- [ ] **Step 2: Note the fan-out where the README asks for a value twice**

In Step 4's numbered list, append to item 2 (the repository secrets item):

```markdown
`npm run config` sets these and their `.env` counterparts together, so the
two copies can't drift apart.
```

And append to item 4 (the `ENTRY_CODE` item):

```markdown
`npm run config` writes this to both `.env` and Supabase in one go.
```

- [ ] **Step 3: Note it in the Splitwise section**

Replace step 3 of the Splitwise list ("Set both as Supabase secrets") body with the same commands plus:

```markdown
or `npm run config`, which validates the group id before setting it.
```

- [ ] **Step 4: Add the scripts directory to the project layout**

In the layout block near `README.md:277`, add above the `config.ts` line:

```
  scripts/config.mjs        interactive setup + config editor
```

- [ ] **Step 5: Run the full verification suite**

```bash
npm run lint
npm run typecheck
npm test
npm run format:check
npm run build
```

Expected: all five pass. `typecheck` and `build` are unaffected by `.mjs` files but confirm nothing in `vitest.config.ts`, `eslint.config.js`, or `package.json` broke.

- [ ] **Step 6: Confirm the working tree is clean**

Run: `git status --porcelain`
Expected: empty. If `src/config.ts` shows changes, the earlier manual verification wasn't reverted — `git checkout -- src/config.ts`.

- [ ] **Step 7: Commit**

```bash
npx prettier --write README.md
git add README.md
git commit -m "docs: point setup and config steps at npm run setup / npm run config"
```

---

## Self-Review

**1. Spec coverage.** Every numbered spec section maps to a task:

| Spec                                                    | Task                                                   |
| ------------------------------------------------------- | ------------------------------------------------------ |
| §3.1 settings have targets, effect derived from surface | 6 (registry), 6 (`EFFECT_TEXT`)                        |
| §3.2 the eleven-setting registry                        | 6                                                      |
| §3.3 surface interface                                  | 2, 3, 4, 5                                             |
| §3.4 digest-provable drift                              | 4 (`digestMatches`), 9 (`describeSetting`)             |
| §3.5 platform-managed and strays                        | 4 (`isPlatformManaged`), 9 (`gather`)                  |
| §3.6 status / menu / wizard                             | 9, 10, 11                                              |
| §3.7 obtain, open URL                                   | 6 (`obtain` blocks), 7 (`openUrl`), 10 (`editSetting`) |
| §3.8 one live check                                     | 9 (`checkSupabase`), 11 (`runLiveCheck`)               |
| §3.9 secrets never in argv                              | 4 (`--env-file`), 5 (`setViaStdin`)                    |
| §3.10 create `production`, list what it can't do        | 5 (`ensureEnvironment`), 11                            |
| §3.11 atomic, conservative writes                       | 2, 3                                                   |
| §3.12 partial writes reported                           | 10 (`applyToTargets`)                                  |
| §3.13 batched git                                       | 8, 10 (`offerCommit`)                                  |
| §4 module layout                                        | 1–9, deviations declared in File Structure             |
| §5 repo integration                                     | 1 (vitest, eslint, package.json), 12 (README)          |
| §6 testing                                              | 1, 2, 3, 4, 5, 6, 8, 9                                 |

No gaps. §7 Deferred is deliberately unimplemented.

**2. Placeholder scan.** No "TBD", no "add error handling", no "similar to Task N". Every code step carries the actual code. The one forward reference — `runWizard` in Task 10 — is given an explicit runnable stub in Task 10 Step 4 and replaced in Task 11 Step 1.

**3. Type consistency.** Checked across tasks: validators return `{ok, value, warn?}` / `{ok, reason}` and are consumed that way in Task 10's `promptValue`. `TargetState` is produced identically by all five surfaces and consumed by `describeSetting` and `gather`. `atomicWrite(path, contents)` is defined in Task 2 and used unchanged in Task 3. `commitMessage(changes)` takes `{label, value, secret?}`, which is exactly what `session.configFileTouched` accumulates in Task 10. Surface ids `config-file` / `dotenv` / `supabase` / `github-repo` / `github-env` are spelled the same in `SURFACES`, in every registry target, and in `applyToTargets`'s manual-command branch.
