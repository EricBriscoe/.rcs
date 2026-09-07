# Code navigation

- `grep`/`find`/`ls`: native lexical/path tools; explicit CLI tool restrictions win.
- `code_nav`: read-only LSP definitions, references, implementations, types, hover, document/workspace symbols. Unsupported methods error explicitly.
- `code_search`: ast-grep patterns, e.g. `console.log($$$ARGS)`; structural matches, not resolved references. No rewrites.

## Setup

The first agent turn in a trusted project requests assessment of **all relevant languages/subprojects**, including unfamiliar/extensionless source. No startup model call or delegated agent. Configure useful servers, verify representative queries, then `assess`; explicitly explain unsupported/unnecessary languages. Inventory is a heuristic, not proof of coverage.

`/code-nav` shows status; `/code-nav reassess` resets assessment. Tool actions: `status`, `setup` with a `recipe`, `configure` for custom stdio servers, `assess` with `summary`/`skipped`, and `remove`. `directory` supports subprojects; most-specific matching server wins. Select `server` for ambiguous workspace searches.

Pins: `pi/code-navigation.json`. Managed npm servers cover JS/TS, Python, HTML, CSS, JSON, YAML, Bash; other recipes reuse installed binaries. Custom commands/advanced settings and unrelated roots need confirmation. Never run privileged/project setup or change project dependencies without approval. Cancelled/unavailable approval means fallback, not success.

Assessment is per canonical worktree root or non-Git cwd. Language/manifest/pin changes and missing executables trigger reassessment; ordinary edits do not. Huge inventories require narrower roots (20,000 files/100 manifests). Home and `/` are not recursively scanned. Managed tooling is installed outside source repositories.

## Boundaries

Paths are relative to root; symlink escapes are rejected. LSP positions are **1-based UTF-16**; AST `byteColumn` is **1-based UTF-8 bytes**, not interchangeable after non-ASCII text. External definition locations are labelled, not automatically opened.

Three resident servers/process; 32 open documents/server; 2 MB/file; initialization 30s, requests 20s, frames 8 MB. Results ≤100/16,000 characters. AST: two threads, 15s. Files are refreshed before queries and changes forwarded; indexes remain eventually consistent. Reload/exit closes watchers and process groups, not arbitrary daemonized descendants.

**Not an OS sandbox:** servers can read dependencies, cache, use networks, or load plugins. Client edits/commands are denied. TypeScript disables automatic type acquisition and uses one semantic server; local project TS may override the pinned fallback. Rust disables checks/build scripts/proc macros. ast-grep uses a native empty config, not repository plugins.

State/tooling: `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/code-navigation/`, private 0700/0600, unencrypted, outside Git/Obsidian. No persisted source snapshots/transcripts. Installs use exact npm pins and `--ignore-scripts`; locks recover dead owners conservatively. No automatic cache eviction. Stop all users before deleting state/tooling to reset it.

Tests: `node --test tests/pi-code-navigation*.test.mjs`; add `PI_CODE_NAV_LIVE=1` for actual pinned servers/ast-grep, no model calls. `PI_CODE_NAV_TOOLING_DIR` redirects the live-test cache.
