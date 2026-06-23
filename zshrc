export ZSH="$HOME/.oh-my-zsh"
ZSH_THEME="robbyrussell"
plugins=(git)

source $ZSH/oh-my-zsh.sh

export WORKON_HOME=~/.venvs
export EDITOR=nvim

# virtualenvwrapper. Pin the interpreter to Homebrew's python3 so it works
# regardless of PATH order — the system /usr/bin/python3 lacks the module.
export VIRTUALENVWRAPPER_PYTHON=/opt/homebrew/bin/python3
source /opt/homebrew/bin/virtualenvwrapper.sh

# Auto-activate venvs per project, worktree-aware. Priority: a local venv at
# the git root ($root/venv), then $WORKON_HOME/<main-repo-name> — derived from
# git-common-dir, so every worktree of a repo shares ~/.venvs/<repo>. Only ever
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

# olc [parent] — `code` opens every file changed on this branch since `parent`
# (auto-detected from reflog, defaults to main). On main/master: the last commit.
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

export PATH="$HOME/.local/bin:$PATH"
export PATH="$HOME/.cargo/bin:$PATH"

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

# Machine-local / private config (e.g. work-specific functions, paths, secrets).
# Not versioned; lives only on machines that need it. Sourced last so it can use
# the helpers above (e.g. _auto_venv) and override anything.
[ -f ~/.zshrc.local ] && source ~/.zshrc.local
