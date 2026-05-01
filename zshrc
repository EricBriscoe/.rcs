export ZSH="$HOME/.oh-my-zsh"
ZSH_THEME="robbyrussell"
plugins=(git)

source $ZSH/oh-my-zsh.sh

export REPO=$HOME/dev/lodas
export _LODAS_BASE_PYTHONPATH="$PYTHONPATH"
export PYTHONPATH=$REPO:$_LODAS_BASE_PYTHONPATH
export WORKON_HOME=~/.venvs
export ENV=LOCAL

source /opt/homebrew/bin/virtualenvwrapper.sh
workon lodas

eval "$(fnm env)"
eval "$(fnm completions --shell zsh)"

lodas() {
  local script
  script="$(git rev-parse --show-toplevel 2>/dev/null)/scripts/lodas.py"
  if [[ ! -x "$script" ]]; then
    script="$REPO/scripts/lodas.py"
  fi
  "$script" "$@"
}
olc() {
  local branch
  branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || {
    echo "error: not in a git repo"
    return 1
  }

  # On main/master: fall back to last commit
  if [[ "$branch" == "main" || "$branch" == "master" ]]; then
    git show --pretty="" --name-only | xargs code
    return
  fi

  # Use explicit arg, or auto-detect parent branch from reflog, or fall back to main
  local parent="${1:-}"
  if [[ -z "$parent" ]]; then
    parent=$(git reflog show HEAD 2>/dev/null \
      | sed -n "s|.*checkout: moving from \(.*\) to ${branch}$|\1|p" \
      | head -1)
    [[ -z "$parent" || "$parent" == "$branch" ]] && parent="main"
  fi

  local base
  base=$(git merge-base HEAD "$parent" 2>/dev/null) || {
    echo "error: could not find merge-base with '$parent'"
    return 1
  }

  local files
  files=$(git diff --name-only "$base"..HEAD)
  if [[ -z "$files" ]]; then
    echo "No changed files since branching from $parent."
    return 0
  fi
  echo "$files" | xargs code
}
alias lsql='docker exec -it lodas_db psql -U realto -d realto'
alias docker-nuke='read -q "REPLY?Nuke ALL containers, images, volumes, and build cache? [y/N] " && echo && docker stop $(docker ps -aq) 2>/dev/null; docker system prune -af --volumes && docker buildx prune -af'

eval "$(zoxide init zsh)"

# Auto-activate the correct venv when cd-ing between worktrees and the main repo
_lodas_auto_activate_venv() {
  local git_root
  git_root="$(git rev-parse --show-toplevel 2>/dev/null)" || return

  local REPO="$HOME/dev/lodas"

  # Already in the correct venv? Skip.
  if [[ -n "$VIRTUAL_ENV" ]]; then
    if [[ "$git_root" == "$REPO" && "$VIRTUAL_ENV" == *"/lodas" ]]; then
      return
    elif [[ "$VIRTUAL_ENV" == "$git_root/venv" ]]; then
      return
    fi
  fi

  # Activate the appropriate venv
  if [[ "$git_root" == "$REPO" ]]; then
    workon lodas 2>/dev/null
  elif [[ -f "$git_root/venv/bin/activate" ]]; then
    source "$git_root/venv/bin/activate"
  else
    return
  fi

  export PYTHONPATH="$git_root:$_LODAS_BASE_PYTHONPATH"
}

autoload -U add-zsh-hook
add-zsh-hook chpwd _lodas_auto_activate_venv
_lodas_auto_activate_venv  # Run once at startup for shells opened inside a worktree

[ -f ~/.fzf.zsh ] && source ~/.fzf.zsh


