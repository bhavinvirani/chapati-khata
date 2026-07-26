import { describe, expect, it } from "vitest";
import type { User } from "../types";
import { canDelete, canDeletePerson, canRevokeLogin, sortPeople, splitMembers } from "./people";

function user(name: string, over: Partial<User> = {}): User {
  return {
    id: `id-${name}`,
    name,
    in_split: true,
    can_login: true,
    created_at: "2026-07-01T00:00:00Z",
    ...over,
  };
}

describe("canRevokeLogin", () => {
  it("allows revoking someone else when others can still log in", () => {
    const users = [user("bhavin"), user("deven"), user("parth")];
    expect(canRevokeLogin(users[1], "bhavin", users)).toBe(true);
  });

  it("refuses to let you revoke your own access", () => {
    const users = [user("bhavin"), user("deven")];
    expect(canRevokeLogin(users[0], "bhavin", users)).toBe(false);
  });

  it("refuses to revoke the last person who can log in", () => {
    const users = [user("bhavin"), user("deven", { can_login: false })];
    expect(canRevokeLogin(users[0], "deven", users)).toBe(false);
  });

  it("ignores people who already cannot log in when counting", () => {
    const users = [
      user("bhavin"),
      user("deven"),
      user("parth", { can_login: false }),
      user("samir", { can_login: false }),
    ];
    expect(canRevokeLogin(users[0], "deven", users)).toBe(true);
  });
});

describe("canDelete", () => {
  it("allows deleting a person who holds no shares", () => {
    expect(canDelete(false)).toBe(true);
  });

  it("refuses to delete a person who appears in history", () => {
    expect(canDelete(true)).toBe(false);
  });
});

describe("canDeletePerson", () => {
  // This is the composition PeopleSheet got wrong once: the delete path
  // checked only canDelete and missed the login guardrails entirely. These
  // cases pin down that both are enforced together, not just each alone.

  it("refuses a share-holder, regardless of login state", () => {
    const users = [user("bhavin"), user("deven"), user("parth")];
    expect(canDeletePerson(users[1], "bhavin", users, true)).toBe(false);
  });

  it("refuses the actor themselves even when they hold no shares", () => {
    const users = [user("bhavin"), user("deven")];
    expect(canDeletePerson(users[0], "bhavin", users, false)).toBe(false);
  });

  it("refuses the last login-holder even when they hold no shares", () => {
    const users = [user("bhavin"), user("deven", { can_login: false })];
    expect(canDeletePerson(users[0], "deven", users, false)).toBe(false);
  });

  it("allows deleting a person who cannot log in and holds no shares", () => {
    const users = [user("bhavin"), user("samir", { can_login: false })];
    expect(canDeletePerson(users[1], "bhavin", users, false)).toBe(true);
  });

  it("allows deleting an ordinary, non-last, non-self login-holder with no shares", () => {
    const users = [user("bhavin"), user("deven"), user("parth")];
    expect(canDeletePerson(users[1], "bhavin", users, false)).toBe(true);
  });
});

describe("sortPeople", () => {
  it("orders by when they were added, so new people append at the bottom", () => {
    const users = [
      user("parth", { created_at: "2026-07-03T00:00:00Z" }),
      user("bhavin", { created_at: "2026-07-01T00:00:00Z" }),
      user("deven", { created_at: "2026-07-02T00:00:00Z" }),
    ];
    expect(sortPeople(users).map((u) => u.name)).toEqual(["bhavin", "deven", "parth"]);
  });

  it("does not mutate its input", () => {
    const users = [
      user("parth", { created_at: "2026-07-03T00:00:00Z" }),
      user("bhavin", { created_at: "2026-07-01T00:00:00Z" }),
    ];
    sortPeople(users);
    expect(users[0].name).toBe("parth");
  });

  // The seed inserts everyone in one statement, so every seeded person shares
  // a created_at. This is the normal case for the first seven people, not an
  // edge case, and without a tiebreak their order would be unspecified.
  it("falls back to name when timestamps tie, as the seeded people do", () => {
    const users = [user("samir"), user("abhishek"), user("deven")];
    expect(sortPeople(users).map((u) => u.name)).toEqual(["abhishek", "deven", "samir"]);
  });
});

describe("splitMembers", () => {
  it("offers only people whose split switch is on", () => {
    const users = [user("bhavin"), user("deven", { in_split: false }), user("parth")];
    expect(splitMembers(users).map((u) => u.name)).toEqual(["bhavin", "parth"]);
  });

  it("keeps someone who cannot log in but still eats", () => {
    const users = [user("bhavin"), user("samir", { can_login: false })];
    expect(splitMembers(users).map((u) => u.name)).toEqual(["bhavin", "samir"]);
  });

  it("returns them in row order", () => {
    const users = [
      user("parth", { created_at: "2026-07-03T00:00:00Z" }),
      user("bhavin", { created_at: "2026-07-01T00:00:00Z" }),
    ];
    expect(splitMembers(users).map((u) => u.name)).toEqual(["bhavin", "parth"]);
  });
});
