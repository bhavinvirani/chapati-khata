import type { WeekView } from "../types";
import { money } from "../lib/util";
import { IcCheck } from "./icons";

interface Props {
  owed: number;
  owedQty: number;
  unpaid: WeekView[];
  busy: boolean;
  onSettle: () => void;
}

export function ToPayCard({ owed, owedQty, unpaid, busy, onSettle }: Props) {
  if (owed <= 0) {
    return (
      <section className="topay clear">
        <div className="clear-badge">
          <IcCheck className="ic" />
        </div>
        <div className="topay-amt sm">All settled</div>
        <div className="topay-meta">Nothing owed right now.</div>
      </section>
    );
  }

  return (
    <section className="topay due">
      <div className="topay-label">To pay</div>
      <div className="topay-amt">{money(owed)}</div>
      <div className="topay-meta">
        {unpaid.length} week{unpaid.length > 1 ? "s" : ""} open &middot; {owedQty} chapati
        {owedQty !== 1 ? "s" : ""}
      </div>
      {unpaid.length > 1 && (
        <button className="btn btn-solid wide" disabled={busy} onClick={onSettle}>
          Settle all {unpaid.length} weeks
        </button>
      )}
    </section>
  );
}