# The following lines have been added by Docker Desktop to enable Docker CLI completions.
fpath=(/Users/eric/.docker/completions $fpath)
# End of Docker CLI completions
autoload -Uz compinit
if [[ -n ~/.zcompdump(#qN.mh+24) ]]; then
  compinit
else
  compinit -C
fi

wt () {
  if [[ -z "$1" ]]; then
    echo "usage: wt <branch-name-or-ticket>"
    return 1
  fi

  local root
  root="$(git rev-parse --show-toplevel 2>/dev/null)" || root="$HOME/dev/lodas"

  local branch="$1"
  shift

  # Allow bare ticket numbers: "1234" -> "LM-1234"
  if [[ "$branch" =~ ^[0-9]+$ ]]; then
    branch="LM-$branch"
  fi

  # Fuzzy-resolve if it looks like a ticket ID (LM-NNNN) rather than a full branch
  if [[ "$branch" =~ ^LM-[0-9]+$ ]]; then
    git -C "$root" fetch --prune origin 2>/dev/null
    local resolved
    resolved="$(git -C "$root" branch -a --list "*${branch}*" \
      | sed 's|remotes/origin/||;s/^[+* ]*//' | sort -u \
      | fzf --select-1 --exit-0 --prompt="$branch > ")" || {
      echo "No branch selected."
      return 1
    }
    branch="$resolved"
  fi

  local output
  output="$("$root/scripts/lodas.py" create worktree "$branch" "$@")" || return 1

  # lodas.py prints "cd <path>" on the last line; extract the path
  local target
  target="$(echo "$output" | tail -1 | sed 's/^cd //')"

  if [[ -z "$target" || ! -d "$target" ]]; then
    echo "error: could not determine worktree path"
    echo "$output"
    return 1
  fi

  cd "$target" || return 1
}

cwt () {
  local root
  root="$(git rev-parse --show-toplevel 2>/dev/null)" || root="$HOME/dev/lodas"

  local main_repo
  main_repo="$(cd "$root" && git rev-parse --git-common-dir 2>/dev/null)"
  main_repo="$(cd "$root" && cd "${main_repo:-.git}/.." && pwd)"

  # Deactivate worktree venv if active
  if [[ -n "$VIRTUAL_ENV" && "$VIRTUAL_ENV" != *"/lodas" ]]; then
    deactivate
  fi

  "$root/scripts/lodas.py" clean worktree "$@" || return 1

  # Return to main repo and reactivate its venv
  cd "$main_repo" || return 1
  workon lodas
}

lodas_wt_up () {
  local root
  root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
    echo "error: not in a git repo"
    return 1
  }

  if [[ ! -x "$root/scripts/lodas.py" ]]; then
    echo "error: $root/scripts/lodas.py not found"
    return 1
  fi

  # Ensure correct venv is active for this worktree
  if [[ -f "$root/venv/bin/activate" && "$VIRTUAL_ENV" != "$root/venv" ]]; then
    echo "Activating worktree venv: $root/venv"
    source "$root/venv/bin/activate"
  fi

  echo "Using repo: $root"
  cd "$root" || return 1

  echo "Stopping Tilt and removing containers (this stops all Docker containers)."
  "$root/scripts/lodas.py" tilt down || return 1

  echo "Installing dependencies and building local packages..."
  "$root/scripts/lodas.py" ci || return 1

  echo "Starting full stack with Tilt..."
  "$root/scripts/lodas.py" tilt up --all
}
export PATH="$HOME/.local/bin:$PATH"

test -e "${HOME}/.iterm2_shell_integration.zsh" && source "${HOME}/.iterm2_shell_integration.zsh"

export CCS_DROID_PATH="/Users/eric/.local/bin/droid"

# Claude Code multi-account: work/personal share everything except credentials.
# Credentials are keychain-scoped by CLAUDE_CONFIG_DIR, so each env logs in once.
claude-work()     { CLAUDE_CONFIG_DIR="$HOME/.claude/envs/work"     claude "$@"; }
claude-personal() { CLAUDE_CONFIG_DIR="$HOME/.claude/envs/personal" claude "$@"; }
