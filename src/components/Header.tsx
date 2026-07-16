import { cap } from "../lib/util";
import { IcDownload, IcRefresh, Roti } from "./icons";

interface Props {
  loading: boolean;
  userName: string;
  onExport: () => void;
  onRefresh: () => void;
  onUserClick: () => void;
}

export function Header({ loading, userName, onExport, onRefresh, onUserClick }: Props) {
  return (
    <header className="hdr">
      <div className="brand">
        <Roti size={26} />
        <div>
          <div className="brand-name">Chapati Khata</div>
        </div>
      </div>
      <div className="hdr-r">
        <button className="icon-btn" onClick={onExport} aria-label="Download backup">
          <IcDownload className="ic" />
        </button>
        <button className="icon-btn" onClick={onRefresh} aria-label="Refresh" disabled={loading}>
          <IcRefresh className={"ic" + (loading ? " spin" : "")} />
        </button>
        <button className="who" onClick={onUserClick}>
          {cap(userName)}
        </button>
      </div>
    </header>
  );
}
