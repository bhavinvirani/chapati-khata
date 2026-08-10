import { SURFACES } from "./surfaces/index.mjs";
import { digestMatches } from "./surfaces/supabase.mjs";

const MAX_SHOWN = 12;

export function maskValue(setting, value) {
  if (setting.secret) return "••••";
  const text = String(value);
  return text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN)}…` : text;
}

export function sinceText(iso, now = new Date()) {
  // A surface that reports a secret with no timestamp used to render "NaNd
  // ago". null needs its own guard: new Date(null) is the epoch, not NaN,
  // which would render as "20674d ago" instead.
  if (iso === null || iso === undefined) return "unknown";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "unknown";
  const days = Math.floor((now.getTime() - then) / 86_400_000);
  return days <= 0 ? "today" : `${days}d ago`;
}

/**
 * One line of state for a setting, plus an optional warning.
 * `states` is aligned index-for-index with `setting.targets`.
 */
export function describeSetting(setting, states, now = new Date()) {
  const present = [];
  const absent = [];
  const blocked = [];
  const invalid = [];
  const parts = [];
  let differs = false;

  // A locally readable value, if any — the only thing a digest can be compared against.
  const local = states.find((s) => s.known && s.present);
  const localValue = local ? local.value : null;

  states.forEach((state, i) => {
    const surface = SURFACES[setting.targets[i].surface];

    // Blocked means the surface couldn't be read at all — its own probe
    // failed, or another surface upstream did. Absence you couldn't verify
    // is not evidence of absence, so this is neither present nor absent.
    if (state.blocked) {
      blocked.push(surface.label);
      parts.push(`${surface.label} — not checked`);
      return;
    }

    if (!state.present) {
      absent.push(surface.label);
      // Name the surface that is empty too: with only the blocked one in
      // `parts`, ".env empty + Supabase unreachable" rendered as though .env
      // had never been looked at.
      parts.push(`${surface.label} — not set`);
      return;
    }

    if (state.known) {
      // Validators used to run on typed input only, so a value copied
      // straight out of .env.example read back as configured. Anything we
      // can actually see the plaintext of gets checked.
      const result = setting.validate(state.value);
      if (!result.ok) {
        // `warn` is accept-with-caveat (an unrecognised but plausible key
        // shape); only ok:false means the value cannot be right.
        invalid.push({ surface, reason: result.reason });
        const shown = maskValue(setting, state.value);
        parts.push(
          setting.targets.length > 1
            ? `${surface.label} ${shown} — looks wrong`
            : `${shown} — looks wrong`,
        );
        return;
      }
      present.push(surface.label);
      parts.push(maskValue(setting, state.value));
      return;
    }

    present.push(surface.label);
    if (state.digest && localValue !== null) {
      if (digestMatches(state.digest, localValue)) {
        parts.push(`${surface.label} ✓ matches`);
      } else {
        differs = true;
        parts.push(`${surface.label} ⚠ ${sinceText(state.updatedAt, now)} — DIFFERENT`);
      }
    } else {
      parts.push(`${surface.label} set · ${sinceText(state.updatedAt, now)}`);
    }
  });

  if (present.length === 0 && blocked.length === 0 && invalid.length === 0) {
    return { text: "not set", warning: null };
  }
  // Nothing present and nothing confirmed absent either — every target was blocked.
  if (present.length === 0 && absent.length === 0 && invalid.length === 0) {
    return { text: "not checked", warning: null };
  }

  // A target we couldn't check is not evidence of drift: suppress the
  // warning rather than accuse a setting of being unset or disagreeing when
  // we simply never asked. A value we did read and that does not validate is
  // evidence, though, so it outranks — and is never suppressed by — the rest.
  let warning = null;
  if (invalid.length > 0) {
    warning = invalid
      .map((i) => `${setting.label} in ${i.surface.label} looks wrong — ${i.reason}.`)
      .join(" ");
  } else if (blocked.length === 0) {
    if (absent.length > 0) {
      warning = `${setting.label} is set in ${present.join(", ")} but not set in ${absent.join(", ")}.`;
    } else if (differs) {
      warning = `${setting.label} differs between ${present.join(" and ")}.`;
    }
  }

  // "· both" is earned only when every target of a multi-target setting is
  // present, checked, valid, and nothing disagrees.
  const complete =
    setting.targets.length > 1 &&
    absent.length === 0 &&
    blocked.length === 0 &&
    invalid.length === 0 &&
    !differs;
  const text = complete ? `${parts.join(" · ")} · both` : parts.join(" · ");

  return { text, warning };
}
