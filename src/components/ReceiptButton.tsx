import { useState } from "react";
import type { Entry } from "../types";
import { renderReceiptImage, shareOrDownloadReceipt } from "../lib/receiptImage";

interface Props {
  entries: Entry[];
  weekIds: string[];
  onError: (msg: string) => void;
  className?: string;
}

/**
 * Turns a settlement's entries into a shareable receipt PNG — the one
 * implementation SettleSummary, WeekCard, and PaidHistory's settlement
 * groups all render this same button from, so the layout logic lives once.
 */
export function ReceiptButton({ entries, weekIds, onError, className = "link" }: Props) {
  const [busy, setBusy] = useState(false);

  async function handleClick() {
    setBusy(true);
    try {
      const blob = await renderReceiptImage(entries, weekIds);
      await shareOrDownloadReceipt(blob, weekIds);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not generate the receipt.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button className={className} disabled={busy} onClick={handleClick}>
      {busy ? "Generating…" : "Generate receipt"}
    </button>
  );
}
