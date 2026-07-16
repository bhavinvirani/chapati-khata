import { useEffect, useRef, useState } from "react";
import { Roti } from "./icons";

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 30_000;

type GateError = "name" | "code" | "network" | null;

interface Props {
  /** Validate name + code. Return null on success, or the error key. */
  onSubmit: (name: string, code: string) => Promise<GateError>;
}

export function Gate({ onSubmit }: Props) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [err, setErr] = useState<GateError | "locked">(null);
  const [loading, setLoading] = useState(false);
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

  const go = async () => {
    if (locked || loading) return;
    setErr(null);
    setLoading(true);
    try {
      const result = await onSubmit(name, code);
      if (!result) return; // success — parent handles navigation
      if (result === "code") {
        attempts.current++;
        if (attempts.current >= MAX_ATTEMPTS) {
          attempts.current = 0;
          setLockUntil(Date.now() + LOCKOUT_MS);
          setErr("locked");
        } else {
          setErr("code");
        }
      } else {
        setErr(result);
      }
    } catch {
      setErr("network");
    } finally {
      setLoading(false);
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
          disabled={locked || loading}
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
        <input
          className={"in gate-in gate-code" + (err === "code" || err === "locked" ? " bad" : "")}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="off"
          maxLength={4}
          placeholder="- - - -"
          value={code}
          disabled={locked || loading}
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
        {err === "network" && (
          <div className="gate-err">
            Can't reach the server. Check your connection.
          </div>
        )}
        <button className="btn btn-solid wide" onClick={go} disabled={locked || loading}>
          {locked ? `Locked (${countdown}s)` : loading ? "Checking\u2026" : "Open the khata"}
        </button>
      </div>
      <div className="gate-foot">
        Your name is your key — keep this link between us.
      </div>
    </div>
  );
}
