import { useCallback, useState } from "react";
import { ALLOWED_NAMES } from "../config";

export function useAuth() {
  const [user, setUser] = useState<string | null>(null);

  const restoreUser = useCallback(() => {
    const saved = localStorage.getItem("khata.name");
    if (saved && ALLOWED_NAMES.includes(saved)) setUser(saved);
  }, []);

  function signIn(name: string): boolean {
    const clean = name.trim().toLowerCase();
    if (!ALLOWED_NAMES.includes(clean)) return false;
    setUser(clean);
    try {
      localStorage.setItem("khata.name", clean);
    } catch {
      /* ignore */
    }
    return true;
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
