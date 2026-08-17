// What kind of thing the app is running in. Lifted out of useInstallPrompt so
// the notification opt-in can ask the same questions: on iOS, Web Push works
// only once the app is on the Home Screen, so "installed?" stops being a
// nicety and becomes a prerequisite.

export function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // iOS Safari exposes standalone here instead of via display-mode.
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

export function isIos(): boolean {
  const ua = window.navigator.userAgent;
  const iDevice = /iphone|ipad|ipod/i.test(ua);
  // iPadOS 13+ reports as a Mac; distinguish by touch support.
  const iPadOs = /macintosh/i.test(ua) && navigator.maxTouchPoints > 1;
  return iDevice || iPadOs;
}
