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
