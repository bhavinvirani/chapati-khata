import { useState } from "react";
import type { Entry } from "../types";
import { dayLabel } from "../lib/util";
import { IcTrash, IcX } from "./icons";

interface Props {
  entry: Entry;
  busy: boolean;
  onClose: () => void;
  onSave: (entry: Entry, qty: number, note: string) => void;
  onDelete: (entry: Entry) => void;
}

export function EditSheet({ entry, busy, onClose, onSave, onDelete }: Props) {
  const [q, setQ] = useState(String(entry.qty));
  const [note, setNote] = useState(entry.note ?? "");
  const [askDel, setAskDel] = useState(false);

  const n = parseInt(q, 10);
  const valid = /^\d+$/.test(q) && n > 0;

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

        <label className="fld-l">Chapatis this day</label>
        <input
          className="in"
          inputMode="numeric"
          value={q}
          autoFocus
          onChange={(e) => setQ(e.target.value.replace(/[^0-9]/g, ""))}
          aria-label="Chapati count"
        />
        <label className="fld-l">Note</label>
        <input
          className="in"
          value={note}
          maxLength={60}
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
            <button className="btn btn-solid" disabled={!valid || busy} onClick={() => onSave(entry, n, note)}>
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
