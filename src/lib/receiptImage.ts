import type { Entry } from "../types";
import { buildReceiptData } from "./receipt";
import { settlementDateRange, settlementLabel } from "./splitwise";
import { dayLabel, money, todayStr } from "./util";

// Canvas-drawn PNG receipt for a settlement — see docs/superpowers/specs/
// 2026-07-28-payment-receipt-image-design.md. Deliberately drawn rather than
// rasterizing existing DOM: full control over a fixed receipt layout with no
// dependency on live page layout, CSS, or a snapshot library.

const WIDTH = 720;
const PAD_X = 40;
const PAD_TOP = 36;
const PAD_BOTTOM = 36;
const HEADER_H = 132;
const ROW_H = 34;
const SUBLINE_H = 22;
const FOOTER_H = 96;

// Roti mark drawn in the header, to the left of the "Chapati Khata" title —
// a canvas equivalent of the <Roti> SVG in src/components/icons.tsx.
const MARK_D = 20;
const MARK_R = MARK_D / 2;
const MARK_GAP = 8;

const COLOR = {
  paper: "#F8F3E9",
  ink: "#241E15",
  soft: "#7C6E58",
  faint: "#A99C85",
  line: "#EBE1CE",
  marigoldDeep: "#BE7C10",
  marigoldTint: "#FAEECF",
};

const DISP = `'Bricolage Grotesque', ui-sans-serif, system-ui, sans-serif`;
const MONO = `'Space Mono', ui-monospace, 'SFMono-Regular', Menlo, monospace`;

async function ensureFontsReady(): Promise<void> {
  await Promise.all([
    document.fonts.load(`800 24px 'Bricolage Grotesque'`),
    document.fonts.load(`700 15px 'Bricolage Grotesque'`),
    document.fonts.load(`400 14px 'Space Mono'`),
    document.fonts.load(`700 15px 'Space Mono'`),
  ]);
  await document.fonts.ready;
}

function rowHeightFor(rateCount: number): number {
  return ROW_H + rateCount * SUBLINE_H;
}

/** Renders a settlement's entries into a PNG receipt image. */
export async function renderReceiptImage(entries: Entry[], weekIds: string[]): Promise<Blob> {
  const data = buildReceiptData(entries);
  const range = settlementDateRange(weekIds);

  const bodyHeight = data.days.reduce((sum, d) => sum + rowHeightFor(d.rates.length), 0);
  const height = PAD_TOP + HEADER_H + bodyHeight + FOOTER_H + PAD_BOTTOM;

  await ensureFontsReady();

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not create the image.");
  ctx.scale(dpr, dpr);

  ctx.fillStyle = COLOR.paper;
  ctx.fillRect(0, 0, WIDTH, height);

  const y0 = PAD_TOP;

  const markCx = PAD_X + MARK_R;
  const markCy = y0 + 16;
  ctx.beginPath();
  ctx.arc(markCx, markCy, MARK_R, 0, Math.PI * 2);
  ctx.fillStyle = COLOR.marigoldTint;
  ctx.fill();
  ctx.strokeStyle = COLOR.marigoldDeep;
  ctx.lineWidth = 1.4;
  ctx.stroke();

  ctx.fillStyle = COLOR.marigoldDeep;
  const markDots: [number, number, number][] = [
    [-3, -2, 1.15],
    [2.5, -2.5, 0.8],
    [1, 2.5, 1.05],
    [-3.5, 2, 0.7],
  ];
  for (const [dx, dy, r] of markDots) {
    ctx.beginPath();
    ctx.arc(markCx + dx, markCy + dy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = COLOR.marigoldDeep;
  ctx.font = `800 24px ${DISP}`;
  ctx.textAlign = "left";
  ctx.fillText("Chapati Khata", PAD_X + MARK_D + MARK_GAP, y0 + 26);

  ctx.fillStyle = COLOR.soft;
  ctx.font = `700 15px ${DISP}`;
  ctx.fillText(range, PAD_X, y0 + 54);

  ctx.strokeStyle = COLOR.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD_X, y0 + 78);
  ctx.lineTo(WIDTH - PAD_X, y0 + 78);
  ctx.stroke();

  ctx.fillStyle = COLOR.faint;
  ctx.font = `400 12px ${MONO}`;
  ctx.fillText(`${data.totalDays} day${data.totalDays !== 1 ? "s" : ""}`, PAD_X, y0 + 100);

  let y = y0 + HEADER_H;

  for (const d of data.days) {
    ctx.fillStyle = COLOR.ink;
    ctx.font = `700 15px ${MONO}`;
    ctx.textAlign = "left";
    ctx.fillText(dayLabel(d.day), PAD_X, y + 16);

    ctx.font = `400 14px ${MONO}`;
    ctx.textAlign = "right";
    ctx.fillText(`${d.qty}`, WIDTH - PAD_X - 90, y + 16);

    ctx.font = `700 15px ${MONO}`;
    ctx.fillText(money(d.amount), WIDTH - PAD_X, y + 16);

    let subY = y + ROW_H;
    for (const r of d.rates) {
      ctx.fillStyle = COLOR.faint;
      ctx.font = `400 13px ${MONO}`;
      ctx.textAlign = "left";
      ctx.fillText(`${r.qty} @ ${money(r.rate)}`, PAD_X + 16, subY + 14);

      ctx.textAlign = "right";
      ctx.fillText(money(r.amount), WIDTH - PAD_X, subY + 14);

      subY += SUBLINE_H;
    }

    y += rowHeightFor(d.rates.length);
  }

  ctx.strokeStyle = COLOR.line;
  ctx.beginPath();
  ctx.moveTo(PAD_X, y + 10);
  ctx.lineTo(WIDTH - PAD_X, y + 10);
  ctx.stroke();

  ctx.fillStyle = COLOR.ink;
  ctx.font = `800 20px ${DISP}`;
  ctx.textAlign = "left";
  ctx.fillText("Total", PAD_X, y + 44);

  ctx.font = `700 16px ${MONO}`;
  ctx.textAlign = "right";
  ctx.fillText(
    `${data.totalQty} chapati${data.totalQty !== 1 ? "s" : ""}`,
    WIDTH - PAD_X,
    y + 38,
  );

  ctx.font = `700 22px ${MONO}`;
  ctx.fillText(money(data.totalAmount), WIDTH - PAD_X, y + 64);

  ctx.fillStyle = COLOR.faint;
  ctx.font = `400 11px ${MONO}`;
  ctx.textAlign = "left";
  ctx.fillText(`Generated ${dayLabel(todayStr())}`, PAD_X, height - PAD_BOTTOM + 10);

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Could not create the image."));
    }, "image/png");
  });
}

function filenameFor(weekIds: string[]): string {
  const slug = settlementDateRange(weekIds)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `chapati-khata_${slug}.png`;
}

/**
 * Hands a receipt image to the user: the OS share sheet where file sharing
 * is supported, a plain download otherwise. Swallows a user-cancelled share
 * (AbortError) rather than surfacing it as a failure, and falls back to the
 * download path for any other share failure so the user always ends up with
 * the image one way or another.
 */
export async function shareOrDownloadReceipt(blob: Blob, weekIds: string[]): Promise<void> {
  const filename = filenameFor(weekIds);
  const file = new File([blob], filename, { type: "image/png" });

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: settlementLabel(weekIds) });
      return;
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      // fall through to the download below rather than dead-ending
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
