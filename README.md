# .rcs

My zsh, tmux, neovim and Pi config. Real files live in this repo, `~/` is symlinked into it.

## Setup

```sh
git clone git@github.com:EricBriscoe/.rcs.git ~/dev/.rcs
cd ~/dev/.rcs
./setup.sh
```

`setup.sh` is idempotent and will replace anything in its way. It:

- ensures Homebrew is first on `PATH` for login shells by adding `eval "$(brew shellenv)"` to `~/.zprofile` (ahead of `/usr/bin`, so `python3` resolves to the Homebrew version because the system `python3` lacks `virtualenvwrapper`)
- `brew install`s `fnm`, `zoxide`, `fzf`, `neovim`, `ripgrep`, `fd`, `bat`, `git`, `tmux`, `node`, `python`
- installs oh-my-zsh (skipped if already present)
- runs the fzf installer to wire up `ctrl+t` / `ctrl+r` / completion (writes `~/.fzf.zsh`)
- installs `virtualenvwrapper` and creates `~/.venvs` (create venvs yourself with `mkvirtualenv <name>`)
- symlinks `~/.zshrc`, `~/.tmux.conf`, `~/.config/nvim`, and `~/.config/sqlfluff` into this repo
- installs the Pi and Playwright CLI versions pinned in `pi/`, installs Chromium, and links Pi's settings, instructions, extensions, and skills

Optional bits that the zshrc sources only when present: iTerm2 shell integration, Docker CLI completions.

First nvim launch bootstraps `lazy.nvim`, then Mason installs the LSPs/formatters/linters listed below (~3s after open). `:Lazy sync` to update.

## Pi on another Mac

With Homebrew installed, run this to install only Pi:

```sh
git clone https://github.com/EricBriscoe/.rcs.git ~/dev/.rcs
cd ~/dev/.rcs
./setup-pi.sh
pi
```

Inside Pi, run `/login openai-codex` and complete the browser sign-in with your ChatGPT account. The installer uses Pi's subscription provider, with GPT-6 Astra and high reasoning as the startup defaults. If login selects a different model, select GPT-6 Astra in `/model` and press Ctrl+S to save it.

`~/.pi/agent/settings.json` links to `pi/settings.json` in this checkout. Saved changes from `/settings`, `/model`, and `/thinking` therefore appear in `git diff`. Commit and push those changes to share them. On the other Mac, run `git pull --ff-only`, rerun `./setup-pi.sh`, and restart Pi.

The installer adds Node if needed and installs the versions in `pi/version` and `pi/playwright-version`, plus Playwright's Chromium browser. To upgrade these tools on all your Macs, change the version files, rerun the installer, and commit them. Use `./setup-pi.sh --skip-install` to relink resources without installing packages. Existing resources are backed up before replacement; rerunning the script keeps correct links in place.

