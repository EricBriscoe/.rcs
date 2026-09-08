# Efficiency / RTK

Pi runs commands **unchanged, once**. Supported successful Bash output passes through [RTK](https://github.com/rtk-ai/rtk) `pipe --filter`; Node/Python passing-test lines use a native reducer. No model calls or tool schemas. Other tools, user `!` commands and monitors stay unchanged.

Filters: ordinary Git diffs/porcelain-v1 status, cargo/pytest/ctest/Vitest success, plain file:line grep. Diagnostics, failures, complex commands, unknown formats, oversized output, missing RTK and non-beneficial reductions stay raw. Ordinary `git log` lacks RTK's required delimiters and stays raw.

Filter processes use isolated HOME/cwd, disabled TOML filters/telemetry; original commands keep their environment. No `rtk init`, hooks or history scanners. Explicit RTK commands are not this isolation boundary.

`/output raw|auto` controls the session; `# pi:raw` bypasses one Bash result. Read the returned artifact for exact output—**never replay side effects**. Capture ≤2 MB; larger results retain native log links. At most 100 artifacts/session.

`/tokens [all]` separates provider-reported usage from tool-result byte reductions, including recovery metadata. Neither measures subscription/billing savings. Each instrumented session is independent; Pi `/session` and subagent fleet own delegated totals. Failures without usage are unknown; no history import. Terminal `rtk gain` estimates savings for explicit RTK commands, not Pi's automatic filters.

Private state: agent-directory `efficiency/usage.sqlite`, raw output and isolated `rtk-home` (0700/0600). Logs can contain secrets, are unencrypted, and never belong in Git/Obsidian. Metadata contains no commands/prompts/source. Stop Pi before deleting state.

Setup installs `~/.local/bin/rtk`; Pi and terminal share the selected release. See [update policy](../../skills/pi-maintenance/SKILL.md). Tests: `node --test tests/pi-efficiency*.test.mjs`; `PI_RTK_LIVE=1` also runs real RTK fixtures.
