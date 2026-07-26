import type { User } from "../types";
import type { Alloc } from "../lib/split";
import { allocated, evenSplit } from "../lib/split";
import { cap } from "../lib/util";

interface Props {
  /** People to offer, already filtered and ordered by the caller. */
  members: User[];
  /** The add's total — what the allocation must add up to. */
  total: number;
  rows: Alloc;
  onChange: (rows: Alloc) => void;
  /** Chapatis eaten by guests. Counts toward the total; nobody claims it. */
  otherQty: number;
  onOtherChange: (qty: number) => void;
  /** Who covers the guests. Everyone by default; narrow it by tapping. */
  otherSharers: string[];
  onSharersChange: (ids: string[]) => void;
  /** Numbers from the previous add, for the "Same as last" fill. Null hides it. */
  lastAdd: Alloc | null;
  disabled?: boolean;
}

/**
 * Allocate a known total across people. Controlled — the parent owns the
 * allocation and decides what to do with it; this only edits it and shows how
 * far off it is.
 */
export function SplitEditor({
  members,
  total,
  rows,
  onChange,
  otherQty,
  onOtherChange,
  otherSharers,
  onSharersChange,
  lastAdd,
  disabled,
}: Props) {
  // Count only the boxes on screen, plus the guest box. The parent gates on the
  // same projection, so a stale key for someone just removed from the split
  // cannot make the readout and the button contradict each other.
  const left = total - members.reduce((sum, m) => sum + (rows[m.id] || 0), 0) - otherQty;

  const digitsOf = (raw: string) => {
    const digits = raw.replace(/[^0-9]/g, "");
    return digits === "" ? 0 : parseInt(digits, 10);
  };

  function setOne(id: string, raw: string) {
    onChange({ ...rows, [id]: digitsOf(raw) });
  }

  return (
    <div className="split">
      <div className="split-fills">
        <button
          className="btn btn-ghost split-fill"
          disabled={disabled || total <= 0 || members.length === 0}
          onClick={() =>
            // Divide only what is left after the guests, so a guest count you
            // have already typed survives the fill instead of being overrun.
            onChange(
              evenSplit(
                Math.max(0, total - otherQty),
                members.map((m) => m.id),
              ),
            )
          }
        >
          Even split
        </button>
        {lastAdd && (
          <button
            className="btn btn-ghost split-fill"
            disabled={disabled}
            onClick={() => onChange({ ...lastAdd })}
          >
            Same as last
          </button>
        )}
        <button
          className="btn btn-ghost split-fill"
          disabled={disabled || (allocated(rows) === 0 && otherQty === 0)}
          onClick={() => {
            onChange({});
            onOtherChange(0);
          }}
        >
          Clear
        </button>
      </div>

      {members.length === 0 ? (
        <div className="split-empty">Nobody is in the split. Add people first.</div>
      ) : (
        <ul className="split-rows">
          {members.map((m) => (
            <li key={m.id} className="split-row">
              <span className="split-name">{cap(m.name)}</span>
              <input
                className="in split-qty"
                inputMode="numeric"
                value={rows[m.id] ? String(rows[m.id]) : ""}
                placeholder="0"
                disabled={disabled}
                onChange={(e) => setOne(m.id, e.target.value)}
                aria-label={`Chapatis for ${m.name}`}
              />
            </li>
          ))}
        </ul>
      )}

      {members.length > 0 && (
        <ul className="split-rows split-other">
          <li className="split-row">
            <span className="split-name">
              Others
              <span className="split-hint">cost shared by everyone</span>
            </span>
            <input
              className="in split-qty"
              inputMode="numeric"
              value={otherQty ? String(otherQty) : ""}
              placeholder="0"
              disabled={disabled}
              onChange={(e) => onOtherChange(digitsOf(e.target.value))}
              aria-label="Chapatis for guests"
            />
          </li>
        </ul>
      )}

      {otherQty > 0 && members.length > 0 && (
        <div className="split-sharers">
          <div className="split-sharers-t">
            {otherSharers.length === members.length
              ? "Covered by everyone"
              : otherSharers.length === 0
                ? "Nobody is covering these yet"
                : `Covered by ${otherSharers.length} of ${members.length}`}
          </div>
          <div className="split-chips">
            {members.map((m) => {
              const on = otherSharers.includes(m.id);
              return (
                <button
                  key={m.id}
                  className={"chip" + (on ? " on" : "")}
                  disabled={disabled}
                  aria-pressed={on}
                  onClick={() =>
                    onSharersChange(
                      on ? otherSharers.filter((id) => id !== m.id) : [...otherSharers, m.id],
                    )
                  }
                >
                  {cap(m.name)}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className={"split-left" + (left === 0 ? " ok" : left < 0 ? " over" : "")}>
        {total <= 0
          ? "Enter a total first"
          : left === 0
            ? "All allocated"
            : left > 0
              ? `${left} left to allocate`
              : `${-left} over-allocated`}
      </div>
    </div>
  );
}
