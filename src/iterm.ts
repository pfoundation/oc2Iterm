/**
 * iTerm2 Session Status (OSC 21337) and progress (OSC 9;4) escape sequences.
 *
 * https://iterm2.com/documentation-session-status.html
 *
 * A status write is a full snapshot: every key is always present and an empty
 * value clears that field, so a write can never leave a stale dot or detail
 * behind from a previous state.
 */

export const ESC = "\x1b";
export const BEL = "\x07";
export const OSC_21337 = `${ESC}]21337;`;
/** DCS introducer used to wrap a sequence for tmux passthrough. */
export const DCS_TMUX_PREFIX = `${ESC}Ptmux;`;
export const ST_STRING = `${ESC}\\`;
/** Save/restore both titles because OSC 0 updates both, including tmux's pane title. */
export const SAVE_TITLE = `${ESC}[22;0t`;
export const RESTORE_TITLE = `${ESC}[23;0t`;

/** OSC 0 sets iTerm2's session name and tmux's pane title; tmux ignores OSC 1. */
export function buildTitleSequence(title: string): string {
  const safe = title
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 256);
  return `${ESC}]0;${safe}${BEL}`;
}

export type ItermFields = {
  /** Subtitle text shown below the tab name. */
  status: string;
  /** Dot indicator color, `#rrggbb`. Empty clears it. */
  indicator?: string;
  /** Subtitle text color, `#rrggbb`. Empty clears it. */
  statusColor?: string;
  /** Extra text shown in the Session Status tool and Cockpit. Empty clears it. */
  detail?: string;
};

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export function isHexColor(value: string): boolean {
  return HEX_COLOR.test(value);
}

/**
 * Make a value safe for the `;`-separated OSC 21337 payload: strip control
 * characters (which could break out of the sequence), replace `;` so it can
 * never be mistaken for a field separator, collapse whitespace, and cap the
 * length so paths and error messages stay readable in the tab.
 */
export function sanitizeField(value: string, maxLength: number): string {
  return value
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/;/g, ":")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, Math.max(0, maxLength));
}

function sanitizeColor(value: string | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  return isHexColor(trimmed) ? trimmed : "";
}

export function buildStatusSequence(fields: ItermFields): string {
  const status = sanitizeField(fields.status, 64);
  const indicator = sanitizeColor(fields.indicator);
  const statusColor = sanitizeColor(fields.statusColor);
  const detail = sanitizeField(fields.detail ?? "", 120);
  return (
    `${OSC_21337}status=${status};` +
    `indicator=${indicator};` +
    `status-color=${statusColor};` +
    `detail=${detail}${BEL}`
  );
}

/** Sequence that clears every status field. */
export function buildClearSequence(): string {
  return buildStatusSequence({ status: "" });
}

/** Native progress: clear, error, indeterminate, or paused (no percentage). */
export function buildProgressSequence(state: 0 | 2 | 3 | 4): string {
  return `${ESC}]9;4;${state}${BEL}`;
}

/**
 * Wrap a sequence in tmux's DCS passthrough form so plain-tmux clients forward
 * it to the outer terminal (requires `allow-passthrough`). Every ESC inside
 * the wrapped payload must be doubled. `levels` supports nested tmux
 * sessions; each level doubles the ESCs again.
 */
export function wrapTmuxPassthrough(sequence: string, levels = 1): string {
  let payload = sequence;
  for (let i = 0; i < Math.max(1, levels); i++) {
    payload = `${DCS_TMUX_PREFIX}${payload.replaceAll(ESC, ESC + ESC)}${ST_STRING}`;
  }
  return payload;
}
