import { useCallback, useEffect, useRef, useState } from "react";
import * as push from "../lib/push";
import * as db from "../lib/db";

const DISMISS_KEY = "khata.notifyDismissed";

function wasDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Drives the notification opt-in, for both the banner and the People sheet's
 * toggle. Owned by App and passed to both, so turning notifications on in one
 * place is immediately true in the other.
 *
 * Shaped after useInstallPrompt, and for the same reason: the two questions
 * are the same on iOS. Web Push reaches an iPhone only once the app is on the
 * Home Screen, so `needsHomeScreen` is not an edge case to handle later — it
 * is the first thing the UI has to check before offering a button.
 */
export function usePushNotifications(userName: string | null, deviceId: string) {
  const [supported] = useState(() => push.pushSupported() && push.configured());
  const [needsHomeScreen] = useState(() => push.needsHomeScreen());
  const [permission, setPermission] = useState<NotificationPermission>(() => push.permission());
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(() => wasDismissed());
  const busyRef = useRef(false);

  // What this device already has. Answered by the browser, not the database —
  // there is no read path to push_subscriptions on purpose.
  useEffect(() => {
    if (!supported) return;
    let live = true;
    push
      .currentSubscription()
      .then((sub) => {
        if (live) setEnabled(!!sub);
      })
      .catch(() => {
        /* no worker yet, or storage blocked — treat as not subscribed */
      });
    return () => {
      live = false;
    };
  }, [supported]);

  const enable = useCallback(async (): Promise<boolean> => {
    if (busyRef.current || !userName) return false;
    busyRef.current = true;
    setBusy(true);
    try {
      // Nothing may be awaited before this line. Safari only honours a
      // permission request raised inside the user gesture that started it,
      // and an await hands the gesture back before the prompt is asked for.
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== "granted") return false;

      const keys = await push.subscribe();
      if (!keys) return false;
      await db.savePushSubscription(keys, userName, deviceId);
      setEnabled(true);
      return true;
    } catch {
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [userName, deviceId]);

  const disable = useCallback(async (): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    try {
      // Browser first: once it has unsubscribed, the endpoint is dead
      // whatever happens next, and the sender prunes it on the first 410. So
      // a failed row delete leaves no window where this device still buzzes.
      const endpoint = await push.unsubscribe();
      if (endpoint) await db.deletePushSubscription(endpoint);
      setEnabled(false);
      return true;
    } catch {
      // The browser is unsubscribed either way — reflect that.
      setEnabled(false);
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* storage blocked — session-only dismissal is fine */
    }
  }, []);

  // Nothing to offer when it cannot work, is already on, was refused at the
  // browser level (only site settings can undo that), or was waved away.
  const showBanner = supported && !enabled && !dismissed && permission !== "denied";

  return {
    supported,
    needsHomeScreen,
    permission,
    enabled,
    busy,
    showBanner,
    enable,
    disable,
    dismiss,
  };
}
