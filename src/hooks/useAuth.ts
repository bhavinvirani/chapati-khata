import { useCallback, useState } from "react";
import { ALLOWED_NAMES } from "../config";

export function useAuth() {
  const [user, setUser] = useState<string | null>(null);

  /** Restore a previously saved name (checks allowlist for safety). */
  const restoreUser = useCallback(() => {
    const saved = localStorage.getItem("khata.name");
    if (saved && ALLOWED_NAMES.includes(saved)) setUser(saved);
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
