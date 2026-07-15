import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  // Fail loud in dev — a missing .env is the most common setup slip.
  console.error(
    "Missing Supabase env vars. Copy .env.example to .env and fill VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.",
  );
}

export const supabase = createClient(url ?? "", anonKey ?? "");

/**
 * Light gate: sign the browser in anonymously so RLS (which requires an
 * authenticated session) will allow reads/writes. The session is cached by
 * supabase-js, so this is a no-op on repeat visits.
 * Requires "Anonymous sign-ins" enabled in Supabase → Authentication.
 */
export async function ensureAuth(): Promise<void> {
  const { data } = await supabase.auth.getSession();
  if (data.session) return;
  const { error } = await supabase.auth.signInAnonymously();
  if (error) throw error;
}
