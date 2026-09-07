---
name: schlep
description: Stage and commit all current repository changes without pushing. Use only when invoked or explicitly asked to schlep, not when discussing this skill.
---
# Schlep

1. Find the repository containing cwd; otherwise ask. Stop on detached HEAD, conflicts, or an active merge/rebase/cherry-pick/revert.
2. Inspect status and diffs yourself. Stop on apparent secrets/private state; report paths, not values. No reviewers or other harnesses.
3. Run `git add -A` at the root, including pre-existing, staged, unstaged, deleted, and untracked non-ignored changes. Do not silently omit files or force-add ignored ones.
4. If empty, report nothing to commit. Otherwise make one descriptive commit. Honor required checks/hooks; stop on failure.
5. Report hash, summary, and remaining changes. Do not repeatedly commit newly arriving edits.

No push, branch switching, amend, stash/discard, bypassed hooks, unsolicited implementation, or edits merely to make the commit pass.