Credentials, sessions, project trust decisions, and model caches stay under `~/.pi/agent/` on each Mac. Each Mac signs in separately. See [Pi's provider documentation](https://pi.dev/docs/latest/providers) for subscription login details.

### Web search and browsing

The `rcs-web` extension adds two tools backed by [Microsoft's Playwright CLI](https://github.com/microsoft/playwright-cli):

- `web_search` searches Bing by default and returns titles, source URLs, and snippets. DuckDuckGo is selectable with `engine: "duckduckgo"`. Neither route needs an API key. Search engines can rate-limit requests or show a CAPTCHA; the tool reports a challenge or unreadable results page as an error.
- `web_browse` opens pages, reads text, returns snapshots with element refs, clicks, fills inputs, presses keys, scrolls, manages tabs, and returns screenshots. It supports localhost URLs for testing development apps.

Ask Pi to search for a topic and read the relevant sources, or to open your local app and test a specific interaction. Search and browsing use separate sessions, so searching won't replace the page you're working on. Browser calls preserve state until you close the browser or leave the Pi session. To watch a browser, ask Pi to open it with `headed: true`; close it first if it's already running headless.

Profiles are isolated from your normal browser. CLI logs and screenshots live in temporary directories outside Git. Page text and snapshots return bounded slices with a `nextOffset` for reading more. Screenshots are also returned as images to the model.

### Questions and background monitors

The `ask_user` tool shows a choice menu or text input and waits for your response. Every choice menu includes a typed-answer option. Escape cancels the question; Pi receives no answer. Dialogs work in interactive Pi and compatible RPC clients. Print mode reports that no interactive UI is available.

The `monitor` tool starts background shell commands, such as a log watcher or a long-running test. New stdout, stderr, or exit status wakes Pi automatically after a short batching delay. If Pi is already working, the output waits until that work finishes and then starts a follow-up turn. Pi can list monitors, read pending output, or stop them. Buffers are bounded, and monitors stop when you leave or switch the Pi session.

For example: “Monitor the development server logs and investigate any new errors.” The monitor's command runs with the same local access as Pi's other shell commands.

### Commit and push with schlep

The installer links `pi/skills/schlep/` into `~/.pi/agent/skills/schlep/`. This is the Codex `schlep` workflow, with Pi's command syntax added. Run `/reload`, then `/skill:schlep` in a repository, or ask Pi to schlep it.

Schlep reviews and checks all current changes, commits them together on the current branch, and pushes that branch. It includes pre-existing and untracked changes without another confirmation. It stops on failed checks, conflicts, an in-progress merge or rebase, detached HEAD, or a rejected push. It never force-pushes or switches branches.

### Letting Pi configure itself

`~/.pi/agent/AGENTS.md` links to `pi/AGENTS.md`. Pi loads this as global context, including when it starts in another project. It explains how to locate this checkout from the settings symlink, where configuration and dependency pins live, and how to verify changes. Custom extension source lives in `pi/extensions/`; the installer links the `web`, `ask-user`, and `monitor` directories into `~/.pi/agent/extensions/` with an `rcs-` prefix.

After changing instructions or extension code, run `/reload` in Pi. Restart Pi to check changes to startup defaults. Publish the source changes in this repo to share them across Macs.

### Pi checks

```sh
bash -n setup-pi.sh setup.sh
python3 -m unittest discover -s tests -v
node --test tests/pi-*.test.mjs
PI_WEB_LIVE=1 node --test tests/pi-web.test.mjs
```

The last command opens Chromium against a temporary local test page. It requires the installed Playwright CLI and browser. Public search availability also needs a live `web_search` call.

## Machine-local config

This repo is generic. Anything machine- or work-specific (paths, secrets, project functions) lives in two unversioned files, sourced only when present, so a machine without them stays clean:

- **`~/.zshrc.local`**: sourced at the end of `zshrc`. Define work functions/aliases/exports here; it can use the helpers `zshrc` already defines (e.g. `_auto_venv`).
- **`nvim/lua/local.lua`** (`require("local")`, gitignored): optional table of overrides consumed by the nvim config:
  - `biome` / `ruff` / `python`: absolute paths to project-local binaries (LSP + formatters prefer these, falling back to `$PATH` when absent)
  - `dbs`: a function returning `{ name = connection-url }` for the `vim-dadbod-ui` connection list (`<leader>D`)

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

- `olc [parent]`: `code` opens every file changed on this branch since `parent` (auto-detected from reflog, defaults to `main`)
- `cleandocker`: confirms, then force-removes every container and prunes every image, volume, network, and build cache
- `claude-work` / `claude-personal`: `claude` with a per-account `CLAUDE_CONFIG_DIR`

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

- `which-key.nvim`: leader hints
- `lazydev.nvim`: Lua + `vim.uv` types
- `blink.cmp` + `friendly-snippets`: completion
- `mason.nvim` + `mason-tool-installer.nvim`: auto-installs the tools below
- `nvim-lspconfig`: LSP wiring
- `conform.nvim`: format on save
- `nvim-lint`: async linting
- `fzf-lua`: files / grep / buffers / etc.
- `gitsigns.nvim`: gutter signs, hunk staging, blame
- `vim-dadbod` + `vim-dadbod-ui`: query runner / schema browser; connections come from `lua/local.lua`'s `dbs()` (empty by default)

Mason installs:

- **LSPs:** bashls, basedpyright, docker-compose-ls, dockerls, jsonls, lua_ls, marksman, terraform-ls, tflint, vtsls, yamlls
- **Formatters:** shfmt, stylua, biome (TS/JS/CSS/JSON), ruff (Python), sqlfluff (SQL, Postgres dialect), terraform fmt
- **Linters:** actionlint, shellcheck, sqlfluff (Postgres dialect), tflint

Notable behaviour:

- format on save for bash/css/js(x)/json(c)/lua/markdown/python/sh/sql/terraform/ts(x). Toggle per-buffer with `<leader>uf`, globally with `:lua vim.g.disable_autoformat = true`. SQL files under `db/deltas/` are exempt because those files are append-only history.
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
| `:olc` (or `:Olc`) | open each branch-changed file in its own tab (idempotent; skips files already open) |

### `sqlfluff/`
Global `sqlfluff` config (Postgres dialect). UPPER keywords / literals / functions / types, snake_case identifiers, 4-space indent, trailing commas, leading `AND`/`OR`. Line length is unenforced. Project-local `.sqlfluff` files override this.

### `keyboards/`
`id80_ansi_layout_mine.json`: VIA layout for my id80. Not part of the shell/editor setup, just parked here.
