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
  playwright_version="$(cat "$REPO/pi/playwright-version")"
  npm install -g --ignore-scripts \
    "@earendil-works/pi-coding-agent@$pi_version" \
    "@playwright/cli@$playwright_version"
  PLAYWRIGHT_SKIP_BROWSER_GC=1 playwright-cli install-browser chromium
fi

pi_agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
mkdir -p "$pi_agent_dir"
pi_agent_dir="$(cd "$pi_agent_dir" && pwd)"
link_resource() {
  local source="$1" destination="$2" label="$3" backup_dir previous_target
  mkdir -p "$(dirname "$destination")"
  if [[ -L "$destination" ]] && [[ "$(readlink "$destination")" == "$source" ]]; then
    return
  fi
  if [[ -e "$destination" || -L "$destination" ]]; then
    backup_dir="$(mktemp -d "$pi_agent_dir/$label-backup.XXXXXX")"
    previous_target=""
    if [[ -L "$destination" ]]; then
      previous_target="$(readlink "$destination")"
    fi
    if [[ -n "$previous_target" && "$previous_target" != /* ]]; then
      ln -s "$(dirname "$destination")/$previous_target" "$backup_dir/$(basename "$destination")"
      rm "$destination"
    else
      mv "$destination" "$backup_dir/$(basename "$destination")"
    fi
    printf 'Previous %s saved to %s\n' "$label" "$backup_dir"
  fi
  ln -s "$source" "$destination"
}

link_resource "$REPO/pi/settings.json" "$pi_agent_dir/settings.json" settings
link_resource "$REPO/pi/AGENTS.md" "$pi_agent_dir/AGENTS.md" instructions
link_resource "$REPO/pi/extensions/web" "$pi_agent_dir/extensions/rcs-web" extension
link_resource "$REPO/pi/extensions/ask-user" "$pi_agent_dir/extensions/rcs-ask-user" extension
link_resource "$REPO/pi/extensions/monitor" "$pi_agent_dir/extensions/rcs-monitor" extension
link_resource "$REPO/pi/extensions/memory" "$pi_agent_dir/extensions/rcs-memory" extension
link_resource "$REPO/pi/extensions/project-context" "$pi_agent_dir/extensions/rcs-project-context" extension
link_resource "$REPO/pi/extensions/orchestrate" "$pi_agent_dir/extensions/rcs-orchestrate" extension
# Retire only our known imported skill link, never a user's unrelated replacement.
if [[ -L "$pi_agent_dir/skills/schlep" && "$(readlink "$pi_agent_dir/skills/schlep")" == "$REPO/pi/skills/schlep" ]]; then
  rm "$pi_agent_dir/skills/schlep"
fi
link_resource "$REPO/pi/launch.mjs" "$pi_agent_dir/bin/pi" launcher

printf 'Pi settings linked to %s/pi/settings.json\n' "$REPO"
printf 'Pi web tools linked to %s/pi/extensions/web\n' "$REPO"
printf 'Pi question, monitor and memory tools linked to %s/pi/extensions/\n' "$REPO"
printf 'Pi-native launcher linked to %s/bin/pi\n' "$pi_agent_dir"
printf 'Use that launcher (the repo zshrc adds it to PATH); restart Pi to clear inherited context.\n'
printf 'Run pi in a project. On a new Mac, use /login openai-codex to sign in.\n'
