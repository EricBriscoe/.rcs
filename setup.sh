#!/usr/bin/env bash
# Idempotent setup for this dotfiles repo. Mercilessly replaces any existing
# ~/.zshrc, ~/.tmux.conf, ~/.config/nvim, ~/.config/sqlfluff.
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

say() { printf '\n==> %s\n' "$*"; }

# Put Homebrew first on PATH for this script *and* every future login shell,
# ahead of /usr/bin so `python3` resolves to Homebrew's (the system python3
# lacks virtualenvwrapper). A stock Homebrew install writes this to ~/.zprofile;
# some installs only drop /etc/paths.d/homebrew, which path_helper appends
# *after* /usr/bin — leaving system python first. Pin it ourselves, idempotently.
say "Ensuring Homebrew is first on PATH (~/.zprofile)"
brew_shellenv='eval "$(/opt/homebrew/bin/brew shellenv)"'
if ! grep -qsF "$brew_shellenv" "$HOME/.zprofile"; then
  printf '%s\n' "$brew_shellenv" >>"$HOME/.zprofile"
fi
eval "$brew_shellenv"

say "Installing Homebrew packages"
brew install \
  fnm zoxide fzf \
  neovim ripgrep fd bat \
  git tmux node python

say "Installing oh-my-zsh"
if [[ ! -d "$HOME/.oh-my-zsh" ]]; then
  RUNZSH=no KEEP_ZSHRC=yes sh -c \
    "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" \
    "" --unattended --keep-zshrc
fi

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

say "Linking dotfiles into \$HOME (replacing anything in the way)"
mkdir -p "$HOME/.config"
rm -rf "$HOME/.zshrc" "$HOME/.tmux.conf" "$HOME/.config/nvim" "$HOME/.config/sqlfluff"
ln -s "$REPO/zshrc"     "$HOME/.zshrc"
ln -s "$REPO/tmux.conf" "$HOME/.tmux.conf"
ln -s "$REPO/nvim"      "$HOME/.config/nvim"
ln -s "$REPO/sqlfluff"  "$HOME/.config/sqlfluff"

say "Done. Open a new shell. nvim's first launch will bootstrap lazy.nvim + Mason."
say "Machine-specific extras go in ~/.zshrc.local (and nvim/lua/local.lua), sourced if present."
