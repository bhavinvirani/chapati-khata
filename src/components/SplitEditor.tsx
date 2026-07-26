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
  /** Numbers from the previous add, for the "Same as last" fill. Null hides it. */
  lastAdd: Alloc | null;
  disabled?: boolean;
}

/**
 * Allocate a known total across people. Controlled — the parent owns the
 * allocation and decides what to do with it; this only edits it and shows how
 * far off it is.
 */
export function SplitEditor({ members, total, rows, onChange, lastAdd, disabled }: Props) {
  // Count only the boxes on screen. The parent gates on the same projection, so
  // a stale key for someone just removed from the split cannot make the readout
  // and the button contradict each other.
  const left = total - members.reduce((sum, m) => sum + (rows[m.id] || 0), 0);

  function setOne(id: string, raw: string) {
    const digits = raw.replace(/[^0-9]/g, "");
    onChange({ ...rows, [id]: digits === "" ? 0 : parseInt(digits, 10) });
  }

  return (
    <div className="split">
      <div className="split-fills">
        <button
          className="btn btn-ghost split-fill"
          disabled={disabled || total <= 0 || members.length === 0}
          onClick={() =>
            onChange(
              evenSplit(
                total,
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
          disabled={disabled || allocated(rows) === 0}
          onClick={() => onChange({})}
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
