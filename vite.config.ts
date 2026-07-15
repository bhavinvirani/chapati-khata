import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// If you deploy to GitHub Pages under https://<user>.github.io/<repo>/,
// set VITE_BASE="/<repo>/" at build time. Netlify / Cloudflare / Vercel need no base.
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE ?? "/",
});
