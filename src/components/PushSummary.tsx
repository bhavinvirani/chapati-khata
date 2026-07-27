import { useState } from "react";
import type { Entry, User } from "../types";
import { SettleSummary } from "./SettleSummary";
import { cap } from "../lib/util";

interface Props {
  entries: Entry[];
  users: User[];
  weekIds: string[];
  payerOptions: User[];
  defaultPayerId: string | null;
  onPayerChange: (userId: string | null) => void;
}

/** The push confirm dialog's body: the same breakdown Mark Paid already
 * shows via SettleSummary, plus who's paying on Splitwise. */
export function PushSummary({
  entries,
  users,
  weekIds,
  payerOptions,
  defaultPayerId,
  onPayerChange,
}: Props) {
  const [payerId, setPayerId] = useState(defaultPayerId);
  return (
    <div className="push-summary">
      <SettleSummary entries={entries} users={users} weekIds={weekIds} />
      <label className="fld-l">Who paid?</label>
      <select
        className="in"
        value={payerId ?? ""}
        onChange={(e) => {
          const id = e.target.value || null;
          setPayerId(id);
          onPayerChange(id);
        }}
      >
        <option value="" disabled>
          Choose who paid
        </option>
        {payerOptions.map((u) => (
          <option key={u.id} value={u.id}>
            {cap(u.name)}
          </option>
        ))}
      </select>
    </div>
  );
}
