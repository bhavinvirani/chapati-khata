import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;

const Base = (props: P) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.9}
    strokeLinecap="round"
    strokeLinejoin="round"
    {...props}
  />
);

export const IcRefresh = (p: P) => (
  <Base {...p}>
    <path d="M21 12a9 9 0 1 1-2.6-6.36M21 4v5h-5" />
  </Base>
);
export const IcCheck = (p: P) => (
  <Base {...p}>
    <path d="M20 6 9 17l-5-5" />
  </Base>
);
export const IcLock = (p: P) => (
  <Base {...p}>
    <rect x="4.5" y="11" width="15" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </Base>
);
export const IcPlus = (p: P) => (
  <Base {...p}>
    <path d="M12 5v14M5 12h14" />
  </Base>
);
export const IcX = (p: P) => (
  <Base {...p}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Base>
);
export const IcPencil = (p: P) => (
  <Base {...p}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </Base>
);
export const IcTrash = (p: P) => (
  <Base {...p}>
    <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
  </Base>
);
export const IcDownload = (p: P) => (
  <Base {...p}>
    <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" />
  </Base>
);

/** Roti disc — the signature mark. */
export function Roti({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="var(--marigold-tint)" stroke="var(--marigold-deep)" strokeWidth="1.4" />
      <circle cx="9" cy="10" r="1.15" fill="var(--marigold-deep)" />
      <circle cx="14.5" cy="9.5" r="0.8" fill="var(--marigold-deep)" />
      <circle cx="13" cy="14.5" r="1.05" fill="var(--marigold-deep)" />
      <circle cx="8.5" cy="14" r="0.7" fill="var(--marigold-deep)" />
    </svg>
  );
}
