import { IcDownload, IcShare, IcX } from "./icons";
import { Roti } from "./icons";
import { useInstallPrompt } from "../hooks/useInstallPrompt";

/**
 * A dismissible card inviting the user to install the app to their home
 * screen. On Android/desktop it triggers the native install dialog; on iOS
 * Safari (no programmatic prompt) it shows the manual Share → "Add to Home
 * Screen" steps. Renders nothing when already installed or dismissed.
 */
export function InstallPrompt() {
  const { show, canPrompt, ios, promptInstall, dismiss } = useInstallPrompt();

  if (!show) return null;

  return (
    <div className="install" role="region" aria-label="Install app">
      <button className="install-x" onClick={dismiss} aria-label="Dismiss">
        <IcX className="ic sm" />
      </button>
      <div className="install-mark">
        <Roti size={30} />
      </div>
      <div className="install-body">
        <div className="install-t">Add to your Home Screen</div>
        {canPrompt ? (
          <div className="install-s">Install Chapati Khata for one-tap access, like an app.</div>
        ) : ios ? (
          <div className="install-s">
            Tap <IcShare className="ic sm install-inline" aria-label="the Share button" /> Share,
            then <b>Add to Home Screen</b>.
          </div>
        ) : null}
      </div>
      {canPrompt && (
        <button className="btn btn-solid install-cta" onClick={promptInstall}>
          <IcDownload className="ic sm" />
          Install
        </button>
      )}
    </div>
  );
}
