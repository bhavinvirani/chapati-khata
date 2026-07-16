import { useRef, useState } from "react";

export function useToast() {
  const [toast, setToast] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  function flash(msg: string) {
    setToast(msg);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), 2200);
  }

  return { toast, flash };
}
