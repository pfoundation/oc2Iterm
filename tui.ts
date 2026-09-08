/**
 * Discovery entrypoint.
 *
 * OpenCode discovers CLI plugins at `<plugin-dir>/tui.ts`; the implementation
 * lives in `src/` and is re-exported here so both discovery and the
 * package.json `./tui` export resolve to the same module.
 */
export { default } from "./src/tui.js";
