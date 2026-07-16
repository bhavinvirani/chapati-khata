import { useState } from "react";
import type { Entry, Week } from "../types";
import type { ParsedQty } from "../lib/util";
import { DEFAULT_PRICE } from "../config";
import { dayLabel, money, parseQty, sanitizeQty, todayStr, weekIdOf } from "../lib/util";
import { IcPlus } from "./icons";

interface Props {
  entries: Entry[];
  weeks: Week[];
  busy: boolean;
  onAdd: (parsed: ParsedQty, note: string, date: string) => Promise<boolean>;
}

export function AddForm({ entries, weeks, busy, onAdd }: Props) {
  const [qtyRaw, setQtyRaw] = useState("");
  const [noteRaw, setNoteRaw] = useState("");
  const [addErr, setAddErr] = useState("");
  const [selectedDate, setSelectedDate] = useState(todayStr());

  const isToday = selectedDate === todayStr();
  const weekId = weekIdOf(selectedDate);
  const weekData = weeks.find((w) => w.week_start === weekId);
  const weekPaid = weekData?.paid ?? false;
  const existingEntry = entries.find((e) => e.day === selectedDate) ?? null;

  async function handleAdd() {
    setAddErr("");
    if (weekPaid) {
      setAddErr("This week is marked paid. Reopen it to add more.");
      return;
    }
    const parsed = parseQty(qtyRaw);
    if (!parsed) {
      setAddErr("Enter a number like 5");
      return;
    }
    const note = noteRaw.trim().slice(0, 60);
    const ok = await onAdd(parsed, note, selectedDate);
    if (ok) {
      setQtyRaw("");
      setNoteRaw("");
    }
  }

  return (
    <section className="add">
      <div className="add-head">
        <span className="eyebrow">Add entry</span>
        <div className="add-date-wrap">
          <input
            type="date"
            className="add-date-pick"
            value={selectedDate}
            max={todayStr()}
            onChange={(e) => {
              setSelectedDate(e.target.value || todayStr());
              setAddErr("");
            }}
            aria-label="Entry date"
          />
          {isToday && <span className="add-today-tag">today</span>}
        </div>
      </div>
      <div className="add-row">
        <input
          className="in qty"
          inputMode="text"
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
        <button className="btn btn-solid add-btn" disabled={busy} onClick={handleAdd} aria-label="Add entry">
          <IcPlus className="ic" />
          <span>Add</span>
        </button>
      </div>
      <input
        className="in note"
        placeholder="Note (optional)"
        value={noteRaw}
        maxLength={60}
        onChange={(e) => setNoteRaw(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleAdd();
        }}
        aria-label="Optional note"
      />
      {addErr && <div className="add-err">{addErr}</div>}
      {!addErr && (
        existingEntry ? (
          <div className="add-hint">
            {isToday ? "Today" : dayLabel(selectedDate)} so far &middot; <b>{existingEntry.qty}</b> chapati
            {existingEntry.qty !== 1 ? "s" : ""} &middot; {money(existingEntry.amount)}
          </div>
        ) : (
          <div className="add-rate">{money(DEFAULT_PRICE)} per chapati</div>
        )
      )}
    </section>
  );
}
