import { useCallback, useEffect, useState } from "react";
import { isIos, isStandalone } from "../lib/platform";

// The event Chromium fires when the app meets the installability criteria.
// Not in the DOM lib types yet, so it's declared here.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISS_KEY = "khata.installDismissed";

function wasDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Drives the "install to home screen" affordance.
 *
 * - Android / desktop Chromium: captures `beforeinstallprompt` and exposes
 *   `promptInstall()` to trigger the native install dialog.
 * - iOS Safari: there is no programmatic prompt, so `iosHint` is true and the
 *   UI shows the manual Share → "Add to Home Screen" steps instead.
 *
 * Returns nothing to show when the app is already installed (standalone) or
 * the user has dismissed the hint before.
 */
export function useInstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(() => wasDismissed());
  const [installed, setInstalled] = useState(() => isStandalone());
  const [ios] = useState(() => isIos());

  useEffect(() => {
    if (installed) return;

    const onBeforeInstall = (e: Event) => {
      // Stop Chrome's default mini-infobar; we show our own affordance.
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, [installed]);

  const promptInstall = useCallback(async () => {
    if (!deferred) return;
    await deferred.prompt();
    const { outcome } = await deferred.userChoice;
    // A one-shot event: once used it can't be reused.
    setDeferred(null);
    if (outcome === "accepted") setInstalled(true);
  }, [deferred]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* storage blocked — session-only dismissal is fine */
    }
  }, []);

  // Something to show only when not installed, not dismissed, and either the
  // native prompt is ready or we're on iOS (manual steps).
  const canPrompt = !!deferred;
  const show = !installed && !dismissed && (canPrompt || ios);

  return { show, canPrompt, ios, promptInstall, dismiss };
}
