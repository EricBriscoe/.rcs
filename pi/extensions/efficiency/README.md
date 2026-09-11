# Efficiency / RTK

Commands execute **unchanged, once**. [RTK](https://github.com/rtk-ai/rtk) filters ordinary Git diffs/porcelain-v1 status and cargo/pytest/ctest/Vitest success; native code reduces Node/Python pass lines. No model calls/tools added.

Native/Bash grep groups paths without dropping matches, line numbers, whitespace or order. Monitor JSON removes formatting whitespace only. Reads, user `!`, context/truncated grep, ordinary `git log`, diagnostics, failures, complex/unknown/oversized output and non-beneficial reductions stay raw; missing RTK falls back.

Filters isolate HOME/cwd and disable TOML/telemetry; commands keep their environment. No `rtk init`, hooks or history scans. Explicit RTK calls are outside this isolation.

`/output raw|auto` controls Bash/search reductions for the session; `# pi:raw` bypasses one Bash result. Read the returned artifact for exact output—**never replay side effects**. Capture ≤2 MB; larger results retain native log links. At most 100 artifacts/session.

`/tokens [all]` separates provider usage from byte reductions (including recovery metadata), not subscription/billing savings. Sessions count independently; Pi `/session` and fleet own delegated totals. Failures without usage are unknown; no history import. `rtk gain` covers explicit RTK calls only.

Private state: agent-directory `efficiency/usage.sqlite`, raw output and isolated `rtk-home` (0700/0600). Logs can contain secrets, are unencrypted, and never belong in Git/Obsidian. Metadata contains no commands/prompts/source. Stop Pi before deleting state.

Pi/terminal share `~/.local/bin/rtk`. [Updates](../../skills/pi-maintenance/SKILL.md). Tests: `node --test tests/pi-efficiency*.test.mjs`; `PI_RTK_LIVE=1` also runs real RTK fixtures.
