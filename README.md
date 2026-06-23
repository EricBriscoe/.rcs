# .rcs

My zsh, tmux and neovim config. Real files live in this repo, `~/` is symlinked into it.

## Setup

```sh
git clone git@github.com:EricBriscoe/.rcs.git ~/dev/.rcs
cd ~/dev/.rcs
./setup.sh
```

`setup.sh` is idempotent and will replace anything in its way. It:

- ensures Homebrew is first on `PATH` for login shells by adding `eval "$(brew shellenv)"` to `~/.zprofile` (ahead of `/usr/bin`, so `python3` resolves to Homebrew's — the system `python3` lacks `virtualenvwrapper`)
- `brew install`s `fnm`, `zoxide`, `fzf`, `neovim`, `ripgrep`, `fd`, `bat`, `git`, `tmux`, `node`, `python`
- installs oh-my-zsh (skipped if already present)
- runs the fzf installer to wire up `ctrl+t` / `ctrl+r` / completion (writes `~/.fzf.zsh`)
- installs `virtualenvwrapper` and creates `~/.venvs` (create venvs yourself with `mkvirtualenv <name>`)
- symlinks `~/.zshrc`, `~/.tmux.conf`, `~/.config/nvim`, and `~/.config/sqlfluff` into this repo

Optional bits that the zshrc sources only when present: iTerm2 shell integration, Docker CLI completions.

First nvim launch bootstraps `lazy.nvim`, then Mason installs the LSPs/formatters/linters listed below (~3s after open). `:Lazy sync` to update.

## Machine-local config

This repo is generic. Anything machine- or work-specific (paths, secrets, project functions) lives in two unversioned files, sourced only when present — so a machine without them stays clean:

- **`~/.zshrc.local`** — sourced at the end of `zshrc`. Define work functions/aliases/exports here; it can use the helpers `zshrc` already defines (e.g. `_auto_venv`).
- **`nvim/lua/local.lua`** (`require("local")`, gitignored) — optional table of overrides consumed by the nvim config:
  - `biome` / `ruff` / `python` — absolute paths to project-local binaries (LSP + formatters prefer these, falling back to `$PATH` when absent)
  - `dbs` — a function returning `{ name = connection-url }` for the `vim-dadbod-ui` connection list (`<leader>D`)

## What's in each file

### `zshrc`
oh-my-zsh with `robbyrussell` and the `git` plugin. Beyond that:

- auto-activates a venv per project, worktree-aware (`chpwd` hook): a local `venv/` at the git root, else `~/.venvs/<main-repo-name>` (derived from `git-common-dir`, so every worktree of a repo shares one venv). Only deactivates venvs it activated itself.
- `compinit` cached to once per day
- sources `fnm`, `zoxide`, `fzf`, `virtualenvwrapper`, iTerm2 integration, Docker completions when present
- pins `VIRTUALENVWRAPPER_PYTHON` to Homebrew's `python3` so virtualenvwrapper works regardless of `PATH` order
- tab title = current git branch (or short SHA / dir name when not on a branch)
- sources `~/.zshrc.local` last, if present

Functions and aliases:

- `olc [parent]` — `code` opens every file changed on this branch since `parent` (auto-detected from reflog, defaults to `main`)
- `cleandocker` — confirms, then force-removes every container and prunes every image, volume, network, and build cache
- `claude-work` / `claude-personal` — `claude` with a per-account `CLAUDE_CONFIG_DIR`

### `tmux.conf`
Two lines. Enables window titles using the active pane's title.

### `nvim/`

```
init.lua                     -- entrypoint
lua/config/lazy.lua          -- bootstraps lazy.nvim
lua/config/options.lua       -- editor options + diagnostics
lua/config/terminal.lua      -- floating terminal toggle
lua/plugins/git.lua          -- gitsigns
lua/plugins/language.lua     -- LSP, completion, format, lint
lua/plugins/navigation.lua   -- fzf-lua pickers
lua/plugins/sql.lua          -- vim-dadbod-ui (connections from lua/local.lua)
lazy-lock.json               -- pinned plugin commits
lua/local.lua                -- optional, gitignored machine-local overrides
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
- `vim-dadbod` + `vim-dadbod-ui` — query runner / schema browser; connections come from `lua/local.lua`'s `dbs()` (empty by default)

Mason installs:

- **LSPs:** bashls, basedpyright, docker-compose-ls, dockerls, jsonls, lua_ls, marksman, terraform-ls, tflint, vtsls, yamlls
- **Formatters:** shfmt, stylua, biome (TS/JS/CSS/JSON), ruff (Python), sqlfluff (SQL, Postgres dialect), terraform fmt
- **Linters:** actionlint, shellcheck, sqlfluff (Postgres dialect), tflint

Notable behaviour:

- format on save for bash/css/js(x)/json(c)/lua/markdown/python/sh/sql/terraform/ts(x). Toggle per-buffer with `<leader>uf`, globally with `:lua vim.g.disable_autoformat = true`. SQL files under `db/deltas/` are exempt — those are append-only history.
- `actionlint` runs automatically on `.github/workflows/*.yml`
- `biome`/`ruff`/`python` prefer the binaries named in `lua/local.lua` when present; otherwise fall back to `$PATH`.

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
| `<space>D` | toggle DB UI (connections from `lua/local.lua`) |
| `:olc` (or `:Olc`) | open each branch-changed file in its own tab (idempotent — skips files already open) |

### `sqlfluff/`
Global `sqlfluff` config (Postgres dialect). UPPER keywords / literals / functions / types, snake_case identifiers, 4-space indent, trailing commas, leading `AND`/`OR`. Line length is unenforced. Project-local `.sqlfluff` files override this.

### `keyboards/`
`id80_ansi_layout_mine.json` — VIA layout for my id80. Not part of the shell/editor setup, just parked here.
