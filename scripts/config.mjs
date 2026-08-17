#!/usr/bin/env node
import { SETTINGS, WIZARD_STEPS, settingById } from "./config/registry.mjs";
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

export const GROUPS = [
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
    // Not the REST root: on a modern `sb_publishable_` key, `/rest/v1/` with
    // no table returns 401 even for a key that works fine on real queries —
    // it demands a secret key for that specific introspection route. Auth's
    // health check discriminates valid from invalid keys correctly and
    // depends on no table name, schema, or RLS policy, so it can't start
    // failing because a migration renamed something.
    const res = await fetch(`${url}/auth/v1/health`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
      signal: controller.signal,
    });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: `the key was rejected (HTTP ${res.status})` };
    }
    // Anything else is undetermined, not proof the pair works. A paused
    // free-tier project answers on this route without being usable, and used
    // to render as a clean "✓ the URL and anon key work together".
    return { ok: null, reason: `Supabase answered HTTP ${res.status} — is the project paused?` };
  } catch (err) {
    // Undetermined, not failed — being offline is not a configuration error.
    return { ok: null, reason: err.name === "AbortError" ? "timed out after 8s" : err.message };
  } finally {
    clearTimeout(timer);
  }
}

export function printStatus(report) {
  const warnings = [];
  // What the screen could not see. Without this, a run where four settings
  // were hidden and three half-read still closed with a green all-clear.
  const unchecked = new Set();
  let unavailableSurfaces = 0;
  let blockedTargets = 0;
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
      unavailableSurfaces += 1;
      for (const member of members) unchecked.add(member.id);
      console.log(
        `    ${yellow(probe?.reason ?? "unavailable")} — ${members.length} settings hidden\n`,
      );
      continue;
    }

    for (const setting of members) {
      const states = report.states.get(setting.id) ?? [];
      const blocked = states.filter((s) => s.blocked).length;
      blockedTargets += blocked;
      if (blocked > 0) unchecked.add(setting.id);

      const { text, warning } = describeSetting(setting, states);
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
  } else if (unavailableSurfaces > 0 || blockedTargets > 0) {
    // "Agrees" would be a claim about places we never reached.
    const n = unchecked.size;
    console.log(
      `  ${yellow(`✓ nothing disagrees — ${n} setting${n === 1 ? "" : "s"} not checked`)}\n`,
    );
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
          ? // Never `supabase secrets set KEY=value`: that puts the secret in
            // argv for anyone running `ps`, which is why write() uses a file.
            `supabase secrets set --env-file <file holding ${target.key}=…>, or set it in the Supabase dashboard`
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

/**
 * Tell the database the hook secret, and where to send it.
 *
 * The trigger reads both from Vault, which no CLI reaches and PostgREST does
 * not expose — so the deployed notify function is asked to write them, using
 * the same secret we have just set as its own proof of who is asking. Failing
 * here is a warning, not a stop: the README carries the one line of SQL that
 * does the same thing.
 */
export async function installNotifyHook(secret) {
  const { value: url } = await SURFACES.dotenv.read("VITE_SUPABASE_URL");
  if (!url) {
    console.log(`  ${yellow("⚠ can't reach the notify function — set the Supabase URL first")}`);
    return false;
  }
  const endpoint = `${url.replace(/\/+$/, "")}/functions/v1/notify`;

  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-khata-hook": secret },
      body: JSON.stringify({ action: "install-hook", url: endpoint }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    console.log(`  ${yellow(`⚠ could not reach ${endpoint} — ${err.message}`)}`);
    console.log(`    ${dim("Deploy the notify function, then re-run this setting.")}`);
    return false;
  }

  if (!res.ok) {
    // 401 is the one worth naming: it means the function is running with a
    // different secret than the one just written, i.e. it needs redeploying.
    const why =
      res.status === 401
        ? "the deployed function still has the old secret — redeploy it, then re-run this setting"
        : `HTTP ${res.status}`;
    console.log(`  ${yellow(`⚠ the notify function refused the hook — ${why}`)}`);
    return false;
  }

  console.log(`  ${green("✓")} ${"database hook".padEnd(24)} installed`);
  return true;
}

/**
 * Offer to make a value that exists nowhere to be looked up.
 *
 * A VAPID keypair and a shared secret are generated, not obtained, and one
 * generation can fill more than one setting — the keypair yields both the
 * browser's public key and the sender's JWK pair, which are two settings
 * holding two shapes of the same thing. So this applies every id the
 * generator returns, validating each through its own validator on the way:
 * a generator that ever produced something malformed should fail here, not
 * silently on somebody's phone.
 */
async function offerGenerate(setting, unset) {
  if (!(await confirm(`  ${setting.generate.label}?`, { default: unset }))) return null;

  const produced = setting.generate.run();
  let value = null;
  for (const [id, raw] of Object.entries(produced)) {
    const target = settingById(id);
    if (!target) throw new Error(`generator returned an unknown setting id: ${id}`);
    const checked = target.validate(raw);
    if (!checked.ok) throw new Error(`generated ${target.label} is invalid: ${checked.reason}`);
    if (target !== setting) console.log(`\n  ${bold(target.label)} ${dim("(generated with it)")}`);
    await applyToTargets(target, checked.value);
    if (target.installHook) await installNotifyHook(checked.value);
    if (target === setting) value = checked.value;
  }
  return { changed: true, value };
}

export async function editSetting(setting, { unset = false } = {}) {
  console.log(`\n${bold(setting.label)}`);
  console.log(`  ${dim(setting.help)}`);

  if (setting.generate) {
    const generated = await offerGenerate(setting, unset);
    if (generated) return generated;
  }

  if (setting.obtain) {
    console.log(`  ${dim(setting.obtain.instructions)}`);
    if (await confirm(`  Open ${setting.obtain.url}?`, { default: true })) {
      if (!openUrl(setting.obtain.url)) console.log(`  ${dim(setting.obtain.url)}`);
      await pause("  Press Enter once you have the value");
    }
  }

  const value = await promptValue(setting);
  if (value === null) {
    // "left unchanged" is a lie when there was nothing there to leave.
    if (unset && setting.wizard?.required) {
      console.log(`  ${yellow("skipped — you'll need this before deploying")}`);
    } else {
      console.log(`  ${dim("left unchanged")}`);
    }
    return { changed: false };
  }
  await applyToTargets(setting, value);
  if (setting.installHook) await installNotifyHook(value);
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

  // git fails for routine first-time reasons — no user.email, no upstream,
  // a rejected push. None of them undo the writes that already landed, and
  // none of them should cost the user the closing instructions, so report and
  // carry on rather than throwing out of the wizard.
  try {
    await git.commit("src/config.ts", message);
    console.log(`  ${green("✓")} committed`);
  } catch (err) {
    console.log(`  ${red(`✗ couldn't commit — ${gitErrorText(err)}`)}`);
    console.log(`  ${dim("your changes are written to src/config.ts; commit it yourself")}`);
    return;
  }

  if (answer === "1") {
    if (branch !== "main") {
      console.log(
        `  ${yellow(`⚠ you're on '${branch}', not main — this push won't trigger the deploy.`)}`,
      );
      if (!(await confirm("  Push anyway?", { default: false }))) return;
    }
    try {
      await git.push();
      console.log(`  ${green("✓")} pushed`);
    } catch (err) {
      console.log(`  ${red(`✗ couldn't push — ${gitErrorText(err)}`)}`);
      console.log(`  ${dim("the commit is safe on this branch; push it yourself")}`);
    }
  }
}

/** The one line of a git failure worth showing, out of its several. */
export function gitErrorText(err) {
  const lines = `${err?.stderr ?? ""}\n${err?.message ?? ""}`
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.find((l) => /^(fatal|error):/i.test(l)) ?? lines[0] ?? "unknown error";
}

/**
 * One menu row per setting. A setting used to disappear entirely when any one
 * of its surfaces was unreachable, with no message — so on a fresh clone you
 * could see "Entry code" on the status screen and have no way to set it. A
 * partially blocked setting is offered with the caveat spelled out; only a
 * setting with nowhere at all to write is unselectable.
 */
export function menuEntries(report) {
  let n = 0;
  return SETTINGS.map((setting) => {
    const blocked = setting.targets.filter((t) => !report.probes.get(t.surface)?.available);
    const writable = setting.targets.filter((t) => report.probes.get(t.surface)?.available);

    if (blocked.length === 0) {
      return { setting, key: String(++n), label: setting.label };
    }
    const blockedLabels = blocked.map((t) => SURFACES[t.surface].label).join(", ");
    if (writable.length === 0) {
      const reason = report.probes.get(blocked[0].surface)?.reason ?? "unavailable";
      return { setting, key: null, label: `${setting.label}  (${reason})` };
    }
    const writableLabels = writable.map((t) => SURFACES[t.surface].label).join(", ");
    return {
      setting,
      key: String(++n),
      label: `${setting.label}  (${blockedLabels} unavailable — will write ${writableLabels} only)`,
    };
  });
}

export async function runMenu() {
  session.configFileDirtyBefore = await git.isDirty("src/config.ts");

  for (;;) {
    const report = await gather();
    printStatus(report);

    const entries = menuEntries(report);
    const choices = entries.map((e) => ({ key: e.key, label: e.label }));
    choices.push({ key: "q", label: "Quit" });

    const picked = await choose("Change which setting?", choices);
    if (picked === "q") break;
    // By key, not by index — the numbering skips the unselectable rows.
    const chosen = entries.find((e) => e.key === picked);
    if (!chosen) continue;
    const unset = (report.states.get(chosen.setting.id) ?? []).every((s) => !s.present);
    await editSetting(chosen.setting, { unset });
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
    const members = SETTINGS.filter((s) => s.wizard?.step === step.n);
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

      const states = report.states.get(setting.id) ?? [];
      const { text, warning } = describeSetting(setting, states);
      if (text !== "not set") {
        console.log(`\n${bold(setting.label)}  ${dim(text)}`);
        if (warning) console.log(`  ${yellow(`⚠ ${warning}`)}`);
        // A warning means this value is only half-configured, or is something
        // that cannot be right at all (a .env.example placeholder). Re-entering
        // it writes every target, so make that the default rather than "keep".
        if (await confirm("  Keep this?", { default: !warning })) continue;
      }

      const result = await editSetting(setting, { unset: states.every((s) => !s.present) });
      if (result.changed) report = await gather();
    }
  }

  report = await gather();
  await runLiveCheck(report);
  await offerCommit();
  printRemainingSteps(stillMissing(report));
}

/**
 * Every setting the registry marks `required` that this run did not end up
 * with a usable value for. `wizard.required` was declared on seven settings
 * and read nowhere, so a wizard you pressed Enter through claimed success.
 */
export function stillMissing(report) {
  const missing = [];
  for (const setting of SETTINGS) {
    if (!setting.wizard?.required) continue;
    const states = report.states.get(setting.id) ?? [];

    // Only a value we can see the plaintext of can be judged wrong.
    const bad = states.find((s) => s.known && s.present && !setting.validate(s.value).ok);
    if (bad) {
      missing.push({ setting, reason: `looks wrong — ${setting.validate(bad.value).reason}` });
      continue;
    }

    if (states.some((s) => s.present)) continue;

    // Confirmed empty somewhere we could actually look beats "not checked":
    // the user's problem is the missing value, not the missing CLI.
    if (states.some((s) => !s.present && !s.blocked)) {
      missing.push({ setting, reason: "not set" });
      continue;
    }

    const blockedAt = states.findIndex((s) => s.blocked);
    const probe = report.probes.get(setting.targets[blockedAt]?.surface);
    missing.push({ setting, reason: `not checked — ${probe?.reason ?? "unavailable"}` });
  }
  return missing;
}

async function runLiveCheck(report) {
  const url = report.states.get("supabase-url")?.[0];
  const key = report.states.get("supabase-anon-key")?.[0];

  console.log(`\n${bold("Checking the Supabase connection")}`);

  // Only the .env target can yield a plaintext value — the GitHub target
  // always reports known:false — so targets[0] is the right one to read.
  // But say so when it isn't there, rather than returning in silence.
  if (!url?.present || !key?.present) {
    const missing = [!url?.present && "project URL", !key?.present && "anon key"].filter(Boolean);
    console.log(`  ${yellow(`⚠ skipped — no ${missing.join(" or ")} in .env`)}`);
    return;
  }

  const result = await checkSupabase(url.value, key.value);
  if (result.ok === true) console.log(`  ${green("✓")} the URL and anon key work together`);
  else if (result.ok === false) console.log(`  ${red(`✗ ${result.reason}`)}`);
  else console.log(`  ${yellow(`⚠ couldn't check — ${result.reason}`)}`);
}

export function printRemainingSteps(missing = []) {
  if (missing.length > 0) {
    console.log(`\n${bold("Still missing")}`);
    for (const m of missing) {
      console.log(`  ${yellow("•")} ${m.setting.label}  ${dim(m.reason)}`);
    }
    console.log(`  ${dim("Run `npm run config` to fill these in.")}`);
  }

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
// Comparing whole paths, not basenames: the old check compared the last "/"
// segment, which never matched on Windows and matched any other config.mjs.
if (process.argv[1] && import.meta.filename === process.argv[1]) {
  main().catch((err) => {
    console.error(red(`\n${err.message}\n`));
    process.exit(1);
  });
}
