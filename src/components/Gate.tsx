import { useEffect, useRef, useState } from "react";
import { Roti } from "./icons";

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 30_000;

interface Props {
  onSubmit: (name: string) => boolean;
  entryCode?: string;
}

export function Gate({ onSubmit, entryCode }: Props) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [err, setErr] = useState<"name" | "code" | "locked" | null>(null);
  const [lockUntil, setLockUntil] = useState(0);
  const [countdown, setCountdown] = useState(0);
  const attempts = useRef(0);

  // countdown timer while locked
  useEffect(() => {
    if (lockUntil <= Date.now()) return;
    const tick = () => {
      const left = Math.ceil((lockUntil - Date.now()) / 1000);
      if (left <= 0) {
        setCountdown(0);
        setErr(null);
      } else {
        setCountdown(left);
      }
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [lockUntil]);

  const locked = countdown > 0;

  const go = () => {
    if (locked) return;
    setErr(null);
    if (entryCode && code !== entryCode) {
      attempts.current++;
      if (attempts.current >= MAX_ATTEMPTS) {
        attempts.current = 0;
        setLockUntil(Date.now() + LOCKOUT_MS);
        setErr("locked");
      } else {
        setErr("code");
      }
      return;
    }
    // code is correct — reset attempts
    attempts.current = 0;
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
          disabled={locked}
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
              className={"in gate-in gate-code" + (err === "code" || err === "locked" ? " bad" : "")}
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="off"
              maxLength={4}
              placeholder="- - - -"
              value={code}
              disabled={locked}
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
            {err === "locked" && (
              <div className="gate-err">
                Too many attempts. Try again in {countdown}s.
              </div>
            )}
          </>
        )}
        <button className="btn btn-solid wide" onClick={go} disabled={locked}>
          {locked ? `Locked (${countdown}s)` : "Open the khata"}
        </button>
      </div>
      <div className="gate-foot">
        Your name is your key — keep this link between us.
      </div>
    </div>
  );
}
