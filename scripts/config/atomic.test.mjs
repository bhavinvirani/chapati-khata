import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, stat, chmod, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWrite } from "./atomic.mjs";

let dir;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "chapati-atomic-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("atomicWrite", () => {
  it("creates a file that does not exist yet", async () => {
    const file = join(dir, ".env");
    await atomicWrite(file, "A=1\n");
    expect(await readFile(file, "utf8")).toBe("A=1\n");
  });

  it("replaces the contents of an existing file", async () => {
    const file = join(dir, ".env");
    await writeFile(file, "A=1\n");
    await atomicWrite(file, "A=2\n");
    expect(await readFile(file, "utf8")).toBe("A=2\n");
  });

  it("keeps the permissions the user chose", async () => {
    // Someone who ran `chmod 600 .env` silently got 0644 back on the next
    // write, because rename replaces the target's mode along with its bytes.
    const file = join(dir, ".env");
    await writeFile(file, "A=1\n");
    await chmod(file, 0o600);
    await atomicWrite(file, "A=2\n");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("leaves no temp file behind", async () => {
    const file = join(dir, ".env");
    await atomicWrite(file, "A=1\n");
    expect(await readdir(dir)).toEqual([".env"]);
  });
});
