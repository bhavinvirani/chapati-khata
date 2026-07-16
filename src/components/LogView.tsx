import type { LogRow } from "../types";
import { Roti } from "./icons";
import { cap, dayLabel, stamp, weekLabel } from "../lib/util";

function logText(ev: LogRow): string {
  const day = ev.day ? dayLabel(ev.day) : "a day";
  switch (ev.action) {
    case "create":
      return `logged ${ev.qty_after} for ${day}`;
    case "add":
      return `added to ${day} (${ev.qty_before} \u2192 ${ev.qty_after})`;
    case "edit": {
      const qtyChanged = ev.qty_before !== ev.qty_after;
      return qtyChanged
        ? `edited ${day} (${ev.qty_before} \u2192 ${ev.qty_after})`
        : `edited ${day}`;
    }
    case "delete":
      return `deleted ${day} (had ${ev.qty_before})`;
    case "paid":
      return `marked ${ev.week_start ? weekLabel(ev.week_start, true) : "a week"} paid`;
    case "reopen":
      return `reopened ${ev.week_start ? weekLabel(ev.week_start, true) : "a week"}`;
    case "login":
      return "signed in";
    default:
      return ev.action;
  }
}

function NoteChange({ before, after }: { before: string; after: string }) {
  if (!before && after) {
    return <div className="log-note-diff">note: <span className="log-note-new">{after}</span></div>;
  }
  if (before && !after) {
    return <div className="log-note-diff">note removed: <span className="log-note-old">{before}</span></div>;
  }
  return (
    <div className="log-note-diff">
      <span className="log-note-old">{before}</span> <span className="log-note-arrow">{"\u2192"}</span> <span className="log-note-new">{after}</span>
    </div>
  );
}

const KIND: Record<string, string> = {
  create: "c-add",
  add: "c-add",
  edit: "c-edit",
  delete: "c-del",
  paid: "c-paid",
  reopen: "c-open",
  login: "c-login",
};

interface Props {
  logs: LogRow[];
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}

export function LogView({ logs, hasMore, loadingMore, onLoadMore }: Props) {
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
              <div className="log-what">
                <b className="log-actor">{cap(ev.actor)}</b> {logText(ev)}
              </div>
              {(ev.action === "edit" || ev.action === "add") && ev.note_before != null && ev.note_after != null && (
                <NoteChange before={ev.note_before} after={ev.note_after} />
              )}
              <div className="log-when">{stamp(ev.ts)}</div>
            </div>
          </li>
        ))}
      </ul>
      {hasMore && (
        <button className="btn btn-ghost wide log-more" onClick={onLoadMore} disabled={loadingMore}>
          {loadingMore ? "Loading\u2026" : "Load more"}
        </button>
      )}
      <div className="foot">Make your life easy</div>
    </main>
  );
}
