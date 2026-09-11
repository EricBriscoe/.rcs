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

use_homebrew() {
  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  else
    echo "setup-pi.sh: install Homebrew (https://brew.sh), then rerun this script" >&2
    exit 1
  fi
}

if ! "$skip_install"; then
  if ! node_ready; then
    use_homebrew
    brew install node
    if ! node_ready; then
      echo "setup-pi.sh: Node >=22.19 and npm must be available on PATH" >&2
      exit 1
    fi
  fi
  if ! command -v rg >/dev/null 2>&1 || ! command -v fd >/dev/null 2>&1; then
    use_homebrew
    brew install ripgrep fd
  fi
  pi_version="$(cat "$REPO/pi/version")"
  playwright_version="$(cat "$REPO/pi/playwright-version")"
  if [[ "${PI_AUTO_UPDATE:-1}" != 0 ]]; then
    pi_version=latest
    playwright_version=latest
  fi
  npm install -g --ignore-scripts \
    "@earendil-works/pi-coding-agent@$pi_version" \
    "@playwright/cli@$playwright_version"
  PLAYWRIGHT_SKIP_BROWSER_GC=1 playwright-cli install-browser chromium
  node "$REPO/pi/install-rtk.mjs"
  node "$REPO/pi/install-memory-embedding.mjs"
  npm ci --ignore-scripts --omit=dev --prefix "$REPO/pi/extensions/codex-account-pool"
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
link_resource "$REPO/pi/models.json" "$pi_agent_dir/models.json" models
link_resource "$REPO/pi/AGENTS.md" "$pi_agent_dir/AGENTS.md" instructions
link_resource "$REPO/pi/SUBAGENTS.md" "$pi_agent_dir/SUBAGENTS.md" instructions
link_resource "$REPO/pi/subagents.json" "$pi_agent_dir/extensions/subagent/config.json" subagent-config
# Keep sibling names identical to the checkout: Pi's TypeScript loader resolves
# ../memory imports relative to the symlink path, not its canonical target.
for extension in web ask-user monitor memory project-context code-navigation efficiency codex-account-pool appearance model-briefing; do
  source="$REPO/pi/extensions/$extension"
  link_resource "$source" "$pi_agent_dir/extensions/$extension" extension
  # Retire only our old prefixed link; preserve user-owned replacements.
  previous="$pi_agent_dir/extensions/rcs-$extension"
  if [[ -L "$previous" && "$(readlink "$previous")" == "$source" ]]; then
    rm "$previous"
  fi
done
# Remove only recognized links to the retired runtime. Keep historical task data.
for previous in "$pi_agent_dir/extensions/orchestrate" "$pi_agent_dir/extensions/rcs-orchestrate"; do
  if [[ -L "$previous" && "$(readlink "$previous")" == "$REPO/pi/extensions/orchestrate" ]]; then
    rm "$previous"
  fi
done
# Link owned themes individually so unrelated user themes remain discoverable.
for theme in quiet-graphite paper; do
  link_resource "$REPO/pi/themes/$theme.json" "$pi_agent_dir/themes/$theme.json" theme
done
for skill in schlep pi-maintenance; do
  link_resource "$REPO/pi/skills/$skill" "$pi_agent_dir/skills/$skill" skill
done
link_resource "$REPO/pi/launch.mjs" "$pi_agent_dir/bin/pi" launcher
link_resource "$REPO/pi/rtk.mjs" "$pi_agent_dir/bin/rtk" launcher
link_resource "$REPO/pi/rtk.mjs" "$HOME/.local/bin/rtk" launcher
if ! "$skip_install"; then
  packages="$(node -p 'require(process.argv[1]).packages.map(p => {
    const source = typeof p === "string" ? p : p?.source;
    if (typeof source !== "string" || !source || /[\r\n]/.test(source)) throw new Error("Expected a package source string");
    return source;
  }).join("\n")' "$REPO/pi/settings.json")"
  while IFS= read -r package; do
    [[ -n "$package" ]] || continue
    PI_AUTO_UPDATE=0 npm_config_ignore_scripts=true "$pi_agent_dir/bin/pi" install "$package"
  done <<< "$packages"
  if [[ "${PI_AUTO_UPDATE:-1}" != 0 ]]; then
    node "$REPO/pi/update-deps.mjs" || printf 'Dependency update incomplete; the next Pi launch retries.\n' >&2
  fi
fi

printf 'Pi settings linked to %s/pi/settings.json\n' "$REPO"
printf 'Pi web tools linked to %s/pi/extensions/web\n' "$REPO"
printf 'Pi owned extensions and Quiet Graphite/Paper themes linked from %s/pi/\n' "$REPO"
printf 'Pi-native launcher linked to %s/bin/pi\n' "$pi_agent_dir"
printf 'Pi checks latest stable dependencies on every launch; PI_AUTO_UPDATE=0 bypasses updates.\n'
printf 'RTK linked to %s/.local/bin/rtk; both commands use the same installed release. Restart Pi after setup.\n' "$HOME"
printf 'Run pi in a project. On a new Mac, use /login openai-codex to sign in.\n'
