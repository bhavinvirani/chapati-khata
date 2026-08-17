import { useState } from "react";
import type { User } from "../types";
import { canDeletePerson, canRevokeLogin, sortPeople } from "../lib/people";
import * as db from "../lib/db";
import { cap, normalizeName } from "../lib/util";
import { IcBell, IcBellOff, IcRefresh, IcTrash, IcX } from "./icons";

interface Props {
  users: User[];
  actor: string;
  busy: boolean;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
  onError: (message: string) => void;
  deviceId: string;
  notify: NotifyControls;
}

/** The slice of usePushNotifications this sheet renders. App owns the hook so
 * the banner and this toggle never disagree about whether it is on. */
export interface NotifyControls {
  supported: boolean;
  needsHomeScreen: boolean;
  permission: NotificationPermission;
  enabled: boolean;
  busy: boolean;
  enable: () => Promise<boolean>;
  disable: () => Promise<boolean>;
}

/**
 * Notifications are a property of this phone, not of a person — the same
 * name signed in elsewhere is a separate switch — so this sits above the
 * people list in its own section rather than as a column in someone's row.
 */
function DeviceRow({ notify, onError }: { notify: NotifyControls; onError: (m: string) => void }) {
  if (!notify.supported) return null;

  const { needsHomeScreen, permission, enabled, busy } = notify;
  const blocked = permission === "denied";

  return (
    <div className="ppl-device">
      <span className="ppl-device-main">
        {enabled ? <IcBell className="ic sm" /> : <IcBellOff className="ic sm" />}
        <span>
          <span className="ppl-device-t">Notifications on this device</span>
          {needsHomeScreen && !enabled && (
            <span className="ppl-device-s">Add the app to your Home Screen first.</span>
          )}
          {blocked && !enabled && (
            <span className="ppl-device-s">Blocked — allow them in your browser settings.</span>
          )}
        </span>
      </span>
      <input
        type="checkbox"
        className="ppl-box"
        checked={enabled}
        disabled={busy || (!enabled && (needsHomeScreen || blocked))}
        onChange={async (e) => {
          if (!e.target.checked) {
            await notify.disable();
            return;
          }
          const ok = await notify.enable();
          // enable() swallows its own failures so the toggle can't get stuck;
          // this is the only place the user hears about it.
          if (!ok) onError("Could not turn notifications on. Check your browser's permissions.");
        }}
        aria-label="Notifications on this device"
      />
    </div>
  );
}

function EmailRow({
  user,
  disabled,
  onSave,
}: {
  user: User;
  disabled: boolean;
  onSave: (email: string) => Promise<void>;
}) {
  const [value, setValue] = useState(user.splitwise_email ?? "");
  const [checking, setChecking] = useState(false);
  const linked = !!user.splitwise_user_id;
  return (
    <div className="ppl-splitwise">
      <input
        className="in ppl-email"
        placeholder="Splitwise email"
        value={value}
        disabled={disabled || checking}
        autoComplete="off"
        onChange={(e) => setValue(e.target.value)}
        onBlur={async () => {
          const clean = value.trim();
          if (clean === (user.splitwise_email ?? "")) return;
          setChecking(true);
          try {
            await onSave(clean);
          } finally {
            setChecking(false);
          }
        }}
        aria-label={`${user.name}'s Splitwise email`}
      />
      {checking ? (
        <span className="ppl-linked checking">
          <IcRefresh className="ic sm spin" />
          Checking&hellip;
        </span>
      ) : (
        value && (
          <span className={"ppl-linked" + (linked ? " on" : "")}>
            {linked ? "Linked" : "Not linked"}
          </span>
        )
      )}
    </div>
  );
}

export function PeopleSheet({
  users,
  actor,
  busy,
  onClose,
  onChanged,
  onError,
  deviceId,
  notify,
}: Props) {
  const [newName, setNewName] = useState("");
  const [pendingDelete, setPendingDelete] = useState<User | null>(null);
  // The `hasShares` result askDelete already paid a network call for, held
  // alongside the pending person so the confirm button can re-run
  // canDeletePerson without re-fetching it.
  const [pendingHeld, setPendingHeld] = useState(false);
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
   *
   * `canDeletePerson` is the single source of truth for the yes/no; the two
   * branches below exist only to say *why* it was no, which a single boolean
   * can't do on its own.
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
    if (!canDeletePerson(u, actor, users, held)) {
      onError(`${cap(u.name)} appears in past entries and cannot be deleted.`);
      return;
    }
    setPendingDelete(u);
    setPendingHeld(held);
  }

  async function handleEmailSave(target: User, email: string) {
    const clean = email.trim();
    if (clean) {
      const dupe = people.find(
        (p) => p.id !== target.id && p.splitwise_email?.toLowerCase() === clean.toLowerCase(),
      );
      if (dupe) {
        onError(`That email is already linked to ${cap(dupe.name)}.`);
        return;
      }
    }
    await run(() => db.setSplitwiseEmail(target, clean));
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

        <DeviceRow notify={notify} onError={onError} />

        <div className="ppl-legend">
          <span>In split</span>
          <span>Can log in</span>
        </div>

        <ul className="ppl">
          {people.map((u) => {
            const mayRevoke = canRevokeLogin(u, actor, users);
            return (
              <li key={u.id} className="ppl-row">
                <div className="ppl-row-main">
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
                </div>
                <EmailRow
                  user={u}
                  disabled={locked}
                  onSave={(email) => handleEmailSave(u, email)}
                />
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
            disabled={locked || !normalizeName(newName)}
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
                onClick={() => {
                  // `pendingDelete` is a snapshot from when `askDelete` ran, and
                  // `canDeletePerson` branches on `target.can_login` from that
                  // snapshot. The confirm card can sit open long enough for
                  // another device to grant a login to a target that looked
                  // like a normal, `can_login: false` person at snapshot time
                  // while revoking every other login — which would let this
                  // check wave through deleting the group's last login-holder.
                  // Look the target up fresh by id and check that instead.
                  const live = users.find((u) => u.id === pendingDelete.id);
                  if (!live) {
                    setPendingDelete(null);
                    onError(`${cap(pendingDelete.name)} is already gone.`);
                    return;
                  }
                  if (!canDeletePerson(live, actor, users, pendingHeld)) {
                    setPendingDelete(null);
                    onError(
                      `${cap(live.name)} can no longer be deleted — access changed while this was open.`,
                    );
                    return;
                  }
                  run(async () => {
                    await db.deletePerson(live, actor, deviceId);
                    setPendingDelete(null);
                  });
                }}
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
