// Row shapes mirror the Postgres tables in supabase/schema.sql.

export interface Week {
  week_start: string; // 'YYYY-MM-DD' (Monday) — primary key
  paid: boolean;
  paid_at: string | null; // ISO timestamp
}

export interface User {
  id: string; // uuid
  name: string; // lowercase, unique
  in_split: boolean; // appears in the split composer
  can_login: boolean; // passes the gate
  created_at: string; // ISO timestamp — also the composer's row order
}

export interface EntryShare {
  entry_id: string; // uuid -> entries.id
  user_id: string; // uuid -> users.id
  qty: number;
  amount: number;
}

export interface Entry {
  id: string; // uuid
  week_start: string; // FK -> weeks.week_start
  day: string; // 'YYYY-MM-DD' — NOT unique; one row per add
  qty: number; // the add's total — always equals sum(shares.qty) + other_qty
  rate: number; // price per chapati for this add
  other_qty: number; // chapatis nobody on the list claimed; cost shared by those who ate
  amount: number; // always equals the sum of its shares' amounts
  note: string;
  created_at: string; // ISO timestamp — orders adds within a day
  entry_shares: EntryShare[]; // embedded by PostgREST; [] means "needs repair"
}

export type LogAction =
  | "create"
  | "add"
  | "edit"
  | "delete"
  | "paid"
  | "reopen"
  | "login"
  | "user_add"
  | "user_delete"
  | "user_split_on"
  | "user_split_off"
  | "user_login_on"
  | "user_login_off";

export interface LogRow {
  id: string;
  ts: string; // ISO timestamp
  actor: string; // the name typed at the gate
  action: LogAction;
  week_start: string | null;
  day: string | null;
  qty_before: number | null;
  qty_after: number | null;
  note_before: string | null;
  note_after: string | null;
  target: string | null; // the person a user_* action refers to
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
