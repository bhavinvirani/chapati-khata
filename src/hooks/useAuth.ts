import { useCallback, useState } from "react";
import * as db from "../lib/db";

export function useAuth() {
  const [user, setUser] = useState<string | null>(null);

  /**
   * Restore a previously saved name, re-checking it against the users table.
   *
   * This check is the only thing that makes revoking someone's access take
   * effect. `khata.name` is read nowhere else and signing out is user-initiated,
   * so without it a revoked person keeps full access on their existing device
   * indefinitely — there is no "next sign-in" to catch them at.
   *
   * A definitive no clears the saved name. A thrown error does not: the app has
   * to keep working offline, and an unreachable server is not a revocation.
   */
  const restoreUser = useCallback(async () => {
    const saved = localStorage.getItem("khata.name");
    if (!saved) return;
    try {
      if (!(await db.nameCanLogin(saved))) {
        localStorage.removeItem("khata.name");
        return;
      }
    } catch {
      // Offline or server error — keep the session rather than lock them out.
    }
    setUser(saved);
  }, []);

  /** Set the signed-in user. Call AFTER validation (Gate / edge function). */
  function signIn(name: string) {
    const clean = name.trim().toLowerCase();
    setUser(clean);
    try {
      localStorage.setItem("khata.name", clean);
    } catch {
      /* ignore */
    }
  }

  function signOut() {
    try {
      localStorage.removeItem("khata.name");
    } catch {
      /* ignore */
    }
    setUser(null);
  }

  return { user, signIn, signOut, restoreUser };
}
