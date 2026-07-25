import type { User } from "../types";

// Guardrails for people management. There is no admin role — anyone signed in
// can change anyone — so these are what stop the group locking itself out.

/**
 * May `actorName` clear `target`'s login switch?
 *
 * No if it is the actor themselves — revoking your own access mid-session is
 * never what you meant. No if the target is the last person who can log in,
 * which would leave recovery to the Supabase SQL editor.
 */
export function canRevokeLogin(target: User, actorName: string, users: User[]): boolean {
  if (target.name === actorName) return false;
  const withLogin = users.filter((u) => u.can_login);
  if (withLogin.length <= 1) return false;
  return true;
}

/**
 * May this person be deleted outright? Only when they hold no shares, so a
 * mistyped name can be cleaned up but real history can never be orphaned.
 * The database enforces this independently via `on delete restrict`; this
 * check exists to produce a sentence instead of a foreign-key error.
 */
export function canDelete(hasShares: boolean): boolean {
  return !hasShares;
}

/** People in stable display order: oldest first, so additions append. */
export function sortPeople(users: User[]): User[] {
  return [...users].sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
}

/**
 * The people the split composer offers, in row order.
 *
 * Only the split switch matters here — someone who eats but never opens the
 * app still belongs in the split, and someone on a break does not.
 */
export function splitMembers(users: User[]): User[] {
  return sortPeople(users.filter((u) => u.in_split));
}
