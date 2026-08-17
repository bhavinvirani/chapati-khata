import { afterEach, describe, expect, it, vi } from "vitest";
import { needsHomeScreen, permission, pushSupported, urlBase64ToUint8Array } from "./push";

// These run in vitest's node environment, so there is no window/navigator to
// begin with. Each test installs exactly the globals the case is about, which
// is also the honest way to reproduce a browser missing one of them.
const g = globalThis as unknown as Record<string, unknown>;

function setBrowser(opts: {
  serviceWorker?: boolean;
  pushManager?: boolean;
  notification?: NotificationPermission | false;
  ua?: string;
  maxTouchPoints?: number;
  standalone?: boolean;
  displayMode?: boolean;
}) {
  const nav: Record<string, unknown> = {
    userAgent: opts.ua ?? "Mozilla/5.0 (Linux; Android 14) Chrome/126",
    maxTouchPoints: opts.maxTouchPoints ?? 0,
  };
  if (opts.serviceWorker !== false) nav.serviceWorker = {};
  if (opts.standalone) nav.standalone = true;

  const win: Record<string, unknown> = {
    navigator: nav,
    matchMedia: () => ({ matches: !!opts.displayMode }),
  };
  if (opts.pushManager !== false) win.PushManager = class {};
  if (opts.notification !== false) {
    win.Notification = { permission: opts.notification ?? "default" };
    g.Notification = win.Notification;
  }

  g.window = win;
  g.navigator = nav;
}

afterEach(() => {
  delete g.window;
  delete g.navigator;
  delete g.Notification;
  vi.restoreAllMocks();
});

describe("urlBase64ToUint8Array", () => {
  it("decodes a real VAPID public key to the 65 raw bytes subscribe() wants", () => {
    // An uncompressed P-256 point: 0x04 followed by a 32-byte x and y.
    const bytes = new Uint8Array(65);
    bytes[0] = 0x04;
    for (let i = 1; i < 65; i++) bytes[i] = i;
    const base64url = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const decoded = urlBase64ToUint8Array(base64url);
    expect(decoded.length).toBe(65);
    expect(decoded[0]).toBe(0x04);
    expect([...decoded]).toEqual([...bytes]);
  });

  it("restores the padding the base64url form strips", () => {
    // Lengths 1, 2 and 3 exercise the two-, one- and zero-pad cases.
    for (const raw of ["a", "ab", "abc"]) {
      const b64 = btoa(raw).replace(/=+$/, "");
      expect(new TextDecoder().decode(urlBase64ToUint8Array(b64))).toBe(raw);
    }
  });

  it("translates the url-safe alphabet back", () => {
    // 0xfb 0xff encodes as "+/8" in standard base64 and "-_8" in url-safe.
    expect([...urlBase64ToUint8Array("-_8")]).toEqual([...urlBase64ToUint8Array("+/8")]);
  });
});

describe("pushSupported", () => {
  it("is true on a browser with all three pieces", () => {
    setBrowser({});
    expect(pushSupported()).toBe(true);
  });

  it("is false without a service worker", () => {
    setBrowser({ serviceWorker: false });
    expect(pushSupported()).toBe(false);
  });

  it("is false without PushManager — an iOS Safari tab before 16.4", () => {
    setBrowser({ pushManager: false });
    expect(pushSupported()).toBe(false);
  });

  it("is false without the Notification API", () => {
    setBrowser({ notification: false });
    expect(pushSupported()).toBe(false);
  });
});

describe("permission", () => {
  it("reports what the browser says", () => {
    setBrowser({ notification: "granted" });
    expect(permission()).toBe("granted");
  });

  it("reports a denial, which only site settings can undo", () => {
    setBrowser({ notification: "denied" });
    expect(permission()).toBe("denied");
  });

  it("says denied rather than throwing where push cannot work at all", () => {
    setBrowser({ pushManager: false });
    expect(permission()).toBe("denied");
  });
});

describe("needsHomeScreen", () => {
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) Safari";
  const IPAD_OS = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari";
  const ANDROID = "Mozilla/5.0 (Linux; Android 14) Chrome/126";

  it("is true in an iPhone Safari tab — where push silently does nothing", () => {
    setBrowser({ ua: IPHONE });
    expect(needsHomeScreen()).toBe(true);
  });

  it("is false once the iPhone app is on the Home Screen", () => {
    setBrowser({ ua: IPHONE, standalone: true });
    expect(needsHomeScreen()).toBe(false);
  });

  it("is true on iPadOS, which reports itself as a Mac", () => {
    setBrowser({ ua: IPAD_OS, maxTouchPoints: 5 });
    expect(needsHomeScreen()).toBe(true);
  });

  it("is false on a real Mac, touch-free and not iOS", () => {
    setBrowser({ ua: IPAD_OS, maxTouchPoints: 0 });
    expect(needsHomeScreen()).toBe(false);
  });

  it("is false on Android, installed or not", () => {
    setBrowser({ ua: ANDROID });
    expect(needsHomeScreen()).toBe(false);
    setBrowser({ ua: ANDROID, displayMode: true });
    expect(needsHomeScreen()).toBe(false);
  });
});
