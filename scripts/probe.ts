/**
 * Manual probe: emit iTerm2 Session Status and progress to this terminal.
 *
 * Run inside iTerm2 (ideally through your real tmux setup) to verify the tab
 * subtitle, dot, and progress update:
 *
 *   bun scripts/probe.ts working "2 agents"
 *   bun scripts/probe.ts waiting "permission · edit"
 *   bun scripts/probe.ts idle
 *   bun scripts/probe.ts error "rate limited"
 *   bun scripts/probe.ts clear
 */
import {
  buildClearSequence,
  buildStatusSequence,
  wrapTmuxPassthrough,
} from "../src/iterm.js";
import {
  DEFAULT_DOT,
  toProgressSequence,
  type AgentState,
} from "../src/state.js";

const [stateArg, detailArg] = process.argv.slice(2);

function emit(payload: string): void {
  const extra = process.env.TMUX ? wrapTmuxPassthrough(payload) : "";
  process.stdout.write(payload + extra);
}

if (stateArg === "clear") {
  emit(buildClearSequence() + toProgressSequence("idle"));
  process.exit(0);
}

const states: ReadonlyArray<AgentState> = [
  "waiting",
  "working",
  "error",
  "idle",
];
const state = states.find((item) => item === stateArg);
if (!state) {
  console.error(
    `usage: bun scripts/probe.ts <${[...states, "clear"].join("|")}> [detail]`,
  );
  process.exit(1);
}

const payload =
  buildStatusSequence({
    status: state,
    indicator: DEFAULT_DOT[state],
    detail: detailArg ?? "",
  }) + toProgressSequence(state);
emit(payload);
console.error(
  `emitted state=${state} tmux=${process.env.TMUX ? "wrapped+raw" : "raw"}`,
);
