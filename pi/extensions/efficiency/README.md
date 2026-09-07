# Efficiency / RTK

Pi runs commands **unchanged, once**. Successful supported Bash output passes through pinned [RTK](https://github.com/rtk-ai/rtk) `pipe --filter`; Node/Python passing-test lines have a native reducer. No extra model calls or tool schemas. `read`, `grep`, `find`, LSP, user `!` commands, and monitors are unchanged.

Auto filters: normal git diffs, porcelain-v1 status, cargo/pytest/ctest/Vitest success output, and plain file:line grep results. Unknown formats, complex shell commands, errors, detected warnings, oversized output, missing RTK, filter failures, and non-beneficial reductions stay raw. This is deliberately narrower than upstream rewrites.

Why not the upstream hook? Its rewrite path reads Claude settings. We install no `rtk init`, hooks, instructions, discovery/history scanners, or telemetry. Filter subprocesses use isolated HOME/cwd and disabled TOML filters/telemetry; original commands retain their normal environment. Ordinary `git log` stays raw: RTK's pipe filter requires injected delimiters. Native Pi adds the pinned binary to its PATH for explicit use; explicit RTK commands are not the automatic isolation boundary.

`/output raw|auto` controls this session. Prefix one Bash call with `# pi:raw` to bypass reduction. Read the returned raw artifact for exact patches or omitted details—**never rerun side effects for output**. Reductions are lossy and labelled; failures retain native output/error status. Raw capture precedes reduction (≤2 MB); larger native logs retain Pi's existing file link. Keep at most 100 generated artifacts/session.

`/tokens [all]` records each instrumented session independently, including memory learning, compaction, and branch summaries. Use Pi's `/session` and the subagent fleet for delegated usage; this extension does not re-count their aggregate. Provider tokens and before/after tool-result bytes are distinct; neither proves bill/quota savings. Only new reported usage is counted; errors without usage are unknown.

State: agent-directory `efficiency/usage.sqlite`, private per-session raw output folders and isolated `rtk-home`. Permissions 0700/0600; logs may contain secrets, are unencrypted, and must not enter Git/Obsidian. Metadata stores no commands/prompts/source bodies. Stop Pi before deleting state; no automatic session-history import or global cleanup.

Install/update: pin release/checksums in `pi/rtk.json`, run `./setup-pi.sh`. No remote installer scripts. Tests: `node --test tests/pi-efficiency*.test.mjs`; `PI_RTK_LIVE=1` also tests the real pinned binary.
