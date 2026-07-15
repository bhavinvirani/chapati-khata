import type { LogRow } from "../types";
import { Roti } from "./icons";
import { dayLabel, stamp, weekLabel } from "../lib/util";

function logText(ev: LogRow): string {
  switch (ev.action) {
    case "create":
      return `Logged ${ev.qty_after} for ${ev.day ? dayLabel(ev.day) : "a day"}`;
    case "add":
      return `Added to ${ev.day ? dayLabel(ev.day) : "a day"} (${ev.qty_before} → ${ev.qty_after})`;
    case "edit":
      return `Edited ${ev.day ? dayLabel(ev.day) : "a day"} (${ev.qty_before} → ${ev.qty_after})`;
    case "delete":
      return `Deleted ${ev.day ? dayLabel(ev.day) : "a day"} (had ${ev.qty_before})`;
    case "paid":
      return `Marked ${ev.week_start ? weekLabel(ev.week_start, true) : "a week"} paid`;
    case "reopen":
      return `Reopened ${ev.week_start ? weekLabel(ev.week_start, true) : "a week"}`;
    default:
      return ev.action;
  }
}

const KIND: Record<string, string> = {
  create: "c-add",
  add: "c-add",
  edit: "c-edit",
  delete: "c-del",
  paid: "c-paid",
  reopen: "c-open",
};

export function LogView({ logs }: { logs: LogRow[] }) {
  if (!logs.length) {
    return (
      <main className="scroll">
        <div className="empty">
          <Roti size={40} />
          <p>No changes yet.</p>
          <span>Every add, edit, delete and payment shows up here.</span>
        </div>
      </main>
    );
  }

  return (
    <main className="scroll">
      <div className="log-intro">History of every change, newest first.</div>
      <ul className="log">
        {logs.map((ev) => (
          <li key={ev.id} className="log-row">
            <span className={"log-dot " + (KIND[ev.action] || "c-add")} />
            <div className="log-body">
              <div className="log-what">{logText(ev)}</div>
              <div className="log-when">{stamp(ev.ts)}</div>
            </div>
          </li>
        ))}
      </ul>
      <div className="foot">Names are recorded but not shown here.</div>
    </main>
  );
}
