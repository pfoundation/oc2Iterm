# oc-iterm2

OpenCode CLI plugin that mirrors agent status to **iTerm2 3.7+ Session Status**:
a subtitle below the tab name, a colored dot, and detail text for the
[Session Status tool](https://iterm2.com/documentation-session-status.html) and Cockpit.

It reports the same lifecycle Claude Code's integration shows, plus failures:

| State     | Meaning                                              | Dot     |
| --------- | ---------------------------------------------------- | ------- |
| `waiting` | permission, form, or question needs your input       | red     |
| `working` | this session or its subagents are running            | orange  |
| `error`   | last run failed (sticky until the next run)          | red     |
| `idle`    | nothing running                                      | gray    |

## Requirements

- iTerm2 3.7 or later (stable release with Session Status).
- OpenCode V2 (`opencode2` beta with CLI plugin support).
- Recommended: run tmux through iTerm2's native integration (`tmux -CC`) so
  each pane gets its own tab status. Plain tmux works too via DCS passthrough
  (see below), but all panes in one iTerm2 tab share that tab's status.

## Install

```sh
# 1. Link the plugin into OpenCode's global plugin directory.
ln -s ~/dev/oc-iterm2 ~/.config/opencode/plugins/oc-iterm2

# 2. Register it in ~/.config/opencode/cli.json (path is relative to that dir):
#    { "plugins": ["./plugins/oc-iterm2"] }

# 3. Restart the OpenCode TUI.
```

Loading is via directory discovery: OpenCode picks up
`~/.config/opencode/plugins/oc-iterm2/tui.ts` (a re-export of `src/tui.ts`).
The `cli.json` entry documents the dependency; on some betas local-path
`cli.json` entries alone are silently ignored, so the root `tui.ts` is what
makes the plugin load. Because the install is a symlink, edits under
`~/dev/oc-iterm2` are picked up when the TUI reloads plugins.

The plugin is CLI-only: it runs in the terminal process, so it also works when
the TUI connects to a remote OpenCode server.

## Options

All options are optional; set them in `cli.json` with the object form:

```json
{
  "plugins": [
    {
      "package": "./plugins/oc-iterm2",
      "options": {
        "text": { "working": "working", "waiting": "waiting", "idle": "idle", "error": "error" },
        "dot": {
          "working": "#ffa500",
          "waiting": "#ff5f57",
          "idle": "#8e8e93",
          "error": "#ff0000"
        },
        "textColor": "",
        "detail": true,
        "tmux": "auto",
        "tmuxLevels": 1,
        "pollMs": 2000,
        "forceMs": 30000,
        "debug": false
      }
    }
  ]
}
```

| Option       | Default | Notes                                                                 |
| ------------ | ------- | --------------------------------------------------------------------- |
| `text`       | above   | Subtitle per state. Lowercase matches iTerm2's default priority sort. |
| `dot`        | above   | `#rrggbb` dot color per state.                                        |
| `textColor`  | `""`    | Subtitle text color; empty keeps iTerm2's default.                    |
| `detail`     | `true`  | Show permission action, subagent count, or error in tool/Cockpit.     |
| `tmux`       | `auto`  | `auto` adds a DCS-wrapped copy when `$TMUX` is set.                   |
| `tmuxLevels` | `1`     | Wrap depth for nested tmux sessions.                                  |
| `pollMs`     | `2000`  | Recompute cadence (session switches, drift). Min 250.                 |
| `forceMs`    | `30000` | Force re-emit cadence (recovers after tmux reattach). Min 1000.       |
| `debug`      | `false` | Append to `/tmp/opencode/oc-iterm2.log`.                              |

`OC_ITERM2_DEBUG=1` in the TUI's environment enables debug logging without
passing options (useful when `cli.json` only lists the plugin by path).

## Plain tmux (non-`-CC`)

The plugin emits the raw `OSC 21337` sequence plus, when `$TMUX` is set, a
DCS-wrapped copy (`ESC Ptmux; … ESC \`) that tmux forwards to iTerm2. Enable
forwarding in `~/.tmux.conf`:

```
set -g allow-passthrough on
```

(tmux 3.3+; `all` instead of `on` if hidden panes should also update the tab.)

## iTerm2 tips

- **View every session:** `View > Toolbelt > Session Status`, or the floating
  `Window > Cockpit` (`⌥⇧⌘C`).
- **Priority sort:** the tool sorts `waiting > working > idle` by default. To
  rank failures the same way, add `error` to the priority list in the tool's
  gear-menu settings.
- **Dot only:** the same gear menu can hide subtitle text while keeping dots.
- **Notify on change:** `Window > Notify on Status Change` (`⇧⌘X`) alerts when
  any session in the window changes state.

## Manual probe

Emit one status update from your real terminal setup to verify rendering:

```sh
bun scripts/probe.ts working "2 agents"
bun scripts/probe.ts waiting "permission · edit"
bun scripts/probe.ts clear
```

## Development

```sh
bun install
bun test        # unit + plugin integration tests
bunx tsc --noEmit
```

Layout: `tui.ts` (discovery entrypoint, re-exports `src/tui.ts`),
`src/iterm.ts` (OSC 21337 encoding), `src/state.ts` (options and state
derivation), `src/tui.ts` (plugin entry, `{ id, setup }` per the V2 TUI
loader contract).
