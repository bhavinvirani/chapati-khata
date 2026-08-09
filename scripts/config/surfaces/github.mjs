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
    // handler below, and an unhandled stream error would crash the whole
    // script.
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
        return {
          available: false,
          reason: text.trim().split("\n")[0] || "gh secret list failed",
        };
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
