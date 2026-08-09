import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { Writable } from "node:stream";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `[${code}m${s}[0m` : String(s));

export const bold = paint("1");
export const dim = paint("2");
export const red = paint("31");
export const green = paint("32");
export const yellow = paint("33");

function rl() {
  return createInterface({ input: process.stdin, output: process.stdout });
}

export async function ask(question, { default: fallback } = {}) {
  const io = rl();
  try {
    const hint = fallback === undefined ? "" : dim(` [${fallback}]`);
    const answer = (await io.question(`${question}${hint}: `)).trim();
    return answer === "" && fallback !== undefined ? String(fallback) : answer;
  } finally {
    io.close();
  }
}

export async function askSecret(question) {
  // readline has no native echo suppression: write the prompt through a
  // stream we can mute, flip the mute once the question has been printed.
  const state = { muted: false };
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!state.muted) process.stdout.write(chunk, encoding);
      callback();
    },
  });
  const io = createInterface({ input: process.stdin, output, terminal: true });
  try {
    const pending = io.question(`${question}: `);
    state.muted = true;
    const answer = await pending;
    process.stdout.write("\n");
    return answer.trim();
  } finally {
    state.muted = false;
    io.close();
  }
}

export async function confirm(question, { default: fallback = true } = {}) {
  const hint = fallback ? "Y/n" : "y/N";
  const answer = (await ask(`${question} ${dim(`(${hint})`)}`)).toLowerCase();
  if (answer === "") return fallback;
  return answer === "y" || answer === "yes";
}

export async function choose(question, choices) {
  for (;;) {
    console.log();
    for (const c of choices) console.log(`  ${bold(c.key)}) ${c.label}`);
    console.log();
    const answer = (await ask(question)).toLowerCase();
    const hit = choices.find((c) => c.key.toLowerCase() === answer);
    if (hit) return hit.key;
    console.log(red("  Not one of the options."));
  }
}

export async function pause(message = "Press Enter to continue") {
  await ask(dim(message));
}

const OPENERS = { darwin: "open", linux: "xdg-open", win32: "start" };

export function openUrl(url) {
  const command = OPENERS[process.platform];
  if (!command) return false;
  try {
    const { status } = spawnSync(command, [url], { stdio: "ignore" });
    return status === 0;
  } catch {
    return false;
  }
}
