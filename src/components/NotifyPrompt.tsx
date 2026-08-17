import { IcBell, IcShare, IcX } from "./icons";

interface Props {
  show: boolean;
  needsHomeScreen: boolean;
  busy: boolean;
  onEnable: () => void;
  onDismiss: () => void;
}

/**
 * A dismissible card inviting this device to turn notifications on.
 *
 * Deliberately shaped like `InstallPrompt` — same card, same dismiss — because
 * on iOS the two are the same errand: Web Push reaches an iPhone only from the
 * Home Screen, so there the card teaches the install step instead of offering
 * a button that cannot work.
 */
export function NotifyPrompt({ show, needsHomeScreen, busy, onEnable, onDismiss }: Props) {
  if (!show) return null;

  return (
    <div className="install notify" role="region" aria-label="Turn on notifications">
      <button className="install-x" onClick={onDismiss} aria-label="Dismiss">
        <IcX className="ic sm" />
      </button>
      <div className="install-mark">
        <IcBell className="ic" />
      </div>
      <div className="install-body">
        <div className="install-t">Get told when something changes</div>
        {needsHomeScreen ? (
          <div className="install-s">
            On iPhone this needs the app on your Home Screen first. Tap{" "}
            <IcShare className="ic sm install-inline" aria-label="the Share button" /> Share, then{" "}
            <b>Add to Home Screen</b>, and open it from there.
          </div>
        ) : (
          <div className="install-s">
            A nudge when someone adds chapatis or settles the week. Never the amounts.
          </div>
        )}
      </div>
      {!needsHomeScreen && (
        <button
          className="btn btn-solid install-cta"
          onClick={onEnable}
          disabled={busy}
          aria-label="Turn on notifications"
        >
          <IcBell className="ic sm" />
          {busy ? "…" : "Turn on"}
        </button>
      )}
    </div>
  );
}
