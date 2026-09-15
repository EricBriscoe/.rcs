#!/usr/bin/env bash
# Idempotent setup for this dotfiles repo. Back up conflicting resources.
#
# macOS + Homebrew (Apple Silicon) only.

set -euo pipefail

if [[ "$(uname)" != "Darwin" ]]; then
  echo "setup.sh: macOS only" >&2
  exit 1
fi

if [[ ! -x /opt/homebrew/bin/brew ]]; then
  echo "setup.sh: install Homebrew first (https://brew.sh)" >&2
  exit 1
fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$REPO/setup-common.sh"
backup_root="$HOME/.local/state/rcs/backups"
config_home="${XDG_CONFIG_HOME:-$HOME/.config}"

say() { printf '\n==> %s\n' "$*"; }

# Put Homebrew first on PATH for this script *and* every future login shell,
# ahead of /usr/bin so `python3` resolves to Homebrew's (the system python3
# lacks virtualenvwrapper). A stock Homebrew install writes this to ~/.zprofile;
# some installs only drop /etc/paths.d/homebrew, which path_helper appends
# *after* /usr/bin, leaving system python first. Pin it ourselves, idempotently.
say "Ensuring Homebrew is first on PATH (~/.zprofile)"
brew_shellenv='eval "$(/opt/homebrew/bin/brew shellenv)"'
if ! grep -qsF "$brew_shellenv" "$HOME/.zprofile"; then
  printf '%s\n' "$brew_shellenv" >>"$HOME/.zprofile"
fi
eval "$brew_shellenv"

say "Installing Homebrew packages"
brew install \
  fnm zoxide fzf starship \
  neovim ripgrep fd bat lazygit tree-sitter-cli \
  git tmux node python

say "Wiring up fzf key bindings (ctrl+t, ctrl+r) and completion"
# Writes ~/.fzf.zsh, which our zshrc sources. --no-update-rc keeps it from
# touching rc files itself.
"$(brew --prefix fzf)/install" --key-bindings --completion --no-update-rc

say "Installing virtualenvwrapper"
# Generic Python venv tooling the zshrc uses for worktree-aware auto-activation.
# Installed into Homebrew's python; create venvs yourself with `mkvirtualenv`.
if [[ ! -x /opt/homebrew/bin/virtualenvwrapper.sh ]]; then
  "$(brew --prefix)/bin/pip3" install --break-system-packages virtualenvwrapper
fi
mkdir -p "$HOME/.venvs"

say "Linking dotfiles (backing up conflicts)"
link_resource "$REPO/zshrc" "$HOME/.zshrc" zshrc
link_resource "$REPO/tmux.conf" "$HOME/.tmux.conf" tmux
link_resource "$REPO/nvim" "$config_home/nvim" nvim

say "Installing Pi and linking its settings"
"$REPO/setup-pi.sh"

say "Linking shared instructions and skills for installed harnesses"
# Claude's native installer uses ~/.local/bin, even before the new zshrc loads.
export PATH="$HOME/.local/bin:$PATH"
if command -v codex >/dev/null 2>&1; then
  for directory in "$HOME/.codex" "${CODEX_HOME:-$HOME/.codex}" \
    "$HOME/.codex/envs/work" "$HOME/.codex/envs/personal"; do
    link_resource "$REPO/AGENTS.md" "$directory/AGENTS.md" codex-instructions
  done
  # Account homes share ~/.codex/skills wholesale (see _codex_account in zshrc).
  for directory in "$HOME/.codex" "${CODEX_HOME:-$HOME/.codex}"; do
    for skill in "$REPO"/skills/*/; do
      skill="$(basename "$skill")"
      link_resource "$REPO/skills/$skill" "$directory/skills/$skill" codex-skill
    done
  done
fi
if command -v claude >/dev/null 2>&1; then
  for directory in "$HOME/.claude" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" \
    "$HOME/.claude/envs/work" "$HOME/.claude/envs/personal"; do
    link_resource "$REPO/AGENTS.md" "$directory/CLAUDE.md" claude-instructions
    for skill in "$REPO"/skills/*/; do
      skill="$(basename "$skill")"
      link_resource "$REPO/skills/$skill" "$directory/skills/$skill" claude-skill
    done
  done
fi

say "Installing locked LazyVim plugins"
NVIM_APPNAME=nvim nvim --headless -u NONE -i NONE -n -l "$REPO/nvim/bootstrap.lua"

say "Done. Open a new shell. Mason installs language tools when needed."
say "Machine-specific extras go in ~/.zshrc.local (and nvim/lua/plugins/local.lua), sourced if present."
