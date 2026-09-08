import { describe, expect, test } from "bun:test";
import {
  buildClearSequence,
  buildStatusSequence,
  sanitizeField,
  wrapTmuxPassthrough,
} from "../src/iterm.js";

const ESC = "\x1b";
const BEL = "\x07";

describe("buildStatusSequence", () => {
  test("emits the documented OSC 21337 payload", () => {
    expect(
      buildStatusSequence({ status: "working", indicator: "#ffa500" }),
    ).toBe(
      `${ESC}]21337;status=working;indicator=#ffa500;status-color=;detail=${BEL}`,
    );
  });

  test("includes text color and detail when provided", () => {
    expect(
      buildStatusSequence({
        status: "waiting",
        indicator: "#ff5f57",
        statusColor: "#ff5f57",
        detail: "permission · edit",
      }),
    ).toBe(
      `${ESC}]21337;status=waiting;indicator=#ff5f57;status-color=#ff5f57;detail=permission · edit${BEL}`,
    );
  });

  test("omits invalid colors instead of emitting garbage", () => {
    expect(
      buildStatusSequence({
        status: "idle",
        indicator: "red",
        statusColor: "#12345",
      }),
    ).toBe(`${ESC}]21337;status=idle;indicator=;status-color=;detail=${BEL}`);
  });
});

describe("buildClearSequence", () => {
  test("clears every field", () => {
    expect(buildClearSequence()).toBe(
      `${ESC}]21337;status=;indicator=;status-color=;detail=${BEL}`,
    );
  });
});

describe("sanitizeField", () => {
  test("strips control characters and field separators", () => {
    expect(sanitizeField("a;b\x1bc\nd", 64)).toBe("a:b c d");
  });

  test("collapses whitespace and truncates", () => {
    expect(sanitizeField("  hello   world  ", 5)).toBe("hello");
  });

  test("keeps printable unicode", () => {
    expect(sanitizeField("permission · edit", 64)).toBe("permission · edit");
  });
});

describe("wrapTmuxPassthrough", () => {
  const inner = `${ESC}]21337;status=working;indicator=;status-color=;detail=${BEL}`;

  test("wraps with DCS tmux prefix and doubles ESC", () => {
    expect(wrapTmuxPassthrough(inner)).toBe(
      `${ESC}Ptmux;${ESC}${inner}${ESC}\\`,
    );
  });

  test("supports nested tmux levels", () => {
    const once = wrapTmuxPassthrough(inner, 1);
    const twice = wrapTmuxPassthrough(inner, 2);
    expect(twice).toBe(
      `${ESC}Ptmux;${once.replaceAll(ESC, ESC + ESC)}${ESC}\\`,
    );
    expect(twice.length).toBeGreaterThan(once.length);
  });
});
