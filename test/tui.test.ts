import { afterEach, describe, expect, test } from "bun:test";
import plugin from "../src/tui.js";
import { buildClearSequence } from "../src/iterm.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

type SessionRecord = {
  title?: string;
  projectID?: string;
  location?: { directory: string };
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
  theme?: unknown;
  location?: { directory: string };
  data: {
    project?: {
      get: (id: string) => { name?: string; canonical?: string } | undefined;
    };
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
  test("tab title follows the session folder rather than project metadata", async () => {
    captureStdout();
    const store = createStore({
      sessions: {
        ses_main: {
          title: "Fix login",
          projectID: "prj_main",
          location: { directory: "/repo/worktree" },
        },
        ses_other: {
          title: "Add tests",
          location: { directory: "/repo/other/" },
        },
      },
    });
    const ctx = createCtx(store);
    ctx.data.project = {
      get: () => ({ name: "my-project", canonical: "/repo/main" }),
    };
    const cleanup = plugin.setup(ctx);
    try {
      expect(writes.join("")).toContain(
        "\x1b[22;0t\x1b]0;Fix login · worktree\x07",
      );
      store.sessions.ses_main!.title = "Fix authentication";
      ctx.emit("session.updated", { sessionID: "ses_main" });
      await sleep(120);
      expect(writes.join("")).toContain(
        "\x1b]0;Fix authentication · worktree\x07",
      );

      store.routeSessionID = "ses_other";
      ctx.emit("tui.session.select", { sessionID: "ses_other" });
      await sleep(120);
      expect(writes.join("")).toContain("\x1b]0;Add tests · other\x07");
      expect(writes.join("").split("\x1b[22;0t")).toHaveLength(2);
    } finally {
      cleanup?.();
    }
    expect(writes.join("")).toContain("\x1b[23;0t");
  });

  test("home title uses the live location instead of the previous session", async () => {
    captureStdout();
    const store = createStore({
      sessions: {
        ses_main: { title: "Work", location: { directory: "/repo/old" } },
      },
    });
    const ctx = createCtx(store);
    const cleanup = plugin.setup(ctx);
    try {
      expect(writes.join("")).toContain("\x1b]0;Work · old\x07");
      delete store.routeSessionID;
      ctx.location = { directory: "/repo/new" };
      const deadline = Date.now() + 2000;
      while (
        !writes.join("").includes("\x1b]0;OpenCode · new\x07") &&
        Date.now() < deadline
      )
        await sleep(10);
      expect(writes.join("")).toContain("\x1b]0;OpenCode · new\x07");
    } finally {
      cleanup?.();
    }
  });

  test("title option can leave title ownership with the terminal", () => {
    captureStdout();
    const ctx = createCtx(
      createStore({
        sessions: {
          ses_main: { title: "Work", location: { directory: "/repo/project" } },
        },
      }),
      { title: false },
    );
    const cleanup = plugin.setup(ctx);
    cleanup?.();
    expect(writes.join("")).not.toContain("\x1b]0;");
    expect(writes.join("")).not.toContain("\x1b[22;0t");
    expect(writes.join("")).not.toContain("\x1b[23;0t");
  });

  test("setup emits idle for the current session", async () => {
    captureStdout();
    const store = createStore();
    const ctx = createCtx(store);
    const cleanup = plugin.setup(ctx) as unknown as () => void;
    try {
      expect(statuses()).toEqual(["idle"]);
      expect(writes[0]).toContain("indicator=#00ff00");
      expect(writes[0]).toContain("\x1b]9;4;0\x07");
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
      expect(writes[1]).toContain("indicator=#ec5b2b");
      expect(writes[1]).toContain("detail=build · sonnet");
      expect(writes[1]).toContain("\x1b]9;4;3\x07");

      store.running.clear();
      ctx.emit("session.execution.succeeded", { sessionID: "ses_main" });
      await sleep(120);
      expect(statuses()).toEqual(["idle", "working", "idle"]);
      expect(writes[2]).toContain("\x1b]9;4;0\x07");
    } finally {
      cleanup();
    }
  });

  test("working dot follows the live theme without a session event", async () => {
    captureStdout();
    const ctx = createCtx(createStore({ running: new Set(["ses_main"]) }));
    let theme: unknown = {
      hue: { accent: { 500: { r: 0, g: 128 / 255, b: 1, a: 1 } } },
    };
    Object.defineProperty(ctx, "theme", { get: () => theme });
    const cleanup = plugin.setup(ctx);
    try {
      expect(writes[0]).toContain("indicator=#0080ff;");
      theme = { hue: { accent: { 500: "#aabbcc" } } };
      const deadline = Date.now() + 2000;
      while (writes.length < 2 && Date.now() < deadline) await sleep(10);
      expect(writes[1]).toContain("indicator=#aabbcc;");
    } finally {
      cleanup?.();
    }
  });

  test("explicit working dot overrides the theme", () => {
    captureStdout();
    const ctx = createCtx(createStore({ running: new Set(["ses_main"]) }), {
      dot: { working: "#123456" },
    });
    ctx.theme = { hue: { accent: { 500: "#abcdef" } } };
    const cleanup = plugin.setup(ctx);
    try {
      expect(writes[0]).toContain("indicator=#123456;");
    } finally {
      cleanup?.();
    }
  });

  test.each([
    undefined,
    {},
    { hue: { accent: { 500: "invalid" } } },
    { hue: { accent: { 500: { r: NaN, g: 0, b: 1 } } } },
    { hue: { accent: { 500: { r: 256, g: 0, b: 1 } } } },
  ])("unavailable theme color falls back to orange: %j", (theme) => {
    captureStdout();
    const ctx = createCtx(createStore({ running: new Set(["ses_main"]) }));
    ctx.theme = theme;
    const cleanup = plugin.setup(ctx);
    try {
      expect(writes[0]).toContain("indicator=#ec5b2b;");
    } finally {
      cleanup?.();
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
      expect(statuses()).toEqual(["idle", "working · 2 agents"]);
      expect(writes[1]).toContain("detail=2 agents");
      expect(writes[1]).toContain("\x1b]9;4;3\x07");

      store.running.delete("ses_sub");
      ctx.emit("session.execution.succeeded", { sessionID: "ses_sub" });
      await sleep(120);
      expect(statuses()).toEqual(["idle", "working · 2 agents", "working"]);
      expect(writes[2]).not.toContain("detail=2 agents");
      expect(writes[2]).toContain("\x1b]9;4;3\x07");
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
      expect(writes[2]).toContain("\x1b]9;4;4\x07");

      delete store.permissions.ses_main;
      ctx.emit("permission.replied", {
        sessionID: "ses_main",
        requestID: "per_1",
        reply: "once",
      });
      await sleep(120);
      expect(statuses()).toEqual(["idle", "working", "waiting", "working"]);
      expect(writes[3]).toContain("\x1b]9;4;3\x07");
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
      expect(writes[1]).toContain("\x1b]9;4;2\x07");
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

  test("dispose clears the status and active progress", async () => {
    captureStdout();
    const store = createStore({ running: new Set(["ses_main"]) });
    const ctx = createCtx(store);
    const cleanup = plugin.setup(ctx) as unknown as () => void;
    cleanup();
    expect(writes[writes.length - 1]).toBe(
      buildClearSequence() + "\x1b]9;4;0\x07",
    );
  });

  test("tmux wrapping appends a DCS copy when $TMUX is set", async () => {
    captureStdout();
    process.env.TMUX = "/tmp/tmux-test,123,0";
    const store = createStore({ running: new Set(["ses_main"]) });
    const ctx = createCtx(store);
    const cleanup = plugin.setup(ctx) as unknown as () => void;
    try {
      expect(writes).toHaveLength(1);
      expect(writes[0]).toContain("\x1bPtmux;");
      expect(writes[0]).toContain("\x1b\x1b]9;4;3\x07");
      expect(statuses()).toEqual(["working"]);
    } finally {
      cleanup();
    }
    expect(writes.at(-1)).toContain("\x1bPtmux;");
    expect(writes.at(-1)).toContain("\x1b\x1b]9;4;0\x07");
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
    expect(writes).toEqual([buildClearSequence() + "\x1b]9;4;0\x07"]);
    expect(cleanup).toBeUndefined();
  });

  test("disabling progress preserves status and leaves other progress writers alone", () => {
    captureStdout();
    const store = createStore({ running: new Set(["ses_main"]) });
    const cleanup = plugin.setup(createCtx(store, { progress: false }));
    try {
      expect(statuses()).toEqual(["working"]);
      expect(writes.join("")).not.toContain("\x1b]9;4;");
    } finally {
      cleanup?.();
    }
    expect(writes.at(-1)).toBe(buildClearSequence());
  });

  test("progress follows state even with customized status text", () => {
    captureStdout();
    const store = createStore({ running: new Set(["ses_main"]) });
    const cleanup = plugin.setup(
      createCtx(store, { text: { working: "busy" } }),
    );
    try {
      expect(statuses()).toEqual(["busy"]);
      expect(writes[0]).toContain("\x1b]9;4;3\x07");
    } finally {
      cleanup?.();
    }
  });

  test("disabled plugin clears progress through configured nested tmux wrapping", () => {
    captureStdout();
    plugin.setup(
      createCtx(createStore(), {
        enabled: false,
        tmux: "always",
        tmuxLevels: 2,
      }),
    );
    expect(writes[0]).toContain("\x1b]9;4;0\x07");
    expect(writes[0]).toContain("\x1bPtmux;\x1b\x1bPtmux;");
    expect(writes[0]).toContain("\x1b\x1b\x1b\x1b]9;4;0\x07");
  });
});
