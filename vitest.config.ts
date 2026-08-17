import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Needed even for node-environment tests: the root tsconfig.json is
  // solution-style ("files": [] + references), so esbuild can't discover
  // jsx: "react-jsx" on its own and would fall back to the classic runtime.
  plugins: [react()],
  test: {
    environment: "node",
    // supabase/functions/_shared holds plain-TypeScript modules the edge
    // functions import. They have no `Deno.*` in them precisely so they can
    // be tested here instead of being duplicated into src/ to get coverage.
    include: [
      "src/**/*.{test,spec}.{ts,tsx}",
      "scripts/**/*.{test,spec}.mjs",
      "supabase/functions/_shared/*.{test,spec}.ts",
    ],
    // There are no tests yet; vitest exits 1 on "no test files found".
    passWithNoTests: true,
    // weekIdOf / parseYMD / todayStr / dayLabel / stamp are all local-time.
    env: { TZ: "America/Toronto" },
    restoreMocks: true,
  },
});
