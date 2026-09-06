#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
skip_install=false
case "${1:-}" in
  "") ;;
  --skip-install) skip_install=true ;;
  *) echo "Usage: $0 [--skip-install]" >&2; exit 1 ;;
esac
if [[ $# -gt 1 ]]; then
  echo "Usage: $0 [--skip-install]" >&2
  exit 1
fi

if [[ "$(uname)" != Darwin ]]; then
  echo "setup-pi.sh: macOS only" >&2
  exit 1
fi

node_ready() {
  command -v node >/dev/null 2>&1 &&
    command -v npm >/dev/null 2>&1 &&
    node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1)'
}

if ! "$skip_install"; then
  if ! node_ready; then
    if [[ -x /opt/homebrew/bin/brew ]]; then
      eval "$(/opt/homebrew/bin/brew shellenv)"
    elif [[ -x /usr/local/bin/brew ]]; then
      eval "$(/usr/local/bin/brew shellenv)"
    else
      echo "setup-pi.sh: install Homebrew (https://brew.sh), then rerun this script" >&2
      exit 1
    fi
    brew install node
    if ! node_ready; then
      echo "setup-pi.sh: Node >=22.19 and npm must be available on PATH" >&2
      exit 1
    fi
  fi
  pi_version="$(cat "$REPO/pi/version")"
  npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@$pi_version"
fi

pi_agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
mkdir -p "$pi_agent_dir"
pi_settings="$pi_agent_dir/settings.json"
if [[ ! -L "$pi_settings" ]] || [[ "$(readlink "$pi_settings")" != "$REPO/pi/settings.json" ]]; then
  if [[ -e "$pi_settings" || -L "$pi_settings" ]]; then
    pi_backup_dir="$(mktemp -d "$pi_agent_dir/settings-backup.XXXXXX")"
    mv "$pi_settings" "$pi_backup_dir/settings.json"
    printf 'Previous settings saved to %s/settings.json\n' "$pi_backup_dir"
  fi
  ln -s "$REPO/pi/settings.json" "$pi_settings"
fi

printf 'Pi settings linked to %s/pi/settings.json\n' "$REPO"
printf 'Run pi in a project. On a new Mac, use /login openai-codex to sign in.\n'
