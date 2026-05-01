# .rcs

My zsh, tmux and neovim config. Real files live in this repo, `~/` is symlinked into it.

## Setup

```sh
git clone git@github.com:EricBriscoe/.rcs.git ~/dev/.rcs
cd ~/dev/.rcs
./setup.sh
```

`setup.sh` is idempotent and will replace anything in its way. It:

- `brew install`s `fnm`, `zoxide`, `fzf`, `neovim`, `ripgrep`, `fd`, `bat`, `git`, `tmux`, `node`, `python`
- installs oh-my-zsh (skipped if already present)
- runs the fzf installer to wire up `ctrl+t` / `ctrl+r` / completion (writes `~/.fzf.zsh`)
- installs `virtualenvwrapper` and creates the `lodas` venv
- symlinks `~/.zshrc`, `~/.tmux.conf` and `~/.config/nvim` into this repo

Optional bits that the zshrc sources only when present: iTerm2 shell integration, Docker CLI completions, the `droid` CLI.

First nvim launch bootstraps `lazy.nvim`, then Mason installs the LSPs/formatters/linters listed below (~3s after open). `:Lazy sync` to update.

## What's in each file

### `zshrc`
oh-my-zsh with `robbyrussell` and the `git` plugin. Beyond that:

- auto-activates the `lodas` venv at startup, and per-worktree `venv/` when `cd`-ing into one (`chpwd` hook)
- adds `$HOME/.local/bin` and the `lodas` repo to `PYTHONPATH`
- `compinit` cached to once per day
- sources `fnm`, `zoxide`, `fzf`, iTerm2 integration, Docker completions when present

Functions and aliases:

- `lodas <args>` — runs `scripts/lodas.py` from the current repo, falling back to `~/dev/lodas`
- `olc [parent]` — `code` opens every file changed on this branch since `parent` (auto-detected from reflog, defaults to `main`)
- `wt <branch-or-ticket>` — create + jump into a worktree. Bare numbers become `LM-NNNN`; ticket IDs fuzzy-match existing branches via `fzf`
- `cwt` — clean the current worktree and bounce back to the main repo with the right venv
- `lodas_wt_up` — `tilt down` → `lodas ci` → `tilt up --all`
- `lsql` — psql into the local LODAS Postgres container
- `docker-nuke` — confirms, then wipes every container/image/volume/build cache
- `claude-work` / `claude-personal` — `claude` with a per-account `CLAUDE_CONFIG_DIR`

### `tmux.conf`
Two lines. Enables window titles using the active pane's title.

### `nvim/`

```
init.lua                     -- entrypoint
lua/config/lazy.lua          -- bootstraps lazy.nvim
lua/config/options.lua       -- editor options + diagnostics
lua/config/terminal.lua      -- floating terminal toggle
lua/plugins/claude.lua       -- claudecode.nvim + account switching
lua/plugins/git.lua          -- gitsigns
lua/plugins/language.lua     -- LSP, completion, format, lint
lua/plugins/navigation.lua   -- fzf-lua pickers
lua/plugins/sql.lua          -- vim-dadbod-ui with worktree-aware connections
lazy-lock.json               -- pinned plugin commits
```

Plugins (all via `lazy.nvim`):

- `which-key.nvim` — leader hints
- `lazydev.nvim` — Lua + `vim.uv` types
- `blink.cmp` + `friendly-snippets` — completion
- `mason.nvim` + `mason-tool-installer.nvim` — auto-installs the tools below
- `nvim-lspconfig` — LSP wiring
- `conform.nvim` — format on save
- `nvim-lint` — async linting
- `fzf-lua` — files / grep / buffers / etc.
- `gitsigns.nvim` — gutter signs, hunk staging, blame
- `claudecode.nvim` (+ `snacks.nvim`) — Claude Code IDE integration: send selections / buffers as context, accept/reject AI diffs as native nvim ops
- `vim-dadbod` + `vim-dadbod-ui` — query runner / schema browser; the connection auto-targets the current worktree's Postgres container (reads `DB_HOST_PORT` from the worktree's `.env`)

Mason installs:

- **LSPs:** bashls, basedpyright, docker-compose-ls, dockerls, jsonls, lua_ls, marksman, terraform-ls, tflint, vtsls, yamlls
- **Formatters:** shfmt, stylua, biome (TS/JS/CSS/JSON), ruff (Python), sqlfluff (SQL, Postgres dialect), terraform fmt
- **Linters:** actionlint, shellcheck, sqlfluff (Postgres dialect), tflint

Notable behaviour:

- format on save for bash/css/js(x)/json(c)/lua/markdown/python/sh/sql/terraform/ts(x). Toggle per-buffer with `<leader>uf`, globally with `:lua vim.g.disable_autoformat = true`. SQL files under `db/deltas/` are exempt — those are append-only history.
- `actionlint` runs automatically on `.github/workflows/*.yml`
- LSPs prefer LODAS-local binaries when present: `~/dev/lodas/node_modules/.bin/biome`, `~/.venvs/lodas/bin/{python,ruff}`. Falls back to `$PATH` otherwise.
- `:ClaudeAccount <name>` flips `CLAUDE_CONFIG_DIR` mid-session, tab-completing from `~/.claude/envs/`. The choice is written to `stdpath("state")/claude-account` and restored on the next nvim launch. If that directory doesn't exist, the command is a no-op and Claude runs at the default `~/.claude`.

Keymaps worth remembering (leader = space):

| keys | action |
| --- | --- |
| `<space><space>` | find files |
| `<space>sg` | live grep |
| `<space>sw` | grep word under cursor |
| `<space>se` | fzf files changed on this branch vs `origin/HEAD`, with diff preview |
| `<space>sb` / `<space>sr` / `<space>sk` | buffers / recent / keymaps |
| `<space>f` | format buffer |
| `<space>uf` | toggle autoformat for this buffer |
| `<C-/>` or `<space>tt` | toggle floating terminal |
| `K` / `gd` / `gr` / `gi` / `gD` | hover / def / refs / impl / decl |
| `<space>rn` / `<space>ca` | rename / code action |
| `]d` / `[d` | next / prev diagnostic |
| `]c` / `[c` | next / prev git hunk |
| `<space>gs` / `<space>gr` | stage / reset hunk (works in visual too) |
| `<space>gS` / `<space>gR` | stage / reset whole buffer |
| `<space>gp` | preview hunk |
| `<space>gb` / `<space>gB` | blame line / toggle inline blame |
| `<space>gd` / `<space>gD` | diff against index / last commit |
| `<space>ac` | toggle Claude pane |
| `<space>af` | focus Claude pane |
| `<space>as` | send selection / current buffer to Claude (also in visual mode) |
| `<space>aa` / `<space>ar` | accept / reject Claude's proposed diff |
| `<space>D` | toggle DB UI (auto-targets current worktree's Postgres) |

### `keyboards/`
`id80_ansi_layout_mine.json` — VIA layout for my id80. Not part of the shell/editor setup, just parked here.
