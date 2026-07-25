// ─────────────────────────────────────────────────────────────
// The only things you change to run this for your group.
// Names live in allowed-names.json (repo root) — CI reads that same file
// to keep the production edge function's allowlist in sync, so this is the
// one place to edit; there's no second copy to remember.
// ─────────────────────────────────────────────────────────────
import allowedNames from "../allowed-names.json";

export const ALLOWED_NAMES: string[] = allowedNames;

export const DEFAULT_PRICE = 0.5; // price per chapati at the default rate
export const CURRENCY = "$";
