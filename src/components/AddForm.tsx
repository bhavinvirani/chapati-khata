import { useEffect, useMemo, useRef, useState } from "react";
import type { Entry, User, Week } from "../types";
import type { Alloc, ShareInput } from "../lib/split";
import { buildShares, remaining } from "../lib/split";
import { splitMembers } from "../lib/people";
import { DEFAULT_PRICE } from "../config";
import { dayLabel, money, parseQty, sanitizeQty, todayStr, weekIdOf } from "../lib/util";
import { IcPlus } from "./icons";
import { SplitEditor } from "./SplitEditor";

interface Props {
  entries: Entry[];
  weeks: Week[];
  users: User[];
  busy: boolean;
  onAdd: (
    input: { qty: number; rate: number; note: string; shares: ShareInput[] },
    date: string,
  ) => Promise<boolean>;
}

export function AddForm({ entries, weeks, users, busy, onAdd }: Props) {
  const [qtyRaw, setQtyRaw] = useState("");
  const [noteRaw, setNoteRaw] = useState("");
  const [addErr, setAddErr] = useState("");
  const [rows, setRows] = useState<Alloc>({});
  const today = todayStr();
  const [selectedDate, setSelectedDate] = useState(today);

  const isToday = selectedDate === today;
  const members = useMemo(() => splitMembers(users), [users]);
  const parsed = useMemo(() => parseQty(qtyRaw), [qtyRaw]);
  const total = parsed?.qty ?? 0;

  const { weekPaid, dayAdds } = useMemo(() => {
    const wid = weekIdOf(selectedDate);
    return {
      weekPaid: weeks.find((w) => w.week_start === wid)?.paid ?? false,
      dayAdds: entries.filter((e) => e.day === selectedDate),
    };
  }, [selectedDate, weeks, entries]);

  // Numbers from the most recent add anywhere, for the "Same as last" fill.
  //
  // Filtered to people currently in the split, which §4.8 requires. An
  // unfiltered version is worse than it looks: a person toggled out since the
  // last add gets an allocation with no box on screen, and because the
  // remainder counts every key it still reads "All allocated" — so they are
  // billed invisibly. Retype the visible boxes to the total instead and the
  // form deadlocks at "over-allocated" with no box that can correct it.
  const lastAdd = useMemo(() => {
    const latest = [...entries].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (!latest) return null;
    const eligible = new Set(members.map((m) => m.id));
    const out: Alloc = {};
    for (const s of latest.entry_shares) {
      if (eligible.has(s.user_id)) out[s.user_id] = s.qty;
    }
    return Object.keys(out).length > 0 ? out : null;
  }, [entries, members]);

  // Prefill only on a day's first add. A same-day top-up starts blank: the
  // morning's 45-across-seven is the wrong shape for an evening 20-across-two.
  //
  // The ref primes at most once per date. Without it, the realtime refresh that
  // follows every change anywhere would wipe an allocation as you were typing
  // it — and on first paint there is no data to prime from yet.
  const primedFor = useRef<string | null>(null);
  useEffect(() => {
    if (primedFor.current === selectedDate) return;
    if (users.length === 0) return; // nothing loaded yet
    primedFor.current = selectedDate;
    // This is the one-time-per-date prime described above, guarded by the ref
    // so it fires at most once per `selectedDate` rather than on every render.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional
    setRows(dayAdds.length === 0 && lastAdd ? { ...lastAdd } : {});
  }, [selectedDate, users.length, dayAdds.length, lastAdd]);

  // What `rows` actually pays out, restricted to people currently offered.
  //
  // `rows` itself is never re-filtered as `members` changes, so if another
  // device clears someone's `in_split` while this form is open, realtime
  // updates `members` and their box disappears — but their key lingers in
  // `rows`. Gating and writing off `rows` directly would let `remaining` read
  // "All allocated" while the visible boxes sum to less than the total, and
  // then write a share for someone the form no longer offers: the same
  // billed-invisibly outcome §4.8 forbids, reached by concurrency instead of
  // prefill. `<SplitEditor>` still gets raw `rows` — it owns and echoes
  // exactly what was typed; only the gate and the write use this.
  const eligible = useMemo(() => {
    const ids = new Set(members.map((m) => m.id));
    return Object.fromEntries(Object.entries(rows).filter(([id]) => ids.has(id)));
  }, [rows, members]);

  const left = remaining(total, eligible);
  const canAdd = total > 0 && left === 0 && !busy;
  const dayQty = dayAdds.reduce((sum, e) => sum + e.qty, 0);
  const dayAmount = dayAdds.reduce((sum, e) => sum + e.amount, 0);

  async function handleAdd() {
    setAddErr("");
    if (weekPaid) {
      setAddErr("This week is marked paid. Reopen it to add more.");
      return;
    }
    if (!parsed) {
      setAddErr("Enter a number like 5");
      return;
    }
    const shares = buildShares(eligible, parsed.price);
    if (shares.length === 0) {
      setAddErr("Give at least one person some chapatis");
      return;
    }
    const note = noteRaw.trim().slice(0, 60);
    const ok = await onAdd({ qty: parsed.qty, rate: parsed.price, note, shares }, selectedDate);
    if (ok) {
      setQtyRaw("");
      setNoteRaw("");
      setRows({});
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
            max={today}
            onChange={(e) => {
              setSelectedDate(e.target.value || today);
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
          aria-label="Chapati count"
        />
        <button
          className="btn btn-solid add-btn"
          disabled={!canAdd}
          onClick={handleAdd}
          aria-label="Add entry"
        >
          <IcPlus className="ic" />
          <span>Add</span>
        </button>
      </div>

      <SplitEditor
        members={members}
        total={total}
        rows={rows}
        onChange={setRows}
        lastAdd={lastAdd}
        disabled={busy}
      />

      <input
        className="in note"
        placeholder="Note (optional)"
        value={noteRaw}
        maxLength={60}
        onChange={(e) => setNoteRaw(e.target.value)}
        aria-label="Optional note"
      />
      {addErr && <div className="add-err">{addErr}</div>}
      {!addErr &&
        (dayAdds.length > 0 ? (
          <div className="add-hint">
            {isToday ? "Today" : dayLabel(selectedDate)} so far &middot; <b>{dayQty}</b> chapati
            {dayQty !== 1 ? "s" : ""} &middot; {money(dayAmount)}
          </div>
        ) : (
          <div className="add-rate">{money(parsed?.price ?? DEFAULT_PRICE)} per chapati</div>
        ))}
    </section>
  );
}
