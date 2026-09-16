# Efficiency / RTK

Commands execute **unchanged, once**. [RTK](https://github.com/rtk-ai/rtk) filters ordinary Git diffs/porcelain-v1 status and cargo/pytest/ctest/Vitest success; native code reduces Node/Python pass lines. No model calls/tools added.

Native/Bash grep groups paths without dropping matches, line numbers, whitespace or order. Monitor JSON removes formatting whitespace only. Reads, user `!`, context/truncated grep, ordinary `git log`, diagnostics, failures, complex/unknown/oversized output and non-beneficial reductions stay raw; missing RTK falls back.

Filters isolate HOME/cwd and disable TOML/telemetry; commands keep their environment. No `rtk init`, hooks or history scans. Explicit RTK calls are outside this isolation.

`/output raw|auto` controls Bash/search reductions for the session; `# pi:raw` bypasses one Bash result. Read the returned artifact for exact output—**never replay side effects**. Capture ≤2 MB; larger results retain native log links. At most 100 artifacts/session.

Cache diagnostics: every provider request is fingerprinted (system prompt, tool definitions, per-item conversation hashes; hashes only, nothing stored). When an assistant response reports a cache read well below the previous context, the transcript gets a warning naming the cause—system prompt changed, tools added/removed/redefined, conversation diverged at item N, or request unchanged (provider-side eviction/routing, with idle time)—and a `cache-diagnostic` session entry records it for later analysis. Pi's own `showCacheMissNotices` says a miss happened; this says why.

Prompt pinning: Pi applies extension prompt additions (memory, code navigation, chrome primer, advertised agents) only in `before_agent_start` and clears them when a run ends; a run started by a custom message (monitor output, subagent notification) skips that hook, so the next tool-set change rebuilds the bare base prompt and breaks the cached prefix. The extension keeps the last prompt produced by `before_agent_start` as the reference and, when a mid-run request carries exactly that prompt minus its tail, restores it (`cache-prompt-restored` entry). Genuine prompt changes always arrive through `before_agent_start` and are accepted as the new reference.

Idle compaction: `efficiency.idleCompactMinutes` (default 10, `0` disables) and `efficiency.idleCompactMinTokens` (default 30000) in settings.json. After the agent settles with at least that much context, a timer waits for the provider cache to expire; if the agent is still idle with nothing queued and pi-condense is loaded, it dispatches `/pruner compact` (chain compression of all closed turns, one Luna call per multi-batch chain). The next request re-reads the context regardless, so this only makes that re-read, and everything after it, smaller. Logged as `cache-idle-compact`; the following cache diagnostic is annotated as expected.

`/tokens [all]` separates provider usage from byte reductions (including recovery metadata), not subscription/billing savings. Sessions count independently; Pi `/session` and fleet own delegated totals. Failures without usage are unknown; no history import. `rtk gain` covers explicit RTK calls only.

Private state: agent-directory `efficiency/usage.sqlite`, raw output and isolated `rtk-home` (0700/0600). Logs can contain secrets, are unencrypted, and never belong in Git/Obsidian. Metadata contains no commands/prompts/source. Stop Pi before deleting state.

Pi/terminal share `~/.local/bin/rtk`. [Updates](../../../skills/pi-maintenance/SKILL.md). Tests: `node --test tests/pi-efficiency*.test.mjs`; `PI_RTK_LIVE=1` also runs real RTK fixtures.
