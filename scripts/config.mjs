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
    const res = await fetch(`${url}/rest/v1/`, {
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
