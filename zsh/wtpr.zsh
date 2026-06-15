# wtpr — open one iTerm2 tab per open GitHub PR (mine), each in its worktree.
# Pulls my open PRs from the lodas repo with `gh`, then opens a new iTerm window
# with a tab per PR and runs `wt <branch>` in each. `wt` (defined in zshrc) cd's
# to that branch's worktree, creating it via lodas.py if it doesn't exist yet.
#
# usage: wtpr [repo-path] [-n|--dry-run]
#   repo-path     repo to read PRs from (default: ~/dev/lodas)
#   -n/--dry-run  print the PRs and the AppleScript, but don't touch iTerm
wtpr() {
  emulate -L zsh
  local repo="$HOME/dev/lodas"
  local dry=0 arg
  for arg in "$@"; do
    case "$arg" in
      -n|--dry-run) dry=1 ;;
      -h|--help) print "usage: wtpr [repo-path] [-n|--dry-run]"; return 0 ;;
      -*) print -u2 "wtpr: unknown option: $arg"; return 1 ;;
      *) repo="$arg" ;;
    esac
  done

  if [[ ! -d "$repo" ]]; then
    print -u2 "wtpr: repo not found: $repo"
    return 1
  fi

  # My open PRs as "number<TAB>branch" lines. gh has no -C, so cd in a subshell.
  # gh's stderr (e.g. an auth error) passes through; a non-zero exit aborts here.
  local prs
  prs="$( (cd "$repo" && gh pr list --author @me --state open \
    --json number,headRefName --jq '.[] | "\(.number)\t\(.headRefName)"') )" || return 1

  if [[ -z "$prs" ]]; then
    print "wtpr: no open PRs for @me in $repo"
    return 0
  fi

  # Build the AppleScript: a new window whose first session takes PR #1, then a
  # fresh tab per remaining PR. `current session of theWindow` always points at
  # the newest tab. Branch names are AppleScript-safe; escape defensively anyway.
  local tabs="" entry branch cmd first=1 count=0
  for entry in "${(@f)prs}"; do
    branch="${entry#*$'\t'}"
    [[ -z "$branch" || "$branch" == "$entry" ]] && continue
    (( count++ ))
    cmd="wt ${branch}"
    cmd="${cmd//\\/\\\\}"
    cmd="${cmd//\"/\\\"}"
    if (( first )); then
      first=0
    else
      tabs+="  tell theWindow to create tab with default profile"$'\n'
    fi
    tabs+="  tell current session of theWindow to write text \"${cmd}\""$'\n'
  done

  local script="tell application \"iTerm\"
  activate
  set theWindow to (create window with default profile)
${tabs}end tell"

  if (( dry )); then
    print -- "PRs ($count):"
    print -- "$prs"
    print -- "--- AppleScript ---"
    print -- "$script"
    return 0
  fi

  print -- "wtpr: opening $count tab(s) in a new iTerm window…"
  print -r -- "$script" | osascript -
}
