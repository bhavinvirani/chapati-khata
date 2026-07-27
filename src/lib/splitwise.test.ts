import { describe, expect, it } from "vitest";
import type { PersonTotal } from "./aggregate";
import type { User } from "../types";
import {
  buildSplitwisePeople,
  missingSplitwiseLinks,
  normalizeEmail,
  settlementDateRange,
  settlementLabel,
} from "./splitwise";

function user(over: Partial<User> = {}): User {
  return {
    id: "u1",
    name: "bhavin",
    in_split: true,
    can_login: true,
    created_at: "2026-01-01T00:00:00Z",
    splitwise_email: null,
    splitwise_user_id: null,
    ...over,
  };
}

function total(userId: string, qty: number, amount: number): PersonTotal {
  return { userId, qty, amount };
}

describe("settlementLabel", () => {
  it("labels a single week", () => {
    expect(settlementLabel(["2026-07-06"])).toBe("Roti Jul 6 – 12");
  });

  it("spans from the earliest week's Monday to the latest week's Sunday", () => {
    expect(settlementLabel(["2026-07-13", "2026-07-06"])).toBe("Roti Jul 6 – 19");
  });

  it("shows the year only when the span crosses one", () => {
    expect(settlementLabel(["2025-12-29", "2026-01-05"])).toBe("Roti Dec 29, 2025 – Jan 11, 2026");
  });
});

describe("settlementDateRange", () => {
  it("has no 'Roti' prefix, unlike settlementLabel", () => {
    expect(settlementDateRange(["2026-07-06"])).toBe("Jul 6 – 12");
  });

  it("spans from the earliest week's Monday to the latest week's Sunday", () => {
    expect(settlementDateRange(["2026-07-13", "2026-07-06"])).toBe("Jul 6 – 19");
  });
});

describe("normalizeEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmail("  Bhavin@Example.com  ")).toBe("bhavin@example.com");
  });
});

describe("missingSplitwiseLinks", () => {
  it("is empty when everyone with a share has an email", () => {
    const users = [user({ id: "u1", splitwise_email: "b@x.com" })];
    expect(missingSplitwiseLinks([total("u1", 5, 2.5)], users)).toEqual([]);
  });

  it("names whoever has a share but no saved email", () => {
    const users = [user({ id: "u1", name: "deven", splitwise_email: null })];
    expect(missingSplitwiseLinks([total("u1", 5, 2.5)], users)).toEqual(["Deven"]);
  });
});

describe("buildSplitwisePeople", () => {
  it("returns null when anyone with a share is unlinked", () => {
    const users = [user({ id: "u1", splitwise_email: null })];
    expect(buildSplitwisePeople([total("u1", 5, 2.5)], users)).toBeNull();
  });

  it("maps totals to the edge function's people shape when everyone is linked", () => {
    const users = [user({ id: "u1", name: "bhavin", splitwise_email: "b@x.com" })];
    expect(buildSplitwisePeople([total("u1", 5, 2.5)], users)).toEqual([
      { name: "bhavin", email: "b@x.com", qty: 5, amount: 2.5 },
    ]);
  });
});
