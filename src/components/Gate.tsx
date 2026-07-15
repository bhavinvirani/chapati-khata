import { useState } from "react";
import { Roti } from "./icons";

export function Gate({ onSubmit }: { onSubmit: (name: string) => boolean }) {
  const [name, setName] = useState("");
  const [err, setErr] = useState(false);

  const go = () => {
    if (!onSubmit(name)) setErr(true);
  };

  return (
    <div className="gate">
      <div className="gate-card">
        <Roti size={44} />
        <h1 className="gate-t">Chapati Khata</h1>
        <p className="gate-s">
          The shared tab for the group’s roti orders. Type your name to open it.
        </p>
        <input
          className={"in gate-in" + (err ? " bad" : "")}
          placeholder="Your name"
          value={name}
          autoFocus
          onChange={(e) => {
            setName(e.target.value);
            setErr(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") go();
          }}
          aria-label="Your name"
        />
        {err && (
          <div className="gate-err">
            That name isn’t on the list. Check the spelling, or ask to be added.
          </div>
        )}
        <button className="btn btn-solid wide" onClick={go}>
          Open the khata
        </button>
      </div>
      <div className="gate-foot">
        No password — the name is the key. Keep the link inside the group.
      </div>
    </div>
  );
}
