export ZSH="$HOME/.oh-my-zsh"
ZSH_THEME="robbyrussell"
plugins=(git)

source $ZSH/oh-my-zsh.sh

export REPO=$HOME/dev/lodas
export _LODAS_BASE_PYTHONPATH="$PYTHONPATH"
export PYTHONPATH=$REPO:$_LODAS_BASE_PYTHONPATH
export WORKON_HOME=~/.venvs
export ENV=LOCAL
export EDITOR=nvim

source /opt/homebrew/bin/virtualenvwrapper.sh

# Auto-activate venvs per project, worktree-aware. Priority: a local venv at
# the git root ($root/venv), then $WORKON_HOME/<main-repo-name> — derived from
# git-common-dir, so every worktree of lodas shares ~/.venvs/lodas. Only ever
# deactivates a venv it activated itself; manual workon/activate is left alone.
typeset -g _AUTO_VENV=""
_auto_venv() {
  emulate -L zsh
  local root venv=""
  root="$(git rev-parse --show-toplevel 2>/dev/null)"
  if [[ -n "$root" ]]; then
    if [[ -f "$root/venv/bin/activate" ]]; then
      venv="$root/venv"
    else
      local common name
      common="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"
      name="${common:h:t}"
      [[ -n "$name" && -f "$WORKON_HOME/$name/bin/activate" ]] && venv="$WORKON_HOME/$name"
    fi
  fi

  # A venv we didn't activate is the user's business — leave it alone
  [[ -n "$VIRTUAL_ENV" && "$VIRTUAL_ENV" != "$_AUTO_VENV" ]] && return

  if [[ "$venv" != "$VIRTUAL_ENV" ]]; then
    [[ -n "$VIRTUAL_ENV" ]] && deactivate
    if [[ -n "$venv" ]]; then
      source "$venv/bin/activate"
      _AUTO_VENV="$venv"
    else
      _AUTO_VENV=""
    fi
  fi
}
autoload -U add-zsh-hook
add-zsh-hook chpwd _auto_venv
_auto_venv  # cover the shell's starting directory; chpwd only fires on cd

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
alias aws-creds="$HOME/dev/scripts/aws-to-1p.sh"
cleandocker () {
  read -q "REPLY?Nuke ALL Docker containers, images, volumes, networks, and build cache? [y/N] " || return
  echo
  docker rm -f $(docker ps -aq) 2>/dev/null
  docker system prune -af --volumes
  docker buildx prune -af
}

eval "$(zoxide init zsh)"

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

  # If a worktree already exists for this branch, jump straight to it
  local existing
  existing="$(git -C "$root" worktree list --porcelain 2>/dev/null \
    | awk -v b="refs/heads/$branch" '
        /^worktree / { wt=$2 }
        $0 == "branch " b { print wt; exit }
    ')"
  if [[ -n "$existing" && -d "$existing" ]]; then
    echo "Worktree for '$branch' already exists at $existing"
    cd "$existing" || return 1
    return 0
  fi

  # lodas.py runs under `python`, which lives in the repo's virtualenv. The chpwd
  # hook only activates that venv once you're inside the repo, but wt may be run
  # from anywhere (e.g. ~). Create the worktree from within $root in a subshell,
  # activating the venv there, so this works with no venv active and leaves the
  # caller's shell untouched.
  local output
  output="$(
    cd "$root" || exit 1
    typeset -f _auto_venv >/dev/null && _auto_venv >/dev/null 2>&1
    "$root/scripts/lodas.py" create worktree "$branch" "$@"
  )" || return 1

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

  "$root/scripts/lodas.py" clean worktree "$@" || return 1

  cd "$main_repo" || return 1
}

# wtpr: open an iTerm2 tab per open PR (mine), each in its worktree
[ -f ~/dev/.rcs/zsh/wtpr.zsh ] && source ~/dev/.rcs/zsh/wtpr.zsh

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
export PATH="$HOME/.cargo/bin:$PATH"

# LODAS personal glossary — `lodef` opens it, `lodef <term>` greps for a term.
# Renders with glow if available; falls back to plain text.
lodef() {
  local glossary="$HOME/Documents/LODAS/glossary.md"
  if [[ ! -f "$glossary" ]]; then
    echo "Glossary not found: $glossary"
    return 1
  fi
  local has_glow=0
  command -v glow >/dev/null 2>&1 && has_glow=1
  if [[ -z "$1" ]]; then
    if (( has_glow )); then
      glow -w 0 -p "$glossary"
    else
      ${PAGER:-less} "$glossary"
    fi
    return
  fi
  local term="${(L)1}"
  local result
  result=$(awk -v RS='\n## ' -v term="$term" '
    NR==1 { next }
    tolower($0) ~ term { print "## " $0 }
  ' "$glossary")
  if [[ -z "$result" ]]; then
    echo "No match for '$1' in $glossary"
    return 1
  fi
  if (( has_glow )); then
    print -r -- "$result" | glow -w 0 -
  else
    print -r -- "$result"
  fi
}
lodef-edit() { ${EDITOR:-code} "$HOME/Documents/LODAS/glossary.md"; }

test -e "${HOME}/.iterm2_shell_integration.zsh" && source "${HOME}/.iterm2_shell_integration.zsh"

# Tab title = git branch when inside a repo, else the current directory name.
# Reuses oh-my-zsh's `title` helper (handles iTerm2/tmux escape codes); we just
# feed it the branch/dir and stop omz from overwriting it with PWD/command name.
DISABLE_AUTO_TITLE=true
_tab_title() {
  emulate -L zsh
  local name
  name=$(git symbolic-ref --quiet --short HEAD 2>/dev/null)
  if [[ -z "$name" ]]; then
    if git rev-parse --git-dir &>/dev/null; then
      name="@$(git rev-parse --short HEAD 2>/dev/null)"  # detached HEAD -> short sha
    else
      name=${PWD:t}                                       # not a repo -> dir name
    fi
  fi
  title "$name"
}
autoload -U add-zsh-hook
add-zsh-hook precmd _tab_title

# Claude Code multi-account: work/personal share everything except credentials.
# Credentials are keychain-scoped by CLAUDE_CONFIG_DIR, so each env logs in once.
claude-work()     { CLAUDE_CONFIG_DIR="$HOME/.claude/envs/work"     claude "$@"; }
claude-personal() { CLAUDE_CONFIG_DIR="$HOME/.claude/envs/personal" claude "$@"; }
