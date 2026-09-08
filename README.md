# .rcs

macOS zsh, tmux, Neovim, SQLFluff, and Pi configuration; home-directory links point here.

## Install / sync

```sh
git clone https://github.com/EricBriscoe/.rcs.git ~/dev/.rcs
cd ~/dev/.rcs
./setup.sh                 # whole dotfiles setup; replaces conflicting resources
# Or Pi only:
./setup-pi.sh
export PATH="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/bin:$PATH"
pi
```

Full setup configures Homebrew PATH, shell/editor tools, oh-my-zsh, fzf, virtualenvwrapper/`~/.venvs`, symlinks, and Pi. Optional local shell integrations load only when present. Neovim bootstraps lazy.nvim/Mason on first launch; `:Lazy sync` updates plugins.

Pi setup ensures Node ≥22.19, ripgrep, fd, Pi/Playwright/Chromium, checksum-verified RTK, and `pi-subagents`. It backs up conflicting Pi resources; `--skip-install` only relinks. Extension links retain source directory names for sibling imports and migrate recognized old `rcs-` links without deleting user replacements.

On each Mac, `/login openai-codex`. Default: Astra/high; `/model` or `/thinking`, then Ctrl+S, saves defaults through the settings symlink. To sync: commit/push authorized source changes, then `git pull --ff-only`, rerun setup, restart Pi. Credentials and runtime state remain machine-local.

## Pi

The launcher at `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/bin/pi` checks latest stable dependencies on every launch and uses standard Pi discovery. `PI_AUTO_UPDATE=0 pi --no-extensions` bypasses updates for repair. Versions stay machine-local; no update PRs or test gate. Settings, owned extensions, themes, and skills are linked from this checkout; npm packages are declared in `pi/settings.json`. The optional project-context extension also loads a real `.pi/AGENTS.md` from the trusted starting workspace.

| Feature | Usage / reference |
|---|---|
| Appearance | Quiet Graphite + compact footer; Paper alternative in `/settings`. `/appearance compact\|stock`. [Guide](pi/extensions/appearance/README.md) |
| File/code search | Native `grep` (ripgrep), `find`, `ls`; read-only LSP/ast-grep. First-use assessment covers relevant languages. `/code-nav [reassess]`. [Guide](pi/extensions/code-navigation/README.md) |
| Quiet output / RTK | Automatic supported-output filtering; raw artifacts, no command replay. `/output raw\|auto`, `/tokens [all]`. [Guide](pi/extensions/efficiency/README.md) |
| Memory | Automatic scoped recall/idle learning. `/memory` controls/search; consumes model quota. Start Pi in the target repo—shell `cd` does not rescope it. [Guide](pi/extensions/memory/README.md) |
| Subagents | Stock `pi-subagents`: delegation, workflows, fleet inspector, and worktrees. `/subagents-guide`, `/subagents-fleet`, `/subagents-models`. [Setup](pi/SUBAGENTS.md) |
| Questions | `ask_user`: choices or text; Escape/blank/unavailable UI is not approval. Interactive/RPC only. |
| Monitors | Background command output wakes Pi; bounded buffers, session-owned, stopped on exit/switch. Stop unused watchers. |
| Commit | `/skill:schlep`: stage all non-ignored changes and make one commit; **no push**. [Skill](pi/skills/schlep/SKILL.md) |
| Maintenance | Sources/update policy/checks in [pi-maintenance](pi/skills/pi-maintenance/SKILL.md), loaded only for Pi work. |

`web_search` uses Bing or DuckDuckGo without an API key; `web_browse` reads/interacts with pages, screenshots, and localhost apps. Both use separate temporary Playwright profiles, not your normal browser. Open returned URLs before citing content. Login/CAPTCHA requires human input. Use `headed: true` to show a new browser; close before changing mode.

Keep auth, sessions, memories, task logs, navigation tooling, raw output, caches, and browser profiles outside Git/Obsidian. Private permissions are not encryption or an OS sandbox. Delegation follows upstream `pi-subagents` behavior, without the retired custom restrictions. Restart after setup; `/reload` refreshes already-loaded resources.

