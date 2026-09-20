# .rcs

Shell, editor, and Pi configuration for macOS. Full setup requires Apple Silicon Homebrew (`/opt/homebrew`).

## Install / sync

```sh
git clone https://github.com/EricBriscoe/.rcs.git ~/dev/.rcs
cd ~/dev/.rcs
./setup.sh                 # full setup; backs up conflicting resources
# Or Pi only:
./setup-pi.sh
export PATH="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/bin:$PATH"
pi
```

Full setup installs shell/editor tools, Starship for Zsh, Pi, and the locked LazyVim plugins. Reruns preserve correct links and back up conflicts to `~/.local/state/rcs/backups` (Pi uses its agent directory). `:Lazy sync` updates plugins.

Root `AGENTS.md` is the shared instruction source for Pi, Codex, and Claude. It starts empty; setup never clears it. Pi always links it. If `codex` or `claude` is on PATH, full setup links `~/.codex/AGENTS.md` or `~/.claude/CLAUDE.md`, plus their work/personal account directories. `CODEX_HOME` and `CLAUDE_CONFIG_DIR` also receive links when set. Root `skills/` holds shared skills, linked per skill into `~/.pi/agent/skills`, `~/.codex/skills` (account homes share it), and every Claude config directory. Other harness files and credentials stay unchanged. Editor links respect `XDG_CONFIG_HOME`.

Pi setup installs Node ≥22.19, ripgrep, fd, Pi, Playwright/Chromium, checksum-verified RTK, and packages from `pi/settings.json`. Conflicts are backed up; `--skip-install` reconciles settings and relinks resources.

`pi/settings.json` holds shared defaults. Setup and launch maintain a separate writable `~/.pi/agent/settings.json` (or `$PI_CODING_AGENT_DIR/settings.json`). A local `settings-defaults.json` baseline lets unchanged values follow new defaults while preserving local overrides, deletions, and runtime state such as the changelog marker. Nested settings merge by key; arrays, including packages, are replaced as a whole. Existing settings are backed up on migration; the checkout is never rewritten. To share a preference, edit the checkout defaults rather than the local file.

On each Mac, `/login openai-codex` uses your subscription; credentials stay local. `/model` or `/thinking`, then Ctrl+S, saves machine-local defaults. Push authorized commits; Pi pulls on launch.

Subscription usage is almost entirely input context, so the harness keeps the prompt prefix cacheable: Codex models stay on Pi's 272K context window (compaction before OpenAI's long-context surcharge), subagents default to Terra/Luna with Astra reserved for `reviewer`/`oracle`, and cache-miss notices are on. One habit matters: prefer `/chrome authorize indefinite` over repeated 15-minute grants (each grant/expiry changes the prompt). Breaks are handled for you: after ten idle minutes the efficiency extension runs pi-condense chain compaction, since the provider cache is gone either way ([details](pi/extensions/efficiency/README.md)).

## Pi

Vim prompt editing is enabled: `Esc` enters Normal mode; `i` returns to Insert. Motions, text objects, visual mode, `u` undo, and `Ctrl+r` redo work. In Normal mode, `:codex-pool` opens account settings.

The Pi launcher pulls `.rcs` before updating dependencies and unpinned npm packages; [safeguards](skills/pi-maintenance/SKILL.md). Repair: `PI_AUTO_UPDATE=0 pi --no-extensions`. Trusted workspace context includes `.pi/AGENTS.md`.

