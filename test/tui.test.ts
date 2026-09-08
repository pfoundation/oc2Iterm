import { afterEach, describe, expect, test } from "bun:test";
import plugin from "../src/tui.js";
import { buildClearSequence } from "../src/iterm.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

type SessionRecord = {
  outcome?: string;
  agent?: string;
  model?: { id: string };
  parentID?: string;
};

type Store = {
  routeSessionID?: string;
  family: Record<string, string[]>;
  sessions: Record<string, SessionRecord>;
  running: Set<string>;
  permissions: Record<string, Array<{ action: string; resources: string[] }>>;
  forms: Record<string, Array<{ title: string }>>;
};

function createStore(overrides: Partial<Store> = {}): Store {
  return {
    routeSessionID: "ses_main",
    family: { ses_main: ["ses_main"] },
    sessions: { ses_main: { agent: "build", model: { id: "sonnet" } } },
    running: new Set(),
    permissions: {},
    forms: {},
    ...overrides,
  };
}

type Ctx = {
  options: Record<string, unknown>;
  data: {
    listen?: (handler: (event: unknown) => void) => () => void;
    on?: (type: string, handler: (event: unknown) => void) => () => void;
    session: {
      family: (id: string) => string[];
      get: (id: string) => SessionRecord | undefined;
      status: (id: string) => "idle" | "running";
      permission: {
        list: (id: string) => Array<{ action: string; resources: string[] }>;
      };
      form: { list: (id: string) => Array<{ title: string }> };
    };
  };
  ui: {
    router: { current: () => { type: string; sessionID?: string } };
    tabs: { enabled: () => boolean; list: () => Array<{ sessionID: string }> };
  };
  emit: (type: string, data?: Record<string, unknown>) => void;
};

function createCtx(store: Store, options: Record<string, unknown> = {}): Ctx {
  let listenHandler: ((event: unknown) => void) | undefined;
  const onHandlers = new Map<string, Array<(event: unknown) => void>>();
  const emit = (type: string, data: Record<string, unknown> = {}): void => {
    const event = {
      id: `evt_${Math.random()}`,
      type,
      created: Date.now(),
      data,
    };
    listenHandler?.({ details: event });
    for (const handler of onHandlers.get(type) ?? []) handler(event);
  };
  return {
    options: { pollMs: 60, forceMs: 60_000, ...options },
    data: {
      listen: (handler) => {
        listenHandler = handler;
        return () => {
          listenHandler = undefined;
        };
      },
      on: (type, handler) => {
        const list = onHandlers.get(type) ?? [];
        list.push(handler);
        onHandlers.set(type, list);
        return () => {
          onHandlers.set(
            type,
            (onHandlers.get(type) ?? []).filter((item) => item !== handler),
          );
        };
      },
      session: {
        family: (id) => store.family[id] ?? [id],
        get: (id) => store.sessions[id],
        status: (id) => (store.running.has(id) ? "running" : "idle"),
        permission: { list: (id) => store.permissions[id] ?? [] },
        form: { list: (id) => store.forms[id] ?? [] },
      },
    },
    ui: {
      router: {
        current: () =>
          store.routeSessionID
            ? { type: "session", sessionID: store.routeSessionID }
            : { type: "home" },
      },
      tabs: { enabled: () => false, list: () => [] },
    },
    emit,
  };
}

let writes: string[] = [];
const originalWrite = process.stdout.write.bind(process.stdout);
const originalTmux = process.env.TMUX;

function captureStdout(): void {
  writes = [];
  // Deterministic TMUX state per test; the tmux test opts back in explicitly.
  delete process.env.TMUX;
  (process.stdout as unknown as { write: (chunk: string) => boolean }).write = (
    chunk: string,
  ) => {
    writes.push(String(chunk));
    return true;
  };
}

