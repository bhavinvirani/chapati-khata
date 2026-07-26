import { useMemo, useState } from "react";
import type { Entry, User } from "../types";
import type { Alloc, ShareInput } from "../lib/split";
import { buildShares, remaining } from "../lib/split";
import { splitMembers } from "../lib/people";
import { DEFAULT_PRICE } from "../config";
import { dayLabel, money, parseQty, round2, sanitizeQty } from "../lib/util";
import { IcTrash, IcX } from "./icons";
import { SplitEditor } from "./SplitEditor";

interface Props {
  entry: Entry;
  users: User[];
  busy: boolean;
  onClose: () => void;
  onSave: (
    entry: Entry,
    input: { qty: number; rate: number; otherQty: number; note: string; shares: ShareInput[] },
  ) => void;
  onDelete: (entry: Entry) => void;
}

export function EditSheet({ entry, users, busy, onClose, onSave, onDelete }: Props) {
  const [qtyRaw, setQtyRaw] = useState(
    entry.rate === DEFAULT_PRICE ? String(entry.qty) : `${entry.qty}x${entry.rate}`,
  );
  const [note, setNote] = useState(entry.note ?? "");
  const [askDel, setAskDel] = useState(false);
  const [rows, setRows] = useState<Alloc>(() => {
    const out: Alloc = {};
    for (const s of entry.entry_shares) out[s.user_id] = s.qty;
    return out;
  });
  const [otherQty, setOtherQty] = useState(entry.other_qty ?? 0);
  // Who covered the guests is recoverable from the rows: a sharer's money is
  // more than their own chapatis cost. No column needed. Falls back to
  // everyone when this add had no guests to attribute.
  const [sharerPick, setSharerPick] = useState<string[] | null>(() => {
    if (!entry.other_qty) return null;
    const covered = entry.entry_shares
      .filter((sh) => sh.amount - round2(sh.qty * entry.rate) > 0.005)
      .map((sh) => sh.user_id);
    return covered.length > 0 ? covered : null;
  });

  // Anyone already in this add stays editable even if their split switch has
  // since been turned off — history is never rewritten by a status change.
  // Derived from the stored shares, not the live `rows`: zeroing someone out
  // must not make their row vanish out from under you mid-edit.
  const members = useMemo(() => {
    const inSplit = splitMembers(users);
    const seen = new Set(inSplit.map((m) => m.id));
    const held = new Set(entry.entry_shares.map((s) => s.user_id));
    return [...inSplit, ...users.filter((u) => !seen.has(u.id) && held.has(u.id))];
  }, [users, entry.entry_shares]);

  // What `rows` actually pays out, restricted to people currently offered.
  //
  // `members` already keeps a deactivated person's row alive when they hold a
  // stored share on this add (see above), so this filter does not drop them —
  // it only catches someone whose `in_split` is cleared by another device
  // while this sheet is open. Without it, `remaining` would count a key whose
  // box has vanished and let the save button write a share for someone the
  // sheet no longer offers, the same billed-invisibly outcome §4.8 forbids.
  // `<SplitEditor>` still gets raw `rows` — it owns and echoes exactly what
  // was typed; only the gate and the write use this.
  const eligible = useMemo(() => {
    const ids = new Set(members.map((m) => m.id));
    return Object.fromEntries(Object.entries(rows).filter(([id]) => ids.has(id)));
  }, [rows, members]);

  const parsed = parseQty(qtyRaw);
  const total = parsed?.qty ?? 0;
  const sharers = useMemo(() => {
    const ids = members.map((m) => m.id);
    return sharerPick === null ? ids : sharerPick.filter((id) => ids.includes(id));
  }, [sharerPick, members]);

  const valid =
    total > 0 &&
    remaining(total, eligible, otherQty) === 0 &&
    (otherQty === 0 || sharers.length > 0);

  return (
    <div className="ovl" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" />
        <div className="sheet-head">
          <h3 className="sheet-t">{dayLabel(entry.day)}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <IcX className="ic" />
          </button>
        </div>

        <label className="fld-l">Total this add</label>
        <input
          className="in"
          inputMode="text"
          value={qtyRaw}
          autoFocus
          onChange={(e) => setQtyRaw(sanitizeQty(e.target.value))}
          aria-label="Chapati count"
        />
        <div className="add-rate">{money(parsed?.price ?? entry.rate)} per chapati</div>

        <label className="fld-l">Who had them</label>
        <SplitEditor
          members={members}
          total={total}
          rows={rows}
          onChange={setRows}
          otherQty={otherQty}
          onOtherChange={setOtherQty}
          otherSharers={sharers}
          onSharersChange={setSharerPick}
          lastAdd={null}
          disabled={busy}
        />

        <label className="fld-l">Note</label>
        <input
          className="in"
          value={note}
          placeholder="Optional"
          onChange={(e) => setNote(e.target.value)}
          aria-label="Note"
        />

        {!askDel ? (
          <div className="sheet-a">
            <button className="btn btn-danger-ghost" onClick={() => setAskDel(true)}>
              <IcTrash className="ic sm" />
              Delete
            </button>
            <button
              className="btn btn-solid"
              disabled={!valid || busy}
              onClick={() =>
                parsed &&
                onSave(entry, {
                  qty: parsed.qty,
                  rate: parsed.price,
                  otherQty,
                  note,
                  shares: buildShares(eligible, parsed.price, otherQty, sharers),
                })
              }
            >
              Save changes
            </button>
          </div>
        ) : (
          <div className="del-confirm">
            <span>Delete this entry? It stays in the log.</span>
            <div className="sheet-a">
              <button className="btn btn-ghost" onClick={() => setAskDel(false)}>
                Keep
              </button>
              <button className="btn btn-danger" disabled={busy} onClick={() => onDelete(entry)}>
                Delete
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