| Feature | Usage / reference |
|---|---|
| Appearance | Quiet Graphite + compact footer; Paper alternative in `/settings`. `/appearance compact\|stock`. [Guide](pi/extensions/appearance/README.md) |
| File/code search | Native search plus stock [pi-knowledge](https://github.com/nczz/pi-knowledge): local BM25/semantic retrieval and indexed symbol lookup. Use `knowledge_plan` before indexing, then `knowledge_add` and `knowledge_search`. No custom LSP/ast-grep tools. |
| Quiet output / RTK | Filtered output; raw artifacts retained. `/output raw\|auto`, `/tokens [all]`. [Guide](pi/extensions/efficiency/README.md) |
| Context inspector | `/context usage` and `/context injections` inspect prompt/tool overhead without adding model tools. [Upstream](https://github.com/dimk90/pi-context-view) |
| Context pruning | Stock [pi-condense](https://github.com/mjakl/pi-condense) summarizes finished tool-call batches with Luna once per agent reply; originals stay recoverable via `context_tree_query`. Chain compression is off: it rewrote old turns on every reply, which re-read the whole transcript for a few K tokens of savings. `/pruner status\|now\|off`. |
| Tool loader | Delegation tools (`subagent`, `bg_wait`, `subagent_supervisor`) stay out of the prompt prefix until the model calls `load_tools`. [Guide](pi/extensions/tool-loader/README.md) |
| Memory | Stock [pi-memory](https://github.com/jayzeng/pi-memory): daily logs, long-term notes and scratchpad in `~/.pi/agent/memory/`. `memory_status` reports health; setup installs `qmd` via npm if missing from PATH. Restart Pi to auto-create the search collection. |
| Subagents | Stock delegation, workflows, fleet, and worktrees. `/subagents-guide`, `/subagents-fleet`, `/subagents-models`. [Setup](pi/SUBAGENTS.md) |
| Bigpowers | Skills/prompts only; hooks disabled. `/skill:using-bigpowers`. Project provisioning (`bigpowers init`) is opt-in. |
| Questions | `ask_user`: choices or text; Escape/blank/unavailable UI is not approval. Interactive/RPC only. |
| Background commands | `monitor` start requires `notifyOn: "output"` (live events) or `"completion"` (one final result). Session-owned; bounded output, manual read/stop available. |
| Commit + push | `/skill:schlep`: stage all non-ignored changes, commit, and push to the upstream. [Skill](skills/schlep/SKILL.md) |
| Maintenance | See [pi-maintenance](skills/pi-maintenance/SKILL.md). |

`pi-chrome`: `/reload`, `/chrome onboard`, manually load its Chrome companion, `/chrome authorize` (15m), `/chrome doctor`. `/chrome revoke` locks access. Preferred when authorized/connected; broad signed-in-profile access, with page content sent to the model.

`web_browse`/`web_search` remain isolated Playwright fallbacks, without Chrome cookies. Login/CAPTCHA needs human input. `headed: true` shows the fallback browser; close before changing mode.

`pi-knowledge` uses local embeddings and machine-local storage (`~/.pi/knowledge/` by default). No sources are indexed by setup. The launcher disables automatic context injection; upstream still appends a KB inventory to the prompt, which can change after indexing. Native dependency install scripts are enabled only for explicit `pi install npm:pi-knowledge` / `pi update npm:pi-knowledge` operations and its automatic package update. Other package scripts remain disabled. Indexed symbols are not LSP references; read current source before editing. Retired navigation caches remain inert on disk; setup removes only owned extension links.

Keep credentials and runtime data outside Git/Obsidian. Permissions are not encryption or a sandbox. Restart after setup; `/reload` refreshes loaded resources.

## Checks

```sh
bash -n setup-pi.sh setup.sh setup-common.sh
python3 -m unittest discover -s tests -v
node --test tests/pi-*.test.mjs
git diff --check
```

Tests use the installed Pi package. Optional live checks:

| Environment | Test glob | Effects |
|---|---|---|
| `PI_RTK_LIVE=1` | `tests/pi-efficiency*.test.mjs` | RTK fixtures |
| `PI_KNOWLEDGE_LIVE=1` | `tests/pi-stock-knowledge.test.mjs` | Local model download, temporary-fixture indexing and retrieval |
| `PI_WEB_LIVE=1` | `tests/pi-web.test.mjs` | Chromium/local page; also verify public search separately |

Run as `ENV=1 node --test <glob>`; live model tests use existing login, never copied credentials.

## Machine-local config

MCP server connections belong in `~/.config/mcp/mcp.json`, outside this repository. Setup installs the adapter only; configure servers and sign in on each Mac with `/mcp setup` and `/mcp-auth <server>`. Do not also load the installed adapter from a file in `~/.pi/agent/extensions/`; this causes duplicate tool registration.

`~/.zshrc.local` loads last for private paths, secrets, and shell functions. Optional, gitignored `nvim/lua/plugins/local.lua` supplies lazy.nvim specs; return `{}` if none.

## Shell and other files

[zshrc](zshrc) uses [Starship](https://starship.rs) for its prompt, optional tool integrations, daily compinit caching, and branch tab titles. `./setup.sh` installs Starship through Homebrew (safe to rerun); shell startup only initializes it if installed. It selects Homebrew Python for virtualenvwrapper. Directory changes activate `<git-root>/venv` or `~/.venvs/<main-repo-name>` across worktrees; only these environments are deactivated automatically.

- `cleandocker`: confirm, then remove all containers and prune Docker data.
- `claude-work` / `claude-personal`: separate account config directories.
- `codex-work` / `codex-personal`: separate login/runtime state; shared config, instructions, skills, plugins, hooks, policies, memories, and automations.

[tmux.conf](tmux.conf) uses pane titles.

## Neovim

[nvim/](nvim/) uses LazyVim. `lazyvim.json` selects extras; `lazy-lock.json` pins plugins. Extras cover Python, TypeScript/Biome/ESLint, SQL, Terraform, Docker, YAML/JSON/TOML, Markdown, Git, Rust, Prettier, and neotest. Prettier requires project config.

`lua/util/project.lua` resolves per-project venvs. Git roots take priority over LSP roots. Python uses `<root>/venv`, `<root>/.venv`, then `$WORKON_HOME/<main-repo-name>` (default `~/.venvs`). Without a root it can use `$VIRTUAL_ENV`. The selected venv supplies Python and Ruff when available.

`lua/plugins/python.lua` wires basedpyright, ruff, and neotest to the project venv. Format on save uses project tools. Indentation is four spaces, two for Lua. `.tf`/`.tofu` use Terraform; Compose uses its language server.

Leader: Space; `<space>sk` lists mappings.

| Keys | Action |
|---|---|
| `<space>tt` / `<space>tr` / `<space>ts` | Test file / nearest / summary |
| `<space>cv` / `<space>gg` | Venv picker / lazygit |
| `<space>uf` / `<space>uF` | Toggle format globally / for buffer |

Outside Mason, install Neovim, ripgrep, fd, fzf, lazygit, tree-sitter-cli, rust-analyzer, a C compiler, and a terminal Nerd Font.
