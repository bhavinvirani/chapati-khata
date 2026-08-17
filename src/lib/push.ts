import { isIos, isStandalone } from "./platform";

// The browser half of push notifications: capability checks, the VAPID key
// encoding, and subscribe/unsubscribe. Everything that talks to the service
// worker lives here; db.ts stores what this produces, and the UI renders off
// usePushNotifications.

const PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY;

/** What the sender needs to reach one device. Exactly the browser's own
 * `PushSubscription.toJSON()`, flattened. */
export interface PushKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * `applicationServerKey` wants the raw 65-byte P-256 point, not the base64url
 * text the key is stored and shipped as.
 */
export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Does this browser have the three pieces Web Push needs at all? */
export function pushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/**
 * True when this is an iPhone or iPad that has not been added to the Home
 * Screen. Apple exposes push only to installed web apps, so asking for
 * permission here does nothing — the UI has to teach the install step first.
 */
export function needsHomeScreen(): boolean {
  return isIos() && !isStandalone();
}

/** Whether a public key was built into this bundle at all. */
export function configured(): boolean {
  return !!PUBLIC_KEY;
}

export function permission(): NotificationPermission {
  if (!pushSupported()) return "denied";
  return Notification.permission;
}

/**
 * The active service worker registration, or null.
 *
 * `navigator.serviceWorker.ready` never settles when nothing is registered —
 * which is the case under `npm run dev`, where the PWA plugin installs no
 * worker — so it is raced against a timeout rather than awaited bare. At boot
 * in production `getRegistration()` may briefly resolve undefined while the
 * injected `registerSW.js` is still running, which is what `ready` covers.
 */
async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null;
  try {
    const existing = await navigator.serviceWorker.getRegistration();
    if (existing) return existing;
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
    ]);
  } catch {
    return null;
  }
}

function toKeys(sub: PushSubscription): PushKeys | null {
  const json = sub.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !p256dh || !auth) return null;
  return { endpoint: json.endpoint, p256dh, auth };
}

/** This device's subscription, if it has one. Local and offline-safe — the
 * app never asks the database whether it is subscribed. */
export async function currentSubscription(): Promise<PushKeys | null> {
  const reg = await registration();
  if (!reg) return null;
  const sub = await reg.pushManager.getSubscription();
  return sub ? toKeys(sub) : null;
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  if (x.length !== b.length) return false;
  return x.every((byte, i) => byte === b[i]);
}

/**
 * Subscribe this device, reusing an existing subscription where possible.
 *
 * A subscription is bound to the VAPID key it was made with, so one left over
 * from a previous keypair can never be pushed to and cannot simply be reused
 * — `subscribe` would reject it. Drop it and make a fresh one instead, so
 * rotating the keypair does not mean asking everyone to clear site data.
 *
 * Assumes permission has already been granted by the caller, inside the click
 * that started it.
 */
export async function subscribe(): Promise<PushKeys | null> {
  if (!PUBLIC_KEY) return null;
  const reg = await registration();
  if (!reg) return null;

  const key = urlBase64ToUint8Array(PUBLIC_KEY);
  const existing = await reg.pushManager.getSubscription();
  if (existing) {
    if (sameKey(existing.options?.applicationServerKey, key)) return toKeys(existing);
    await existing.unsubscribe();
  }

  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: key as BufferSource,
  });
  return toKeys(sub);
}

/**
 * Unsubscribe this device. Returns the endpoint that was dropped so the
 * caller can delete its row, or null if there was nothing subscribed.
 */
export async function unsubscribe(): Promise<string | null> {
  const reg = await registration();
  if (!reg) return null;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return null;
  const { endpoint } = sub;
  await sub.unsubscribe();
  return endpoint;
}
