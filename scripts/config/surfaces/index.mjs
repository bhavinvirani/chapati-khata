import * as configFile from "./configFile.mjs";
import * as dotenv from "./dotenv.mjs";
import * as supabase from "./supabase.mjs";
import { repoSurface, envSurface } from "./github.mjs";

export const SURFACES = {
  "config-file": configFile,
  dotenv,
  supabase,
  "github-repo": repoSurface,
  "github-env": envSurface,
};

/** Human sentence for what a change costs, keyed by the surface's effect. */
export const EFFECT_TEXT = {
  "needs-deploy": "takes effect after a commit and push",
  "needs-restart": "restart `npm run dev` to pick it up",
  immediate: "live now",
  "next-deploy": "used by the next deploy",
};
