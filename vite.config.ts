import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// If you deploy to GitHub Pages under https://<user>.github.io/<repo>/,
// set VITE_BASE="/<repo>/" at build time. Netlify / Cloudflare / Vercel need no base.
export default defineConfig({
  plugins: [
    react(),
    // Progressive Web App: lets the site be installed to the home screen on
    // Android/iOS/desktop and opened as a standalone app. The plugin defaults
    // the manifest's `start_url` and `scope` to Vite's `base`, so this keeps
    // working under the GitHub Pages sub-path (/<repo>/) with no extra config.
    VitePWA({
      registerType: "autoUpdate",
      // Copied into the precache so they resolve offline too. The manifest
      // icons below are precached automatically.
      includeAssets: ["favicon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "Chapati Khata",
        short_name: "Chapati Khata",
        description: "A shared roti tab for the group — chapati orders and weekly settle-up.",
        // Matches the paper background so the Android splash + task-switcher
        // blend with the app instead of flashing white.
        theme_color: "#F8F3E9",
        background_color: "#F8F3E9",
        display: "standalone",
        orientation: "portrait",
        // Relative srcs resolve against the manifest URL, so they land under
        // the base path automatically on GitHub Pages.
        icons: [
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
          {
            src: "maskable-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2}"],
        // Google Fonts are cross-origin, so they are not precached with the
        // app shell — cache them at runtime so the installed app keeps its
        // typography offline after the first load.
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.origin === "https://fonts.googleapis.com",
            handler: "StaleWhileRevalidate",
            options: { cacheName: "google-fonts-stylesheets" },
          },
          {
            urlPattern: ({ url }) => url.origin === "https://fonts.gstatic.com",
            handler: "CacheFirst",
            options: {
              cacheName: "google-fonts-webfonts",
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  base: process.env.VITE_BASE ?? "/",
  server: {
    allowedHosts: [".ngrok-free.app"],
  },
});
