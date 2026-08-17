/* eslint-disable */
// Imported into the service worker vite-plugin-pwa generates, via
// `workbox.importScripts` in vite.config.ts. Kept as plain JS in public/
// rather than switching the plugin to `injectManifest`, which would mean
// hand-rewriting the precache manifest and the Google Fonts runtime caching
// this app already relies on offline.
//
// Its whole job is the two events the generated worker knows nothing about.

// The app's own URL. `registration.scope` is the directory the worker
// controls, which is exactly Vite's `base` — so this keeps working under the
// GitHub Pages sub-path without the server having to be told what it is.
function appUrl() {
  return self.registration.scope;
}

self.addEventListener("push", (event) => {
  let title = "Chapati Khata";
  let options = { icon: "pwa-192x192.png", badge: "pwa-192x192.png" };

  try {
    const data = event.data.json();
    if (data.title) title = data.title;
    options.body = data.body || "";
    // Two notifications sharing a tag collapse into one, the later replacing
    // the earlier. `renotify` is left at its default false, so the
    // replacement happens silently — which is what turns the several `paid`
    // rows a multi-week Settle All writes into one card and one buzz.
    if (data.tag) options.tag = data.tag;
  } catch {
    // A payload that will not parse still has to show something: the
    // subscription was made with `userVisibleOnly: true`, and a push that
    // shows no notification costs the site its permission.
  }

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = appUrl();

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      // Focus the app if it is already open anywhere rather than opening a
      // second copy of it.
      for (const client of clients) {
        if (client.url.startsWith(url) && "focus" in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    })(),
  );
});
