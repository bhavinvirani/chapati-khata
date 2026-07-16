import { useState } from "react";
import type { Confirm } from "../types";

export function useConfirm() {
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const clearConfirm = () => setConfirm(null);
  return { confirm, setConfirm, clearConfirm };
}
