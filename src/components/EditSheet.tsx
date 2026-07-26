import { useMemo, useState } from "react";
import type { Entry, User } from "../types";
import type { Alloc, ShareInput } from "../lib/split";
import { buildShares, remaining } from "../lib/split";
import { splitMembers } from "../lib/people";
import { DEFAULT_PRICE } from "../config";
import { dayLabel, money, parseQty, sanitizeQty } from "../lib/util";
import { IcTrash, IcX } from "./icons";
import { SplitEditor } from "./SplitEditor";

interface Props {
  entry: Entry;
  users: User[];
  busy: boolean;
  onClose: () => void;
  onSave: (
    entry: Entry,
    input: { qty: number; rate: number; note: string; shares: ShareInput[] },
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

  const parsed = parseQty(qtyRaw);
  const total = parsed?.qty ?? 0;
  const valid = total > 0 && remaining(total, rows) === 0;

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
                  note,
                  shares: buildShares(rows, parsed.price),
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
