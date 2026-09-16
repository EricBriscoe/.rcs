# Tool loader

Keeps rarely used tool groups out of the prompt prefix until the model asks for them. Codex models support Pi's native deferred tool loading, so `load_tools` activates a group at the tool-result position without invalidating the cached prefix (activating tools that carry prompt snippets still rebuilds the system prompt once).

Groups live in `GROUPS` in `index.ts`:

| Group | Tools | Saves per request |
|---|---|---|
| `delegation` | `subagent`, `bg_wait`, `subagent_supervisor` | ~6K tokens of schema plus the advertised-agents block that pi-subagents and model-briefing only inject when `subagent` is active |

`session_start` deactivates every grouped tool and keeps `load_tools` active. Explicit CLI restrictions (`--tools`, `--no-tools`, `--exclude-tools`, …) win and the loader does nothing. `/reload` re-defers; the model reloads the group on its next call. Subagent notifications and supervisor requests still arrive as messages; the model loads `delegation` before answering them.

Tests: `node --test tests/pi-tool-loader.test.mjs`.
