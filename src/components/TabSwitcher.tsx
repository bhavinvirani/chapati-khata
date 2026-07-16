type Tab = "ledger" | "log";

interface Props {
  tab: Tab;
  onTabChange: (tab: Tab) => void;
}

export function TabSwitcher({ tab, onTabChange }: Props) {
  return (
    <div className="seg" role="tablist">
      <button
        role="tab"
        aria-selected={tab === "ledger"}
        className={"seg-b" + (tab === "ledger" ? " on" : "")}
        onClick={() => onTabChange("ledger")}
      >
        Ledger
      </button>
      <button
        role="tab"
        aria-selected={tab === "log"}
        className={"seg-b" + (tab === "log" ? " on" : "")}
        onClick={() => onTabChange("log")}
      >
        Log
      </button>
    </div>
  );
}
