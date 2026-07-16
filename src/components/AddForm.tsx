import { useState } from "react";
import type { Entry } from "../types";
import type { ParsedQty } from "../lib/util";
import { dayLabel, money, parseQty, sanitizeQty, todayStr } from "../lib/util";
import { IcPlus } from "./icons";

interface Props {
  todayEntry: Entry | null;
  curWeekPaid: boolean;
  busy: boolean;
  onAdd: (parsed: ParsedQty, note: string) => Promise<boolean>;
}

export function AddForm({ todayEntry, curWeekPaid, busy, onAdd }: Props) {
  const [qtyRaw, setQtyRaw] = useState("");
  const [noteRaw, setNoteRaw] = useState("");
  const [addErr, setAddErr] = useState("");

  async function handleAdd() {
    setAddErr("");
    if (curWeekPaid) {
      setAddErr("This week is marked paid. Reopen it to add more.");
      return;
    }
    const parsed = parseQty(qtyRaw);
    if (!parsed) {
      setAddErr("Enter a number like 5 (or 50x0.75).");
      return;
    }
    const note = noteRaw.trim().slice(0, 60);
    const ok = await onAdd(parsed, note);
    if (ok) {
      setQtyRaw("");
      setNoteRaw("");
    }
  }

  return (
    <section className="add">
      <div className="add-head">
        <span className="eyebrow">Add today</span>
        <span className="add-date">{dayLabel(todayStr())}</span>
      </div>
      <div className="add-row">
        <input
          className="in qty"
          inputMode="numeric"
          placeholder="How many?"
          value={qtyRaw}
          onChange={(e) => {
            setQtyRaw(sanitizeQty(e.target.value));
            setAddErr("");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleAdd();
          }}
          aria-label="Chapati count"
        />
        <button className="btn btn-solid add-btn" disabled={busy} onClick={handleAdd} aria-label="Add to today">
          <IcPlus className="ic" />
          <span>Add</span>
        </button>
      </div>
      <input
        className="in note"
        placeholder="Note (optional) — e.g. extra for a guest"
        value={noteRaw}
        maxLength={60}
        onChange={(e) => setNoteRaw(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleAdd();
        }}
        aria-label="Optional note"
      />
      {addErr && <div className="add-err">{addErr}</div>}
      {todayEntry && !addErr && (
        <div className="add-hint">
          Today so far &middot; <b>{todayEntry.qty}</b> chapati{todayEntry.qty !== 1 ? "s" : ""} &middot;{" "}
          {money(todayEntry.amount)}
        </div>
      )}
    </section>
  );
}
