#!/usr/bin/env bash
# Idempotent setup for this dotfiles repo. Mercilessly replaces any
# existing ~/.zshrc, ~/.tmux.conf, ~/.config/nvim.
#
# Assumes macOS + Homebrew (Apple Silicon).

set -euo pipefail

if [[ "$(uname)" != "Darwin" ]]; then
  echo "setup.sh: macOS + Homebrew only" >&2
  exit 1
fi

if ! command -v brew >/dev/null 2>&1; then
  echo "setup.sh: install Homebrew first (https://brew.sh)" >&2
  exit 1
fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say() { printf '\n==> %s\n' "$*"; }

say "Installing Homebrew packages"
brew install \
  fnm zoxide fzf \
  neovim ripgrep fd bat \
  git tmux node \
  python python@3.12 pipx

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

say "Installing virtualenvwrapper + lodas venv"
if [[ ! -x /opt/homebrew/bin/virtualenvwrapper.sh ]]; then
  /opt/homebrew/bin/pip3 install --break-system-packages virtualenvwrapper
fi

say "Installing neovim-remote (nvr) into its own pipx venv on python3.12"
# pynvim is broken on Python 3.14 right now, so pin nvr to 3.12. pipx writes
# to ~/.local/bin, which the zshrc already prepends to PATH.
pipx install --force --python /opt/homebrew/bin/python3.12 neovim-remote
export WORKON_HOME="$HOME/.venvs"
# shellcheck disable=SC1091
source /opt/homebrew/bin/virtualenvwrapper.sh
if [[ ! -d "$WORKON_HOME/lodas" ]]; then
  mkvirtualenv lodas
fi

say "Linking dotfiles into \$HOME (replacing anything in the way)"
mkdir -p "$HOME/.config"
rm -rf "$HOME/.zshrc" "$HOME/.tmux.conf" "$HOME/.config/nvim"
ln -s "$REPO/zshrc"     "$HOME/.zshrc"
ln -s "$REPO/tmux.conf" "$HOME/.tmux.conf"
ln -s "$REPO/nvim"      "$HOME/.config/nvim"

say "Done. Open a new shell. nvim's first launch will bootstrap lazy.nvim + Mason."
