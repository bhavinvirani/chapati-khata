import type { Settlement } from "../types";
import { IcCheck } from "./icons";

interface Props {
  settlement: Settlement | null;
  missing: string[];
  busy: boolean;
  onPush: () => void;
}

/** The push/pushed/retry/blocked control for one settlement — shared by a
 * solo paid week's own footer and a multi-week settlement's group header,
 * since both act on the same settlement and should look identical. */
export function SplitwiseControl({ settlement, missing, busy, onPush }: Props) {
  if (!settlement) return null;
  if (settlement.splitwise_expense_id) {
    return (
      <a
        className="badge-pushed"
        href={`https://secure.splitwise.com/expenses/${settlement.splitwise_expense_id}`}
        target="_blank"
        rel="noreferrer"
      >
        <IcCheck className="ic sm" />
        Pushed
      </a>
    );
  }
  if (settlement.splitwise_status === "unknown") {
    return (
      <button className="link warn" disabled={busy} onClick={onPush}>
        Push status unknown — retry?
      </button>
    );
  }
  if (missing.length > 0) {
    return (
      <span className="link disabled" title={`${missing.join(", ")} not linked to Splitwise`}>
        {missing[0]} not linked
      </span>
    );
  }
  return (
    <button className="link" disabled={busy} onClick={onPush}>
      Push to Splitwise
    </button>
  );
}
