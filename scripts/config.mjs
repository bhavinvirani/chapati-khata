#!/usr/bin/env node
import { SETTINGS, settingById, WIZARD_STEPS } from "./config/registry.mjs";
import { SURFACES, EFFECT_TEXT } from "./config/surfaces/index.mjs";
import { isPlatformManaged } from "./config/surfaces/supabase.mjs";
import { envSurface } from "./config/surfaces/github.mjs";
import { describeSetting } from "./config/render.mjs";
import {
  bold,
  dim,
  green,
  yellow,
  red,
  ask,
  askSecret,
  confirm,
  choose,
  pause,
  openUrl,
} from "./config/prompt.mjs";
import * as git from "./config/git.mjs";

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

async function main() {
  if (process.argv.includes("--setup")) {
    await runWizard();
    return;
  }
  await runMenu();
}

// Only run when invoked directly, so tests can import gather/checkSupabase.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  main().catch((err) => {
    console.error(red(`\n${err.message}\n`));
    process.exit(1);
  });
}
