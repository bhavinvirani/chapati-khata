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
