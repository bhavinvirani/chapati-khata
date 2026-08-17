import { describe, it, expect } from "vitest";
import {
  installFailureHelp,
  notifyUrl,
  parseProjectRef,
  pickServiceKey,
  restHeaders,
} from "./hook.mjs";

describe("pickServiceKey", () => {
  const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.sig";

  it("finds a legacy service_role key", () => {
    expect(
      pickServiceKey([
        { name: "anon", api_key: "eyJhbm9u.x.y" },
        { name: "service_role", api_key: JWT },
      ]),
    ).toBe(JWT);
  });

  it("never mistakes the anon key for a service key", () => {
    // The anon key ships in the browser; using it here would fail the RPC
    // with a permission error that reads like a bug in the migration.
    expect(pickServiceKey([{ name: "anon", api_key: "eyJhbm9u.x.y" }])).toBeNull();
    expect(pickServiceKey([{ name: "publishable", api_key: "sb_publishable_abc" }])).toBeNull();
  });

  it("finds a new-model secret key by prefix, whatever it is named", () => {
    expect(
      pickServiceKey([
        { name: "default", api_key: "sb_publishable_abc" },
        { name: "automations", api_key: "sb_secret_xyz" },
      ]),
    ).toBe("sb_secret_xyz");
  });

  it("prefers the legacy key when a project carries both", () => {
    expect(
      pickServiceKey([
        { name: "default", api_key: "sb_secret_xyz" },
        { name: "service_role", api_key: JWT },
      ]),
    ).toBe(JWT);
  });

  it("falls back to whatever the payload calls a secret", () => {
    expect(pickServiceKey([{ name: "odd", type: "secret", api_key: "k" }])).toBe("k");
  });

  it("reads the field however the CLI spells it", () => {
    expect(pickServiceKey([{ name: "service_role", apiKey: JWT }])).toBe(JWT);
    expect(pickServiceKey([{ name: "service_role", key: JWT }])).toBe(JWT);
  });

  it("returns null rather than throwing on a shape it does not know", () => {
    for (const payload of [null, undefined, {}, [], "nope", [{ name: "service_role" }]]) {
      expect(pickServiceKey(payload)).toBeNull();
    }
  });
});

describe("restHeaders", () => {
  it("sends a legacy JWT on both headers, as every Supabase client does", () => {
    const h = restHeaders("eyJhbGciOiJIUzI1NiJ9.body.sig");
    expect(h.apikey).toBe("eyJhbGciOiJIUzI1NiJ9.body.sig");
    expect(h.Authorization).toBe("Bearer eyJhbGciOiJIUzI1NiJ9.body.sig");
  });

  it("keeps a new-model secret key off Authorization", () => {
    // It is not a JWT: as a bearer token the platform tries to parse it as
    // one and rejects the request outright.
    const h = restHeaders("sb_secret_xyz");
    expect(h.apikey).toBe("sb_secret_xyz");
    expect(h.Authorization).toBeUndefined();
  });

  it("always asks for JSON", () => {
    expect(restHeaders("k")["Content-Type"]).toBe("application/json");
  });
});

describe("parseProjectRef", () => {
  it("reads the ref the CLI links with", () => {
    expect(parseProjectRef('project_id = "ruolemziparsvotdzbzw"\n\n[functions.notify]\n')).toBe(
      "ruolemziparsvotdzbzw",
    );
  });

  it("tolerates whitespace", () => {
    expect(parseProjectRef('  project_id   =  "abc123"')).toBe("abc123");
  });

  it("returns null when there is nothing to read", () => {
    expect(parseProjectRef("[functions.notify]\nenabled = true")).toBeNull();
    expect(parseProjectRef("")).toBeNull();
    expect(parseProjectRef(null)).toBeNull();
  });
});

describe("notifyUrl", () => {
  it("derives the endpoint so it never has to be typed", () => {
    expect(notifyUrl("https://abc.supabase.co")).toBe(
      "https://abc.supabase.co/functions/v1/notify",
    );
  });

  it("does not double the slash on a trailing one", () => {
    expect(notifyUrl("https://abc.supabase.co/")).toBe(
      "https://abc.supabase.co/functions/v1/notify",
    );
  });

  it("returns null with no project url to build from", () => {
    expect(notifyUrl(undefined)).toBeNull();
    expect(notifyUrl("")).toBeNull();
  });
});

describe("installFailureHelp", () => {
  it.each([
    ["no-url", /Supabase project URL/],
    ["no-ref", /supabase link/],
    ["no-key", /supabase login/],
    ["not-found", /deploy the migration/],
    ["forbidden", /api-keys/],
  ])("names the next command for %s", (kind, pattern) => {
    expect(installFailureHelp(kind)).toMatch(pattern);
  });

  it("passes an unexpected error through rather than swallowing it", () => {
    expect(installFailureHelp("other", "HTTP 502")).toBe("HTTP 502");
  });

  it("never returns nothing", () => {
    expect(installFailureHelp("other")).toBeTruthy();
    expect(installFailureHelp("unheard-of")).toBeTruthy();
  });
});