## Checks

```sh
bash -n setup-pi.sh setup.sh
python3 -m unittest discover -s tests -v
node --test tests/pi-*.test.mjs
git diff --check
```

Tests use the installed Pi package. Optional live checks:

| Environment | Test glob | Effects |
|---|---|---|
| `PI_RTK_LIVE=1` | `tests/pi-efficiency*.test.mjs` | RTK fixtures |
| `PI_CODE_NAV_LIVE=1` | `tests/pi-code-navigation*.test.mjs` | Managed servers/AST tooling |
| `PI_WEB_LIVE=1` | `tests/pi-web.test.mjs` | Chromium/local page; also verify public search separately |
| `PI_MEMORY_LIVE=1` | `tests/pi-memory-live.test.mjs` | Synthetic provider extraction |

Run as `ENV=1 node --test <glob>`; live model tests use existing login, never copied credentials.

## Local overrides

- `~/.zshrc.local`: machine/work-specific paths, secrets, functions; sourced last.
- `nvim/lua/local.lua` (ignored): optional `biome`, `ruff`, `python` executable paths and `dbs()` connection map for Dadbod. Missing overrides fall back to PATH/empty connections.

## Shell / tmux

`zshrc`: robbyrussell/git theme, daily compinit cache, fnm/zoxide/fzf/virtualenvwrapper, Homebrew Python, branch tab titles. Auto-venv prefers repository `venv/`, then `~/.venvs/<Git-common-root-name>` across worktrees; only deactivates environments it activated.

- `olc [parent]`: open branch-changed files in VS Code; parent from reflog, else `main`.
- `cleandocker`: confirms destructive container/image/volume/network/cache cleanup.
- `claude-work` / `claude-personal`: separate Claude config directories; unrelated to Pi.
- `tmux.conf`: window titles enabled.

## Neovim

Configuration: [options](nvim/lua/config/options.lua), [terminal](nvim/lua/config/terminal.lua), [language tools](nvim/lua/plugins/language.lua), [navigation](nvim/lua/plugins/navigation.lua), [git](nvim/lua/plugins/git.lua), [SQL](nvim/lua/plugins/sql.lua). Plugin pins: `nvim/lazy-lock.json`; language file owns the Mason server/formatter/linter list.

Uses lazy.nvim, which-key, lazydev, blink.cmp/snippets, Mason/LSP, conform/nvim-lint, fzf-lua, gitsigns, and Dadbod. Format-on-save excludes append-only `db/deltas/` SQL. Actionlint runs on workflow YAML. Leader is Space:

| Keys | Action |
|---|---|
| `<space><space>` | Files |
| `<space>sg` / `sw` / `se` | Grep / word / branch-changed files with diff preview |
| `<space>sb` / `sr` / `sk` | Buffers / recent / keymaps |
| `<space>f` / `uf` | Format / toggle buffer autoformat |
| `<C-/>` or `<space>tt` | Terminal |
| `K`, `gd`, `gr`, `gi`, `gD` | Hover, definition, references, implementation, declaration |
| `<space>rn` / `ca` | Rename / code action |
| `]d` / `[d`, `]c` / `[c` | Diagnostics, hunks |
| `<space>gs` / `gr` / `gS` / `gR` | Stage/reset hunk, stage/reset buffer |
| `<space>gp` / `gb` / `gB` / `gd` / `gD` | Preview / blame / toggle blame / index diff / HEAD diff |
| `<space>D` | DB UI |
| `:olc` / `:Olc` | Tabs for branch-changed files; skips existing tabs |

Global autoformat toggle: `:lua vim.g.disable_autoformat = true`.

`sqlfluff/config`: Postgres, uppercase keywords/literals/functions/types, snake_case, four spaces, trailing commas, leading AND/OR, unlimited line length; project `.sqlfluff` overrides. `keyboards/id80_ansi_layout_mine.json` is a VIA layout, not installed.
