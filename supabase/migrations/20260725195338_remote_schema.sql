-- Baseline migration, generated via `supabase db pull` against the live
-- project and hand-cleaned. This is meant to be stamped as already-applied
-- (`supabase migration repair --status applied 20260725195338`), never
-- actually executed — the schema it describes already exists in production.
--
-- Cleaned up from the raw pg-delta diff output: removed `drop extension if
-- exists "pg_net"` and a block of `revoke ... references/trigger/truncate`
-- statements the diff engine added to reconcile undeclared remote objects
-- against schema.sql. Neither reflects real intent — pg_net is an unrelated
-- Supabase-managed extension, and the revokes targeted privileges schema.sql
-- never granted in the first place.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

ALTER SCHEMA "public" OWNER TO "postgres";

CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";

CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";

CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";

SET default_tablespace = '';

SET default_table_access_method = "heap";

CREATE TABLE IF NOT EXISTS "public"."entries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "week_start" "date" NOT NULL,
    "day" "date" NOT NULL,
    "qty" integer NOT NULL,
    "amount" numeric(10,2) NOT NULL,
    "note" "text" DEFAULT ''::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "entries_qty_check" CHECK (("qty" > 0))
);

ALTER TABLE "public"."entries" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "ts" timestamp with time zone DEFAULT "now"() NOT NULL,
    "actor" "text" NOT NULL,
    "action" "text" NOT NULL,
    "week_start" "date",
    "day" "date",
    "qty_before" integer,
    "qty_after" integer,
    "device_id" "text",
    "note_before" "text",
    "note_after" "text"
);

ALTER TABLE "public"."logs" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."weeks" (
    "week_start" "date" NOT NULL,
    "paid" boolean DEFAULT false NOT NULL,
    "paid_at" timestamp with time zone
);

ALTER TABLE "public"."weeks" OWNER TO "postgres";

ALTER TABLE ONLY "public"."entries"
    ADD CONSTRAINT "entries_day_key" UNIQUE ("day");

ALTER TABLE ONLY "public"."entries"
    ADD CONSTRAINT "entries_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."logs"
    ADD CONSTRAINT "logs_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."weeks"
    ADD CONSTRAINT "weeks_pkey" PRIMARY KEY ("week_start");

CREATE INDEX "entries_week_idx" ON "public"."entries" USING "btree" ("week_start");

CREATE INDEX "logs_ts_idx" ON "public"."logs" USING "btree" ("ts" DESC);

ALTER TABLE ONLY "public"."entries"
    ADD CONSTRAINT "entries_week_start_fkey" FOREIGN KEY ("week_start") REFERENCES "public"."weeks"("week_start") ON DELETE CASCADE;

CREATE POLICY "authed all - entries" ON "public"."entries" TO "authenticated" USING (true) WITH CHECK (true);

CREATE POLICY "authed all - logs" ON "public"."logs" TO "authenticated" USING (true) WITH CHECK (true);

CREATE POLICY "authed all - weeks" ON "public"."weeks" TO "authenticated" USING (true) WITH CHECK (true);

ALTER TABLE "public"."entries" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."logs" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."weeks" ENABLE ROW LEVEL SECURITY;

ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";

ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."entries";

ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."logs";

ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."weeks";

REVOKE USAGE ON SCHEMA "public" FROM PUBLIC;
GRANT ALL ON SCHEMA "public" TO PUBLIC;
GRANT USAGE ON SCHEMA "public" TO "authenticated";

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."entries" TO "authenticated";

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."logs" TO "authenticated";

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."weeks" TO "authenticated";
