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
