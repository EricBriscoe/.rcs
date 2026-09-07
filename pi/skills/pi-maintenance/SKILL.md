---
name: pi-maintenance
description: Configure or develop this Pi harness, its extensions, tools, launcher, dependencies, or instructions. Not needed for ordinary application work.
---
# Pi maintenance

Resolve `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/settings.json`: its target is `<checkout>/pi/settings.json`. Work in that checkout, not an assumed cwd. Inspect Git status and preserve unrelated changes.

| Source | Purpose |
|---|---|
| `pi/settings.json`, `pi/AGENTS.md` | Defaults, lean global rules |
| `pi/version`, `pi/playwright-version`, `pi/rtk.json`, `pi/code-navigation.json` | Version/checksum pins |
| `pi/extensions/<name>/` | Native extension and adjacent README |
| `pi/launch.mjs`, `pi/native-resources.mjs` | Standard Pi startup with the RTK environment |
| `pi/skills/`, `pi/prompts/` | On-demand resources |
| `setup-pi.sh`, `tests/`, `README.md` | Installation, regression tests, usage |

Read installed Pi API docs/examples before changing extension contracts. Preserve symlinks; extension directory names must match source siblings. Declare npm packages with exact versions in `pi/settings.json`; use standard Pi discovery. Subagent controls belong upstream, not in a new custom policy layer. Keep details here or in the relevant README, not global instructions.

From the checkout:

```sh
bash -n setup-pi.sh setup.sh
python3 -m unittest discover -s tests -v
node --test tests/pi-*.test.mjs
git diff --check
```

Capture long test logs locally; report totals/failures, not every passing test. Check new files too. Run `./setup-pi.sh` for changed pins; `--skip-install` for links only. Navigation changes require `PI_CODE_NAV_LIVE=1 node --test tests/pi-code-navigation*.test.mjs`; RTK changes require `PI_RTK_LIVE=1 node --test tests/pi-efficiency*.test.mjs`. Browser changes need a live search and local interaction test.

Restart through the native launcher for new extensions/startup changes; `/reload` refreshes already-loaded resources. Report checks. Commit/push only when authorized. Machine-local state stays under the agent directory, never Git or Obsidian; each Mac logs in separately.
