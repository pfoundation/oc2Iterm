/**
 * oc-iterm2 — OpenCode CLI (TUI) plugin.
 *
 * Mirrors the current agent state to iTerm2 3.7+ Session Status (OSC 21337):
 * a subtitle below the tab name, a colored dot, and detail text for the
 * Session Status tool / Cockpit.
 *
 * NOTE: the default export shape `{ id, setup }` is intentional. The V2 TUI
 * loader validates exactly that (a string `id` plus a `setup` function), so
 * this module must keep that shape and must not require any OpenCode package
 * at runtime. All context access below is defensive for the same reason:
 * across beta releases the context gains fields, and a missing field must
 * degrade gracefully instead of breaking the TUI.
 */

import { appendFileSync } from "node:fs";
import {
  buildClearSequence,
  buildStatusSequence,
  wrapTmuxPassthrough,
} from "./iterm.js";
import {
  deriveState,
  resolveOptions,
  toItermFields,
  type ResolvedOptions,
  type Snapshot,
} from "./state.js";

export const PLUGIN_ID = "oc-iterm2";

const DEBUG_LOG = "/tmp/opencode/oc-iterm2.log";

/** Event types (from `@opencode/schema`) that can change the derived state. */
const RELEVANT_TYPES: ReadonlySet<string> = new Set([
  "session.status",
  "session.idle",
  "session.error",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.retry.scheduled",
  "session.compaction.started",
  "session.compaction.ended",
  "session.compaction.failed",
  "session.created",
  "session.deleted",
  "permission.asked",
  "permission.replied",
  "question.asked",
  "question.replied",
  "question.rejected",
  "form.created",
  "form.replied",
  "form.cancelled",
  "tui.session.select",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
}

function call<T>(fn: unknown, ...args: Array<unknown>): T | undefined {
  if (typeof fn !== "function") return undefined;
  try {
    return (fn as (...callArgs: Array<unknown>) => T)(...args);
  } catch {
    return undefined;
  }
}

function writeStdout(chunk: string): void {
  try {
    const proc = (globalThis as { process?: unknown }).process;
    const stdout = isRecord(proc) ? proc.stdout : undefined;
    const write = isRecord(stdout) ? stdout.write : undefined;
    if (typeof write === "function") {
      (write as (chunk: string) => unknown).call(stdout, chunk);
    }
  } catch {
    // Best-effort only; never break the TUI.
  }
}

function readEnv(name: string): string | undefined {
  try {
    const proc = (globalThis as { process?: unknown }).process;
    const env = isRecord(proc) ? proc.env : undefined;
    const value = isRecord(env) ? env[name] : undefined;
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function tmuxDetected(): boolean {
  const value = readEnv("TMUX");
  return value !== undefined && value.length > 0;
}

/** Env override so diagnostics work even when plugin options can't be passed. */
function debugEnvEnabled(): boolean {
  const value = readEnv("OC_ITERM2_DEBUG");
  return value === "1" || value?.toLowerCase() === "true";
}

function debugLog(enabled: boolean, line: string): void {
  if (!enabled) return;
  try {
    appendFileSync(
      DEBUG_LOG,
      `${new Date().toISOString()} pid=${process.pid} ${line}\n`,
    );
  } catch {
    // Best-effort only.
  }
}

/** Normalize `data.on` events (`{type, data}`) and `data.listen` wraps (`{details}`). */
function unwrapEvent(raw: unknown): Record<string, unknown> | undefined {
  const outer = isRecord(raw) ? raw : undefined;
  if (!outer) return undefined;
  const inner = isRecord(outer.details) ? outer.details : outer;
  return inner;
}

function sessionIDOfData(data: unknown): string | undefined {
  const rec = isRecord(data) ? data : undefined;
  if (!rec) return undefined;
  const direct = asString(rec.sessionID);
  if (direct) return direct;
  // form.created nests the session id under `form`.
  const form = isRecord(rec.form) ? rec.form : undefined;
  return form ? asString(form.sessionID) : undefined;
}

function errorMessageOfData(data: unknown): string | undefined {
  const rec = isRecord(data) ? data : undefined;
  if (!rec) return undefined;
  const nested = isRecord(rec.error) ? rec.error : undefined;
  return asString(nested?.message) ?? asString(rec.message);
}

type SessionApi = {
  family?: unknown;
  get?: unknown;
  status?: unknown;
  permission?: unknown;
  form?: unknown;
};

function readRouteSessionID(router: unknown): string | undefined {
  const current = isRecord(router) ? router.current : undefined;
  const route = call<unknown>(current);
  const rec = isRecord(route) ? route : undefined;
  if (!rec || rec.type !== "session") return undefined;
  return asString(rec.sessionID);
}

function readTabSessionIDs(tabs: unknown): string[] {
  if (!isRecord(tabs)) return [];
  if (call<unknown>(tabs.enabled) !== true) return [];
  const list = call<unknown>(tabs.list);
  if (!Array.isArray(list)) return [];
  const ids: string[] = [];
  for (const entry of list) {
    const id = isRecord(entry) ? asString(entry.sessionID) : undefined;
    if (id) ids.push(id);
  }
  return ids;
}

function readPermissionList(
  session: SessionApi,
  sessionID: string,
): Snapshot["permissions"] {
  const api = isRecord(session.permission) ? session.permission : undefined;
  const list = call<unknown>(api?.list, sessionID);
  if (!Array.isArray(list)) return [];
  const out: Snapshot["permissions"] = [];
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const action = asString(entry.action) ?? "permission";
    out.push({ sessionID, action, resources: asStringArray(entry.resources) });
  }
  return out;
}

function readFormList(
  session: SessionApi,
  sessionID: string,
  location: unknown,
): Snapshot["forms"] {
  const api = isRecord(session.form) ? session.form : undefined;
  const list = call<unknown>(api?.list, sessionID, location);
  if (!Array.isArray(list)) return [];
  const out: Snapshot["forms"] = [];
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    out.push({ sessionID, title: asString(entry.title) ?? "form" });
  }
  return out;
}

export type SetupContext = {
  options?: unknown;
  location?: unknown;
  data?: {
    listen?: (handler: (event: unknown) => void) => unknown;
    on?: (type: string, handler: (event: unknown) => void) => unknown;
    session?: SessionApi;
  };
  ui?: {
    router?: unknown;
    tabs?: unknown;
  };
};

export default {
  id: PLUGIN_ID,
  setup(ctx: SetupContext) {
    const context: Record<string, unknown> = isRecord(ctx)
      ? (ctx as Record<string, unknown>)
      : {};
    const options: ResolvedOptions = resolveOptions(context.options);
    if (debugEnvEnabled()) options.debug = true;
    const log = (line: string): void => debugLog(options.debug, line);

    const data = isRecord(context.data) ? context.data : undefined;
    const session =
      data !== undefined && isRecord(data.session)
        ? (data.session as SessionApi)
        : undefined;
    const ui = isRecord(context.ui) ? context.ui : undefined;
    const router = ui?.router;
    const tabs = ui?.tabs;
    const location = context.location;

    if (!options.enabled) {
      writeStdout(buildClearSequence());
      return;
    }
    if (!data || !session) {
      log("abort: context.data.session missing");
      return;
    }

    log(
      `setup data.listen=${typeof data.listen} data.on=${typeof data.on} ` +
        `router=${typeof (isRecord(router) ? router.current : undefined)} tmux=${tmuxDetected()}`,
    );

    let currentID = readRouteSessionID(router);
    const pendingQuestions = new Set<string>();
    const lastErrors = new Map<string, string>();
    let lastPayload = "";
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let followUpTimer: ReturnType<typeof setTimeout> | undefined;

    const shouldWrap = (): boolean => {
      if (options.tmux === "always") return true;
      if (options.tmux === "never") return false;
      return tmuxDetected();
    };

    const emitStatus = (payload: string): void => {
      const extra = shouldWrap()
        ? wrapTmuxPassthrough(payload, options.tmuxLevels)
        : "";
      writeStdout(payload + extra);
    };

    const takeSnapshot = (): Snapshot => {
      const routeID = readRouteSessionID(router);
      if (routeID) currentID = routeID;

      let familyIDs: string[] = [];
      if (currentID) {
        const family = call<unknown>(session.family, currentID);
        familyIDs = asStringArray(family);
        if (familyIDs.length === 0) familyIDs = [currentID];
      } else {
        familyIDs = readTabSessionIDs(tabs);
      }
      familyIDs = [...new Set(familyIDs)].slice(0, 50);

      const runningIDs = familyIDs.filter(
        (id) => call<unknown>(session.status, id) === "running",
      );
      const permissions = familyIDs.flatMap((id) =>
        readPermissionList(session, id),
      );
      const forms = familyIDs.flatMap((id) =>
        readFormList(session, id, location),
      );
      const questionSessionIDs = familyIDs.filter((id) =>
        pendingQuestions.has(id),
      );

      const info = currentID
        ? call<unknown>(session.get, currentID)
        : undefined;
      const infoRec = isRecord(info) ? info : undefined;
      const modelRec = isRecord(infoRec?.model)
        ? (infoRec?.model as Record<string, unknown>)
        : undefined;

      return {
        currentID,
        familyIDs,
        runningIDs,
        permissions,
        forms,
        questionSessionIDs,
        outcomeFailed: infoRec?.outcome === "failed",
        lastError: currentID ? lastErrors.get(currentID) : undefined,
        agent: asString(infoRec?.agent),
        model: asString(modelRec?.id),
      };
    };

    const recompute = (force: boolean): void => {
      try {
        const snapshot = takeSnapshot();
        const state = deriveState(snapshot);
        const payload = buildStatusSequence(
          toItermFields(state, snapshot, options),
        );
        if (!force && payload === lastPayload) return;
        lastPayload = payload;
        emitStatus(payload);
        log(
          `state=${state} current=${snapshot.currentID ?? "-"} running=${snapshot.runningIDs.length} ` +
            `perm=${snapshot.permissions.length} forms=${snapshot.forms.length} q=${snapshot.questionSessionIDs.length}`,
        );
      } catch (error) {
        log(`recompute failed: ${(error as Error)?.message ?? String(error)}`);
      }
    };

    /** Debounced recompute plus a follow-up tick: the TUI store may apply the event after our handler runs. */
    const schedule = (): void => {
      if (debounceTimer !== undefined) clearTimeout(debounceTimer);
      if (followUpTimer !== undefined) clearTimeout(followUpTimer);
      debounceTimer = setTimeout(() => recompute(false), 50);
      followUpTimer = setTimeout(() => recompute(false), 500);
    };

    const onEvent = (raw: unknown): void => {
      try {
        const event = unwrapEvent(raw);
        const type = event ? asString(event.type) : undefined;
        if (!type || !RELEVANT_TYPES.has(type)) return;
        const dataEvent = event?.data;
        const sid = sessionIDOfData(dataEvent);

        if (type === "tui.session.select" && sid) {
          currentID = sid;
        } else if (type === "question.asked" && sid) {
          pendingQuestions.add(sid);
        } else if (
          (type === "question.replied" || type === "question.rejected") &&
          sid
        ) {
          pendingQuestions.delete(sid);
        } else if (
          (type === "session.execution.failed" || type === "session.error") &&
          sid
        ) {
          const message = errorMessageOfData(dataEvent);
          if (message) {
            lastErrors.set(sid, message);
            if (lastErrors.size > 50) {
              const oldest = lastErrors.keys().next().value;
              if (oldest !== undefined) lastErrors.delete(oldest);
            }
          }
        }
        schedule();
      } catch (error) {
        log(`event failed: ${(error as Error)?.message ?? String(error)}`);
      }
    };

    const stops: Array<() => void> = [];
    const track = (result: unknown): void => {
      stops.push(
        typeof result === "function" ? (result as () => void) : () => {},
      );
    };

    if (typeof data.listen === "function") {
      try {
        track(
          (data.listen as (handler: (event: unknown) => void) => unknown)(
            onEvent,
          ),
        );
      } catch (error) {
        log(`listen failed: ${(error as Error)?.message ?? String(error)}`);
        return;
      }
    } else if (typeof data.on === "function") {
      const on = data.on as (
        type: string,
        handler: (event: unknown) => void,
      ) => unknown;
      for (const type of RELEVANT_TYPES) {
        try {
          track(on(type, onEvent));
        } catch (error) {
          log(
            `subscribe ${type} failed: ${(error as Error)?.message ?? String(error)}`,
          );
        }
      }
    } else {
      log("abort: neither data.listen nor data.on is available");
      return;
    }

    recompute(false);
    const pollTimer = setInterval(() => recompute(false), options.pollMs);
    const forceTimer = setInterval(() => recompute(true), options.forceMs);
    log(
      `subscribed stops=${stops.length} pollMs=${options.pollMs} forceMs=${options.forceMs}`,
    );

    return () => {
      clearInterval(pollTimer);
      clearInterval(forceTimer);
      if (debounceTimer !== undefined) clearTimeout(debounceTimer);
      if (followUpTimer !== undefined) clearTimeout(followUpTimer);
      for (const stop of stops) {
        try {
          stop();
        } catch {
          // Ignore teardown errors.
        }
      }
      writeStdout(buildClearSequence());
      log("disposed");
    };
  },
};
