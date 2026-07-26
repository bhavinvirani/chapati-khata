import type { ReactNode } from "react";

// Row shapes mirror the Postgres tables in supabase/schema.sql.

export interface Week {
  week_start: string; // 'YYYY-MM-DD' (Monday) — primary key
  paid: boolean;
  paid_at: string | null; // ISO timestamp
  settlement_id: string | null; // FK -> settlements.id, null for weeks paid before this feature or never paid
}

export interface User {
  id: string; // uuid
  name: string; // lowercase, unique
  in_split: boolean; // appears in the split composer
  can_login: boolean; // passes the gate
  created_at: string; // ISO timestamp — also the composer's row order
  splitwise_email: string | null; // what's typed in the People sheet
  splitwise_user_id: string | null; // resolved id from the last successful link check — a UI hint only, never trusted at push time
}

export interface Settlement {
  id: string; // uuid
  created_at: string; // ISO timestamp
  actor: string;
  device_id: string | null;
  splitwise_payer_user_id: string | null;
  splitwise_expense_id: string | null;
  splitwise_status: "unknown" | null;
  splitwise_pushed_at: string | null;
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
  | "user_login_off"
  | "splitwise_push"
  | "splitwise_unpush";

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
  detail: string | null; // what changed, in words
  device_id: string | null; // breadcrumb — not shown in the UI
}

// A week with its entries attached, ready to render.
export interface WeekView extends Week {
  entries: Entry[];
  total: number;
  count: number;
  settlement: Settlement | null;
}

export interface Confirm {
  title: string;
  body: string;
  /** Optional rich block under the body — e.g. the pre-payment breakdown. */
  detail?: ReactNode;
  cta: string;
  tone: "go" | "plain";
  onYes: () => void;
}
