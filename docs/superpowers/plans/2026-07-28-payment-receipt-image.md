# Payment Receipt Image Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Generate image" action that turns a settlement's entries into a shareable PNG receipt — day-by-day quantity and amount, with custom-rate adds broken out.

**Architecture:** Two new pure-logic modules (`src/lib/receipt.ts` for day/rate shaping, extending `src/lib/aggregate.ts` with a `rateBreakdown` helper) feed a canvas-drawing module (`src/lib/receiptImage.ts`) that renders a PNG and hands it to the OS share sheet or a file download. One shared `<ReceiptButton>` component wires this into `SettleSummary` (pre-payment confirm) and `PaidHistory`/`WeekCard` (post-payment history).

**Tech Stack:** React 18 + TypeScript (existing app), native `<canvas>` (no new dependency), Web Share API with a download fallback, vitest for the pure-logic layer.

**Spec:** `docs/superpowers/specs/2026-07-28-payment-receipt-image-design.md`

## Global Constraints

- Canvas-drawn image, not a DOM snapshot library (`html2canvas` or similar) — no new dependency.
- Image shows day totals only — no per-person breakdown (that already exists elsewhere in the app).
- A day gets per-rate sub-lines only when it isn't uniformly at `DEFAULT_PRICE` (imported from `src/config.ts`) — a single custom rate counts, a single default-rate day does not.
- Days render oldest-first (opposite of `groupByDay`'s newest-first order).
- Output via `navigator.share` with `files` when available (checked via `navigator.canShare`), falling back to an anchor-tag download. A user-cancelled share (`DOMException` named `AbortError`) is not an error.
- Visual style pulled from `src/styles.css`'s existing tokens: `--paper` (`#F8F3E9`) background, `--ink` (`#241E15`) text, `--marigold-deep` (`#BE7C10`) accent, `--faint` (`#A99C85`) secondary text, `--line` (`#EBE1CE`) rules, `Bricolage Grotesque` for headings, `Space Mono` for every number.
- No new backend/edge function; no persistence of generated images.
- Money formatting always goes through `money()`/`round2()` from `src/lib/util.ts` — never hand-rolled.
- Pure logic (`rateBreakdown`, `receipt.ts`) gets vitest coverage; the canvas-drawing and share/download module does not (consistent with this project's existing carve-out for browser-API-only code, e.g. the Splitwise edge function).

---

### Task 1: `rateBreakdown` — group a day's adds by rate

**Files:**

- Modify: `src/lib/aggregate.ts`
- Test: `src/lib/aggregate.test.ts`

**Interfaces:**

- Consumes: `Entry` (from `src/types.ts`) — uses `.rate`, `.qty`, `.amount`.
- Produces: `export interface RateGroup { rate: number; qty: number; amount: number }` and `export function rateBreakdown(adds: Entry[]): RateGroup[]` — adds grouped by their `rate`, summed, sorted cheapest rate first. Later tasks (`src/lib/receipt.ts`) import both.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/aggregate.test.ts` (add `rateBreakdown` to the existing import on line 3, so it reads `import { groupByDay, nameOf, needsRepair, otherQty, perPerson, rateBreakdown } from "./aggregate";`), then add at the end of the file:

```ts
describe("rateBreakdown", () => {
  it("collapses one add into a single rate group", () => {
    expect(rateBreakdown([entry({ rate: 0.5, qty: 12, amount: 6 })])).toEqual([
      { rate: 0.5, qty: 12, amount: 6 },
    ]);
  });

  it("groups same-rate adds together", () => {
    const a = entry({ id: "e1", rate: 0.75, qty: 20, amount: 15 });
    const b = entry({ id: "e2", rate: 0.75, qty: 5, amount: 3.75 });
    expect(rateBreakdown([a, b])).toEqual([{ rate: 0.75, qty: 25, amount: 18.75 }]);
  });

  it("sorts distinct rates cheapest first", () => {
    const cheap = entry({ id: "e1", rate: 0.5, qty: 10, amount: 5 });
    const pricey = entry({ id: "e2", rate: 1, qty: 5, amount: 5 });
    expect(rateBreakdown([pricey, cheap]).map((r) => r.rate)).toEqual([0.5, 1]);
  });

  it("is empty for no adds", () => {
    expect(rateBreakdown([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- aggregate.test.ts`
Expected: FAIL — `rateBreakdown` is not exported from `./aggregate`.

- [ ] **Step 3: Implement `rateBreakdown`**

Add to `src/lib/aggregate.ts`, after `groupByDay` (after line 59):

```ts
export interface RateGroup {
  rate: number;
  qty: number;
  amount: number;
}

/**
 * A day's adds grouped by rate, cheapest first — the "20 @ $0.75 / 10 @
 * $1.00" breakdown a mixed-price day needs on the payment receipt image.
 */
export function rateBreakdown(adds: Entry[]): RateGroup[] {
  const byRate = new Map<number, RateGroup>();
  for (const a of adds) {
    const row = byRate.get(a.rate) ?? { rate: a.rate, qty: 0, amount: 0 };
    row.qty += a.qty;
    row.amount = round2(row.amount + a.amount);
    byRate.set(a.rate, row);
  }
  return [...byRate.values()].sort((a, b) => a.rate - b.rate);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- aggregate.test.ts`
Expected: PASS, all tests including the four new ones.

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/aggregate.ts src/lib/aggregate.test.ts
git commit -m "feat: add rateBreakdown for grouping a day's adds by rate"
```

---

### Task 2: `src/lib/receipt.ts` — pure day-by-day receipt data

**Files:**

- Create: `src/lib/receipt.ts`
- Test: `src/lib/receipt.test.ts`

**Interfaces:**

- Consumes: `Entry` (`src/types.ts`); `groupByDay`, `rateBreakdown`, `RateGroup` (`src/lib/aggregate.ts`, Task 1); `round2` (`src/lib/util.ts`); `DEFAULT_PRICE` (`src/config.ts`).
- Produces: `export interface ReceiptDay { day: string; qty: number; amount: number; rates: RateGroup[] }`, `export interface ReceiptData { days: ReceiptDay[]; totalDays: number; totalQty: number; totalAmount: number }`, `export function shouldBreakOutRates(rates: RateGroup[]): boolean`, `export function buildReceiptData(entries: Entry[]): ReceiptData`. Task 3 (`src/lib/receiptImage.ts`) consumes `buildReceiptData` and `ReceiptData`/`ReceiptDay`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/receipt.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Entry } from "../types";
import { buildReceiptData, shouldBreakOutRates } from "./receipt";

function entry(over: Partial<Entry> = {}): Entry {
  return {
    id: "e1",
    week_start: "2026-07-20",
    day: "2026-07-22",
    qty: 12,
    rate: 0.5,
    amount: 6,
    note: "",
    other_qty: 0,
    created_at: "2026-07-22T09:00:00Z",
    entry_shares: [],
    ...over,
  };
}

describe("shouldBreakOutRates", () => {
  it("hides the breakdown for a single default-rate group", () => {
    expect(shouldBreakOutRates([{ rate: 0.5, qty: 12, amount: 6 }])).toBe(false);
  });

  it("shows the breakdown for a single custom-rate group", () => {
    expect(shouldBreakOutRates([{ rate: 0.75, qty: 12, amount: 9 }])).toBe(true);
  });

  it("shows the breakdown whenever more than one rate is present", () => {
    expect(
      shouldBreakOutRates([
        { rate: 0.5, qty: 5, amount: 2.5 },
        { rate: 0.75, qty: 5, amount: 3.75 },
      ]),
    ).toBe(true);
  });
});

describe("buildReceiptData", () => {
  it("orders days oldest first", () => {
    const mon = entry({ id: "e1", day: "2026-07-20" });
    const wed = entry({ id: "e2", day: "2026-07-22" });
    const data = buildReceiptData([wed, mon]);
    expect(data.days.map((d) => d.day)).toEqual(["2026-07-20", "2026-07-22"]);
  });

  it("leaves a uniform default-rate day without a rate breakdown", () => {
    const data = buildReceiptData([entry({ rate: 0.5, qty: 12, amount: 6 })]);
    expect(data.days[0].rates).toEqual([]);
  });

  it("breaks out a mixed-rate day", () => {
    const cheap = entry({ id: "e1", rate: 0.5, qty: 10, amount: 5 });
    const pricey = entry({ id: "e2", rate: 1, qty: 5, amount: 5 });
    const data = buildReceiptData([cheap, pricey]);
    expect(data.days[0].rates).toEqual([
      { rate: 0.5, qty: 10, amount: 5 },
      { rate: 1, qty: 5, amount: 5 },
    ]);
  });

  it("totals across days and rounds money", () => {
    const a = entry({ id: "e1", day: "2026-07-20", qty: 10, amount: 5 });
    const b = entry({ id: "e2", day: "2026-07-21", qty: 7, amount: 3.5 });
    const data = buildReceiptData([a, b]);
    expect(data.totalDays).toBe(2);
    expect(data.totalQty).toBe(17);
    expect(data.totalAmount).toBe(8.5);
  });

  it("merges entries across week boundaries into one chronological list", () => {
    const wk1 = entry({ id: "e1", week_start: "2026-07-13", day: "2026-07-17" });
    const wk2 = entry({ id: "e2", week_start: "2026-07-20", day: "2026-07-21" });
    const data = buildReceiptData([wk2, wk1]);
    expect(data.days.map((d) => d.day)).toEqual(["2026-07-17", "2026-07-21"]);
  });

  it("is empty for no entries", () => {
    const data = buildReceiptData([]);
    expect(data).toEqual({ days: [], totalDays: 0, totalQty: 0, totalAmount: 0 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- receipt.test.ts`
Expected: FAIL — `src/lib/receipt.ts` does not exist yet.

- [ ] **Step 3: Implement `src/lib/receipt.ts`**

```ts
import type { Entry } from "../types";
import { DEFAULT_PRICE } from "../config";
import { groupByDay, rateBreakdown, type RateGroup } from "./aggregate";
import { round2 } from "./util";

// Pure data shaping for the payment receipt image. src/lib/receiptImage.ts
// draws it; this file only decides what goes on the receipt. Kept separate
// from aggregate.ts's general-purpose helpers since this is one feature's
// presentation rule, not a reusable aggregation.

export interface ReceiptDay {
  day: string;
  qty: number;
  amount: number;
  /** Per-rate sub-lines, populated only when the day isn't uniformly at
   * DEFAULT_PRICE — see shouldBreakOutRates. */
  rates: RateGroup[];
}

export interface ReceiptData {
  days: ReceiptDay[]; // oldest first
  totalDays: number;
  totalQty: number;
  totalAmount: number;
}

/**
 * A day is worth breaking into per-rate lines once it isn't simply "every
 * chapati at the one default price" — a single custom-rate day is exactly as
 * worth surfacing as a mixed-rate one.
 */
export function shouldBreakOutRates(rates: RateGroup[]): boolean {
  if (rates.length > 1) return true;
  return rates.length === 1 && rates[0].rate !== DEFAULT_PRICE;
}

/**
 * Builds the day-by-day figures a payment receipt image shows, oldest day
 * first (a bill reads forward in time) — the reverse of groupByDay's
 * newest-first order, which exists for the app's own scan-what's-recent
 * lists.
 */
export function buildReceiptData(entries: Entry[]): ReceiptData {
  const days: ReceiptDay[] = [...groupByDay(entries)].reverse().map((d) => {
    const rates = rateBreakdown(d.adds);
    return {
      day: d.day,
      qty: d.qty,
      amount: d.amount,
      rates: shouldBreakOutRates(rates) ? rates : [],
    };
  });
  return {
    days,
    totalDays: days.length,
    totalQty: days.reduce((sum, d) => sum + d.qty, 0),
    totalAmount: round2(days.reduce((sum, d) => sum + d.amount, 0)),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- receipt.test.ts`
Expected: PASS, all ten tests.

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/receipt.ts src/lib/receipt.test.ts
git commit -m "feat: add buildReceiptData for the payment receipt image"
```

---

### Task 3: `src/lib/receiptImage.ts` — canvas rendering and share/download

**Files:**

- Create: `src/lib/receiptImage.ts`

**Interfaces:**

- Consumes: `Entry` (`src/types.ts`); `buildReceiptData` (`src/lib/receipt.ts`, Task 2); `settlementDateRange` (`src/lib/splitwise.ts`, existing); `dayLabel`, `money` (`src/lib/util.ts`, existing).
- Produces: `export function renderReceiptImage(entries: Entry[], weekIds: string[]): Promise<Blob>` and `export function shareOrDownloadReceipt(blob: Blob, weekIds: string[]): Promise<void>`. Task 4 (`ReceiptButton`) calls both.

No automated test for this file — it is pure browser-API drawing/output code with no pure logic left to isolate (all the branching lives in `buildReceiptData`, already covered by Task 2). Verified manually in Task 8.

- [ ] **Step 1: Implement `src/lib/receiptImage.ts`**

```ts
import type { Entry } from "../types";
import { buildReceiptData } from "./receipt";
import { settlementDateRange } from "./splitwise";
import { dayLabel, money } from "./util";

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

const COLOR = {
  paper: "#F8F3E9",
  ink: "#241E15",
  soft: "#7C6E58",
  faint: "#A99C85",
  line: "#EBE1CE",
  marigoldDeep: "#BE7C10",
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

  const dpr = window.devicePixelRatio || 1;
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not create the image.");
  ctx.scale(dpr, dpr);

  ctx.fillStyle = COLOR.paper;
  ctx.fillRect(0, 0, WIDTH, height);

  const y0 = PAD_TOP;

  ctx.fillStyle = COLOR.marigoldDeep;
  ctx.font = `800 24px ${DISP}`;
  ctx.textAlign = "left";
  ctx.fillText("Chapati Khata", PAD_X, y0 + 26);

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
  ctx.fillText(`${data.totalQty} chapatis`, WIDTH - PAD_X, y + 38);

  ctx.font = `800 22px ${MONO}`;
  ctx.fillText(money(data.totalAmount), WIDTH - PAD_X, y + 64);

  ctx.fillStyle = COLOR.faint;
  ctx.font = `400 11px ${MONO}`;
  ctx.textAlign = "left";
  ctx.fillText(`Generated ${new Date().toLocaleDateString()}`, PAD_X, height - PAD_BOTTOM + 10);

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
 * (AbortError) rather than surfacing it as a failure.
 */
export async function shareOrDownloadReceipt(blob: Blob, weekIds: string[]): Promise<void> {
  const filename = filenameFor(weekIds);
  const file = new File([blob], filename, { type: "image/png" });

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return;
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      throw e;
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
```

- [ ] **Step 2: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors. (This is the first correctness check this file gets — read through the canvas draw calls once against the constants above if either command flags something, rather than just silencing the error.)

- [ ] **Step 3: Commit**

```bash
git add src/lib/receiptImage.ts
git commit -m "feat: render settlements as a canvas-drawn PNG receipt"
```

---

### Task 4: `<ReceiptButton>` — shared UI entry point

**Files:**

- Create: `src/components/ReceiptButton.tsx`

**Interfaces:**

- Consumes: `Entry` (`src/types.ts`); `renderReceiptImage`, `shareOrDownloadReceipt` (`src/lib/receiptImage.ts`, Task 3).
- Produces: `export function ReceiptButton(props: { entries: Entry[]; weekIds: string[]; onError: (msg: string) => void; className?: string }): JSX.Element`. Tasks 5–7 render this inside `SettleSummary`, `WeekCard`, and `PaidHistory`.

- [ ] **Step 1: Implement `src/components/ReceiptButton.tsx`**

```tsx
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
      onError(e instanceof Error ? e.message : "Could not generate the image.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button className={className} disabled={busy} onClick={handleClick}>
      {busy ? "Generating…" : "Generate image"}
    </button>
  );
}
```

- [ ] **Step 2: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/ReceiptButton.tsx
git commit -m "feat: add ReceiptButton component"
```

---

### Task 5: Wire into `SettleSummary` (pre-payment confirm)

**Files:**

- Modify: `src/components/SettleSummary.tsx`
- Modify: `src/App.tsx:391-405` (Settle All confirm) and `src/App.tsx:439-454` (single-week Mark Paid confirm)
- Modify: `src/styles.css` (add one rule near the other `.settle-*` rules, around line 257)

**Interfaces:**

- Consumes: `ReceiptButton` (`src/components/ReceiptButton.tsx`, Task 4); `flash` (`App.tsx`'s existing `useToast()` result, already in scope at both call sites).
- Produces: `SettleSummary`'s `Props` gains `onError: (msg: string) => void`, a breaking change to its two existing call sites in `App.tsx`.

- [ ] **Step 1: Add the button to `SettleSummary`**

In `src/components/SettleSummary.tsx`, add the import and extend `Props` (after line 4):

```ts
import { ReceiptButton } from "./ReceiptButton";
```

```ts
interface Props {
  /** Every add being settled by this action. */
  entries: Entry[];
  users: User[];
  /** Week ids covered, so the summary can say what period this payment is for. */
  weekIds: string[];
  onError: (msg: string) => void;
}
```

Destructure the new prop in the function signature (line 24):

```tsx
export function SettleSummary({ entries, users, weekIds, onError }: Props) {
```

Add the button after the `settle-total` block (after line 85, before the closing `</div>` on line 86):

```tsx
<div className="settle-actions">
  <ReceiptButton
    entries={entries}
    weekIds={weekIds}
    onError={onError}
    className="settle-days-btn"
  />
</div>
```

- [ ] **Step 2: Add the CSS rule**

In `src/styles.css`, after the `.settle-total` rule (line 257), add:

```css
.settle-actions {
  margin-top: 6px;
  text-align: right;
}
```

- [ ] **Step 3: Pass `onError` from both `App.tsx` call sites**

In `src/App.tsx`, the Settle All confirm (inside the `detail:` around line 396):

```tsx
                  detail: (
                    <SettleSummary
                      entries={unpaid.flatMap((wk) => wk.entries)}
                      users={users}
                      weekIds={unpaid.map((wk) => wk.week_start)}
                      onError={flash}
                    />
                  ),
```

And the single-week Mark Paid confirm (around line 444):

```tsx
                            detail: (
                              <SettleSummary
                                entries={w.entries}
                                users={users}
                                weekIds={[w.week_start]}
                                onError={flash}
                              />
                            ),
```

- [ ] **Step 4: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 5: Manual check**

Run: `npm run dev`, open the app, click "Mark paid" on any unpaid week (or "Settle all" if more than one is unpaid). Confirm the confirm dialog now shows a "Generate image" button below the total, and clicking it either opens a share sheet or downloads a PNG that shows the week's days, quantities, and amounts. Stop the dev server after checking.

- [ ] **Step 6: Commit**

```bash
git add src/components/SettleSummary.tsx src/App.tsx src/styles.css
git commit -m "feat: add Generate image to the settle confirmation"
```

---

### Task 6: Wire into `WeekCard` (single paid weeks in history)

**Files:**

- Modify: `src/components/WeekCard.tsx`
- Modify: `src/App.tsx:425-457` (the one direct `WeekCard` usage, for unpaid weeks)

**Interfaces:**

- Consumes: `ReceiptButton` (Task 4).
- Produces: `WeekCard`'s `Props` gains `onError: (msg: string) => void`. `PaidHistory` (Task 7) will need to pass this to each of its own `WeekCard` usages.

- [ ] **Step 1: Add the prop and import**

In `src/components/WeekCard.tsx`, add the import (after line 7):

```ts
import { ReceiptButton } from "./ReceiptButton";
```

Extend `Props` (after line 21, before the closing brace of the interface):

```ts
  onError: (msg: string) => void;
```

Destructure it in the function signature (lines 26-36):

```tsx
export function WeekCard({
  w,
  users,
  busy,
  onEntry,
  onDiscard,
  onPay,
  onReopen,
  onPush,
  onError,
  showActions = true,
}: Props) {
```

- [ ] **Step 2: Render the button in the paid-week footer**

In the `week-foot-a` block (lines 209-221), add `ReceiptButton` between `SplitwiseControl` and the `Reopen` button:

```tsx
{
  showActions && (
    <div className="week-foot-a">
      <SplitwiseControl settlement={w.settlement} missing={missing} busy={busy} onPush={onPush} />
      <ReceiptButton entries={w.entries} weekIds={[w.week_start]} onError={onError} />
      <button className="link" disabled={busy} onClick={onReopen}>
        Reopen
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Pass `onError` from `App.tsx`'s direct `WeekCard` usage**

In `src/App.tsx`, the unpaid-week `WeekCard` (around lines 425-457) never shows this button (`showActions` only matters once `w.paid`, and these weeks aren't paid), but the prop is required, so pass it for type consistency with every other required prop on this call:

```tsx
<WeekCard
  w={w}
  users={users}
  busy={busy}
  onEntry={(entry) => setEditing(entry)}
  onDiscard={(entry) =>
    setConfirm({
      title: "Discard this add?",
      body: "It was never fully split. Discarding removes it, and its money, from the week. This cannot be undone.",
      cta: "Discard",
      tone: "plain",
      onYes: () => handleDeleteEntry(entry),
    })
  }
  onPay={() =>
    setConfirm({
      title: "Mark this week paid?",
      body: `Paying ${money(w.total)}. Here is what makes it up — entries lock once paid, and you can reopen later.`,
      detail: (
        <SettleSummary entries={w.entries} users={users} weekIds={[w.week_start]} onError={flash} />
      ),
      cta: "Mark paid",
      tone: "go",
      onYes: () => handleMarkPaid(w.week_start),
    })
  }
  onPush={() => handlePush(w)}
  onReopen={() => confirmReopen(w)}
  onError={flash}
/>
```

(This block already changed in Task 5 — only the trailing `onError={flash}` line is new here; keep the `onError={flash}` already added to the nested `SettleSummary` from Task 5.)

- [ ] **Step 4: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: TypeScript errors at every other `WeekCard` usage inside `PaidHistory.tsx` (two of them — the single-week and grouped-week call sites — missing the new required `onError` prop) — expected at this point, resolved in Task 7. Confirm the errors are exactly those two and nothing else.

- [ ] **Step 5: Commit**

```bash
git add src/components/WeekCard.tsx src/App.tsx
git commit -m "feat: add Generate image to a paid week's own actions"
```

---

### Task 7: Wire into `PaidHistory` (settlement groups) and finish prop threading

**Files:**

- Modify: `src/components/PaidHistory.tsx`
- Modify: `src/App.tsx:462-481` (the `PaidHistory` usage)

**Interfaces:**

- Consumes: `ReceiptButton` (Task 4); `WeekCard`'s now-required `onError` prop (Task 6).
- Produces: `PaidHistory`'s `Props` gains `onError: (msg: string) => void`.

- [ ] **Step 1: Add the prop and import**

In `src/components/PaidHistory.tsx`, add the import (after line 7):

```ts
import { ReceiptButton } from "./ReceiptButton";
```

Extend `Props` (after line 18, before the closing brace):

```ts
  onError: (msg: string) => void;
```

Destructure it in the function signature (lines 43-53):

```tsx
export function PaidHistory({
  paidCount,
  historyLoaded,
  loadingHistory,
  paid,
  users,
  busy,
  onExpand,
  onReopen,
  onPush,
  onError,
}: Props) {
```

- [ ] **Step 2: Pass `onError` to the single-week `WeekCard`**

In the `group.length === 1` branch (lines 89-106), add `onError={onError}` to the `WeekCard`:

```tsx
<WeekCard
  w={w}
  users={users}
  busy={busy}
  onEntry={() => {}}
  onDiscard={() => {}}
  onPay={() => {}}
  onPush={() => onPush(w)}
  onReopen={() => onReopen(w.week_start)}
  onError={onError}
/>
```

- [ ] **Step 3: Add the group-level `ReceiptButton` and pass `onError` to the grouped `WeekCard`s**

In the multi-week branch, add `ReceiptButton` into `settlement-group-a` (lines 122-136) after `SplitwiseControl` and before the `Reopen` button:

```tsx
<div className="settlement-group-a">
  <SplitwiseControl
    settlement={settlement}
    missing={missing}
    busy={busy}
    onPush={() => onPush(group[0])}
  />
  <ReceiptButton
    entries={groupEntries}
    weekIds={group.map((w) => w.week_start)}
    onError={onError}
  />
  <button className="link" disabled={busy} onClick={() => onReopen(group[0].week_start)}>
    Reopen
  </button>
</div>
```

Then in the `group.map((w) => ...)` loop just below it (lines 138-151), add `onError={onError}` to that `WeekCard` too:

```tsx
{
  group.map((w) => (
    <WeekCard
      key={w.week_start}
      w={w}
      users={users}
      busy={busy}
      onEntry={() => {}}
      onDiscard={() => {}}
      onPay={() => {}}
      onPush={() => {}}
      onReopen={() => {}}
      onError={onError}
      showActions={false}
    />
  ));
}
```

- [ ] **Step 4: Pass `onError` from `App.tsx`'s `PaidHistory` usage**

In `src/App.tsx`, around line 462:

```tsx
<PaidHistory
  paidCount={paidCount}
  historyLoaded={historyLoaded}
  loadingHistory={loadingHistory}
  paid={paid}
  users={users}
  busy={busy}
  onExpand={() => {
    loadHistory().catch(() => {});
  }}
  onReopen={(weekId) => {
    const w = paid.find((x) => x.week_start === weekId);
    if (w) confirmReopen(w);
  }}
  onPush={(w) => handlePush(w)}
  onError={flash}
/>
```

- [ ] **Step 5: Typecheck, lint, and run the full test suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: no errors, all tests pass — this is the point where every `WeekCard`/`SettleSummary`/`PaidHistory` call site in the app has the new prop, so no leftover type errors from Task 6 should remain.

- [ ] **Step 6: Commit**

```bash
git add src/components/PaidHistory.tsx src/App.tsx
git commit -m "feat: add Generate image to paid history's settlement groups"
```

---

### Task 8: End-to-end manual verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full automated check**

Run: `npm run typecheck && npm run lint && npm test`
Expected: everything passes.

- [ ] **Step 2: Start the app**

Run: `npm run dev`, open the printed local URL in a browser.

- [ ] **Step 3: Verify a single default-rate week**

Add a few chapatis across 2-3 different days at the default price only (plain quantity, no `x` price). Click "Mark paid" and generate the image from `SettleSummary`. Confirm: one row per day, no rate sub-lines anywhere, correct total quantity and amount at the bottom, and either a share sheet opens or a PNG downloads.

- [ ] **Step 4: Verify a custom-rate week**

On another open week, add entries using both the plain form (`e.g. "20"`) and the `qty x price` form (e.g. `"10x0.75"`) on the same day, plus a day that's entirely one custom rate. Generate the image again. Confirm: the mixed day shows both rate sub-lines with correct qty/amount each, the all-custom day shows its single sub-line too, and an unrelated plain-default-rate day in the same image has no sub-lines.

- [ ] **Step 5: Verify a multi-week settlement**

With two or more open weeks, use "Settle all" and generate the image from that confirm dialog. Confirm the image merges all covered weeks' days into one chronological list (oldest date at the top across week boundaries, not grouped by week) and the header's date range spans the full settlement.

- [ ] **Step 6: Verify the Paid History entry points**

Open the History section. For a single standalone paid week, confirm "Generate image" appears next to Reopen and reproduces that week's image. For a group of weeks settled together, confirm the button appears once in the group header (not once per week) and produces the combined image.

- [ ] **Step 7: Verify the cancel path**

On a device/browser where the share sheet appears, open it and dismiss it without sharing. Confirm no error toast appears (the app should treat a cancelled share as a no-op, not a failure).

- [ ] **Step 8: Stop the dev server**

No further action needed once verification passes — nothing to commit from this task.
