# Payment receipt image — design

## 1. Problem

When a payment is settled here, the numbers only ever live inside the app.
Telling the other person what a payment covers means retyping it by hand into
a chat. This adds a "Generate image" action that turns a settlement's entries
into a single shareable picture — day-by-day quantity and amount, with any
custom-rate adds called out — so the receipt itself can be sent, not
retyped.

## 2. What this is not

- **Not automatic.** Nothing generates on its own when a week is paid; it's a
  button the user presses, same trigger model as Push to Splitwise.
- **Not a per-person breakdown.** The image only shows day totals. Per-person
  splits already exist in the app itself (`SettleSummary`, `WeekCard`) for
  whoever needs them; the image is the "here's what this payment was for"
  artifact, not a replacement for the ledger.
- **Not server-rendered.** Drawn entirely client-side on `<canvas>`; no new
  edge function, no dependency on Splitwise's push/pull machinery.
- **Not paginated.** A long multi-week payment just produces one tall image.

## 3. Decisions

### 3.1 What the image shows

One row per calendar day covered by the settlement, oldest first (a bill
reads top-to-bottom forward in time — the opposite of the app's own
newest-first lists, which are for scanning what's recent):

```
Wed Jul 21           30      $22.50
Thu Jul 22           25      $12.50
  20 @ $0.75
   5 @ $1.00
...
```

A day is a single row (date, total qty, total amount) unless its adds carry
more than one distinct rate, or a single rate that isn't `DEFAULT_PRICE` — in
either case, indented sub-lines break the day down by rate: `qty @ rate`, one
line per distinct rate present that day. This is the same logic already
implicit in `WeekCard`'s per-add `{qty} @ {rate}` line (`WeekCard.tsx:118-120`),
just aggregated per rate per day instead of per add.

Header: "Chapati Khata" + the Roti mark, and the date range covered
(`weekLabel` for one week, the existing multi-week range builder from the
Splitwise work for several). Footer: day count, total quantity, grand total.
A small timestamp line notes when the image was generated.

Guest/unclaimed chapatis (`other_qty`) need no special handling — they're
already folded into each entry's `qty`/`amount`, which is all the image reads.
Per-person shares (`entry_shares`) are never read, so an entry mid-repair
(`needsRepair`) doesn't block image generation the way it would block a push.

### 3.2 Rendering: canvas, not DOM snapshot

Drawn programmatically on `<canvas>` rather than rasterizing existing markup
(e.g. `html2canvas`). A snapshot approach would need a hidden, fully-styled
DOM tree kept in sync with `SettleSummary`/`WeekCard`, and is more prone to
font-loading and layout quirks across browsers; drawing directly gives full
control over a fixed, receipt-shaped layout and needs no new dependency.

Visual style is pulled from the app's existing tokens (`styles.css`) rather
than invented fresh: `--paper` background, `--ink` text, `--marigold`/
`--marigold-deep` for the header accent, `Bricolage Grotesque` for
headings/dates, `Space Mono` for every number — matching how the app itself
already reserves mono exclusively for numeric columns
(`.row-amt`, `.share-qty`, `.add-line-qty`, etc.). Canvas is a fixed logical
width (~720px), scaled by `devicePixelRatio` for crisp output on phone
screens, with height computed from the row count — no fixed canvas height, no
cropping.

Both custom fonts are loaded via Google Fonts (`index.html:9-12`); rendering
awaits `document.fonts.ready` (plus an explicit `document.fonts.load(...)`
for the two weights actually used) before drawing, so a cold cache can't
silently fall back to the browser default font mid-receipt.

### 3.3 Entry points

Two buttons, one shared implementation:

- **`SettleSummary`** — a "Generate image" button alongside the existing
  show/hide days control, using the same `entries`/`weekIds` props already
  passed in. Available at the moment of Mark Paid / Settle All, before the
  action is even confirmed, since the entries being paid are already fully
  known at that point.
- **`PaidHistory`** — one button per settlement group (`groupBySettlement`),
  so a past payment's image can be (re)generated anytime: placed next to
  Reopen/`SplitwiseControl` for multi-week groups (`PaidHistory.tsx:122-136`),
  and on the single-week path (`PaidHistory.tsx:89-106`) alongside `WeekCard`.

Both call one function, `renderReceiptImage(entries: Entry[], weekIds:
string[]): Promise<Blob>`, so the layout logic exists exactly once.

### 3.4 Getting the image out

`navigator.share` with a `files` array, when supported (`navigator.canShare`
checked first) — opens the OS share sheet directly, e.g. straight to
WhatsApp on mobile. Falls back to a plain anchor-tag download
(`URL.createObjectURL` + `download` attribute) wherever the Web Share API or
file sharing isn't available, which today is effectively "desktop browsers."
No separate "copy image" path — the two above cover both the mobile-share
and the desktop-download case this app's users actually hit.

Filename / share text: `chapati-khata_<range>.png`, e.g.
`chapati-khata_jul21-27.png`, built from the same date-range label shown in
the header.

## 4. Non-goals / accepted trade-offs

- **Not localized/multi-currency.** Uses `CURRENCY`/`money()` exactly as the
  rest of the app does today.
- **No image caching or storage.** Every generation re-renders from scratch;
  nothing is written to Supabase or kept after the browser tab closes. Cheap
  enough client-side that this isn't worth persisting.
- **No visual regression testing.** Canvas output correctness is verified by
  eye during implementation; the day/rate aggregation logic that feeds it
  gets unit tests (below), not the pixels themselves.

## 5. Testing

- **Pure logic in `src/lib`**, covered by vitest same as the rest of
  `aggregate.ts`: the new day/rate-breakdown helper — uniform-default-rate
  days collapse to one row, multi-rate and single-custom-rate days produce
  the right per-rate sub-lines, and multi-week entry lists sort chronologically
  across week boundaries.
- **Canvas drawing itself** is exercised manually (generate an image for a
  single default-rate week, a week with custom rates, and a multi-week
  settlement) rather than under vitest, consistent with this project's
  existing posture toward code that talks to a browser API vitest doesn't
  model (`splitwise` edge function has the same exemption, per the Splitwise
  design doc §11).
