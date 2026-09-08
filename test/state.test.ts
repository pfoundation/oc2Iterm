import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DOT,
  DEFAULT_TEXT,
  deriveDetail,
  deriveState,
  resolveOptions,
  toItermFields,
  type Snapshot,
} from "../src/state.js";

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    currentID: "ses_test",
    familyIDs: ["ses_test"],
    runningIDs: [],
    permissions: [],
    forms: [],
    questionSessionIDs: [],
    outcomeFailed: false,
    ...overrides,
  };
}

describe("resolveOptions", () => {
  test("defaults match the documented behavior", () => {
    const options = resolveOptions(undefined);
    expect(options.enabled).toBe(true);
    expect(options.text).toEqual(DEFAULT_TEXT);
    expect(options.dot).toEqual(DEFAULT_DOT);
    expect(options.textColor).toBe("");
    expect(options.detail).toBe(true);
    expect(options.tmux).toBe("auto");
    expect(options.tmuxLevels).toBe(1);
    expect(options.pollMs).toBe(2000);
    expect(options.forceMs).toBe(30000);
    expect(options.debug).toBe(false);
  });

  test("applies overrides and clamps bounds", () => {
    const options = resolveOptions({
      enabled: false,
      text: { working: "busy" },
      dot: { idle: "#000000" },
      textColor: "#ffffff",
      detail: false,
      tmux: "never",
      tmuxLevels: 9,
      pollMs: 10,
      forceMs: 50,
      debug: true,
    });
    expect(options.enabled).toBe(false);
    expect(options.text.working).toBe("busy");
    expect(options.text.idle).toBe("idle");
    expect(options.dot.idle).toBe("#000000");
    expect(options.textColor).toBe("#ffffff");
    expect(options.detail).toBe(false);
    expect(options.tmux).toBe("never");
    expect(options.tmuxLevels).toBe(3);
    expect(options.pollMs).toBe(250);
    expect(options.forceMs).toBe(1000);
    expect(options.debug).toBe(true);
  });

  test("ignores malformed option values", () => {
    const options = resolveOptions({
      text: "nope",
      tmux: "sometimes",
      pollMs: Number.NaN,
    });
    expect(options.text).toEqual(DEFAULT_TEXT);
    expect(options.tmux).toBe("auto");
    expect(options.pollMs).toBe(2000);
  });
});

describe("deriveState", () => {
  test("waiting outranks everything", () => {
    expect(
      deriveState(snapshot({ runningIDs: ["ses_test"], outcomeFailed: true })),
    ).toBe("working");
    expect(
      deriveState(
        snapshot({
          runningIDs: ["ses_test"],
          outcomeFailed: true,
          permissions: [
            { sessionID: "ses_test", action: "edit", resources: [] },
          ],
        }),
      ),
    ).toBe("waiting");
    expect(
      deriveState(
        snapshot({ forms: [{ sessionID: "ses_test", title: "pick one" }] }),
      ),
    ).toBe("waiting");
    expect(deriveState(snapshot({ questionSessionIDs: ["ses_test"] }))).toBe(
      "waiting",
    );
  });

  test("a fresh run outranks a stale failure", () => {
    expect(
      deriveState(snapshot({ outcomeFailed: true, runningIDs: ["ses_test"] })),
    ).toBe("working");
    expect(deriveState(snapshot({ outcomeFailed: true }))).toBe("error");
  });

  test("idle is the fallback", () => {
    expect(deriveState(snapshot())).toBe("idle");
  });
});

describe("deriveDetail", () => {
  test("waiting prefers the current session permission with its resource", () => {
    expect(
      deriveDetail(
        "waiting",
        snapshot({
          permissions: [
            { sessionID: "ses_other", action: "bash", resources: [] },
            {
              sessionID: "ses_test",
              action: "edit",
              resources: ["/tmp/example.txt"],
            },
          ],
        }),
      ),
    ).toBe("permission · edit · example.txt");
  });

  test("waiting falls back to forms and questions", () => {
    expect(
      deriveDetail(
        "waiting",
        snapshot({ forms: [{ sessionID: "ses_test", title: "Deploy?" }] }),
      ),
    ).toBe("form · Deploy?");
    expect(
      deriveDetail("waiting", snapshot({ questionSessionIDs: ["ses_test"] })),
    ).toBe("question");
  });

  test("working shows subagent fan-out or agent and model", () => {
    expect(
      deriveDetail("working", snapshot({ runningIDs: ["a", "b", "c"] })),
    ).toBe("3 agents");
    expect(
      deriveDetail(
        "working",
        snapshot({ runningIDs: ["a"], agent: "build", model: "sonnet" }),
      ),
    ).toBe("build · sonnet");
    expect(deriveDetail("working", snapshot({ runningIDs: ["a"] }))).toBe("");
  });

  test("error surfaces the captured message", () => {
    expect(deriveDetail("error", snapshot({ lastError: "boom" }))).toBe("boom");
    expect(deriveDetail("error", snapshot())).toBe("failed");
  });

  test("idle has no detail", () => {
    expect(deriveDetail("idle", snapshot())).toBe("");
  });
});

describe("toItermFields", () => {
  test("maps state through the resolved text and colors", () => {
    const options = resolveOptions(undefined);
    expect(
      toItermFields("working", snapshot({ runningIDs: ["a", "b"] }), options),
    ).toEqual({
      status: "working",
      indicator: "#ffa500",
      statusColor: "",
      detail: "2 agents",
    });
  });

  test("detail can be disabled", () => {
    const options = resolveOptions({ detail: false });
    expect(
      toItermFields(
        "waiting",
        snapshot({
          permissions: [{ sessionID: "s", action: "e", resources: [] }],
        }),
        options,
      ).detail,
    ).toBe("");
  });
});
