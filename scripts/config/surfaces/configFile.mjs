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
