import { useState } from "react";
import { Roti } from "./icons";

interface Props {
  onSubmit: (name: string) => boolean;
  entryCode?: string;
}

export function Gate({ onSubmit, entryCode }: Props) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [err, setErr] = useState<"name" | "code" | null>(null);

  const go = () => {
    setErr(null);
    if (entryCode && code !== entryCode) {
      setErr("code");
      return;
    }
    if (!onSubmit(name)) {
      setErr("name");
      return;
    }
  };

  return (
    <div className="gate">
      <div className="gate-card">
        <Roti size={44} />
        <h1 className="gate-t">Chapati Khata</h1>
        <p className="gate-s">
          The shared tab for the group's roti orders. Type your first name to open it.
        </p>
        <input
          className={"in gate-in" + (err === "name" ? " bad" : "")}
          placeholder="Your first name"
          value={name}
          autoFocus
          autoComplete="off"
          onChange={(e) => {
            setName(e.target.value);
            setErr(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") go();
          }}
          aria-label="Your first name"
        />
        {err === "name" && (
          <div className="gate-err">
            Not allowed. Check the spelling, or ask to be added.
          </div>
        )}
        {entryCode && (
          <>
            <input
              className={"in gate-in gate-code" + (err === "code" ? " bad" : "")}
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="off"
              maxLength={4}
              placeholder="- - - -"
              value={code}
              onChange={(e) => {
                setCode(e.target.value.replace(/[^0-9]/g, "").slice(0, 4));
                setErr(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") go();
              }}
              aria-label="Access code"
            />
            {err === "code" && (
              <div className="gate-err">Wrong access code.</div>
            )}
          </>
        )}
        <button className="btn btn-solid wide" onClick={go}>
          Open the khata
        </button>
      </div>
      <div className="gate-foot">
        No password — the name is the key. Do not share this link with anyone.
      </div>
    </div>
  );
}
