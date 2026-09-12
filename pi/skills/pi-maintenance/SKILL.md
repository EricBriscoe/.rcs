---
name: pi-maintenance
description: Configure or develop this Pi harness, its extensions, tools, launcher, dependencies, or instructions. Not needed for ordinary application work.
---
# Pi maintenance

Resolve `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/settings.json` to `<checkout>/pi/settings.json`. Work there; inspect Git status and preserve changes.

| Source | Purpose |
|---|---|
| `pi/settings.json`, `pi/models.json`, `pi/AGENTS.md` | Defaults, model budgets, lean global rules |
| `pi/version`, `pi/playwright-version`, `pi/rtk.json`, `pi/code-navigation.json` | Bootstrap/recovery versions and recipes |
| `pi/extensions/<name>/` | Native extension and adjacent README |
| `pi/launch.mjs`, `pi/update-deps.mjs`, `pi/rtk.mjs` | Launch-time updates and shared RTK |
| `pi/skills/`, `pi/prompts/` | On-demand resources |
| `setup-pi.sh`, `tests/`, `README.md` | Installation, regression tests, usage |

Read installed API docs/examples before changing extension contracts. Preserve symlinks and sibling names. Keep `pi-subagents` unversioned; use stock discovery, updates and controls. Put details here or in extension READMEs, not global instructions.

Markdown: trim redundancy, preserving safety/commands/limits; raise caps gradually only if needed. No confirmation needed; check/commit rules still apply.

Codex Astra: 416,384 context budget − 16,384 default reserve = ~400K compaction. Other models unchanged. Open `/model` or restart to reload overrides; provider limits apply.

Launch updates: fast-forward pull clean `.rcs` main/master from its matching remote upstream, skipping active Git operations. No hooks/stash/rebase/reset/push. Then check latest stable Pi, pi-subagents, Playwright/Chromium, RTK, proper-lockfile and used navigation recipes; preserve custom/system servers. No CI gate, npm scripts, Node/Homebrew upgrades or session restarts. Verify RTK checksums. Dependency state: agent-directory `updates/`, not `.rcs`. Failures warn/continue/retry next launch; no guaranteed rollback.

Recovery: `PI_AUTO_UPDATE=0 pi --no-extensions` or `--offline`. Nested/child launches skip updates. `PI_AUTO_UPDATE=0 ./setup-pi.sh` uses bootstrap core/browser versions; `--skip-install` only relinks.

From the checkout:

```sh
bash -n setup-pi.sh setup.sh
python3 -m unittest discover -s tests -v
node --test tests/pi-*.test.mjs
git diff --check
```

Capture logs locally; report totals/failures. Check new files too. Navigation: `PI_CODE_NAV_LIVE=1 node --test tests/pi-code-navigation*.test.mjs`; RTK: `PI_RTK_LIVE=1 node --test tests/pi-efficiency*.test.mjs`. Browser changes require live search/local interaction tests.

Pulled resources load in the new session; launcher/updater changes apply next launch. Rerun setup for new links; `/reload` refreshes resources. Commit/push only when authorized. State stays outside Git/Obsidian; log in separately on each Mac.
