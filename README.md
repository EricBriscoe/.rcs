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
lua/plugins/language.lua     -- LSP, completion, format, lint
lua/plugins/navigation.lua   -- fzf-lua pickers
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

Mason installs:

- **LSPs:** bashls, basedpyright, docker-compose-ls, dockerls, jsonls, lua_ls, marksman, sqls, terraform-ls, tflint, vtsls, yamlls
- **Formatters:** shfmt, stylua, biome (TS/JS/CSS/JSON), ruff (Python), terraform fmt
- **Linters:** actionlint, shellcheck, tflint

Notable behaviour:

- format on save for bash/css/js(x)/json(c)/lua/markdown/python/sh/terraform/ts(x). Toggle per-buffer with `<leader>uf`, globally with `:lua vim.g.disable_autoformat = true`
- `actionlint` runs automatically on `.github/workflows/*.yml`
- LSPs prefer LODAS-local binaries when present: `~/dev/lodas/node_modules/.bin/biome`, `~/.venvs/lodas/bin/{python,ruff}`. Falls back to `$PATH` otherwise.

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

### `keyboards/`
`id80_ansi_layout_mine.json` — VIA layout for my id80. Not part of the shell/editor setup, just parked here.
