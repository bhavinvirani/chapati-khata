import type { Entry, User } from "../types";
import { cap, money, round2 } from "./util";

// Human-readable descriptions of what an add contained, or what changed about
// it, composed at write time and stored on the log row.
//
// Composed here rather than rendered later because the log is a record of what
// happened: names are resolved against the people who existed at the time, and
// a person deleted afterwards still reads as their name rather than "unknown".

/** The shape both `EntryInput` and a stored `Entry` satisfy. */
interface AddLike {
  qty: number;
  rate: number;
  otherQty: number;
  shares: { user_id: string; qty: number }[];
}

const nameOf = (users: User[], id: string) =>
  cap(users.find((u) => u.id === id)?.name ?? "someone");

/** "bhavin 7 · deven 5", in the order the shares were written. */
function whoAte(shares: { user_id: string; qty: number }[], users: User[]): string {
  const eaten = shares.filter((s) => s.qty > 0);
  if (eaten.length === 0) return "";
  return eaten.map((s) => `${nameOf(users, s.user_id)} ${s.qty}`).join(" · ");
}

/** Turn a stored entry into the shape the describers work on. */
export function asAdd(entry: Entry): AddLike {
  return {
    qty: entry.qty,
    rate: entry.rate,
    otherQty: entry.other_qty ?? 0,
    shares: (entry.entry_shares ?? []).map((s) => ({ user_id: s.user_id, qty: s.qty })),
  };
}

/** What an add contained: "21 @ $0.50 · bhavin 7 · deven 14 · guests 5". */
export function describeAdd(add: AddLike, users: User[]): string {
  const parts = [`${add.qty} @ ${money(add.rate)}`];
  const ate = whoAte(add.shares, users);
  if (ate) parts.push(ate);
  if (add.otherQty > 0) parts.push(`guests ${add.otherQty}`);
  return parts.join(" · ");
}

/**
 * What actually changed, and nothing that didn't.
 *
 * A rate-only edit used to read as a bare "edited Wed Jul 15", because the log
 * only carried quantities and the quantity had not moved. Every field that can
 * change now gets named, including a person joining or leaving the split.
 */
export function describeEdit(before: AddLike, after: AddLike, users: User[]): string {
  const parts: string[] = [];
  if (before.qty !== after.qty) parts.push(`total ${before.qty} → ${after.qty}`);
  if (round2(before.rate) !== round2(after.rate)) {
    parts.push(`rate ${money(before.rate)} → ${money(after.rate)}`);
  }
  if (before.otherQty !== after.otherQty) {
    parts.push(`guests ${before.otherQty} → ${after.otherQty}`);
  }

  const was = new Map(before.shares.map((s) => [s.user_id, s.qty]));
  const now = new Map(after.shares.map((s) => [s.user_id, s.qty]));
  for (const id of new Set([...was.keys(), ...now.keys()])) {
    const a = was.get(id) ?? 0;
    const b = now.get(id) ?? 0;
    if (a === b) continue;
    // An em dash rather than 0 for "not in this add": somebody who took
    // nothing but covered guests is a real row, and reads differently from
    // somebody who was not part of it at all.
    parts.push(`${nameOf(users, id)} ${a || "—"} → ${b || "—"}`);
  }

  return parts.length > 0 ? parts.join(" · ") : "no change";
}
