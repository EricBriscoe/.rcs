# .rcs

macOS shell, editor, and Pi configuration.

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

Full setup installs shell/editor tools and links these files. Optional local shell integrations load when present. Neovim installs plugins on first launch; `:Lazy sync` updates them.

Pi setup installs Node ≥22.19, ripgrep, fd, Pi, Playwright/Chromium, checksum-verified RTK, and the packages in `pi/settings.json`, including `pi-subagents`, `pi-mcp-adapter`, and `pi-vim`. Conflicts are backed up; `--skip-install` only relinks.

On each Mac, `/login openai-codex` uses your OpenAI subscription. `/model` or `/thinking`, then Ctrl+S, saves defaults through the settings symlink. To sync: commit/push authorized source changes, then `git pull --ff-only`, rerun setup, restart Pi. Credentials stay local.

## Pi

Vim prompt editing is enabled: `Esc` enters Normal mode; `i` returns to Insert. Motions, text objects, visual mode, `u` undo, and `Ctrl+r` redo work. In Normal mode, `:codex-pool` opens account settings.

`${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/bin/pi` checks stable updates on launch. For repair: `PI_AUTO_UPDATE=0 pi --no-extensions`. Settings, extensions, themes, and skills link here; packages are in `pi/settings.json`. Project context can load the trusted workspace's `.pi/AGENTS.md`.

| Feature | Usage / reference |
|---|---|
| Appearance | Quiet Graphite + compact footer; Paper alternative in `/settings`. `/appearance compact\|stock`. [Guide](pi/extensions/appearance/README.md) |
| File/code search | Native search plus read-only LSP/ast-grep. `/code-nav [reassess]`. [Guide](pi/extensions/code-navigation/README.md) |
| Quiet output / RTK | Filtered output; raw artifacts retained. `/output raw\|auto`, `/tokens [all]`. [Guide](pi/extensions/efficiency/README.md) |
| Memory | `/memory`: recall/learning; uses quota. Start in the target repo; shell `cd` does not change scope. [Guide](pi/extensions/memory/README.md) |
| Subagents | Stock delegation, workflows, fleet, and worktrees. `/subagents-guide`, `/subagents-fleet`, `/subagents-models`. [Setup](pi/SUBAGENTS.md) |
| Questions | `ask_user`: choices or text; Escape/blank/unavailable UI is not approval. Interactive/RPC only. |
| Background commands | `monitor` start requires `notifyOn: "output"` (live events) or `"completion"` (one final result). Session-owned; bounded output, manual read/stop available. |
| Commit | `/skill:schlep`: stage all non-ignored changes and make one commit; **no push**. [Skill](pi/skills/schlep/SKILL.md) |
| Maintenance | See [pi-maintenance](pi/skills/pi-maintenance/SKILL.md). |

`web_search` uses Bing/DuckDuckGo without a key. `web_browse` supports pages, screenshots, and localhost. Both use temporary Playwright profiles. Open URLs before citing them. Login/CAPTCHA needs human input. `headed: true` shows the browser; close it before changing mode.

Keep credentials and runtime data outside Git/Obsidian. Permissions are not encryption or a sandbox. Subagents follow upstream behavior. Restart after setup; `/reload` refreshes loaded resources.

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

## Machine-local config

MCP server connections belong in `~/.config/mcp/mcp.json`, outside this repository. Setup installs the adapter only; configure servers and sign in on each Mac with `/mcp setup` and `/mcp-auth <server>`. Do not also load the installed adapter from a file in `~/.pi/agent/extensions/`; this causes duplicate tool registration.

`~/.zshrc.local` loads last for private paths, secrets, and shell functions. Optional, gitignored `nvim/lua/plugins/local.lua` supplies lazy.nvim specs; return `{}` if none. Append functions to `require("util.project").db_sources` for dadbod-ui connections (`{ name = connection_url }`).

## Shell and other files

[zshrc](zshrc) uses oh-my-zsh/robbyrussell, optional tool integrations, daily compinit caching, and branch tab titles. It selects Homebrew Python for virtualenvwrapper. Directory changes activate `<git-root>/venv` or `~/.venvs/<main-repo-name>` across worktrees; only these environments are deactivated automatically.

- `olc [parent]`: open branch changes in VS Code; parent comes from the reflog, else main.
- `cleandocker`: confirm, then remove all containers and prune Docker data.
- `claude-work` / `claude-personal`: separate account config directories.
- `codex-work` / `codex-personal`: separate login/runtime state; shared config, instructions, skills, plugins, hooks, policies, memories, and automations.

[tmux.conf](tmux.conf) uses pane titles. [sqlfluff/](sqlfluff/) sets Postgres style; project config overrides it. [keyboards/](keyboards/) holds a VIA layout; setup does not install it.

## Neovim

[nvim/](nvim/) uses LazyVim. `lazyvim.json` selects extras; `lazy-lock.json` pins plugins. Extras cover Python, TypeScript/Biome/ESLint, SQL, Terraform, Docker, YAML/JSON/TOML, Markdown, Git, Rust, Prettier, and neotest. Prettier requires project config.

`lua/util/project.lua` resolves Git/worktree roots, mainline, venvs, and `.env` files. Git roots take priority over LSP roots. Python uses `<root>/venv`, `<root>/.venv`, then `$WORKON_HOME/<main-repo-name>` (default `~/.venvs`). Without a root it can use `$VIRTUAL_ENV`. The selected venv supplies Python and Ruff when available. Biome uses the nearest config and ancestor `node_modules/.bin/biome`, else PATH. ESLint needs both config and an installed binary.

`lua/plugins/` configures language tools and navigation. Format on save uses project tools. SQL uses Postgres formatting without diagnostics; `db/deltas/` is exempt. Indentation is four spaces, two for Lua. `.tf`/`.tofu` use Terraform; Compose uses its language server; Swift uses sourcekit-lsp.

Leader: Space; `<space>sk` lists mappings.

| Keys | Action |
|---|---|
| `<space>gw` / `<space>se` | Worktrees / branch edits with diff preview |
| `:Olc` or `:olc` | Load branch changes as buffers |
| `<space>D` | Database UI |
| `<space>tt` / `<space>tr` / `<space>ts` | Test file / nearest / summary |
| `<space>cv` / `<space>gg` | Venv picker / lazygit |
| `<space>uf` / `<space>uF` | Toggle format globally / for buffer |

Outside Mason, install Neovim, ripgrep, fd, fzf, lazygit, tree-sitter-cli, rust-analyzer, a C compiler, and a terminal Nerd Font.
