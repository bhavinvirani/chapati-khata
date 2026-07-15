// A random, local-only id so the log can carry a breadcrumb of which device
// took an action. It is NOT an IP and NOT identity — just a hint that helps
// spot a name used from an unexpected device. Resettable by clearing storage.

const KEY = "khata.device";

export function getDeviceId(): string {
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id =
        (crypto.randomUUID && crypto.randomUUID()) ||
        Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return "unknown";
  }
}
