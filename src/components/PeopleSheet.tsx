import { useState } from "react";
import type { User } from "../types";
import { canDelete, canRevokeLogin, sortPeople } from "../lib/people";
import * as db from "../lib/db";
import { cap, normalizeName } from "../lib/util";
import { IcTrash, IcX } from "./icons";

interface Props {
  users: User[];
  actor: string;
  busy: boolean;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
  onError: (message: string) => void;
  deviceId: string;
}

export function PeopleSheet({ users, actor, busy, onClose, onChanged, onError, deviceId }: Props) {
  const [newName, setNewName] = useState("");
  const [pendingDelete, setPendingDelete] = useState<User | null>(null);
  const [working, setWorking] = useState(false);
  const people = sortPeople(users);

  async function run(fn: () => Promise<void>) {
    if (working) return;
    setWorking(true);
    try {
      await fn();
      await onChanged();
    } catch {
      onError("Could not save that. Check your connection.");
    } finally {
      setWorking(false);
    }
  }

  async function handleAdd() {
    const clean = normalizeName(newName);
    if (!clean) return;
    if (people.some((p) => p.name === clean)) {
      onError(`${cap(clean)} is already on the list.`);
      return;
    }
    await run(async () => {
      await db.addPerson(clean, actor, deviceId);
      setNewName("");
    });
  }

  /**
   * Deletion is offered only once we know the person holds no history AND that
   * removing them would not revoke a login the group cannot afford to lose.
   *
   * The second check is not optional: deleting a row removes the name the gate
   * matches on, so it is a strict superset of clearing `can_login`. Without it
   * the sole login-holder — who, if they are out of the split, holds zero
   * shares forever — could delete themselves and lock the group out entirely.
   */
  async function askDelete(u: User) {
    if (u.can_login && !canRevokeLogin(u, actor, users)) {
      onError(
        u.name === actor
          ? "You cannot delete yourself while you can log in."
          : `${cap(u.name)} is the last person who can log in.`,
      );
      return;
    }
    let held: boolean;
    try {
      held = await db.hasShares(u.id);
    } catch {
      onError("Could not check that. Check your connection.");
      return;
    }
    if (!canDelete(held)) {
      onError(`${cap(u.name)} appears in past entries and cannot be deleted.`);
      return;
    }
    setPendingDelete(u);
  }

  const locked = busy || working;

  return (
    <div className="ovl" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" />
        <div className="sheet-head">
          <h3 className="sheet-t">People</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <IcX className="ic" />
          </button>
        </div>

        <div className="ppl-legend">
          <span>In split</span>
          <span>Can log in</span>
        </div>

        <ul className="ppl">
          {people.map((u) => {
            const mayRevoke = canRevokeLogin(u, actor, users);
            return (
              <li key={u.id} className="ppl-row">
                <span className="ppl-name">
                  {cap(u.name)}
                  {u.name === actor && <span className="ppl-you">you</span>}
                  {/* `title` never renders on a phone, and this is the sheet's
                      one safety-critical control — say why it is blocked. */}
                  {u.can_login && !mayRevoke && (
                    <span className="ppl-why">
                      {u.name === actor ? "can't remove your own access" : "last login"}
                    </span>
                  )}
                </span>

                <input
                  type="checkbox"
                  className="ppl-box"
                  checked={u.in_split}
                  disabled={locked}
                  onChange={(e) =>
                    run(() => db.setPersonFlag(u, "in_split", e.target.checked, actor, deviceId))
                  }
                  aria-label={`${u.name} in split`}
                />

                <input
                  type="checkbox"
                  className="ppl-box"
                  checked={u.can_login}
                  disabled={locked || (u.can_login && !mayRevoke)}
                  title={
                    u.can_login && !mayRevoke
                      ? u.name === actor
                        ? "You cannot revoke your own access"
                        : "Someone must be able to log in"
                      : undefined
                  }
                  onChange={(e) =>
                    run(() => db.setPersonFlag(u, "can_login", e.target.checked, actor, deviceId))
                  }
                  aria-label={`${u.name} can log in`}
                />

                <button
                  className="icon-btn"
                  disabled={locked || (u.can_login && !mayRevoke)}
                  onClick={() => askDelete(u)}
                  aria-label={`Delete ${u.name}`}
                >
                  <IcTrash className="ic sm" />
                </button>
              </li>
            );
          })}
        </ul>

        <label className="fld-l">Add someone</label>
        <div className="add-row">
          <input
            className="in"
            placeholder="First name"
            value={newName}
            autoComplete="off"
            disabled={locked}
            onChange={(e) => setNewName(e.target.value)}
            aria-label="New person's first name"
          />
          <button
            className="btn btn-solid"
            disabled={locked || !newName.trim()}
            onClick={handleAdd}
          >
            Add
          </button>
        </div>

        {pendingDelete && (
          <div className="del-confirm">
            <span>
              Delete {cap(pendingDelete.name)}? They have no entries, so no history is lost — but
              their access goes with them.
            </span>
            <div className="sheet-a">
              <button className="btn btn-ghost" onClick={() => setPendingDelete(null)}>
                Keep
              </button>
              <button
                className="btn btn-danger"
                disabled={locked}
                onClick={() =>
                  run(async () => {
                    await db.deletePerson(pendingDelete, actor, deviceId);
                    setPendingDelete(null);
                  })
                }
              >
                Delete
              </button>
            </div>
          </div>
        )}

        <div className="ppl-note">
          Turning off <b>In split</b> keeps someone's history and their access, but stops offering
          them when you add an entry. Turning off <b>Can log in</b> removes their access. Neither
          ever changes a past entry.
        </div>
      </div>
    </div>
  );
}