function restoreStdout(): void {
  process.stdout.write = originalWrite;
  if (originalTmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = originalTmux;
}

function stripTmuxWrapping(chunk: string): string {
  return chunk.replaceAll(/\x1bPtmux;[\s\S]*?\x1b\\/g, "");
}

function statuses(): string[] {
  return writes.flatMap((chunk) =>
    [...stripTmuxWrapping(chunk).matchAll(/status=([^;]*);/g)].map(
      (match) => match[1] ?? "",
    ),
  );
}

afterEach(() => {
  restoreStdout();
});

describe("oc-iterm2 plugin", () => {
  test("setup emits idle for the current session", async () => {
    captureStdout();
    const store = createStore();
    const ctx = createCtx(store);
    const cleanup = plugin.setup(ctx) as unknown as () => void;
    try {
      expect(statuses()).toEqual(["idle"]);
      expect(writes[0]).toContain("indicator=#8e8e93");
    } finally {
      cleanup();
    }
  });

  test("running session shows working with agent and model detail", async () => {
    captureStdout();
    const store = createStore();
    const ctx = createCtx(store);
    const cleanup = plugin.setup(ctx) as unknown as () => void;
    try {
      store.running.add("ses_main");
      ctx.emit("session.execution.started", { sessionID: "ses_main" });
      await sleep(120);
      expect(statuses()).toEqual(["idle", "working"]);
      expect(writes[1]).toContain("indicator=#ffa500");
      expect(writes[1]).toContain("detail=build · sonnet");
    } finally {
      cleanup();
    }
  });

  test("subagent activity keeps the session working", async () => {
    captureStdout();
    const store = createStore({
      family: { ses_main: ["ses_main", "ses_sub"] },
      sessions: { ses_main: {}, ses_sub: {} },
    });
    const ctx = createCtx(store);
    const cleanup = plugin.setup(ctx) as unknown as () => void;
    try {
      store.running.add("ses_main");
      store.running.add("ses_sub");
      ctx.emit("session.status", {
        sessionID: "ses_sub",
        status: { type: "busy" },
      });
      await sleep(120);
      expect(statuses()).toEqual(["idle", "working"]);
      expect(writes[1]).toContain("detail=2 agents");
    } finally {
      cleanup();
    }
  });

  test("pending permission shows waiting and reply restores working", async () => {
    captureStdout();
    const store = createStore();
    const ctx = createCtx(store);
    const cleanup = plugin.setup(ctx) as unknown as () => void;
    try {
      expect(statuses()).toEqual(["idle"]);

      store.running.add("ses_main");
      ctx.emit("session.execution.started", { sessionID: "ses_main" });
      await sleep(120);
      expect(statuses()).toEqual(["idle", "working"]);

      store.permissions.ses_main = [
        { action: "edit", resources: ["/repo/src/app.ts"] },
      ];
      ctx.emit("permission.asked", { sessionID: "ses_main", action: "edit" });
      await sleep(120);
      expect(statuses()).toEqual(["idle", "working", "waiting"]);
      expect(writes[2]).toContain("indicator=#ff5f57");
      expect(writes[2]).toContain("detail=permission · edit · app.ts");

      delete store.permissions.ses_main;
      ctx.emit("permission.replied", {
        sessionID: "ses_main",
        requestID: "per_1",
        reply: "once",
      });
      await sleep(120);
      expect(statuses()).toEqual(["idle", "working", "waiting", "working"]);
    } finally {
      cleanup();
    }
  });

  test("failed outcome shows error with the captured message", async () => {
    captureStdout();
    const store = createStore();
    const ctx = createCtx(store);
    const cleanup = plugin.setup(ctx) as unknown as () => void;
    try {
      ctx.emit("session.execution.failed", {
        sessionID: "ses_main",
        error: { type: "provider", message: "rate limited" },
      });
      store.sessions.ses_main = { outcome: "failed" };
      await sleep(120);
      expect(statuses()).toEqual(["idle", "error"]);
      expect(writes[1]).toContain("indicator=#ff0000");
      expect(writes[1]).toContain("detail=rate limited");
    } finally {
      cleanup();
    }
  });

  test("questions drive waiting without a list API", async () => {
    captureStdout();
    const store = createStore();
    const ctx = createCtx(store);
    const cleanup = plugin.setup(ctx) as unknown as () => void;
    try {
      ctx.emit("question.asked", { sessionID: "ses_main", id: "q_1" });
      await sleep(120);
      expect(statuses()).toEqual(["idle", "waiting"]);
      ctx.emit("question.replied", { sessionID: "ses_main", id: "q_1" });
      await sleep(120);
      expect(statuses()).toEqual(["idle", "waiting", "idle"]);
    } finally {
      cleanup();
    }
  });

  test("session select switches the tracked session", async () => {
    captureStdout();
    const store = createStore({
      family: { ses_main: ["ses_main"], ses_other: ["ses_other"] },
      sessions: { ses_main: {}, ses_other: { agent: "plan" } },
    });
    store.running.add("ses_other");
    const ctx = createCtx(store);
    const cleanup = plugin.setup(ctx) as unknown as () => void;
    try {
      expect(statuses()).toEqual(["idle"]);
      store.routeSessionID = "ses_other";
      ctx.emit("tui.session.select", { sessionID: "ses_other" });
      await sleep(120);
      expect(statuses()).toEqual(["idle", "working"]);
      expect(writes[1]).toContain("detail=plan");
    } finally {
      cleanup();
    }
  });

  test("dispose clears the status", async () => {
    captureStdout();
    const store = createStore();
    const ctx = createCtx(store);
    const cleanup = plugin.setup(ctx) as unknown as () => void;
    cleanup();
    expect(writes[writes.length - 1]).toBe(buildClearSequence());
  });

  test("tmux wrapping appends a DCS copy when $TMUX is set", async () => {
    captureStdout();
    process.env.TMUX = "/tmp/tmux-test,123,0";
    const store = createStore();
    const ctx = createCtx(store);
    const cleanup = plugin.setup(ctx) as unknown as () => void;
    try {
      expect(writes).toHaveLength(1);
      expect(writes[0]).toContain("\x1bPtmux;");
      expect(statuses()).toEqual(["idle"]);
    } finally {
      cleanup();
    }
  });

  test("falls back to data.on when data.listen is missing", async () => {
    captureStdout();
    const store = createStore();
    const ctx = createCtx(store);
    delete ctx.data.listen;
    const cleanup = plugin.setup(ctx) as unknown as () => void;
    try {
      store.running.add("ses_main");
      ctx.emit("session.status", {
        sessionID: "ses_main",
        status: { type: "busy" },
      });
      await sleep(120);
      expect(statuses()).toEqual(["idle", "working"]);
    } finally {
      cleanup();
    }
  });

  test("disabled option clears and subscribes to nothing", () => {
    captureStdout();
    const store = createStore();
    const ctx = createCtx(store, { enabled: false });
    const cleanup = plugin.setup(ctx) as unknown as (() => void) | undefined;
    expect(writes).toEqual([buildClearSequence()]);
    expect(cleanup).toBeUndefined();
  });
});
