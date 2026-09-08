import { buildStatusSequence, type ItermFields } from "./iterm.js";

/** Agent states, ordered from highest to lowest display priority. */
export type AgentState = "waiting" | "working" | "error" | "idle";

export type StateText = Record<AgentState, string>;
export type StateColor = Record<AgentState, string>;

export type OcIterm2Options = {
  /** Master switch. When false the plugin clears any status and does nothing. */
  enabled?: boolean;
  /** Subtitle text per state. Lowercase matches iTerm2's default priority keywords. */
  text?: Partial<StateText>;
  /** Tab dot color per state (`#rrggbb`). */
  dot?: Partial<StateColor>;
  /** Subtitle text color (`#rrggbb`). Empty keeps iTerm2's default. */
  textColor?: string;
  /** Emit `detail` text (permission action, subagent count, error). Default true. */
  detail?: boolean;
  /**
   * tmux DCS-passthrough wrapping for the emitted sequence:
   * - `auto` (default): emit raw, plus a wrapped copy when `$TMUX` is set.
   * - `always`: always emit both raw and wrapped copies.
   * - `never`: raw only.
   */
  tmux?: "auto" | "always" | "never";
  /** DCS wrap depth for nested tmux sessions. Default 1. */
  tmuxLevels?: number;
  /** Recompute interval in ms (catches route switches and drift). Default 2000. */
  pollMs?: number;
  /** Force re-emit interval in ms (recovers after tmux reattach). Default 30000. */
  forceMs?: number;
  /** Append debug lines to /tmp/opencode/oc-iterm2.log. Default false. */
  debug?: boolean;
};

export type ResolvedOptions = {
  enabled: boolean;
  text: StateText;
  dot: StateColor;
  textColor: string;
  detail: boolean;
  tmux: "auto" | "always" | "never";
  tmuxLevels: number;
  pollMs: number;
  forceMs: number;
  debug: boolean;
};

export const DEFAULT_TEXT: StateText = {
  waiting: "waiting",
  working: "working",
  error: "error",
  idle: "idle",
};

export const DEFAULT_DOT: StateColor = {
  waiting: "#ff5f57",
  working: "#ffa500",
  error: "#ff0000",
  idle: "#8e8e93",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function pickString(source: unknown, fallback: string): string {
  return typeof source === "string" && source.length > 0 ? source : fallback;
}

function pickNumber(source: unknown, fallback: number, min: number): number {
  if (typeof source !== "number" || !Number.isFinite(source)) return fallback;
  return Math.max(min, source);
}

export function resolveOptions(raw: unknown): ResolvedOptions {
  const options: Record<string, unknown> = isRecord(raw) ? raw : {};
  const text = isRecord(options.text) ? options.text : {};
  const dot = isRecord(options.dot) ? options.dot : {};
  const tmux =
    options.tmux === "always" ||
    options.tmux === "never" ||
    options.tmux === "auto"
      ? options.tmux
      : "auto";
  return {
    enabled: options.enabled !== false,
    text: {
      waiting: pickString(text.waiting, DEFAULT_TEXT.waiting),
      working: pickString(text.working, DEFAULT_TEXT.working),
      error: pickString(text.error, DEFAULT_TEXT.error),
      idle: pickString(text.idle, DEFAULT_TEXT.idle),
    },
    dot: {
      waiting: pickString(dot.waiting, DEFAULT_DOT.waiting),
      working: pickString(dot.working, DEFAULT_DOT.working),
      error: pickString(dot.error, DEFAULT_DOT.error),
      idle: pickString(dot.idle, DEFAULT_DOT.idle),
    },
    textColor: typeof options.textColor === "string" ? options.textColor : "",
    detail: options.detail !== false,
    tmux,
    tmuxLevels: Math.min(
      3,
      Math.max(1, Math.floor(pickNumber(options.tmuxLevels, 1, 1))),
    ),
    pollMs: pickNumber(options.pollMs, 2000, 250),
    forceMs: pickNumber(options.forceMs, 30000, 1000),
    debug: options.debug === true,
  };
}

/** Point-in-time view of everything the status derivation needs. */
export type Snapshot = {
  /** Session shown by this TUI, if any. */
  currentID?: string | undefined;
  /** Sessions whose activity counts toward this TUI (current + subagents). */
  familyIDs: string[];
  /** Family members currently running. */
  runningIDs: string[];
  /** Pending permission requests across the family. */
  permissions: Array<{
    sessionID: string;
    action: string;
    resources: string[];
  }>;
  /** Pending forms across the family. */
  forms: Array<{ sessionID: string; title: string }>;
  /** Family members with an open question. */
  questionSessionIDs: string[];
  /** Current session's last execution outcome was a failure. */
  outcomeFailed: boolean;
  /** Most recent error message for the current session, if any. */
  lastError?: string | undefined;
  /** Current session agent/model, used for `working` detail. */
  agent?: string | undefined;
  model?: string | undefined;
};

/**
 * Waiting (needs input) outranks working; a fresh run outranks a stale
 * failure; anything else is idle.
 */
export function deriveState(snapshot: Snapshot): AgentState {
  if (
    snapshot.permissions.length > 0 ||
    snapshot.forms.length > 0 ||
    snapshot.questionSessionIDs.length > 0
  ) {
    return "waiting";
  }
  if (snapshot.runningIDs.length > 0) return "working";
  if (snapshot.outcomeFailed) return "error";
  return "idle";
}

function basename(value: string): string {
  const parts = value.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] ?? value;
}

export function deriveDetail(state: AgentState, snapshot: Snapshot): string {
  if (state === "waiting") {
    const current = snapshot.currentID;
    const permission =
      snapshot.permissions.find((item) => item.sessionID === current) ??
      snapshot.permissions[0];
    if (permission) {
      const resource = permission.resources[0];
      return resource
        ? `permission · ${permission.action} · ${basename(resource)}`
        : `permission · ${permission.action}`;
    }
    const form =
      snapshot.forms.find((item) => item.sessionID === current) ??
      snapshot.forms[0];
    if (form) return `form · ${form.title}`;
    return "question";
  }
  if (state === "working") {
    if (snapshot.runningIDs.length > 1)
      return `${snapshot.runningIDs.length} agents`;
    const parts = [snapshot.agent, snapshot.model].filter(
      (part): part is string => typeof part === "string" && part.length > 0,
    );
    return parts.join(" · ");
  }
  if (state === "error") return snapshot.lastError ?? "failed";
  return "";
}

export function toItermFields(
  state: AgentState,
  snapshot: Snapshot,
  options: ResolvedOptions,
): ItermFields {
  return {
    status: options.text[state],
    indicator: options.dot[state],
    statusColor: options.textColor,
    detail: options.detail ? deriveDetail(state, snapshot) : "",
  };
}

export function toStatusSequence(
  state: AgentState,
  snapshot: Snapshot,
  options: ResolvedOptions,
): string {
  return buildStatusSequence(toItermFields(state, snapshot, options));
}
