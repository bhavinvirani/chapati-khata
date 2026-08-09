import { SURFACES } from "./surfaces/index.mjs";
import { digestMatches } from "./surfaces/supabase.mjs";

const MAX_SHOWN = 12;

export function maskValue(setting, value) {
  if (setting.secret) return "••••";
  const text = String(value);
  return text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN)}…` : text;
}

export function sinceText(iso, now = new Date()) {
  const days = Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000);
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
      return;
    }
    present.push(surface.label);

    if (state.known) {
      parts.push(maskValue(setting, state.value));
    } else if (state.digest && localValue !== null) {
      if (digestMatches(state.digest, localValue)) {
        parts.push(`${surface.label} ✓ matches`);
      } else {
        differs = true;
        parts.push(`${surface.label} ✓ ${sinceText(state.updatedAt, now)} — DIFFERENT`);
      }
    } else {
      parts.push(`${surface.label} set · ${sinceText(state.updatedAt, now)}`);
    }
  });

  if (present.length === 0 && blocked.length === 0) return { text: "not set", warning: null };
  // Nothing present and nothing confirmed absent either — every target was blocked.
  if (present.length === 0 && absent.length === 0) return { text: "not checked", warning: null };

  // A target we couldn't check is not evidence of drift: suppress the
  // warning rather than accuse a setting of being unset or disagreeing when
  // we simply never asked.
  let warning = null;
  if (blocked.length === 0) {
    if (absent.length > 0) {
      warning = `${setting.label} is set in ${present.join(", ")} but not set in ${absent.join(", ")}.`;
    } else if (differs) {
      warning = `${setting.label} differs between ${present.join(" and ")}.`;
    }
  }

  // "· both" is earned only when every target of a multi-target setting is
  // present, checked, and nothing disagrees.
  const complete =
    setting.targets.length > 1 && absent.length === 0 && blocked.length === 0 && !differs;
  const text = complete ? `${parts.join(" · ")} · both` : parts.join(" · ");

  return { text, warning };
}
