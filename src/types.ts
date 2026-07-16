// Row shapes mirror the Postgres tables in supabase/schema.sql.

export interface Week {
  week_start: string; // 'YYYY-MM-DD' (Monday) — primary key
  paid: boolean;
  paid_at: string | null; // ISO timestamp
}

export interface Entry {
  id: string; // uuid
  week_start: string; // FK -> weeks.week_start
  day: string; // 'YYYY-MM-DD' (unique — one entry per day)
  qty: number;
  amount: number; // money for this day, stored at time of logging
  note: string;
}

export type LogAction = "create" | "add" | "edit" | "delete" | "paid" | "reopen";

export interface LogRow {
  id: string;
  ts: string; // ISO timestamp
  actor: string; // the name typed at the gate
  action: LogAction;
  week_start: string | null;
  day: string | null;
  qty_before: number | null;
  qty_after: number | null;
  device_id: string | null; // breadcrumb — not shown in the UI
}

// A week with its entries attached, ready to render.
export interface WeekView extends Week {
  entries: Entry[];
  total: number;
  count: number;
}

export interface Confirm {
  title: string;
  body: string;
  cta: string;
  tone: "go" | "plain";
  onYes: () => void;
}
