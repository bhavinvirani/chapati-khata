import { writeFile, rename, stat, chmod } from "node:fs/promises";
import { dirname, basename, join } from "node:path";

/** The existing file's permission bits, or null when it doesn't exist yet. */
async function currentMode(path) {
  try {
    return (await stat(path)).mode & 0o777;
  } catch {
    return null;
  }
}

/**
 * Write via a temp file in the same directory, then rename. A crash or a
 * Ctrl-C can leave the temp file behind, but never a half-written target.
 * Same-directory is required — rename is only atomic within one filesystem.
 */
export async function atomicWrite(path, contents) {
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}`);
  // Renaming a fresh temp file over the target replaces its permissions too,
  // so someone who ran `chmod 600 .env` would silently get 0644 back. chmod
  // rather than writeFile's mode option: that one is ignored when the temp
  // file already exists, and is masked by umask when it doesn't.
  const mode = await currentMode(path);
  await writeFile(tmp, contents, "utf8");
  if (mode !== null) await chmod(tmp, mode);
  await rename(tmp, path);
}
