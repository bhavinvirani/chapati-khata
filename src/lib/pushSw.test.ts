import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

// public/push-sw.js is plain JS imported into the generated service worker at
// runtime, so nothing else in the build ever type-checks or exercises it — and
// a service worker is the hardest place in this app to debug by hand. It only
// ever touches `self`, so it can be run here against a fake one.
//
// It lives in public/ (Vite copies that directory verbatim), which is why this
// test sits in src/ instead of beside it: a test file next to it would be
// copied into dist/ and shipped.

const source = readFileSync(
  fileURLToPath(new URL("../../public/push-sw.js", import.meta.url)),
  "utf8",
);

const SCOPE = "https://user.github.io/chapati-khata/";

interface Listeners {
  push?: (e: unknown) => void;
  notificationclick?: (e: unknown) => void;
}

function loadWorker(clients: { url: string; focus: () => unknown }[] = []) {
  const listeners: Listeners = {};
  // Typed with their real parameters so `mock.calls[n][1]` is the options
  // object rather than an empty tuple.
  const showNotification = vi.fn((_title: string, _options: Record<string, unknown>) =>
    Promise.resolve(),
  );
  const openWindow = vi.fn((_url: string) => Promise.resolve(null));

  const self = {
    addEventListener: (name: keyof Listeners, fn: (e: unknown) => void) => {
      listeners[name] = fn;
    },
    registration: { scope: SCOPE, showNotification },
    clients: {
      matchAll: () => Promise.resolve(clients),
      openWindow,
    },
  };

  new Function("self", source)(self);
  return { listeners, showNotification, openWindow };
}

/** Stands in for the PushEvent, capturing what the handler waits on. */
function pushEvent(payload: unknown) {
  const waits: Promise<unknown>[] = [];
  return {
    event: {
      data: {
        json: () => {
          if (payload === undefined) throw new SyntaxError("no payload");
          return payload;
        },
      },
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    },
    settled: () => Promise.all(waits),
  };
}

describe("push-sw.js", () => {
  beforeEach(() => vi.restoreAllMocks());

  describe("push", () => {
    it("shows what the sender composed", async () => {
      const w = loadWorker();
      const { event, settled } = pushEvent({
        title: "Deven added 21 chapatis",
        body: "Wed Aug 12",
        tag: "add:log-1",
      });
      w.listeners.push?.(event);
      await settled();

      expect(w.showNotification).toHaveBeenCalledTimes(1);
      const [title, options] = w.showNotification.mock.calls[0];
      expect(title).toBe("Deven added 21 chapatis");
      expect(options.body).toBe("Wed Aug 12");
      expect(options.tag).toBe("add:log-1");
    });

    it("passes the tag through, which is what collapses a Settle All", async () => {
      const w = loadWorker();
      for (const week of ["Jul 27 – Aug 2", "Aug 3 – 9", "Aug 10 – 16"]) {
        const { event, settled } = pushEvent({
          title: "Bhavin settled the khata",
          body: week,
          tag: "paid:bhavin",
        });
        w.listeners.push?.(event);
        await settled();
      }
      const tags = w.showNotification.mock.calls.map((c) => c[1].tag as string);
      // Three sends, one tag — the OS replaces rather than stacks.
      expect(tags).toEqual(["paid:bhavin", "paid:bhavin", "paid:bhavin"]);
    });

    it("never leaves renotify on, which would re-buzz for each replacement", async () => {
      const w = loadWorker();
      const { event, settled } = pushEvent({ title: "t", body: "b", tag: "paid:deven" });
      w.listeners.push?.(event);
      await settled();
      expect(w.showNotification.mock.calls[0][1].renotify).toBe(undefined);
    });

    it("still shows something when the payload will not parse", async () => {
      // userVisibleOnly: true means a push that shows nothing costs the site
      // its permission — so an unreadable payload must not mean silence.
      const w = loadWorker();
      const { event, settled } = pushEvent(undefined);
      w.listeners.push?.(event);
      await settled();
      expect(w.showNotification).toHaveBeenCalledTimes(1);
      expect(w.showNotification.mock.calls[0][0]).toBe("Chapati Khata");
    });

    it("always carries an icon so the card is recognisable", async () => {
      const w = loadWorker();
      const { event, settled } = pushEvent({ title: "t", body: "b" });
      w.listeners.push?.(event);
      await settled();
      expect(w.showNotification.mock.calls[0][1].icon).toBeTruthy();
    });
  });

  describe("notificationclick", () => {
    function clickEvent() {
      const waits: Promise<unknown>[] = [];
      const close = vi.fn();
      return {
        close,
        event: {
          notification: { close },
          waitUntil: (p: Promise<unknown>) => waits.push(p),
        },
        settled: () => Promise.all(waits),
      };
    }

    it("focuses the app when it is already open, rather than opening a second copy", async () => {
      const focus = vi.fn();
      const w = loadWorker([{ url: `${SCOPE}#ledger`, focus }]);
      const c = clickEvent();
      w.listeners.notificationclick?.(c.event);
      await c.settled();

      expect(focus).toHaveBeenCalled();
      expect(w.openWindow).not.toHaveBeenCalled();
    });

    it("opens the app at its own scope when nothing is open", async () => {
      const w = loadWorker([]);
      const c = clickEvent();
      w.listeners.notificationclick?.(c.event);
      await c.settled();

      // Derived from registration.scope, so it lands on the GitHub Pages
      // sub-path without the sender having to know what it is.
      expect(w.openWindow).toHaveBeenCalledWith(SCOPE);
    });

    it("ignores an unrelated window on the same origin", async () => {
      const focus = vi.fn();
      const w = loadWorker([{ url: "https://user.github.io/other-app/", focus }]);
      const c = clickEvent();
      w.listeners.notificationclick?.(c.event);
      await c.settled();

      expect(focus).not.toHaveBeenCalled();
      expect(w.openWindow).toHaveBeenCalledWith(SCOPE);
    });

    it("dismisses the notification it was opened from", async () => {
      const w = loadWorker([]);
      const c = clickEvent();
      w.listeners.notificationclick?.(c.event);
      await c.settled();
      expect(c.close).toHaveBeenCalled();
    });
  });
});
