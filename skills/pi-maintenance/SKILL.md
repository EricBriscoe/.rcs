---
name: pi-maintenance
description: Configure or develop this Pi harness, its extensions, tools, launcher, dependencies, or instructions. Not needed for ordinary application work.
---
# Pi maintenance

Shared defaults live in `<checkout>/pi/settings.json`; `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/settings.json` is a local writable file, not a symlink. Edit checkout defaults for shared changes. Setup/launch reconcile against local `settings-defaults.json`, preserving overrides and runtime state. Inspect Git status and preserve changes.

| Source | Purpose |
|---|---|
| `pi/settings.json`, `pi/models.json`, `AGENTS.md` | Defaults, model budgets, shared harness instructions |
| `pi/version`, `pi/playwright-version`, `pi/rtk.json` | Bootstrap/recovery versions |
| `pi/extensions/<name>/` | Native extension and adjacent README |
| `pi/launch.mjs`, `pi/settings.mjs`, `pi/update-deps.mjs`, `pi/rtk.mjs` | Launch-time updates and shared RTK |
| `skills/` | Shared skills, linked for Pi, Codex, and Claude |
| `setup-pi.sh`, `tests/`, `README.md` | Installation, regression tests, usage |

Read installed API docs/examples before changing extension contracts. Preserve symlinks/sibling names. Keep `pi-subagents` unversioned and stock. Details belong here or in extension READMEs.

Trim Markdown redundancy; preserve safety, commands and limits. Raise caps gradually only if needed, without confirmation. Check/commit rules still apply.

Codex models keep Pi's built-in 272,000 context window so compaction lands before OpenAI's long-context surcharge (2× input above 272K); do not raise it in `pi/models.json`. Subscription usage is ~95% input context: keep the system prompt and tool list byte-stable within a session (no live inventories, timestamps, or auth-state text in `before_agent_start`), and verify with `showCacheMissNotices` or a `before_provider_request` payload dump. Session JSONL `usage.input`/`cacheRead` are the ground truth, and the efficiency extension's `cache-diagnostic` entries name the cause of each drop. Any feature that rewrites earlier transcript items (pruners, chain compression, summaries inserted mid-history) costs a re-read of everything after the rewrite; enable it only where the reclaimed tokens dwarf that tail.

Launch updates: fast-forward pull clean `.rcs` main/master from its matching remote upstream, skipping active Git operations. No hooks/stash/rebase/reset/push. Then update stable Pi, all unpinned npm packages in `pi/settings.json`, Playwright/Chromium, RTK and proper-lockfile. No CI gate, Node/Homebrew upgrades or session restarts. Setup pins Pi’s Node executable in the agent-directory `runtime-node` file without changing project PATH. Updater subprocesses use that runtime’s bin directory. npm scripts are disabled except for explicit pi-knowledge install/update operations and automatic SQLite ABI repair. The updater probes SQLite even when package versions are unchanged. Verify RTK checksums. Dependency state: agent-directory `updates/`, not `.rcs`. Failures warn/continue/retry next launch; no guaranteed rollback.

Recovery: `PI_AUTO_UPDATE=0 pi --no-extensions` or `--offline`. Nested/child launches skip updates. `PI_AUTO_UPDATE=0 ./setup-pi.sh` uses bootstrap core/browser versions; `--skip-install` reconciles settings and relinks resources.

From the checkout:

```sh
bash -n setup-pi.sh setup.sh setup-common.sh
python3 -m unittest discover -s tests -v
node --test tests/pi-*.test.mjs
git diff --check
```

Capture logs locally; report totals/failures. Check new files too. Knowledge: `PI_KNOWLEDGE_LIVE=1 node --test tests/pi-stock-knowledge.test.mjs`; RTK: `PI_RTK_LIVE=1 node --test tests/pi-efficiency*.test.mjs`. Browser changes require live search/local interaction tests.

Pulled resources load in the new session; launcher/updater changes apply next launch. Rerun setup for new links; `/reload` refreshes resources. Commit/push only when authorized. State stays outside Git/Obsidian; log in separately on each Mac.
