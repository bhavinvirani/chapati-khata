import type { Confirm } from "../types";
import { IcX } from "./icons";

interface Props {
  confirm: Confirm;
  busy: boolean;
  onClose: () => void;
}

export function ConfirmDialog({ confirm, busy, onClose }: Props) {
  return (
    <div className="ovl" onClick={onClose}>
      <div className="dlg" onClick={(e) => e.stopPropagation()}>
        <div className="dlg-head">
          <h3 className="dlg-t">{confirm.title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <IcX className="ic" />
          </button>
        </div>
        <p className="dlg-b">{confirm.body}</p>
        <div className="dlg-a">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className={"btn " + (confirm.tone === "go" ? "btn-go" : "btn-solid")}
            disabled={busy}
            onClick={() => {
              const f = confirm.onYes;
              onClose();
              f();
            }}
          >
            {confirm.cta}
          </button>
        </div>
      </div>
    </div>
  );
}
